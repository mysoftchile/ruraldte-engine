// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/** Registro oficial de aceptación/reclamo. Sin reintentos, persistencia ni decisiones del receptor.
 * Obtén token con getLegacyToken del mismo ambiente. HTTP 200 no implica acción completada.
 * Tras una escritura incierta consulta historial antes de decidir un nuevo envío.
 * @module
 */
import type { FetchFn } from "./sii-client.ts";
import { LEGACY_USER_AGENT, type LegacyEnv } from "./sii-legacy-upload.ts";
import { fetchSiiText, SiiTransportError } from "./sii-transport.ts";
import {
  child,
  children,
  decimal,
  parseSafeXml,
  rutParts,
  scalar,
  type XmlElement,
  xmlText,
} from "./xml-utils.ts";

export const REGISTRO_RECLAMO_NS =
  "http://ws.registroreclamodte.diii.sdi.sii.cl";
export const REGISTRO_RECLAMO_ENDPOINTS: Readonly<Record<LegacyEnv, string>> =
  Object.freeze({
    cert:
      "https://ws2.sii.cl/WSREGISTRORECLAMODTECERT/registroreclamodteservice",
    prod: "https://ws1.sii.cl/WSREGISTRORECLAMODTE/registroreclamodteservice",
  });
const SOAP = "http://schemas.xmlsoap.org/soap/envelope/";
const XSI = "http://www.w3.org/2001/XMLSchema-instance";
export type AccionReclamo = "ACD" | "ERM" | "RCD" | "RFP" | "RFT";
export type ReclamoDoc = {
  rutEmisor: string;
  tipoDoc: 33 | 34 | 43;
  folio: string;
};
export type ReclamoOptions = {
  token: string;
  fetchFn?: FetchFn;
  userAgent?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};
export type EventoReclamo = {
  codEvento?: string;
  descEvento?: string;
  rutResponsable?: string;
  dvResponsable?: string;
  fechaEvento?: string;
};
export type RespuestaReclamo = {
  codResp?: number;
  descResp?: string;
  listaEventosDoc?: (EventoReclamo | null)[];
  rutToken?: string;
};
export type ReclamoResponse<T> = {
  status: number;
  raw: string;
  data: T;
  parsing: "complete" | "partial";
  observations: string[];
};
export type RegistroReclamoMethod =
  | "ingresarAceptacionReclamoDoc"
  | "listarEventosHistDoc"
  | "consultarFechaRecepcionSii"
  | "consultarDocDteCedible"
  | "getVersion";
