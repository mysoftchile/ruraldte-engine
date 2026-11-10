// SPDX-License-Identifier: Apache-2.0

import { extractPemFromPkcs12 } from "./pkcs12.ts";

/** Exportación inmediata del portal RCV productivo; no consulta descargas diferidas. */
export type RcvCsvInput = {
  empresaRut: string;
  periodo: string;
  operacion: "COMPRA" | "VENTA";
  exportacion: "resumen" | "detalle";
  autenticacion:
    | { tipo: "clave"; rut: string; clave: string }
    | { tipo: "certificado"; pfxPassword: string };
  pfx?: Uint8Array;
};
export type RcvCsvResult = { sinDatos: true } | {
  sinDatos: false;
  bytes: Uint8Array;
  nombreArchivo: string;
  contentType: string;
};
type Client = { close(): void };
export type RcvCsvOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Transporte inyectable para pruebas sin red ni TLS real. */
  fetchFn?: (
    url: string,
    init: RequestInit & { client?: Client },
  ) => Promise<Response>;
  createClient?: (tls: { cert?: string; key?: string }) => Client;
};
export class RcvCsvError extends Error {
  constructor(
    public readonly code:
      | "SII_OPERATION_FAILED"
      | "SII_TIMEOUT"
      | "SII_RCV_DEFERRED_REQUIRED"
      | "SII_SESSION_CLOSE_FAILED",
  ) {
    super(code);
    this.name = "RcvCsvError";
  }
}

const PORTAL = "https://www4.sii.cl";
const PAGE = `${PORTAL}/consdcvinternetui/`;
const AUTH = "https://zeusr.sii.cl";
const FACADE = `${PAGE}services/data/facadeService/`;
const NS = "cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/";
const HOSTS = new Set([
  "www4.sii.cl",
  "zeusr.sii.cl",
  "herculesr.sii.cl",
  "misiir.sii.cl",
]);
const MAX_BYTES = 32 * 1024 * 1024;
const fail = () => new RcvCsvError("SII_OPERATION_FAILED");
function rutParts(value: string): [string, string] {
  const match = /^([0-9]{1,8})-([0-9Kk])$/.exec(value);
  if (!match) throw fail();
  return [match[1], match[2].toUpperCase()];
}

// Un jar por operación: no se comparten usuarios ni se envían cookies fuera de su dominio/ruta.
function cookieJar() {
  const entries = new Map<
    string,
    {
      name: string;
      value: string;
      domain: string;
      path: string;
      hostOnly: boolean;
      expires: number;
    }
  >();
  return {
    clear: () => entries.clear(),
    receive(url: URL, headers: Headers) {
      for (const line of headers.getSetCookie()) {
        const [pair, ...attributes] = line.split(";");
        const eq = pair.indexOf("=");
        if (eq < 1) continue;
        const item = {
          name: pair.slice(0, eq).trim(),
          value: pair.slice(eq + 1).trim(),
          domain: url.hostname,
          path: url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) || "/",
          hostOnly: true,
          expires: Infinity,
        };
        let maxAge: number | undefined;
        for (const attr of attributes) {
          const [name, ...parts] = attr.trim().split("=");
          const value = parts.join("=");
          if (name.toLowerCase() === "domain") {
            item.domain = value.toLowerCase().replace(/^\./, "");
            item.hostOnly = false;
          }
          if (name.toLowerCase() === "path" && value.startsWith("/")) {
            item.path = value;
          }
          if (name.toLowerCase() === "max-age" && /^-?\d+$/.test(value)) {
            maxAge = Number(value);
          }
          if (
            name.toLowerCase() === "expires" &&
            Number.isFinite(Date.parse(value))
          ) item.expires = Date.parse(value);
        }
        if (maxAge !== undefined) item.expires = Date.now() + maxAge * 1000;
        if (item.domain !== "sii.cl" && !item.domain.endsWith(".sii.cl")) {
          continue;
        }
        if (
          url.hostname !== item.domain &&
          !url.hostname.endsWith("." + item.domain)
        ) continue;
        entries.set(`${item.domain}|${item.path}|${item.name}`, item);
      }
    },
    header(url: URL) {
      return [...entries.values()].filter((c) =>
        c.expires > Date.now() &&
        (url.hostname === c.domain ||
          !c.hostOnly && url.hostname.endsWith("." + c.domain)) &&
        (url.pathname === c.path ||
          url.pathname.startsWith(c.path.endsWith("/") ? c.path : c.path + "/"))
      )
        .sort((a, b) => b.path.length - a.path.length).map((c) =>
          `${c.name}=${c.value}`
        ).join("; ");
    },
    token() {
      const header = this.header(new URL(PAGE));
      return /(?:^|; )TOKEN=([^;]+)/.exec(header)?.[1] ??
        /(?:^|; )CSESSIONID=([^;]+)/.exec(header)?.[1];
    },
  };
}

