// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/** Utilidades internas para XML no confiable; no validan XSD ni firmas. */
import { DOMParser } from "npm:@xmldom/xmldom@0.9.10";
import type { Element } from "npm:@xmldom/xmldom@0.9.10";
export type XmlElement = Element;

function validXmlChar(n: number): boolean {
  return n === 9 || n === 10 || n === 13 || (n >= 0x20 && n <= 0xd7ff) ||
    (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff);
}

export function parseSafeXml(xml: string) {
  if ([...xml].some((c) => !validXmlChar(c.codePointAt(0)!))) {
    throw new Error("XML: carácter inválido");
  }
  // xmldom tolera un & aislado; no permitir que repare silenciosamente la entrada.
  const markup = xml.replace(
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g,
    "",
  );
  if (/&(?!(?:amp|lt|gt|apos|quot|#\d+|#x[\da-fA-F]+);)/.test(markup)) {
    throw new Error("XML: entidad inválida");
  }
  for (const match of markup.matchAll(/&#(x[\da-fA-F]+|\d+);/g)) {
    const n = match[1].startsWith("x")
      ? parseInt(match[1].slice(1), 16)
      : Number(match[1]);
    if (!validXmlChar(n)) {
      throw new Error("XML: referencia de carácter inválida");
    }
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error("XML: DTD/entidades no permitidas");
  }
  const doc = new DOMParser({
    onError: () => {
      throw new Error("XML malformado");
    },
  })
    .parseFromString(xml, "application/xml");
  if (!doc.documentElement) throw new Error("XML vacío");
  const ids = new Set<string>();
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    const id = el.getAttribute("ID");
    if (id !== null) {
      if (ids.has(id)) throw new Error("XML: ID duplicado");
      ids.add(id);
    }
  }
  return doc;
}

export function children(
  parent: XmlElement,
  ns: string,
  name: string,
): XmlElement[] {
  return Array.from(parent.childNodes).filter((n): n is XmlElement =>
    n.nodeType === 1 && (n.namespaceURI ?? "") === ns && n.localName === name
  );
}

export function child(
  parent: XmlElement,
  ns: string,
  name: string,
): XmlElement {
  const nodes = children(parent, ns, name);
  if (nodes.length !== 1) {
    throw new Error("XML: elemento ausente o ambiguo: " + name);
  }
  return nodes[0];
}

export function scalar(el: XmlElement): string {
  if (Array.from(el.childNodes).some((n) => n.nodeType === 1)) {
    throw new Error("XML: se esperaba texto");
  }
  return el.textContent ?? "";
}

export function xmlText(value: string | number): string {
  const s = String(value);
  if ([...s].some((c) => !validXmlChar(c.codePointAt(0)!))) {
    throw new Error("XML: carácter inválido");
  }
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function decimal(
  value: string | number,
  digits: number,
  positive = true,
): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("Entero inseguro");
  }
  const s = String(value);
  if (!/^\d+$/.test(s) || s.length > digits || (positive && BigInt(s) === 0n)) {
    throw new Error("Entero decimal fuera de rango");
  }
  return s;
}

/** La validez del DV se exige en el cliente SOAP; los XML preservan el RUT original. */
export function rutParts(
  value: string,
  checkDv = true,
): { rut: string; dv: string } {
  const m = /^(\d{4,8})-([0-9Kk])$/.exec(value);
  if (!m || Number(m[1]) < 1000) throw new Error("RUT inválido");
  const dv = m[2].toUpperCase();
  if (checkDv) {
    let sum = 0, factor = 2;
    for (const digit of [...m[1]].reverse()) {
      sum += Number(digit) * factor;
      factor = factor === 7 ? 2 : factor + 1;
    }
    const v = 11 - sum % 11;
    if (dv !== (v === 11 ? "0" : v === 10 ? "K" : String(v))) {
      throw new Error("DV inválido");
    }
  }
  return { rut: m[1], dv };
}
