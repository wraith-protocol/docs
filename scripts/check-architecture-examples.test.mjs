import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import {
  getArchitectureTypeErrors,
  inspectArchitectureFixtures,
} from "./check-architecture-examples.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("architecture fixtures stay linked to and in sync with their source pages", async () => {
  const { failures, fixtureFiles } = await inspectArchitectureFixtures(repoRoot);

  assert.deepEqual(failures, []);
  assert.equal(fixtureFiles.length, 3);
});

test("complete architecture examples type-check against the installed SDK declarations", () => {
  assert.deepEqual(getArchitectureTypeErrors(repoRoot), []);
});

test("the compiler rejects unexported SDK symbols and stale announcement fields", async () => {
  const configPath = path.join(repoRoot, "scripts", "fixtures", "architecture", "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const probePath = path.join(
    repoRoot,
    "scripts",
    "fixtures",
    "architecture",
    `.regression-probe-${randomUUID()}.ts`,
  );
  const source = [
    'import { notExported } from "@wraith-protocol/sdk";',
    'import type { Announcement } from "@wraith-protocol/sdk/chains/evm";',
    "declare const announcement: Announcement;",
    "announcement.viewTag;",
    "void notExported;",
  ].join("\n");

  await writeFile(probePath, source, "utf8");
  try {
    const program = ts.createProgram([probePath], parsed.options);
    const diagnosticCodes = ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code);

    assert.ok(diagnosticCodes.includes(2305), "expected an error for an unexported SDK symbol");
    assert.ok(diagnosticCodes.includes(2339), "expected an error for a stale Announcement field");
  } finally {
    await rm(probePath, { force: true });
  }
});