async function limitedBytes(response: Response): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) throw fail();
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_BYTES) throw fail();
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function csvResult(bytes: Uint8Array, headers: Headers): RcvCsvResult {
  const contentType = headers.get("content-type") ?? "";
  if (
    /^(?:text\/csv|application\/(?:csv|octet-stream))(?:;|$)/i.test(contentType)
  ) {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      throw new RcvCsvError("SII_RCV_DEFERRED_REQUIRED");
    }
    if (!bytes.length) throw fail();
    const disposition = headers.get("content-disposition") ?? "";
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const name = encoded
      ? decodeURIComponent(encoded)
      : /filename="([^"]+)"|filename=([^;]+)/i.exec(disposition)?.slice(1).find(
        Boolean,
      );
    if (!name) throw fail();
    return { sinDatos: false, bytes, nombreArchivo: name, contentType };
  }
  if (!/^application\/json(?:;|$)/i.test(contentType)) throw fail();
  const result = JSON.parse(new TextDecoder().decode(bytes));
  const code = result?.respEstado?.codRespuesta;
  if (
    code === 1 || result?.descargaDiferida === true || result?.caId != null ||
    result?.caIdBLOB != null
  ) {
    throw new RcvCsvError("SII_RCV_DEFERRED_REQUIRED");
  }
  const lines = result?.data;
  if (
    (code === 3 || code === 99) &&
    (lines == null || Array.isArray(lines) && lines.length === 0)
  ) return { sinDatos: true };
  if (
    code !== 0 || !Array.isArray(lines) || !lines.length ||
    !lines.every((line) => typeof line === "string") ||
    typeof result.nombreArchivo !== "string" || !result.nombreArchivo
  ) throw fail();
  // El portal agrega LF después de cada línea y descarga UTF-8, sin BOM añadido.
  return {
    sinDatos: false,
    bytes: new TextEncoder().encode(lines.join("\n") + "\n"),
    nombreArchivo: result.nombreArchivo,
    contentType: "text/csv; charset=UTF-8",
  };
}

