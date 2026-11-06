// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/** Ampliación optativa de ./intercambio; no sustituye su API histórica.
 * XML de intercambio: solo construye y firma, sin enviar ni registrar eventos SII.
 * Antes de otorgar recibos verifica el envío y cada DTE con verifyInboundEnvio y XSD.
 * Conserva los bytes ISO-8859-1 retornados: no reformatear después de firmar.
 * Los defaults históricos de aceptación no deciden por el contribuyente: indica estados explícitos.
 * @module
 */
import { encodeLatin1, signSiiXml } from "./xml-signature.ts";
import { extractPemFromPkcs12 } from "./pkcs12.ts";
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
const SII_NS = "http://www.sii.cl/SiiDte";
const DS = "http://www.w3.org/2000/09/xmldsig#";
const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";
const DECLARACION_LEY_19983 =
  "El acuse de recibo que se declara en este acto, de acuerdo a lo dispuesto en la " +
  "letra b) del Art. 4, y la letra c) del Art. 5 de la Ley 19.983, acredita que la " +
  "entrega de mercaderias o servicio(s) prestado(s) ha(n) sido recibido(s).";
const ENV_GLOSAS: Record<string, string> = {
  "0": "Envio Recibido Conforme",
  "1": "Envio Rechazado - Error de Schema",
  "2": "Envio Rechazado - Error de Firma",
  "3": "Envio Rechazado - RUT Receptor No Corresponde",
  "90": "Envio Rechazado - Archivo Repetido",
  "91": "Envio Rechazado - Archivo Ilegible",
  "99": "Envio Rechazado - Otros",
};
const DTE_GLOSAS: Record<string, string> = {
  "0": "DTE Recibido OK",
  "1": "DTE No Recibido - Error de Firma",
  "2": "DTE No Recibido - Error en RUT Emisor",
  "3": "DTE No Recibido - Error en RUT Receptor",
  "4": "DTE No Recibido - DTE Repetido",
  "99": "DTE No Recibido - Otros",
};
const RESULT_GLOSAS: Record<string, string> = {
  "0": "DTE Aceptado OK",
  "1": "DTE Aceptado con Discrepancias",
  "2": "DTE Rechazado",
};

export type InboundDte = {
  tipoDte: number;
  folio: number;
  fchEmis: string;
  rutEmisor: string;
  rutRecep: string;
  mntTotal: number;
};
export type IntercambioDte = Omit<InboundDte, "folio" | "mntTotal"> & {
  folio: string | number;
  mntTotal: string | number;
};
export type InboundDteLossless = Omit<InboundDte, "folio" | "mntTotal"> & {
  folio: string;
  mntTotal: string;
};
export type InboundEnvio = {
  setId: string | null;
  nmbEnvio: string;
  rutEmisor: string;
  rutEnvia: string;
  rutReceptor: string;
  digest: string | null;
  dtes: InboundDte[];
};
export type InboundEnvioLossless = Omit<InboundEnvio, "dtes"> & {
  dtes: InboundDteLossless[];
};
export type IntercambioEnvio = Omit<InboundEnvio, "dtes"> & {
  dtes: IntercambioDte[];
};
export type ResponderIdent = {
  rutResponde: string;
  rutRecibe: string;
  nmbContacto?: string;
  fonoContacto?: string;
  mailContacto?: string;
  tmstFirma: string;
};
export type BuildResult = { xml: string; bytes: Uint8Array };
export type RecepcionDteDecision = { estado: string; glosa?: string };
export type RecepcionEnvioOpts = {
  resultadoId?: string;
  idRespuesta?: string | number;
  estadoRecepEnv?: string;
  recepEnvGlosa?: string;
  estadoRecepDte?: string;
  fchRecep?: string;
  codEnvio?: number | string;
  detalles?: RecepcionDteDecision[];
};
export type RecepcionEnvioItem = {
  inbound: IntercambioEnvio;
  opts?: Omit<RecepcionEnvioOpts, "resultadoId" | "idRespuesta">;
};
export type ResultadoDteItem = IntercambioDte & {
  estado?: string;
  glosa?: string;
  codEnvio?: number | string;
  codRchDsc?: number;
};
export type ReciboItem = IntercambioDte & {
  recinto?: string;
  reciboId?: string;
  tmstFirma?: string;
};