export class RegistroReclamoError extends Error {
  constructor(
    public readonly kind:
      | "http"
      | "soap-fault"
      | "invalid-response"
      | "network"
      | "timeout"
      | "aborted",
    public readonly operation: RegistroReclamoMethod,
    public readonly env: LegacyEnv,
    public readonly outcome: "uncertain" | "not-submitted" | "not-applicable",
    public readonly status?: number,
    public readonly fault?: {
      code?: string;
      message?: string;
      detail?: string;
    },
  ) {
    super("Registro reclamo: " + operation + " (" + kind + ")");
    this.name = "RegistroReclamoError";
  }
}
const CODES: Record<string, readonly number[]> = {
  ingresarAceptacionReclamoDoc: [
    -1,
    0,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    13,
    14,
    15,
    16,
    17,
    18,
    19,
  ],
  listarEventosHistDoc: [1, 2, 3, 8, 10, 14, 15, 16, 17, 18],
  consultarDocDteCedible: [1, 2, 10, 18, 20, 21, 22, 23, 24, 25],
};
const EVENT_CODES = ["ACD", "ERM", "RCD", "RFP", "RFT", "NCA", "ENC"];
function params(doc: ReclamoDoc): [string, string][] {
  const rut = rutParts(doc.rutEmisor);
  if (![33, 34, 43].includes(doc.tipoDoc)) {
    throw new RangeError("Servicio admite solo tipos 33, 34 y 43");
  }
  return [["rutEmisor", rut.rut], ["dvEmisor", rut.dv], [
    "tipoDoc",
    String(doc.tipoDoc),
  ], ["folio", decimal(doc.folio, 10)]];
}
function optionalText(el: XmlElement, name: string): string | undefined {
  const list = children(el, "", name);
  if (list.length > 1) throw new Error("Campo duplicado");
  return list.length ? scalar(list[0]) : undefined;
}
function parseObject(
  ret: XmlElement,
  method: RegistroReclamoMethod,
  observations: string[],
): RespuestaReclamo {
  const data: RespuestaReclamo = {};
  const cod = optionalText(ret, "codResp");
  if (cod !== undefined) {
    if (
      !/^[+-]?\d+$/.test(cod.trim()) || Number(cod) < -2147483648 ||
      Number(cod) > 2147483647
    ) throw new Error("codResp inválido");
    data.codResp = Number(cod);
    if (!CODES[method]?.includes(data.codResp)) {
      observations.push("codResp desconocido");
    }
  } else observations.push("Falta codResp");
  for (const k of ["descResp", "rutToken"] as const) {
    const value = optionalText(ret, k);
    if (value !== undefined) data[k] = value;
  }
  if (data.descResp === undefined) observations.push("Falta descResp");
  const items = children(ret, "", "listaEventosDoc");
  if (items.length) {
    data.listaEventosDoc = items.map((item) => {
      const nil = item.getAttributeNS(XSI, "nil");
      if (nil === "true" || nil === "1") {
        if (scalar(item).trim()) throw new Error("Evento nil con contenido");
        return null;
      }
      const event: EventoReclamo = {};
      const keys = [
        "codEvento",
        "descEvento",
        "rutResponsable",
        "dvResponsable",
        "fechaEvento",
      ] as const;
      for (const k of keys) {
        const value = optionalText(item, k);
        if (value !== undefined) event[k] = value;
        else observations.push("Evento sin " + k);
      }
      if (
        event.codEvento !== undefined && !EVENT_CODES.includes(event.codEvento)
      ) observations.push("codEvento desconocido");
      for (const n of Array.from(item.childNodes)) {
        if (
          n.nodeType === 1 && !keys.includes(n.localName as typeof keys[number])
        ) observations.push("Campo de evento desconocido");
      }
      return event;
    });
  }
  if (data.codResp === 15 && !items.length) {
    observations.push("Listado sin eventos");
  }
  for (const n of Array.from(ret.childNodes)) {
    if (
      n.nodeType === 1 &&
      (n.namespaceURI !== null && n.namespaceURI !== "" ||
        !["codResp", "descResp", "rutToken", "listaEventosDoc"].includes(
          n.localName ?? "",
        ))
    ) observations.push("Campo de respuesta desconocido");
  }
  return data;
}

