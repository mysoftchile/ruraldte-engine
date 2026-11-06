// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import {
  buildEnvioRecibos,
  buildRespuestaRecepcionEnvio,
  buildRespuestaResultadoDte,
  type InboundDte,
  parseInboundEnvioDte,
  type ReciboItem,
  type ResultadoDteItem,
} from "../../engine/intercambio.ts";
import { getLegacyToken } from "../../engine/sii-legacy-upload.ts";
import { Pkcs12ExtractError } from "../../engine/pkcs12.ts";
import { material } from "./material.ts";
const { pfx } = material();
const dte: InboundDte = {
  tipoDte: 33,
  folio: 1,
  mntTotal: 1000,
  fchEmis: "2026-11-06",
  rutEmisor: "77777777-7",
  rutRecep: "78416626-0",
};
const ident = {
  rutResponde: dte.rutRecep,
  rutRecibe: dte.rutEmisor,
  tmstFirma: "2026-11-06T12:00:00",
};
Deno.test("API histórica: tipos públicos siguen siendo numéricos", () => {
  const resultado: ResultadoDteItem = { ...dte, codEnvio: 1 };
  const recibo: ReciboItem = { ...dte };
  const folio: number = resultado.folio;
  const monto: number = recibo.mntTotal;
  const codigo: number | undefined = resultado.codEnvio;
  assertEquals([folio, monto, codigo], [1, 1000, 1]);
});
Deno.test("Parser histórico: conserva metadata parcial y valores por omisión", () => {
  const r = parseInboundEnvioDte("<EnvioDTE/>");
  assertEquals(r.setId, null);
  assertEquals(r.digest, null);
  assertEquals(r.dtes, []);
  assertEquals(r.nmbEnvio, "EnvioDTE.xml");
  assertEquals(r.rutEmisor, "");
});
Deno.test("Recepción histórica: metadata opcional, truncamiento y conteos originales", () => {
  const result = buildRespuestaRecepcionEnvio(
    {
      setId: null,
      digest: null,
      nmbEnvio: "x".repeat(35),
      rutEmisor: dte.rutEmisor,
      rutEnvia: "22222222-2",
      rutReceptor: dte.rutRecep,
      dtes: [dte, { ...dte, folio: 2 }],
    },
    { ...ident, nmbContacto: "n".repeat(41), mailContacto: "" },
    pfx,
    "pass",
    { resultadoId: "RespuestaÑ" },
  );
  assertStringIncludes(result.xml, '<Resultado ID="RespuestaÑ">');
  assertStringIncludes(result.xml, "<EnvioDTEID>SetDoc</EnvioDTEID>");
  assertStringIncludes(
    result.xml,
    "<NmbEnvio>" + "x".repeat(30) + "</NmbEnvio>",
  );
  assertStringIncludes(
    result.xml,
    "<NmbContacto>" + "n".repeat(40) + "</NmbContacto>",
  );
  // Se conserva el comportamiento histórico; la ampliación calcula conteos propios.
  assertStringIncludes(result.xml, "<NroDetalles>2</NroDetalles>");
  assert(!result.xml.includes("<Digest>"));
  assert(!result.xml.includes("<MailContacto>"));
  assert(!result.xml.includes("<NroDTE>"));
});
Deno.test("Builders históricos: no incorporan restricciones nuevas de tipo ni RutFirma", () => {
  // Serializar no acredita conformidad XSD ni aceptación SII del documento 43.
  assertStringIncludes(
    buildRespuestaResultadoDte([{ ...dte, tipoDte: 43 }], ident, pfx, "pass")
      .xml,
    "<TipoDTE>43</TipoDTE>",
  );
  assertStringIncludes(
    buildEnvioRecibos([dte], ident, pfx, "pass").xml,
    "<RutFirma>" + ident.rutResponde + "</RutFirma>",
  );
  assertStringIncludes(
    buildEnvioRecibos([dte], ident, pfx, "pass", { rutFirma: "11111111-1" })
      .xml,
    "<RutFirma>11111111-1</RutFirma>",
  );
});
Deno.test("Autenticación histórica: conserva excepciones originales", async () => {
  const expected = new Error("fallo sintético de transporte");
  const actual = await assertRejects(() =>
    getLegacyToken("cert", pfx, "pass", {
      fetchFn: () => Promise.reject(expected),
    })
  );
  assert(actual === expected);
  const certError = await assertRejects(
    () =>
      getLegacyToken("cert", pfx, "incorrecta", {
        fetchFn: () =>
          Promise.resolve(
            new Response(
              "<getSeedReturn>&lt;R&gt;&lt;SEMILLA&gt;123&lt;/SEMILLA&gt;&lt;/R&gt;</getSeedReturn>",
            ),
          ),
      }),
    Pkcs12ExtractError,
  );
  assertEquals(certError.code, "wrong_password");
});