function text(value: string, max: number, name: string): string {
  if (!value || value.length > max) throw new Error(name + ": largo inválido");
  encodeLatin1(xmlText(value));
  return value;
}
function id(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value)) throw new Error("ID inválido");
  return value;
}
function rut(value: string): string {
  const p = rutParts(value, false);
  return p.rut + "-" + p.dv;
}
function date(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value + "T00:00:00Z")) ||
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
  ) throw new Error("Fecha inválida");
  return value;
}
function timestamp(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)?$/
      .test(value)
  ) throw new Error("Timestamp inválido");
  date(value.slice(0, 10));
  return value;
}
function count(n: number, max = 1000) {
  if (n < 1 || n > max) throw new Error("Cardinalidad inválida");
}
function el(name: string, value: string | number): string {
  return "<" + name + ">" + xmlText(value) + "</" + name + ">";
}
function state(value: string, glosas: Record<string, string>): string {
  if (!Object.hasOwn(glosas, value)) throw new Error("Estado inválido");
  return value;
}
function dteFields(d: IntercambioDte, tag: string): string {
  // Los XSD publicados excluyen 43 aunque el instructivo de recibos lo menciona.
  if (![33, 34, 46, 52, 56, 61].includes(d.tipoDte)) {
    throw new Error(
      "Tipo DTE sin respaldo XSD de intercambio (43: discrepancia oficial)",
    );
  }
  return el(tag, d.tipoDte) + el("Folio", decimal(d.folio, 10)) +
    el("FchEmis", date(d.fchEmis)) + el("RUTEmisor", rut(d.rutEmisor)) +
    el("RUTRecep", rut(d.rutRecep)) +
    el("MntTotal", decimal(d.mntTotal, 18, false));
}
function contact(ident: ResponderIdent): string {
  return (ident.nmbContacto !== undefined
    ? el("NmbContacto", text(ident.nmbContacto, 40, "NmbContacto"))
    : "") +
    (ident.fonoContacto !== undefined
      ? el("FonoContacto", text(ident.fonoContacto, 40, "FonoContacto"))
      : "") +
    (ident.mailContacto !== undefined
      ? el("MailContacto", text(ident.mailContacto, 80, "MailContacto"))
      : "");
}
function identities(ident: ResponderIdent): string {
  return el("RutResponde", rut(ident.rutResponde)) +
    el("RutRecibe", rut(ident.rutRecibe));
}
function checkParties(d: IntercambioDte, ident: ResponderIdent) {
  if (
    rut(d.rutEmisor) !== rut(ident.rutRecibe) ||
    rut(d.rutRecep) !== rut(ident.rutResponde)
  ) throw new Error("DTE no corresponde a las partes de la respuesta");
}
function caratula(
  ident: ResponderIdent,
  respuesta: string | number,
  n: number,
): string {
  return '<Caratula version="1.0">' + identities(ident) +
    el("IdRespuesta", decimal(respuesta, 10)) + el("NroDetalles", n) +
    contact(ident) + el("TmstFirmaResp", timestamp(ident.tmstFirma)) +
    "</Caratula>";
}
function sign(
  root: string,
  content: string,
  tag: string,
  elementId: string,
  schema: string,
  pfxBytes: Uint8Array,
  password: string,
): BuildResult {
  const unsigned = '<?xml version="1.0" encoding="ISO-8859-1"?>\r\n<' + root +
    ' xmlns="' + SII_NS + '" xmlns:xsi="' + XSI_NS + '" xsi:schemaLocation="' +
    SII_NS + " " + schema + '" version="1.0">\r\n' + content + "\r\n</" + root +
    ">";
  encodeLatin1(unsigned);
  const xml = signSiiXml({
    xml: unsigned,
    signedElementTag: tag,
    signedElementId: id(elementId),
    signedElementNs: SII_NS,
    pfxBytes,
    password,
  });
  return { xml, bytes: encodeLatin1(xml) };
}

