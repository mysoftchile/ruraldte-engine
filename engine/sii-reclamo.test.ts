// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  type AccionReclamo,
  consultarDocDteCedible,
  consultarFechaRecepcionSii,
  getVersion,
  ingresarAceptacionReclamoDoc,
  listarEventosHistDoc,
  REGISTRO_RECLAMO_ENDPOINTS,
  REGISTRO_RECLAMO_NS as NS,
  RegistroReclamoError,
} from "./sii-reclamo.ts";
import type { FetchFn } from "./sii-client.ts";
import type { LegacyEnv } from "./sii-legacy-upload.ts";
import { child, children, parseSafeXml } from "./xml-utils.ts";
const SOAP = "http://schemas.xmlsoap.org/soap/envelope/";
const doc = {
  rutEmisor: "76543210-3",
  tipoDoc: 33 as const,
  folio: "9999999999",
};
const base = { ...doc, token: "TOKEN-SINTETICO" };
function response(method: string, content: string) {
  return '<s:Envelope xmlns:s="' + SOAP + '" xmlns:r="' + NS + '"><s:Body><r:' +
    method + "Response><return>" + content + "</return></r:" + method +
    "Response></s:Body></s:Envelope>";
}
const operations = [
  {
    name: "ingresarAceptacionReclamoDoc",
    result: "<codResp>0</codResp><descResp>Acción Completada OK</descResp>",
    run: (env: LegacyEnv, fetchFn: FetchFn) =>
      ingresarAceptacionReclamoDoc(env, { ...base, accionDoc: "ACD", fetchFn }),
  },
  {
    name: "listarEventosHistDoc",
    result: "<codResp>16</codResp><descResp>Sin eventos</descResp>",
    run: (env: LegacyEnv, fetchFn: FetchFn) =>
      listarEventosHistDoc(env, { ...base, fetchFn }),
  },
  {
    name: "consultarFechaRecepcionSii",
    result: "06-11-2026 12:34:56",
    run: (env: LegacyEnv, fetchFn: FetchFn) =>
      consultarFechaRecepcionSii(env, { ...base, fetchFn }),
  },
  {
    name: "consultarDocDteCedible",
    result: "<codResp>23</codResp><descResp>Cedible</descResp>",
    run: (env: LegacyEnv, fetchFn: FetchFn) =>
      consultarDocDteCedible(env, { ...base, fetchFn }),
  },
  {
    name: "getVersion",
    result: "1.2",
    run: (env: LegacyEnv, fetchFn: FetchFn) =>
      getVersion(env, { ...base, fetchFn }),
  },
] as const;
for (const env of ["cert", "prod"] as const) {
  for (const op of operations) {
    Deno.test(op.name + ": RPC/literal " + env, async () => {
      let calls = 0;
      const result = await op.run(env, (url, init) => {
        calls++;
        assertEquals(url, REGISTRO_RECLAMO_ENDPOINTS[env]);
        const headers = new Headers(init?.headers);
        assertEquals(headers.get("Cookie"), "TOKEN=" + base.token);
        assertEquals(headers.get("SOAPAction"), '""');
        assertEquals(headers.get("Content-Type"), "text/xml; charset=UTF-8");
        assertEquals(init?.redirect, "error");
        assert(init?.signal);
        const root = parseSafeXml(String(init?.body)).documentElement!;
        const method = child(child(root, SOAP, "Body"), NS, op.name);
        const expected = op.name === "getVersion" ? [] : [
          "rutEmisor",
          "dvEmisor",
          "tipoDoc",
          "folio",
          ...(op.name === "ingresarAceptacionReclamoDoc" ? ["accionDoc"] : []),
        ];
        assertEquals(
          Array.from(method.childNodes).filter((n) => n.nodeType === 1).map(
            (n) => n.localName,
          ),
          expected,
        );
        for (const name of expected) {
          assertEquals(children(method, "", name).length, 1);
        }
        assert(!String(init?.body).includes("encodingStyle"));
        return respond(response(op.name, op.result));
      });
      assertEquals(calls, 1);
      assertEquals(result.status, 200);
      assert(result.raw.includes("return"));
    });
  }
}
Deno.test("Contrato fijado: cinco operaciones, RPC/literal y strings", async () => {
  const wsdl = parseSafeXml(
    await Deno.readTextFile(
      new URL(
        "./xsd/registro-reclamo/registroreclamodteservice.wsdl",
        import.meta.url,
      ),
    ),
  );
  const W = "http://schemas.xmlsoap.org/wsdl/";
  const port = wsdl.getElementsByTagNameNS(W, "portType")[0];
  assertEquals(
    children(port, W, "operation").map((n) => n.getAttribute("name")).sort(),
    operations.map((x) => x.name).sort(),
  );
  assertEquals(
    wsdl.getElementsByTagNameNS(
      "http://schemas.xmlsoap.org/wsdl/soap/",
      "binding",
    )[0].getAttribute("style"),
    "rpc",
  );
  for (const op of operations) {
    const message = Array.from(wsdl.getElementsByTagNameNS(W, "message")).find(
      (n) => n.getAttribute("name") === op.name,
    )!;
    for (const part of children(message, W, "part")) {
      assert(part.getAttribute("type")?.endsWith(":string"));
    }
  }
});
for (const accionDoc of ["ACD", "ERM", "RCD", "RFP", "RFT"] as const) {
  Deno.test(
    "Acción explícita " + accionDoc +
      ": conserva rechazo/duplicado sin reintento",
    async () => {
      for (const code of [0, 6, 7, 8, 11, 12, 13, 17, -1]) {
        let calls = 0;
        const r = await ingresarAceptacionReclamoDoc("cert", {
          ...base,
          accionDoc,
          fetchFn: (_, init) => {
            calls++;
            assert(
              String(init?.body).includes(
                "<accionDoc>" + accionDoc + "</accionDoc>",
              ),
            );
            return respond(
              response(
                "ingresarAceptacionReclamoDoc",
                "<codResp>" + code +
                  "</codResp><descResp>Glosa literal</descResp>",
              ),
            );
          },
        });
        assertEquals(calls, 1);
        assertEquals(r.data.codResp, code);
        assertEquals(r.data.descResp, "Glosa literal");
      }
    },
  );
}
Deno.test("Historial conserva ACD→ERM, NCA/ENC, fechas, responsables, orden y nil", async () => {
  const events = ["ACD", "ERM", "NCA", "ENC", "NUEVO"].map((code, i) =>
    "<listaEventosDoc><codEvento>" + code +
    "</codEvento><descEvento>A &amp; B</descEvento><rutResponsable>12345678</rutResponsable><dvResponsable>5</dvResponsable><fechaEvento>06-11-2026 12:00:0" +
    i + "</fechaEvento></listaEventosDoc>"
  ).join("");
  const r = await listarEventosHistDoc("prod", {
    ...base,
    fetchFn: () =>
      respond(
        response(
          "listarEventosHistDoc",
          "<codResp>15</codResp><descResp>Listado</descResp><rutToken>12345678</rutToken>" +
            events +
            '<listaEventosDoc xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true"/>',
        ),
      ),
  });
  assertEquals(r.data.listaEventosDoc?.map((x) => x?.codEvento), [
    "ACD",
    "ERM",
    "NCA",
    "ENC",
    "NUEVO",
    undefined,
  ]);
  assertEquals(r.data.listaEventosDoc?.[0]?.descEvento, "A & B");
  assertEquals(r.data.listaEventosDoc?.[1]?.fechaEvento, "06-11-2026 12:00:01");
  assertEquals(r.data.listaEventosDoc?.[1]?.rutResponsable, "12345678");
  assertEquals(r.data.rutToken, "12345678");
  assertEquals(r.parsing, "partial");
});
Deno.test("Campos ausentes y códigos desconocidos no fabrican éxito ni sin eventos", async () => {
  for (
    const content of [
      "",
      "<codResp>999</codResp><nuevo>valor</nuevo>",
      '<x:codResp xmlns:x="urn:otro">16</x:codResp>',
    ]
  ) {
    const r = await listarEventosHistDoc("cert", {
      ...base,
      fetchFn: () => respond(response("listarEventosHistDoc", content)),
    });
    assertEquals(r.parsing, "partial");
    assertEquals(r.data.codResp, content.includes("999") ? 999 : undefined);
    assertEquals(r.data.listaEventosDoc, undefined);
  }
});
Deno.test("Fecha y versión conservan texto; no inventan fechas ni códigos", async () => {
  for (const value of ["06-11-2026 23:59:59", "Sin información", ""]) {
    const r = await consultarFechaRecepcionSii("cert", {
      ...base,
      fetchFn: () => respond(response("consultarFechaRecepcionSii", value)),
    });
    assertEquals(r.data, value);
  }
});
Deno.test("Validación de frontera no usa transporte", () => {
  const fetchFn: FetchFn = () => {
    throw new Error("no debe llamar");
  };
  for (
    const input of [
      { ...base, folio: "10000000000" },
      { ...base, folio: "0" },
      { ...base, folio: "1.2" },
      { ...base, rutEmisor: "76543210-K" },
      { ...base, tipoDoc: 46 },
    ]
  ) {
    assertThrows(() =>
      listarEventosHistDoc(
        "cert",
        { ...input, fetchFn } as Parameters<typeof listarEventosHistDoc>[1],
      )
    );
  }
  assertThrows(() =>
    ingresarAceptacionReclamoDoc("cert", {
      ...base,
      accionDoc: "CNS" as AccionReclamo,
      fetchFn,
    })
  );
});
Deno.test("SOAP Fault, HTTP y cuerpos inválidos distinguen resultado incierto", async () => {
  const fault = '<s:Envelope xmlns:s="' + SOAP +
    '"><s:Body><s:Fault><faultcode>s:Server</faultcode><faultstring>' +
    base.token +
    "</faultstring><detail><X509Certificate>CERT-SINTETICO</X509Certificate><RSASK>KEY-SINTETICA</RSASK></detail></s:Fault></s:Body></s:Envelope>";
  for (
    const [status, body, kind] of [
      [200, fault, "soap-fault"],
      [500, fault, "soap-fault"],
      [401, "sesión expirada", "http"],
      [403, "denegado", "http"],
      [500, "", "http"],
      [200, "", "invalid-response"],
      [200, "<roto>", "invalid-response"],
      [200, response("getVersion", "1"), "invalid-response"],
      [
        200,
        response("ingresarAceptacionReclamoDoc", "<codResp>1.2</codResp>"),
        "invalid-response",
      ],
      [200, "<!DOCTYPE x><x/>", "invalid-response"],
      [
        200,
        response(
          "ingresarAceptacionReclamoDoc",
          "<codResp>0</codResp><TOKEN>mal & valor</TOKEN>",
        ),
        "invalid-response",
      ],
    ] as const
  ) {
    let calls = 0;
    const err = await assertRejects(
      () =>
        ingresarAceptacionReclamoDoc("cert", {
          ...base,
          accionDoc: "ERM",
          fetchFn: () => {
            calls++;
            return respond(body, { status });
          },
        }),
      RegistroReclamoError,
    );
    assertEquals(err.kind, kind);
    assertEquals(err.outcome, "uncertain");
    assertEquals(err.status, status);
    assertEquals(calls, 1);
    assert(!JSON.stringify(err).includes(base.token));
    assert(!JSON.stringify(err).includes("CERT-SINTETICO"));
    assert(!JSON.stringify(err).includes("KEY-SINTETICA"));
    assert(!err.message.includes(base.token));
  }
});
Deno.test("Timeout de envío/cuerpo, red y cancelación: sin reintentos ni secretos", async () => {
  for (const reading of [false, true]) {
    let calls = 0;
    const fetchFn: FetchFn = () => {
      calls++;
      return reading
        ? Promise.resolve(
          respond(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("<incompleto>"));
              },
            }),
          ),
        )
        : new Promise(() => {});
    };
    const err = await assertRejects(
      () =>
        ingresarAceptacionReclamoDoc("cert", {
          ...base,
          accionDoc: "ERM",
          timeoutMs: 10,
          fetchFn,
        }),
      RegistroReclamoError,
    );
    assertEquals(err.kind, "timeout");
    assertEquals(err.outcome, "uncertain");
    assertEquals(calls, 1);
  }
  const controller = new AbortController();
  controller.abort();
  const e = await assertRejects(
    () =>
      ingresarAceptacionReclamoDoc("cert", {
        ...base,
        accionDoc: "ACD",
        signal: controller.signal,
        fetchFn: () => {
          throw new Error("no debe llamar");
        },
      }),
    RegistroReclamoError,
  );
  assertEquals(e.outcome, "not-submitted");
  assertEquals(e.kind, "aborted");
  const network = await assertRejects(
    () =>
      getVersion("cert", {
        ...base,
        fetchFn: () => {
          throw new Error(base.token);
        },
      }),
    RegistroReclamoError,
  );
  assertEquals(network.kind, "network");
  assert(!network.message.includes(base.token));
});

