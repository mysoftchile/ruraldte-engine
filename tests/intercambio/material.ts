// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA
import forge from "npm:node-forge@1.3.1";
export function material() {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024 });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date("2020-01-01");
  certificate.validity.notAfter = new Date("2035-01-01");
  const attrs = [{ name: "commonName", value: "SINTETICO" }, {
    name: "serialNumber",
    value: "22222222-2",
  }];
  certificate.setSubject(attrs);
  certificate.setIssuer(attrs);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const der = forge.asn1.toDer(
    forge.pkcs12.toPkcs12Asn1(keys.privateKey, [certificate], "pass", {
      algorithm: "3des",
    }),
  ).getBytes();
  return {
    pfx: Uint8Array.from(der as string, (c) => c.charCodeAt(0)),
    key: { privateKey: keys.privateKey, certificate },
  };
}