/** Extrae datos sin coerción numérica. No comprueba XSD ni firmas. Rechaza datos ausentes/ambiguos. */
export function parseInboundEnvioDteLossless(
  xml: string,
  opts: { nmbEnvio?: string } = {},
): InboundEnvioLossless {
  const root = parseSafeXml(xml).documentElement;
  if (!root || root.namespaceURI !== SII_NS || root.localName !== "EnvioDTE") {
    throw new Error("No es EnvioDTE");
  }
  const set = child(root, SII_NS, "SetDTE"),
    car = child(set, SII_NS, "Caratula");
  const setId = id(set.getAttribute("ID") ?? "");
  const val = (p: XmlElement, name: string) =>
    scalar(child(p, SII_NS, name)).trim();
  const signatures = children(root, DS, "Signature");
  let digest: string | null = null;
  if (signatures.length > 1) throw new Error("Firma de envío ambigua");
  if (signatures.length) {
    const si = child(signatures[0], DS, "SignedInfo"),
      refs = children(si, DS, "Reference");
    if (refs.length !== 1 || refs[0].getAttribute("URI") !== "#" + setId) {
      throw new Error("Referencia de envío incorrecta");
    }
    digest = valDigest(refs[0]);
  }
  const dtes = children(set, SII_NS, "DTE").map((d) => {
    const enc = child(child(d, SII_NS, "Documento"), SII_NS, "Encabezado");
    const doc = child(enc, SII_NS, "IdDoc");
    const type = decimal(val(doc, "TipoDTE"), 3);
    return {
      tipoDte: Number(type),
      folio: decimal(val(doc, "Folio"), 10),
      fchEmis: date(val(doc, "FchEmis")),
      rutEmisor: rut(val(child(enc, SII_NS, "Emisor"), "RUTEmisor")),
      rutRecep: rut(val(child(enc, SII_NS, "Receptor"), "RUTRecep")),
      mntTotal: decimal(
        val(child(enc, SII_NS, "Totales"), "MntTotal"),
        18,
        false,
      ),
    };
  });
  if (!dtes.length) throw new Error("EnvioDTE sin documentos");
  return {
    setId,
    nmbEnvio: opts.nmbEnvio ?? "EnvioDTE.xml",
    rutEmisor: rut(val(car, "RutEmisor")),
    rutEnvia: rut(val(car, "RutEnvia")),
    rutReceptor: rut(val(car, "RutReceptor")),
    digest,
    dtes,
  };
}
function valDigest(ref: XmlElement): string {
  const digest = scalar(child(ref, DS, "DigestValue")).replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]{27}=$/.test(digest)) {
    throw new Error("Digest SHA1 inválido");
  }
  return digest;
}
/** Retorno histórico numérico; falla si el monto no es un entero seguro. */
export function parseInboundEnvioDte(
  xml: string,
  opts: { nmbEnvio?: string } = {},
): InboundEnvio {
  const data = parseInboundEnvioDteLossless(xml, opts);
  return {
    ...data,
    dtes: data.dtes.map((d) => {
      const monto = Number(d.mntTotal);
      if (!Number.isSafeInteger(monto)) {
        throw new Error("Monto inseguro: usa parseInboundEnvioDteLossless");
      }
      return { ...d, folio: Number(d.folio), mntTotal: monto };
    }),
  };
}

