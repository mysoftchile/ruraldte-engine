// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import { material } from "./material.ts";
import { buildEnvioRecibos as buildLegacyEnvioRecibos } from "../../engine/intercambio.ts";
import { type Element, XMLSerializer } from "npm:@xmldom/xmldom@0.9.10";
import { createHash, verify, X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  buildEnvioRecibos,
  buildRespuestaRecepcionEnvio,
  buildRespuestaRecepcionesEnvio,
  buildRespuestaResultadoDte,
  type IntercambioDte,
  type IntercambioEnvio,
  parseInboundEnvioDte,
  parseInboundEnvioDteLossless,
} from "../../engine/intercambio-extendido.ts";
import {
  encodeLatin1,
  signXmlWithForgeKey,
} from "../../engine/xml-signature.ts";
import { child, parseSafeXml, scalar } from "../../engine/xml-utils.ts";
import { getLegacyToken } from "../../engine/sii-legacy-upload.ts";
const DS = "http://www.w3.org/2000/09/xmldsig#",
  SII = "http://www.sii.cl/SiiDte";
const xmllint = Deno.env.get("XMLLINT") ?? "xmllint";
// No se omite conformidad: la suite exige la herramienta también fuera de CI.
const tool = await new Deno.Command(xmllint, {
  args: ["--version"],
  stderr: "null",
  stdout: "null",
}).output();
assert(tool.success, "xmllint requerido para conformidad y C14N independiente");
const { pfx, key } = material();
const ident = {
  rutResponde: "78416626-0",
  rutRecibe: "77777777-7",
  nmbContacto: "María & José",
  fonoContacto: "+56 2 1234",
  mailContacto: "contacto@example.cl",
  tmstFirma: "2026-11-06T12:00:00-03:00",
};
const dte: IntercambioDte = {
  tipoDte: 33,
  folio: "9999999999",
  mntTotal: "999999999999999999",
  fchEmis: "2026-11-06",
  rutEmisor: ident.rutRecibe,
  rutRecep: ident.rutResponde,
};
const inbound: IntercambioEnvio = {
  setId: "Original",
  digest: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  nmbEnvio: "envío-de-proveedor-con-nombre-mayor-a-30-caracteres.xml",
  rutEmisor: ident.rutRecibe,
  rutEnvia: "22222222-2",
  rutReceptor: ident.rutResponde,
  dtes: [dte, { ...dte, folio: 2 }],
};
async function validate(bytes: Uint8Array, schema: string) {
  const tmp = await Deno.makeTempFile({ suffix: ".xml" });
  try {
    await Deno.writeFile(tmp, bytes);
    const r = await new Deno.Command(xmllint, {
      args: [
        "--nonet",
        "--noout",
        "--schema",
        fileURLToPath(
          new URL("../../engine/xsd/intercambio/" + schema, import.meta.url),
        ),
        tmp,
      ],
    }).output();
    assert(r.success, new TextDecoder().decode(r.stderr));
  } finally {
    await Deno.remove(tmp);
  }
}
/** C14N libxml2 independiente de la C14N del motor; materializa namespaces heredados. */
async function canonical(el: Element): Promise<Uint8Array> {
  const clone = el.cloneNode(true) as Element;
  const namespaces = new Map<string, string>();
  for (
    let parent: Element | null = el;
    parent;
    parent = parent.parentNode?.nodeType === 1
      ? parent.parentNode as Element
      : null
  ) {
    for (const a of Array.from(parent.attributes)) {
      if (a.name === "xmlns" || a.name.startsWith("xmlns:")) {
        if (!namespaces.has(a.name)) namespaces.set(a.name, a.value);
      }
    }
  }
  for (const [name, value] of namespaces) {
    clone.setAttributeNS("http://www.w3.org/2000/xmlns/", name, value);
  }
  const proc = new Deno.Command(xmllint, {
    args: ["--nonet", "--c14n", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = proc.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(new XMLSerializer().serializeToString(clone)),
  );
  await writer.close();
  const r = await proc.output();
  assert(r.success, new TextDecoder().decode(r.stderr));
  return r.stdout;
}
/** Comprueba todos los digests y RSA con node:crypto, no con forge ni verifyForgeSignature. */
async function verifyAll(bytes: Uint8Array): Promise<number> {
  const xml = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  const doc = parseSafeXml(xml);
  const signatures = Array.from(doc.getElementsByTagNameNS(DS, "Signature"));
  for (const sig of signatures) {
    const info = child(sig, DS, "SignedInfo"),
      ref = child(info, DS, "Reference");
    assertEquals(
      child(info, DS, "CanonicalizationMethod").getAttribute("Algorithm"),
      "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
    );
    assertEquals(
      child(info, DS, "SignatureMethod").getAttribute("Algorithm"),
      DS + "rsa-sha1",
    );
    assertEquals(
      child(ref, DS, "DigestMethod").getAttribute("Algorithm"),
      DS + "sha1",
    );
    const targetId = ref.getAttribute("URI")?.slice(1);
    const targets = Array.from(doc.getElementsByTagName("*")).filter((n) =>
      n.getAttribute("ID") === targetId
    );
    assertEquals(targets.length, 1);
    const digest = createHash("sha1").update(await canonical(targets[0]))
      .digest("base64");
    assertEquals(
      digest,
      scalar(child(ref, DS, "DigestValue")).replace(/\s/g, ""),
      "digest " + targetId,
    );
    const certDer = scalar(
      child(child(sig, DS, "KeyInfo"), DS, "X509Data").getElementsByTagNameNS(
        DS,
        "X509Certificate",
      )[0],
    );
    const certificate = new X509Certificate(
      Buffer.from(certDer.replace(/\s/g, ""), "base64"),
    );
    assert(
      verify(
        "RSA-SHA1",
        await canonical(info),
        certificate.publicKey,
        Buffer.from(
          scalar(child(sig, DS, "SignatureValue")).replace(/\s/g, ""),
          "base64",
        ),
      ),
      "RSA " + targetId,
    );
  }
  return signatures.length;
}
Deno.test("Tres XML: XSD oficial, bytes Latin-1 y todas las firmas independientes", async () => {
  const examples = [
    [
      buildRespuestaRecepcionEnvio(inbound, ident, pfx, "pass", {
        detalles: [{ estado: "0" }, { estado: "1", glosa: "Firma no válida" }],
      }),
      "RespuestaEnvioDTE_v10.xsd",
      1,
    ],
    [
      buildRespuestaResultadoDte(
        [dte, {
          ...dte,
          folio: 2,
          estado: "1",
          glosa: "Reparo & revisión",
          codRchDsc: -12,
        }, { ...dte, folio: 3, estado: "2" }],
        ident,
        pfx,
        "pass",
      ),
      "RespuestaEnvioDTE_v10.xsd",
      1,
    ],
    [
      buildEnvioRecibos(
        [dte, {
          ...dte,
          folio: 2,
          recinto: "Bodega Ñuñoa & Sur",
          tmstFirma: "2026-11-06T11:55:00-03:00",
          reciboId: "Recibo2",
        }],
        ident,
        pfx,
        "pass",
      ),
      "EnvioRecibos_v10.xsd",
      3,
    ],
  ] as const;
  for (const [result, schema, n] of examples) {
    assertEquals(result.bytes, encodeLatin1(result.xml));
    await validate(result.bytes, schema);
    assertEquals(await verifyAll(result.bytes), n);
    await assertRejects(() =>
      verifyAll(
        encodeLatin1(
          result.xml.replace("999999999999999999", "999999999999999998"),
        ),
      )
    );
    await assertRejects(() =>
      validate(
        encodeLatin1(result.xml.replace("<MntTotal>", "<FueraDeOrden>")),
        schema,
      )
    );
  }
  const receipt = examples[2][0].xml;
  const parsed = parseSafeXml(receipt);
  for (const r of Array.from(parsed.getElementsByTagNameNS(SII, "Recibo"))) {
    await validate(
      encodeLatin1(
        '<?xml version="1.0" encoding="ISO-8859-1"?>' +
          new XMLSerializer().serializeToString(r),
      ),
      "Recibos_v10.xsd",
    );
  }
  assertStringIncludes(receipt, "<RutFirma>22222222-2</RutFirma>");
  // El parche compartido también corrige la firma exterior del builder histórico.
  const legacyDte = { ...dte, folio: 1, mntTotal: 1000 };
  const legacy = buildLegacyEnvioRecibos(
    [legacyDte, { ...legacyDte, folio: 2 }],
    ident,
    pfx,
    "pass",
  );
  assertEquals(await verifyAll(legacy.bytes), 3);
});
Deno.test("Recepción: cuenta envíos, NroDTE y decisiones independientes", async () => {
  const r = buildRespuestaRecepcionesEnvio(
    [{ inbound }, { inbound, opts: { codEnvio: "2", estadoRecepEnv: "2" } }],
    ident,
    pfx,
    "pass",
  );
  assertStringIncludes(r.xml, "<NroDetalles>2</NroDetalles>");
  assertEquals((r.xml.match(/<NroDTE>2<\/NroDTE>/g) ?? []).length, 2);
  assertStringIncludes(
    buildRespuestaRecepcionEnvio(inbound, ident, pfx, "pass").xml,
    "<NroDetalles>1</NroDetalles>",
  );
  await validate(r.bytes, "RespuestaEnvioDTE_v10.xsd");
  for (const code of ["0", "1", "2", "3", "90", "91", "99"]) {
    const result = buildRespuestaRecepcionEnvio(inbound, ident, pfx, "pass", {
      estadoRecepEnv: code,
    });
    await validate(result.bytes, "RespuestaEnvioDTE_v10.xsd");
  }
  for (const code of ["0", "1", "2", "3", "4", "99"]) {
    await validate(
      buildRespuestaRecepcionEnvio(inbound, ident, pfx, "pass", {
        estadoRecepDte: code,
      }).bytes,
      "RespuestaEnvioDTE_v10.xsd",
    );
  }
  const unreadable = buildRespuestaRecepcionEnvio(
    {
      ...inbound,
      setId: null,
      digest: null,
      rutEmisor: "",
      rutReceptor: "",
      dtes: [],
    },
    ident,
    pfx,
    "pass",
    { estadoRecepEnv: "91" },
  );
  assertStringIncludes(unreadable.xml, "<NroDetalles>1</NroDetalles>");
  await validate(unreadable.bytes, "RespuestaEnvioDTE_v10.xsd");
  const mismatch = buildRespuestaRecepcionEnvio(
    { ...inbound, dtes: [{ ...dte, rutRecep: "11111111-1" }] },
    ident,
    pfx,
    "pass",
  );
  assertStringIncludes(mismatch.xml, "<EstadoRecepDTE>3</EstadoRecepDTE>");
});
Deno.test("Parser DOM: namespaces, entidades, cifras exactas, ausencia y ataques", () => {
  const xml = '<e:EnvioDTE xmlns:e="' + SII +
    '"><e:SetDTE ID="Set1"><e:Caratula><e:RutEmisor>77777777-7</e:RutEmisor><e:RutEnvia>22222222-2</e:RutEnvia><e:RutReceptor>78416626-0</e:RutReceptor></e:Caratula><e:DTE><e:Documento ID="D1"><e:Encabezado><e:IdDoc><e:TipoDTE>33</e:TipoDTE><e:Folio>9999999999</e:Folio><e:FchEmis>2026-11-06</e:FchEmis></e:IdDoc><e:Emisor><e:RUTEmisor>77777777-7</e:RUTEmisor></e:Emisor><e:Receptor><e:RUTRecep>78416626-0</e:RUTRecep></e:Receptor><e:Totales><e:MntTotal>999999999999999999</e:MntTotal></e:Totales></e:Encabezado></e:Documento></e:DTE></e:SetDTE></e:EnvioDTE>';
  const r = parseInboundEnvioDteLossless(xml);
  assertEquals(r.dtes[0].mntTotal, "999999999999999999");
  assertEquals(r.dtes[0].folio, "9999999999");
  assertEquals(r.digest, null);
  assertThrows(() => parseInboundEnvioDte(xml), Error, "Lossless");
  assertEquals(
    parseInboundEnvioDte(xml.replace("999999999999999999", "123")).dtes[0]
      .mntTotal,
    123,
  );
  for (
    const bad of [
      xml.replace('ID="D1"', 'ID="Set1"'),
      xml.replace(/e:MntTotal/g, "e:Otro"),
      xml.replace(/e:IdDoc/g, "e:Otro"),
      '<!DOCTYPE x [<!ENTITY e "x">]>' + xml,
      xml.slice(0, -3),
    ]
  ) assertThrows(() => parseInboundEnvioDteLossless(bad));
});
Deno.test("Frontera XML: cardinalidad, ID, estados, tipos, enteros y caracteres", () => {
  assertThrows(() => buildRespuestaResultadoDte([], ident, pfx, "pass"));
  for (
    const d of [
      { ...dte, mntTotal: Number.MAX_SAFE_INTEGER + 1 },
      { ...dte, folio: "0" },
      { ...dte, fchEmis: "2026-02-30" },
      { ...dte, estado: "9" },
      { ...dte, codRchDsc: 1 },
      { ...dte, tipoDte: 43 },
      { ...dte, rutRecep: "11111111-1" },
    ]
  ) assertThrows(() => buildRespuestaResultadoDte([d], ident, pfx, "pass"));
  for (const code of [43, 56, 61]) {
    assertThrows(() =>
      buildEnvioRecibos([{ ...dte, tipoDte: code }], ident, pfx, "pass")
    );
  }
  for (const name of ["emoji 😀", "mal\u0001", "x".repeat(41)]) {
    assertThrows(() =>
      buildEnvioRecibos([dte], { ...ident, nmbContacto: name }, pfx, "pass")
    );
  }
  assertThrows(() =>
    buildEnvioRecibos([dte], ident, pfx, "pass", {
      rutFirma: ident.rutResponde,
    })
  );
  assertThrows(() =>
    buildEnvioRecibos([{ ...dte, reciboId: "SetRecibos" }], ident, pfx, "pass")
  );
  assertThrows(() =>
    buildEnvioRecibos(
      [{ ...dte, reciboId: "R1" }, { ...dte, reciboId: "R1" }],
      ident,
      pfx,
      "pass",
    )
  );
  assertThrows(() =>
    buildRespuestaRecepcionEnvio(inbound, ident, pfx, "pass", { detalles: [] })
  );
});
Deno.test("Recibos 33/34/46/52: respaldo de instructivo y XSD", async () => {
  const result = buildEnvioRecibos(
    [33, 34, 46, 52].map((tipoDte) => ({ ...dte, tipoDte })),
    ident,
    pfx,
    "pass",
  );
  await validate(result.bytes, "EnvioRecibos_v10.xsd");
  assertEquals(await verifyAll(result.bytes), 5);
});
Deno.test("Firma compartida conserva IDs Latin-1", async () => {
  const xml = signXmlWithForgeKey(
    '<R xmlns="' + SII + '"><D ID="RespuestaÑ">ok</D></R>',
    "D",
    "RespuestaÑ",
    SII,
    key,
  );
  assertEquals(await verifyAll(encodeLatin1(xml)), 1);
});
Deno.test("Autenticación reutilizada: certificado sintético, ambiente y dos requests", async () => {
  for (const env of ["cert", "prod"] as const) {
    let n = 0;
    const result = await getLegacyToken(env, pfx, "pass", {
      fetchFn: (url, init) => {
        n++;
        assert(
          String(url).includes(
            env === "cert" ? "maullin.sii.cl" : "palena.sii.cl",
          ),
        );
        assertEquals(init?.signal, undefined);
        const inner = n === 1
          ? "<RESPUESTA><SEMILLA>12345678</SEMILLA></RESPUESTA>"
          : "<RESPUESTA><TOKEN>SINTETICO</TOKEN></RESPUESTA>";
        const name = n === 1 ? "getSeedReturn" : "getTokenReturn";
        return respond(
          '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><' +
            name + ">" +
            inner.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(
              />/g,
              "&gt;",
            ) + "</" + name + "></s:Body></s:Envelope>",
        );
      },
    });
    assertEquals(result, "SINTETICO");
    assertEquals(n, 2);
  }
});

function respond(
  body: BodyInit | null,
  init?: ResponseInit,
): Promise<Response> {
  return Promise.resolve(new Response(body, init));
}

Deno.test("Integridad de contratos y dependencias XSD fijados", async () => {
  const manifest = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../engine/xsd/registro-reclamo/sources.json",
        import.meta.url,
      ),
    ),
  ) as { files: { path: string; sha256: string }[] };
  for (const file of manifest.files) {
    assertEquals(
      createHash("sha256").update(
        await Deno.readFile(new URL("../../" + file.path, import.meta.url)),
      ).digest("hex"),
      file.sha256,
      file.path,
    );
  }
});
Deno.test("Firmas: alteraciones de referencia, algoritmo y SignatureValue fallan", async () => {
  const result = buildEnvioRecibos(
    [dte, { ...dte, folio: 2 }],
    ident,
    pfx,
    "pass",
  );
  for (
    const xml of [
      result.xml.replace('URI="#SetRecibos"', 'URI="#NoExiste"'),
      result.xml.replace(DS + "rsa-sha1", DS + "rsa-sha256"),
      result.xml.replace(
        /(<SignatureValue>)(.)/,
        (_, open, ch) => open + (ch === "A" ? "B" : "A"),
      ),
    ]
  ) await assertRejects(() => verifyAll(encodeLatin1(xml)));
});