export async function exportRcvCsv(
  input: RcvCsvInput,
  options: RcvCsvOptions = {},
): Promise<RcvCsvResult> {
  const [rutEmisor, dvEmisor] = rutParts(input.empresaRut);
  if (
    !/^\d{4}(0[1-9]|1[0-2])$/.test(input.periodo) ||
    !["COMPRA", "VENTA"].includes(input.operacion) ||
    !["resumen", "detalle"].includes(input.exportacion)
  ) throw fail();
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw fail();
  }
  const jar = cookieJar();
  const deadline = AbortSignal.timeout(timeout);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline])
    : deadline;
  let client: Client | undefined;
  let authAttempted = false;
  let failure: unknown;
  let output: RcvCsvResult | undefined;
  const fetchFn = options.fetchFn ??
    ((url, init) =>
      fetch(url, init as RequestInit & { client?: Deno.HttpClient }));
  async function request(
    urlString: string,
    init: RequestInit = {},
    cleanup = false,
    follow = true,
  ): Promise<{ bytes: Uint8Array; headers: Headers; status: number }> {
    let url = new URL(urlString);
    let current = init;
    const callSignal = cleanup ? AbortSignal.timeout(5_000) : signal;
    for (let hop = 0; hop < 6; hop++) {
      if (
        url.protocol !== "https:" || !HOSTS.has(url.hostname) || url.port ||
        url.username || url.password
      ) throw fail();
      const headers = new Headers(current.headers);
      headers.set("user-agent", "Mozilla/5.0");
      const cookies = jar.header(url);
      if (cookies && !headers.has("cookie")) headers.set("cookie", cookies);
      callSignal.throwIfAborted();
      const response = await fetchFn(url.href, {
        ...current,
        headers,
        redirect: "manual",
        signal: callSignal,
        client,
      });
      jar.receive(url, response.headers);
      const bytes = await limitedBytes(response);
      if (response.status >= 300 && response.status < 400 && follow) {
        const location = response.headers.get("location");
        if (!location) throw fail();
        // No reenviar contraseñas ni PFX en redirects 307/308.
        if (
          current.body != null &&
          (response.status === 307 || response.status === 308)
        ) throw fail();
        url = new URL(location, url);
        current = {};
        continue;
      }
      if (response.status < 200 || response.status >= (follow ? 300 : 400)) {
        throw fail();
      }
      return { bytes, headers: response.headers, status: response.status };
    }
    throw fail();
  }
  async function json(url: string, data: unknown) {
    return await request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: PORTAL,
        referer: PAGE,
      },
      body: JSON.stringify(data),
    });
  }
  function envelope(method: string, data: unknown) {
    return {
      metaData: {
        namespace: NS + method,
        conversationId: jar.token(),
        transactionId: crypto.randomUUID(),
        page: null,
      },
      data,
    };
  }
  try {
    const auth = input.autenticacion;
    let tls: { cert?: string; key?: string } = {};
    if (auth.tipo === "certificado") {
      if (!input.pfx?.length) throw fail();
      const pem = extractPemFromPkcs12(input.pfx, auth.pfxPassword);
      tls = { cert: pem.certPem, key: pem.pkeyPem };
    } else if (
      auth.tipo !== "clave" || !auth.clave || input.pfx !== undefined
    ) throw fail();
    client = options.createClient
      ? options.createClient(tls)
      : Deno.createHttpClient(
        tls.cert && tls.key ? { cert: tls.cert, key: tls.key } : {},
      );
    let authUrl: string;
    const fields = new URLSearchParams({ referencia: PAGE });
    if (auth.tipo === "clave") {
      const [rut, dv] = rutParts(auth.rut);
      await request(
        `${AUTH}/AUT2000/InicioAutenticacion/IngresoRutClave.html?${PAGE}`,
      );
      authUrl = `${AUTH}/cgi_AUT2000/CAutInicio.cgi`;
      fields.set("rut", rut);
      fields.set("dv", dv);
      fields.set(
        "rutcntr",
        `${rut.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}-${dv}`,
      );
      fields.set("411", "");
      fields.set("clave", auth.clave);
    } else {
      await request(
        `${AUTH}/AUT2000/InicioAutenticacion/IngresoCertificado.html?${PAGE}`,
      );
      authUrl = `https://herculesr.sii.cl/cgi_AUT2000/CAutInicio.cgi?${PAGE}`;
    }
    authAttempted = true;
    await request(authUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: new URL(authUrl).origin,
        referer: `${AUTH}/AUT2000/InicioAutenticacion/`,
      },
      body: fields.toString(),
    });
    await request(PAGE);
    if (!jar.token()) throw fail();
    await json(
      `${PORTAL}/common-1.0/services/autConfDataService/obtieneConf`,
      {},
    );
    await request(`${PORTAL}/common-1.0/services/aaSessionService/load`);
    await request(`${AUTH}/cgi_AUT2000/AutTknData.cgi?callback=rcv`);
    const initial = await json(
      FACADE + "getDatosInicio",
      envelope("getDatosInicio", {}),
    );
    if (
      JSON.parse(new TextDecoder().decode(initial.bytes))?.respEstado
        ?.codRespuesta !== 0
    ) throw fail();
    const method = input.exportacion === "resumen"
      ? "getResumenExport"
      : input.operacion === "COMPRA"
      ? "getDetalleCompraExport"
      : "getDetalleVentaExport";
    const data = {
      rutEmisor,
      dvEmisor,
      ptributario: input.periodo,
      estadoContab:
        input.operacion === "VENTA" && input.exportacion === "detalle"
          ? ""
          : "REGISTRO",
      operacion: input.operacion,
      ...(input.exportacion === "detalle" ? { codTipoDoc: 0 } : {}),
    };
    const response = await json(FACADE + method, envelope(method, data));
    output = csvResult(response.bytes, response.headers);
  } catch (error) {
    failure = error instanceof RcvCsvError ? error : new RcvCsvError(
      deadline.aborted && !options.signal?.aborted
        ? "SII_TIMEOUT"
        : "SII_OPERATION_FAILED",
    );
  } finally {
    try {
      if (authAttempted) {
        const previousCookies = jar.header(
          new URL("https://misiir.sii.cl/cgi_misii/siihome.cgi"),
        );
        await request(`${AUTH}/cgi_AUT2000/autTermino.cgi`, {}, true, false);
        // Un 200 en logout no prueba revocación: comprobar con las cookies previas.
        const check = await request(
          "https://misiir.sii.cl/cgi_misii/siihome.cgi",
          { headers: { cookie: previousCookies } },
          true,
          false,
        );
        const location = check.headers.get("location") ?? "";
        const body = new TextDecoder().decode(check.bytes);
        if (
          !/InicioAutenticacion|IngresoRutClave|CAutInicio/.test(
            location + body,
          )
        ) failure ??= new RcvCsvError("SII_SESSION_CLOSE_FAILED");
      }
    } catch {
      failure ??= new RcvCsvError("SII_SESSION_CLOSE_FAILED");
    } finally {
      jar.clear();
      try {
        client?.close();
      } catch {
        failure ??= new RcvCsvError("SII_SESSION_CLOSE_FAILED");
      }
    }
  }
  if (failure) throw failure;
  if (!output) throw fail();
  return output;
}