async function call<T extends RespuestaReclamo | string>(
  method: RegistroReclamoMethod,
  env: LegacyEnv,
  input: ReclamoOptions,
  parts: [string, string][],
): Promise<ReclamoResponse<T>> {
  if (env !== "cert" && env !== "prod") {
    throw new RangeError("Ambiente inválido");
  }
  if (!input.token || /[;\s\r\n]/.test(input.token)) {
    throw new Error("Token inválido");
  }
  const writing = method === "ingresarAceptacionReclamoDoc";
  const redact = (s: string) =>
    s.replaceAll(input.token, "[REDACTADO]")
      .replace(
        /(<(?:[\w.-]+:)?(?:TOKEN|X509Certificate|RSASK)\b[^>]*>)[\s\S]*?(<\/(?:[\w.-]+:)?(?:TOKEN|X509Certificate|RSASK)>)/gi,
        "$1[REDACTADO]$2",
      )
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
        "[REDACTADO]",
      );
  const body = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="' + SOAP + '" xmlns:ws="' +
    REGISTRO_RECLAMO_NS + '"><soapenv:Body>' +
    "<ws:" + method + ">" +
    parts.map(([k, v]) => "<" + k + ">" + xmlText(v) + "</" + k + ">").join(
      "",
    ) +
    "</ws:" + method + "></soapenv:Body></soapenv:Envelope>";
  let sent = false, status: number | undefined;
  try {
    if (input.signal?.aborted) {
      throw new RegistroReclamoError(
        "aborted",
        method,
        env,
        writing ? "not-submitted" : "not-applicable",
      );
    }
    const response = await fetchSiiText(
      ((...args) => {
        sent = true;
        return (input.fetchFn ?? fetch)(...args);
      }) as FetchFn,
      REGISTRO_RECLAMO_ENDPOINTS[env],
      {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=UTF-8",
          SOAPAction: '""',
          Cookie: "TOKEN=" + input.token,
          "User-Agent": input.userAgent ?? LEGACY_USER_AGENT,
        },
        body,
      },
      input,
    );
    status = response.status;
    const raw = redact(response.raw);
    let envelope: XmlElement;
    try {
      // La redacción nunca debe convertir un XML malformado en una respuesta válida.
      parseSafeXml(response.raw);
      const root = parseSafeXml(raw).documentElement;
      if (!root) throw new Error("XML vacío");
      envelope = root;
    } catch {
      throw new RegistroReclamoError(
        status < 200 || status >= 300 ? "http" : "invalid-response",
        method,
        env,
        writing ? "uncertain" : "not-applicable",
        status,
      );
    }
    if (envelope.namespaceURI !== SOAP || envelope.localName !== "Envelope") {
      throw new Error("Envelope inválido");
    }
    const soapBody = child(envelope, SOAP, "Body");
    const faults = children(soapBody, SOAP, "Fault");
    if (faults.length) {
      if (faults.length !== 1) throw new Error("Fault ambiguo");
      const f = faults[0];
      const details = children(f, "", "detail");
      throw new RegistroReclamoError(
        "soap-fault",
        method,
        env,
        writing ? "uncertain" : "not-applicable",
        status,
        {
          code: optionalText(f, "faultcode"),
          message: optionalText(f, "faultstring"),
          detail: details.length === 1
            ? (details[0].textContent ?? "").slice(0, 2000)
            : undefined,
        },
      );
    }
    if (status < 200 || status >= 300) {
      throw new RegistroReclamoError(
        "http",
        method,
        env,
        writing ? "uncertain" : "not-applicable",
        status,
      );
    }
    const wrapper = child(soapBody, REGISTRO_RECLAMO_NS, method + "Response");
    if (
      Array.from(soapBody.childNodes).filter((n) => n.nodeType === 1).length !==
        1
    ) throw new Error("Body ambiguo");
    const ret = child(wrapper, "", "return");
    if (
      Array.from(wrapper.childNodes).filter((n) => n.nodeType === 1).length !==
        1 ||
      ["true", "1"].includes(ret.getAttributeNS(XSI, "nil") ?? "")
    ) throw new Error("Retorno inválido");
    const observations: string[] = [];
    const data =
      method === "getVersion" || method === "consultarFechaRecepcionSii"
        ? scalar(ret)
        : parseObject(ret, method, observations);
    if (typeof data === "string") {
      if (!data.trim()) observations.push("Retorno vacío");
      if (method === "consultarFechaRecepcionSii") {
        observations.push(
          "Fecha textual SII: sin zona ni formato garantizado por WSDL",
        );
      }
    }
    return {
      status,
      raw,
      data: data as T,
      parsing: observations.length ? "partial" : "complete",
      observations,
    };
  } catch (err) {
    if (err instanceof RegistroReclamoError) throw err;
    const kind = err instanceof SiiTransportError
      ? err.kind
      : status !== undefined && (status < 200 || status >= 300)
      ? "http"
      : "invalid-response";
    throw new RegistroReclamoError(
      kind,
      method,
      env,
      writing ? (sent ? "uncertain" : "not-submitted") : "not-applicable",
      status,
    );
  }
}

/** Registra exactamente la acción solicitada. No renueva token ni reintenta escrituras. */
export function ingresarAceptacionReclamoDoc(
  env: LegacyEnv,
  input: ReclamoDoc & ReclamoOptions & { accionDoc: AccionReclamo },
): Promise<ReclamoResponse<RespuestaReclamo>> {
  if (!["ACD", "ERM", "RCD", "RFP", "RFT"].includes(input.accionDoc)) {
    throw new RangeError("Acción inválida");
  }
  return call("ingresarAceptacionReclamoDoc", env, input, [...params(input), [
    "accionDoc",
    input.accionDoc,
  ]]);
}
/** Historial íntegro: ni ordena, ni deduplica, ni deriva un estado comercial. */
export function listarEventosHistDoc(
  env: LegacyEnv,
  input: ReclamoDoc & ReclamoOptions,
): Promise<ReclamoResponse<RespuestaReclamo>> {
  return call("listarEventosHistDoc", env, input, params(input));
}
/** Conserva la fecha textual, sin inventar zona horaria. */
export function consultarFechaRecepcionSii(
  env: LegacyEnv,
  input: ReclamoDoc & ReclamoOptions,
): Promise<ReclamoResponse<string>> {
  return call("consultarFechaRecepcionSii", env, input, params(input));
}
/** codResp 23/25 indican cedibilidad; HTTP 200 no basta. */
export function consultarDocDteCedible(
  env: LegacyEnv,
  input: ReclamoDoc & ReclamoOptions,
): Promise<ReclamoResponse<RespuestaReclamo>> {
  return call("consultarDocDteCedible", env, input, params(input));
}
/** Versión literal del servicio; no interpreta su formato. */
export function getVersion(
  env: LegacyEnv,
  input: ReclamoOptions,
): Promise<ReclamoResponse<string>> {
  return call("getVersion", env, input, []);
}