/** Respuesta técnica de un envío; no verifica automáticamente lo que se acusa. */
export function buildRespuestaRecepcionEnvio(
  inbound: IntercambioEnvio,
  ident: ResponderIdent,
  pfxBytes: Uint8Array,
  password: string,
  opts: RecepcionEnvioOpts = {},
): BuildResult {
  return buildRespuestaRecepcionesEnvio(
    [{ inbound, opts }],
    ident,
    pfxBytes,
    password,
    opts,
  );
}
/** Respuesta técnica de varios envíos del mismo emisor/receptor, hasta 1000. */
export function buildRespuestaRecepcionesEnvio(
  items: RecepcionEnvioItem[],
  ident: ResponderIdent,
  pfxBytes: Uint8Array,
  password: string,
  opts: { resultadoId?: string; idRespuesta?: string | number } = {},
): BuildResult {
  count(items.length);
  const resultadoId = id(opts.resultadoId ?? "Respuesta");
  const envios = items.map(({ inbound: input, opts: o = {} }) => {
    const estado = state(o.estadoRecepEnv ?? "0", ENV_GLOSAS);
    if (input.rutEmisor && rut(input.rutEmisor) !== rut(ident.rutRecibe)) {
      throw new Error("Emisor de envío no corresponde");
    }
    if (
      estado === "0" &&
      (!input.setId || !input.digest || !input.rutReceptor ||
        rut(input.rutReceptor) !== rut(ident.rutResponde))
    ) throw new Error("Recepción conforme sin metadata válida");
    if (
      input.dtes.length > 9999 ||
      (o.detalles && o.detalles.length !== input.dtes.length)
    ) throw new Error("Detalles de recepción inconsistentes");
    const detalles = input.dtes.map((d, i) => {
      const mismatch = input.rutReceptor &&
        rut(d.rutRecep) !== rut(input.rutReceptor);
      const s = state(
        mismatch ? "3" : o.detalles?.[i].estado ?? o.estadoRecepDte ?? "0",
        DTE_GLOSAS,
      );
      return "<RecepcionDTE>" + dteFields(d, "TipoDTE") +
        el("EstadoRecepDTE", s) +
        el(
          "RecepDTEGlosa",
          text(
            mismatch ? DTE_GLOSAS[s] : o.detalles?.[i].glosa ?? DTE_GLOSAS[s],
            256,
            "RecepDTEGlosa",
          ),
        ) + "</RecepcionDTE>";
    }).join("");
    if (input.digest && !/^[A-Za-z0-9+/]{27}=$/.test(input.digest)) {
      throw new Error("Digest SHA1 inválido");
    }
    return "<RecepcionEnvio>" +
      el("NmbEnvio", text(input.nmbEnvio, 80, "NmbEnvio")) +
      el("FchRecep", timestamp(o.fchRecep ?? ident.tmstFirma)) +
      el("CodEnvio", decimal(o.codEnvio ?? 1, 10)) +
      el(
        "EnvioDTEID",
        input.setId === null ? "" : text(input.setId, 80, "EnvioDTEID"),
      ) + (input.digest ? el("Digest", input.digest) : "") +
      (input.rutEmisor ? el("RutEmisor", rut(input.rutEmisor)) : "") +
      (input.rutReceptor ? el("RutReceptor", rut(input.rutReceptor)) : "") +
      el("EstadoRecepEnv", estado) +
      el(
        "RecepEnvGlosa",
        text(o.recepEnvGlosa ?? ENV_GLOSAS[estado], 256, "RecepEnvGlosa"),
      ) +
      (input.dtes.length ? el("NroDTE", input.dtes.length) : "") + detalles +
      "</RecepcionEnvio>";
  }).join("");
  return sign(
    "RespuestaDTE",
    '<Resultado ID="' + resultadoId + '">' +
      caratula(ident, opts.idRespuesta ?? 1, items.length) + envios +
      "</Resultado>",
    "Resultado",
    resultadoId,
    "RespuestaEnvioDTE_v10.xsd",
    pfxBytes,
    password,
  );
}

