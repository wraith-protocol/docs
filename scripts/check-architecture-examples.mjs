import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredPages = new Set(["overview.mdx", "chain-connectors.mdx", "tee.mdx"]);
const fixtureFence = /^\{\/\* architecture-fixture:([a-z0-9-]+) \*\/\}\r?\n```typescript\s*\r?\n([\s\S]*?)^```[ \t]*$/gm;
const allowedSdkEntryPoint = /^@wraith-protocol\/sdk(?:\/chains\/(?:evm|stellar|solana|ckb))?$/;

export async function inspectArchitectureFixtures(root = repoRoot) {
  const pagesDir = path.join(root, "architecture");
  const fixturesDir = path.join(root, "scripts", "fixtures", "architecture");
  const failures = [];
  const expectedFiles = new Map();
  const pages = (await readdir(pagesDir)).filter((file) => file.endsWith(".mdx")).sort();

  for (const page of pages) {
    const markdown = await readFile(path.join(pagesDir, page), "utf8");
    const pageFixtures = Array.from(markdown.matchAll(fixtureFence));

    if (requiredPages.has(page) && pageFixtures.length === 0) {
      failures.push(`architecture/${page}: missing a typed fixture fence.`);
    }

    for (const match of pageFixtures) {
      const [, name, rawCode] = match;
      const code = rawCode.replace(/\r\n/g, "\n").replace(/\n+$/, "");
      const fixtureName = `${name}.ts`;

      if (expectedFiles.has(fixtureName)) {
        failures.push(`architecture/${page}: duplicate fixture name '${name}'.`);
        continue;
      }

      const header = `// Source: ../../../architecture/${page}#public-sdk-fixture`;
      expectedFiles.set(fixtureName, `${header}\n\n${code}\n`);

      if (/\bdeclare\b|@ts-(?:no)?(?:check|ignore|expect-error)|\bno-check\b/.test(code)) {
        failures.push(`architecture/${page}: fixture '${name}' contains a bypass or ambient declaration.`);
      }

      const imports = Array.from(
        code.matchAll(/(?:\bfrom\s*|\bimport\s+|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/g),
      );
      for (const [, moduleName] of imports) {
        if (!allowedSdkEntryPoint.test(moduleName)) {
          failures.push(
            `architecture/${page}: fixture '${name}' imports '${moduleName}', which is not a documented SDK entry point.`,
          );
        }
      }
    }
  }

  const fixtureFiles = (await readdir(fixturesDir)).filter((file) => file.endsWith(".ts")).sort();
  for (const fixtureFile of fixtureFiles) {
    if (!expectedFiles.has(fixtureFile)) {
      failures.push(`scripts/fixtures/architecture/${fixtureFile}: no matching source fence.`);
    }
  }

  for (const [fixtureFile, expected] of expectedFiles) {
    if (!fixtureFiles.includes(fixtureFile)) {
      failures.push(`scripts/fixtures/architecture/${fixtureFile}: fixture is missing.`);
      continue;
    }

    const actual = (await readFile(path.join(fixturesDir, fixtureFile), "utf8")).replace(/\r\n/g, "\n");
    if (actual !== expected) {
      failures.push(
        `scripts/fixtures/architecture/${fixtureFile}: out of sync with its source fence in architecture/${fixtureFile.replace(/\.ts$/, ".mdx")}.`,
      );
    }
  }

  return { failures, fixtureFiles: fixtureFiles.map((file) => path.join(fixturesDir, file)) };
}

export function getArchitectureTypeErrors(root = repoRoot, fixtureFiles) {
  const configPath = path.join(root, "scripts", "fixtures", "architecture", "tsconfig.json");
  const configRead = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configRead.error) {
    return [ts.flattenDiagnosticMessageText(configRead.error.messageText, "\n")];
  }

  const config = ts.parseJsonConfigFileContent(configRead.config, ts.sys, path.dirname(configPath));
  const files = fixtureFiles ?? config.fileNames;
  const program = ts.createProgram(files, config.options);
  const diagnostics = ts.getPreEmitDiagnostics(program);

  return diagnostics.map((diagnostic) => {
    const location = diagnostic.file && diagnostic.start !== undefined
      ? `${path.relative(root, diagnostic.file.fileName)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}: `
      : "";
    return `${location}${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
  });
}

async function main() {
  const { failures, fixtureFiles } = await inspectArchitectureFixtures();
  failures.push(...getArchitectureTypeErrors(repoRoot, fixtureFiles));

  if (failures.length > 0) {
    console.error(`Architecture example checks failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Architecture examples passed (${fixtureFiles.length} strict SDK fixtures).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Architecture example checks failed:", error);
    process.exitCode = 1;
  });
}
