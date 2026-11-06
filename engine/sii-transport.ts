// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

import type { FetchFn } from "./sii-client.ts";

/** Un solo intento; incluye lectura del cuerpo y nunca conserva errores del transporte con secretos. */
export async function fetchSiiText(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ status: number; raw: string }> {
  const ms = opts.timeoutMs ?? 30_000;
  if (!Number.isFinite(ms) || ms <= 0 || ms > 2_147_483_647) {
    throw new RangeError("timeoutMs inválido");
  }
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  opts.signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (opts.signal?.aborted) throw new SiiTransportError("aborted");
    const interrupted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new SiiTransportError(timedOut ? "timeout" : "aborted")),
        { once: true },
      );
    });
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
    const operation = (async () => {
      const res = await fetchFn(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      return { status: res.status, raw: await res.text() };
    })();
    return await Promise.race([operation, interrupted]);
  } catch (err) {
    if (err instanceof SiiTransportError) throw err;
    throw new SiiTransportError(
      controller.signal.aborted
        ? (timedOut ? "timeout" : "aborted")
        : "network",
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
  }
}

export class SiiTransportError extends Error {
  constructor(public readonly kind: "network" | "timeout" | "aborted") {
    super("Transporte SII: " + kind);
    this.name = "SiiTransportError";
  }
}