function respond(
  body: BodyInit | null,
  init?: ResponseInit,
): Promise<Response> {
  return Promise.resolve(new Response(body, init));
}

Deno.test("Tipos 33/34/43, cancelación durante envío y namespaces inválidos", async () => {
  for (const tipoDoc of [33, 34, 43] as const) {
    const result = await consultarDocDteCedible("cert", {
      ...base,
      tipoDoc,
      fetchFn: () =>
        respond(
          response(
            "consultarDocDteCedible",
            "<codResp>25</codResp><descResp>Cedible por plazo</descResp>",
          ),
        ),
    });
    assertEquals(result.data.codResp, 25);
  }
  const controller = new AbortController();
  const err = await assertRejects(
    () =>
      ingresarAceptacionReclamoDoc("prod", {
        ...base,
        accionDoc: "ERM",
        signal: controller.signal,
        fetchFn: () => {
          controller.abort();
          return new Promise(() => {});
        },
      }),
    RegistroReclamoError,
  );
  assertEquals(err.kind, "aborted");
  assertEquals(err.outcome, "uncertain");
  for (
    const body of [
      response("getVersion", "1.2").replace(NS, "urn:otro"),
      response("getVersion", "1.2").replace(
        "<return>",
        '<return xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true">',
      ),
      response("getVersion", "1.2").replace("</return>", "</return><otro/>"),
    ]
  ) {
    await assertRejects(
      () => getVersion("cert", { ...base, fetchFn: () => respond(body) }),
      RegistroReclamoError,
    );
  }
});
