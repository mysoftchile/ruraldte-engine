// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import forge from "node-forge";
import {
  exportRcvCsv,
  RcvCsvError,
  type RcvCsvInput,
  type RcvCsvOptions,
} from "./sii-rcv.ts";

const input = (): RcvCsvInput => ({
  empresaRut: "11111111-1",
  periodo: "202606",
  operacion: "COMPRA",
  exportacion: "detalle",
  autenticacion: { tipo: "clave", rut: "22222222-2", clave: "SECRETO" },
});
const ok = (data: unknown = {}, headers?: HeadersInit) =>
  Response.json(data, { headers });
function fixture(
  exported: () => Response | Promise<Response> = () =>
    ok({
      respEstado: { codRespuesta: 0 },
      data: ["Nro;Total", "1;55"],
      nombreArchivo: "RCV.csv",
    }),
) {
  const calls: { url: string; init: RequestInit }[] = [];
  let closed = 0;
  let tls: unknown;
  let authRejected = false;
  let logoutFailed = false;
  let revoked = true;
  let beforeExport: (() => void) | undefined;
  const options: RcvCsvOptions = {
    createClient: (credentials) => {
      tls = credentials;
      return {
        close: () => {
          closed++;
        },
      };
    },
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      if (url.includes("CAutInicio.cgi")) {
        return authRejected
          ? new Response("Clave incorrecta SECRETO")
          : new Response("autenticado", {
            headers: [[
              "set-cookie",
              "TOKEN=sintetico; Domain=.sii.cl; Path=/; Secure",
            ], ["set-cookie", "OTRO=local; Path=/local"]],
          });
      }
      if (url.includes("autTermino.cgi")) {
        if (logoutFailed) throw new Error("Logout SECRETO");
        return new Response("logout", {
          headers: {
            "set-cookie": "TOKEN=; Max-Age=0; Domain=.sii.cl; Path=/",
          },
        });
      }
      if (url.includes("siihome.cgi")) {
        return new Response(
          revoked
            ? "location.replace('https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoRutClave.html')"
            : "DatosCntrNow",
        );
      }
      if (url.endsWith("getDatosInicio")) {
        return ok({ respEstado: { codRespuesta: 0 } });
      }
      if (/get(?:Resumen|DetalleCompra|DetalleVenta)Export$/.test(url)) {
        beforeExport?.();
        return await exported();
      }
      return ok();
    },
  };
  return {
    options,
    calls,
    get closed() {
      return closed;
    },
    get tls() {
      return tls;
    },
    rejectAuth: () => {
      authRejected = true;
    },
    failLogout: () => {
      logoutFailed = true;
    },
    keepSession: () => {
      revoked = false;
    },
    beforeExport: (fn: () => void) => {
      beforeExport = fn;
    },
  };
}

Deno.test("RCV: cuatro botones exportan globalmente sin reCAPTCHA y cierran sesión/cliente", async () => {
  for (const operacion of ["COMPRA", "VENTA"] as const) {
    for (const exportacion of ["resumen", "detalle"] as const) {
      const f = fixture();
      const result = await exportRcvCsv(
        { ...input(), operacion, exportacion },
        f.options,
      );
      assert.equal(result.sinDatos, false);
      if (result.sinDatos) {
        throw new Error("Se esperaba CSV");
      }
      assert.equal(new TextDecoder().decode(result.bytes), "Nro;Total\n1;55\n");
      assert.equal(result.nombreArchivo, "RCV.csv");
      const exports = f.calls.filter((c) => /Export$/.test(c.url));
      assert.equal(exports.length, 1);
      const call = exports[0];
      assert.ok(call.url.endsWith(
        exportacion === "resumen"
          ? "getResumenExport"
          : operacion === "COMPRA"
          ? "getDetalleCompraExport"
          : "getDetalleVentaExport",
      ));
      const body = JSON.parse(String(call.init.body));
      assert.deepEqual(body.data, {
        rutEmisor: "11111111",
        dvEmisor: "1",
        ptributario: "202606",
        estadoContab: operacion === "VENTA" && exportacion === "detalle"
          ? ""
          : "REGISTRO",
        operacion,
        ...(exportacion === "detalle" ? { codTipoDoc: 0 } : {}),
      });
      assert.equal(body.metaData.conversationId, "sintetico");
      assert.equal(
        new Headers(call.init.headers).get("cookie"),
        "TOKEN=sintetico",
      );
      assert.ok(
        !f.calls.some((c) => /getCtrlAsync|obtenerArchivoBLOB/.test(c.url)),
      );
      assert.ok(!JSON.stringify(f.calls).toLowerCase().includes("recaptcha"));
      assert.ok(f.calls.at(-2)?.url.includes("autTermino.cgi"));
      assert.equal(
        new Headers(f.calls.at(-1)?.init.headers).get("cookie"),
        "TOKEN=sintetico",
      );
      assert.equal(f.closed, 1);
    }
  }
});

Deno.test("RCV: certificado usa PFX existente, TLS y autenticación herculesr", async () => {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date("2026-01-01");
  cert.validity.notAfter = new Date("2030-01-01");
  cert.setSubject([{ name: "commonName", value: "PRUEBA SINTETICA" }]);
  cert.setIssuer(cert.subject.attributes);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const der: string = forge.asn1.toDer(
    forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], "PASSWORD", {
      algorithm: "3des",
    }),
  ).getBytes();
  const pfx = Uint8Array.from(der, (c) => c.charCodeAt(0));
  const f = fixture();
  await exportRcvCsv({
    ...input(),
    autenticacion: { tipo: "certificado", pfxPassword: "PASSWORD" },
    pfx,
  }, f.options);
  assert.ok((f.tls as { cert: string }).cert.includes("BEGIN CERTIFICATE"));
  assert.ok((f.tls as { key: string }).key.includes("PRIVATE KEY"));
  assert.ok(
    f.calls.some((c) =>
      c.url.startsWith("https://herculesr.sii.cl/cgi_AUT2000/CAutInicio.cgi")
    ),
  );
  assert.ok(!f.calls.some((c) => String(c.init.body).includes("PASSWORD")));
  assert.equal(f.closed, 1);
});

