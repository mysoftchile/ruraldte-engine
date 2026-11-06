// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA
import { delimiter, dirname } from "node:path";
const executable = Deno.env.get("XMLLINT") ?? "xmllint";
const probe = await new Deno.Command(executable, {
  args: ["--version"],
  stdout: "null",
  stderr: "inherit",
}).output();
if (!probe.success) throw new Error("xmllint obligatorio");
const path = executable === "xmllint"
  ? (Deno.env.get("PATH") ?? "")
  : dirname(executable) + delimiter + (Deno.env.get("PATH") ?? "");
const result = await new Deno.Command(Deno.execPath(), {
  args: [
    "test",
    "-A",
    "engine/sii-reclamo.test.ts",
    "engine/intercambio.test.ts",
    "tests/intercambio/conformance.test.ts",
    "tests/intercambio/compatibilidad.test.ts",
    "engine/xml-signature.test.ts",
  ],
  env: { XMLLINT: executable, XSD_REQUIRED: "1", PATH: path },
  stdout: "inherit",
  stderr: "inherit",
}).output();
Deno.exit(result.code);