/** Resultado comercial explícito por DTE; el default histórico sigue siendo aceptación. */
export function buildRespuestaResultadoDte(
  dtes: ResultadoDteItem[],
  ident: ResponderIdent,
  pfxBytes: Uint8Array,
  password: string,
  opts: { resultadoId?: string; idRespuesta?: string | number } = {},
): BuildResult {
  count(dtes.length);
  const resultadoId = id(opts.resultadoId ?? "Respuesta");
  const detalles = dtes.map((d) => {
    checkParties(d, ident);
    const estado = state(d.estado ?? "0", RESULT_GLOSAS);
    if (
      d.codRchDsc !== undefined &&
      (!Number.isInteger(d.codRchDsc) || d.codRchDsc > -1 || d.codRchDsc < -999)
    ) throw new Error("CodRchDsc inválido");
    return "<ResultadoDTE>" + dteFields(d, "TipoDTE") +
      el("CodEnvio", decimal(d.codEnvio ?? 1, 10)) + el("EstadoDTE", estado) +
      el(
        "EstadoDTEGlosa",
        text(d.glosa ?? RESULT_GLOSAS[estado], 256, "EstadoDTEGlosa"),
      ) + (d.codRchDsc !== undefined ? el("CodRchDsc", d.codRchDsc) : "") +
      "</ResultadoDTE>";
  }).join("");
  return sign(
    "RespuestaDTE",
    '<Resultado ID="' + resultadoId + '">' +
      caratula(ident, opts.idRespuesta ?? 1, dtes.length) + detalles +
      "</Resultado>",
    "Resultado",
    resultadoId,
    "RespuestaEnvioDTE_v10.xsd",
    pfxBytes,
    password,
  );
}

/** Recibo Ley 19.983: firma cada DocumentoRecibo y después el SetRecibos. No registra ERM. */
export function buildEnvioRecibos(
  dtes: ReciboItem[],
  ident: ResponderIdent,
  pfxBytes: Uint8Array,
  password: string,
  opts: { setId?: string; rutFirma?: string; recinto?: string } = {},
): BuildResult {
  count(dtes.length, Number.MAX_SAFE_INTEGER);
  const setId = id(opts.setId ?? "SetRecibos");
  const { rutFromCert } = extractPemFromPkcs12(pfxBytes, password);
  if (
    !rutFromCert || (opts.rutFirma && rut(opts.rutFirma) !== rut(rutFromCert))
  ) throw new Error("RutFirma debe corresponder al certificado");
  const rutFirma = rut(rutFromCert), ids = new Set([setId]);
  const recibos = dtes.map((d, i) => {
    checkParties(d, ident);
    if (![33, 34, 46, 52].includes(d.tipoDte)) {
      throw new Error("Tipo de recibo no respaldado por instructivo y XSD");
    }
    const reciboId = id(d.reciboId ?? "R" + (i + 1));
    if (ids.has(reciboId)) throw new Error("ID de recibo duplicado");
    ids.add(reciboId);
    const contenido = '<DocumentoRecibo ID="' + reciboId + '">' +
      dteFields(d, "TipoDoc") +
      el(
        "Recinto",
        text(d.recinto ?? opts.recinto ?? "Casa Matriz", 80, "Recinto"),
      ) +
      el("RutFirma", rutFirma) + el("Declaracion", DECLARACION_LEY_19983) +
      el("TmstFirmaRecibo", timestamp(d.tmstFirma ?? ident.tmstFirma)) +
      "</DocumentoRecibo>";
    const signed = sign(
      "Recibo",
      contenido,
      "DocumentoRecibo",
      reciboId,
      "Recibos_v10.xsd",
      pfxBytes,
      password,
    ).xml;
    // El Recibo declara los mismos namespaces del contexto final y conserva su serialización.
    return signed.slice(signed.indexOf("<Recibo"));
  }).join("");
  const car = '<Caratula version="1.0">' + identities(ident) + contact(ident) +
    el("TmstFirmaEnv", timestamp(ident.tmstFirma)) + "</Caratula>";
  return sign(
    "EnvioRecibos",
    '<SetRecibos ID="' + setId + '">' + car + recibos + "</SetRecibos>",
    "SetRecibos",
    setId,
    "EnvioRecibos_v10.xsd",
    pfxBytes,
    password,
  );
}
