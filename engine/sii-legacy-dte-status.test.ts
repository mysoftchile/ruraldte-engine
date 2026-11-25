// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

import assert from "node:assert/strict";
import { getLegacyDteStatus } from "./sii-legacy-upload.ts";

const input = {
  rutConsultante: "11111111-1",
  rutEmisor: "22222222-2",
  rutReceptor: "33333333-K",
  tipoDte: 33,
  folio: 123,
  fechaEmision: "2026-04-09",
  montoTotal: 11900,
  token: "sintetico<&",
};

function wrap(xml: string): Response {
  const escaped = xml.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return new Response(
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
      "<soap:Body><getEstDteResponse><getEstDteReturn>" + escaped +
      "</getEstDteReturn></getEstDteResponse></soap:Body></soap:Envelope>",
  );
}

Deno.test("QueryEstDte envía los parámetros SOAP y conserva el resultado individual", async () => {
  for (
    const [env, host] of [["cert", "maullin"], ["prod", "palena"]] as const
  ) {
    const url = `https://${host}.sii.cl/DTEWS/QueryEstDte.jws`;
    const result = await getLegacyDteStatus(env, {
      ...input,
      fetchFn: (resource, request) => {
        assert.equal(resource, url);
        assert.equal(request?.method, "POST");
        assert.equal(new Headers(request?.headers).get("soapaction"), "");
        assert.ok(String(request?.body).includes(`<m:getEstDte xmlns:m="${url}"`));
        const fields = [
          ["RutConsultante", "11111111"],
          ["DvConsultante", "1"],
          ["RutCompania", "22222222"],
          ["DvCompania", "2"],
          ["RutReceptor", "33333333"],
          ["DvReceptor", "K"],
          ["TipoDte", "33"],
          ["FolioDte", "123"],
          ["FechaEmisionDte", "09042026"],
          ["MontoDte", "11900"],
          ["Token", "sintetico&lt;&amp;"],
        ].map(([name, value]) => `<${name} xsi:type="xsd:string">${value}</${name}>`).join("");
        assert.ok(String(request?.body).includes(fields));
        return Promise.resolve(wrap(
          '<SII:RESPUESTA xmlns:SII="http://www.sii.cl/XMLSchema"><SII:RESP_HDR>' +
            "<ESTADO>DNK</ESTADO><GLOSA_ESTADO>Recibido &amp; revisado</GLOSA_ESTADO>" +
            "<ERR_CODE>001</ERR_CODE><GLOSA_ERR>Datos distintos</GLOSA_ERR>" +
            "<NUM_ATENCION>42</NUM_ATENCION></SII:RESP_HDR></SII:RESPUESTA>",
        ));
      },
    });
    assert.deepEqual(result, {
      estado: "DNK",
      glosa: "Recibido & revisado",
      codigoError: "001",
      glosaError: "Datos distintos",
      numeroAtencion: "42",
    });
  }
});

Deno.test("QueryEstDte distingue un estado nuevo de fallos HTTP, SOAP y de sesión", async () => {
  const xml = (estado: string) =>
    `<RESPUESTA><RESP_HDR><ESTADO>${estado}</ESTADO></RESP_HDR></RESPUESTA>`;
  const fetchStatus = (estado: string) => () => Promise.resolve(wrap(xml(estado)));
  for (const estado of ["DOK", "FAU", "NUE"]) {
    const result = await getLegacyDteStatus("cert", {
      ...input,
      fetchFn: fetchStatus(estado),
    });
    assert.equal(result.estado, estado);
  }
  for (
    const response of [
      new Response("fallo HTTP", { status: 500 }),
      new Response(
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
          "<soap:Body><soap:Fault/></soap:Body></soap:Envelope>",
      ),
      wrap(xml("002")),
      wrap("<RESPUESTA>"),
      wrap("<RESPUESTA/>"),
      wrap("<!DOCTYPE RESPUESTA><RESPUESTA/>"),
    ]
  ) {
    await assert.rejects(
      () =>
        getLegacyDteStatus("cert", {
          ...input,
          fetchFn: () => Promise.resolve(response),
        }),
      Error,
    );
  }
});