Deno.test("RCV: archivo conserva bytes, charset y nombre sin regenerar CSV", async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xe1, 13, 10]);
  const f = fixture(() =>
    new Response(bytes, {
      headers: {
        "content-type": "text/csv; charset=ISO-8859-1",
        "content-disposition":
          "attachment; filename*=UTF-8''compras%20junio.csv",
      },
    })
  );
  const result = await exportRcvCsv(input(), f.options);
  assert.ok(!result.sinDatos);
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.nombreArchivo, "compras junio.csv");
  assert.equal(result.contentType, "text/csv; charset=ISO-8859-1");
});

Deno.test("RCV: ausencia explícita, cabecera sola y errores no inventan datos", async () => {
  for (const code of [3, 99]) {
    assert.deepEqual(
      await exportRcvCsv(
        input(),
        fixture(() => ok({ respEstado: { codRespuesta: code }, data: [] }))
          .options,
      ),
      { sinDatos: true },
    );
  }
  const header = await exportRcvCsv(
    input(),
    fixture(() =>
      ok({
        respEstado: { codRespuesta: 0 },
        data: ["Folio;Total"],
        nombreArchivo: "vacio.csv",
      })
    ).options,
  );
  assert.ok(!header.sinDatos);
  for (
    const body of [{}, { respEstado: { codRespuesta: 0 }, data: [] }, {
      respEstado: { codRespuesta: 98 },
      data: [],
    }, { respEstado: { codRespuesta: 2 }, data: ["SECRETO"] }]
  ) {
    const f = fixture(() => ok(body));
    await assert.rejects(
      () => exportRcvCsv(input(), f.options),
      (e: unknown) =>
        e instanceof RcvCsvError && e.code === "SII_OPERATION_FAILED" &&
        !e.message.includes("SECRETO"),
    );
    assert.equal(f.closed, 1);
  }
});

Deno.test("RCV: descarga diferida falla sin consultar ni generar control", async () => {
  for (
    const response of [
      () => ok({ respEstado: { codRespuesta: 1 }, data: [] }),
      () => ok({ respEstado: { codRespuesta: 0 }, descargaDiferida: true }),
      () =>
        new Response(new Uint8Array([0x1f, 0x8b]), {
          headers: { "content-type": "application/octet-stream" },
        }),
    ]
  ) {
    const f = fixture(response);
    await assert.rejects(
      () => exportRcvCsv(input(), f.options),
      (e: unknown) =>
        e instanceof RcvCsvError && e.code === "SII_RCV_DEFERRED_REQUIRED",
    );
    assert.equal(f.closed, 1);
    assert.ok(
      !f.calls.some((c) => /getCtrlAsync|obtenerArchivoBLOB/.test(c.url)),
    );
  }
});

Deno.test("RCV: autenticación rechazada no reintenta y conserva el error ante fallo de logout", async () => {
  const f = fixture();
  f.rejectAuth();
  f.failLogout();
  await assert.rejects(
    () => exportRcvCsv(input(), f.options),
    (e: unknown) =>
      e instanceof RcvCsvError && e.code === "SII_OPERATION_FAILED",
  );
  assert.equal(
    f.calls.filter((c) => c.url.includes("CAutInicio.cgi")).length,
    1,
  );
  assert.equal(f.closed, 1);
});

Deno.test("RCV: logout fallido o sesión aún válida descarta el CSV", async () => {
  for (const mode of ["failure", "alive"]) {
    const f = fixture();
    if (mode === "failure") f.failLogout();
    else f.keepSession();
    await assert.rejects(
      () => exportRcvCsv(input(), f.options),
      (e: unknown) =>
        e instanceof RcvCsvError && e.code === "SII_SESSION_CLOSE_FAILED",
    );
    assert.equal(f.closed, 1);
  }
});

Deno.test("RCV: timeout/cancelación permiten logout con señal independiente", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const f = fixture();
    const original = f.options.fetchFn!;
    f.options.fetchFn = (url, init) => {
      if (url.endsWith("getDetalleCompraExport")) {
        if (cancel) controller.abort();
        return new Promise<Response>((_, reject) => {
          const rejectAbort = () => reject(new Error("SECRETO"));
          if (init.signal?.aborted) rejectAbort();
          else {init.signal?.addEventListener("abort", rejectAbort, {
              once: true,
            });}
        });
      }
      if (url.includes("autTermino.cgi")) {
        assert.equal(init.signal?.aborted, false);
      }
      return original(url, init);
    };
    await assert.rejects(
      () =>
        exportRcvCsv(input(), {
          ...f.options,
          timeoutMs: cancel ? 1000 : 20,
          signal: controller.signal,
        }),
      (e: unknown) =>
        e instanceof RcvCsvError &&
        e.code === (cancel ? "SII_OPERATION_FAILED" : "SII_TIMEOUT"),
    );
    assert.equal(f.closed, 1);
    assert.ok(f.calls.some((c) => c.url.includes("autTermino.cgi")));
  }
});
