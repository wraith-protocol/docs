import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  loadAllowlist,
  validateSnippetAllowlist,
  InventoryBypass,
} from "./snippet-allowlist.ts";

const repoRoot = process.cwd();
const allowlistPath = path.join(repoRoot, "scripts", "snippet-bypass-allowlist.json");

const ignoredDirs = new Set([
  ".git",
  ".github",
  "node_modules",
  ".next",
  "dist",
  "build",
]);

async function findMdxFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return ignoredDirs.has(entry.name) ? [] : findMdxFiles(fullPath);
      }
      if (entry.isFile() && entry.name.endsWith(".mdx")) {
        return [fullPath];
      }
      return [];
    }),
  );
  return results.flat().sort();
}

export async function collectAllBypasses(files: string[]): Promise<InventoryBypass[]> {
  const bypasses: InventoryBypass[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const lines = content.split(/\r?\n/);
    const relFile = path.relative(repoRoot, file).replace(/\\/g, "/");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Check for code fence with no-check marker
      if (line.startsWith("```") && /\bno-check\b/.test(line)) {
        bypasses.push({
          file: relFile,
          line: i + 1,
          rawFence: line,
        });
      }
    }
  }

  return bypasses;
}

async function main() {
  const files = await findMdxFiles(repoRoot);
  const actualBypasses = await collectAllBypasses(files);
  const allowlist = await loadAllowlist(allowlistPath);

  const failures = validateSnippetAllowlist(allowlist, actualBypasses);

  const summary = [
    `MDX files scanned         : ${files.length}`,
    `Inline bypasses found     : ${actualBypasses.length}`,
    `Allowlist entries checked : ${allowlist.length}`,
    `Violations                : ${failures.length}`,
  ].join("\n");

  if (failures.length > 0) {
    const report = failures.map((f) => `  [${f.type}] ${f.message}`).join("\n");
    console.error(
      `\nSnippet bypass allowlist check FAILED:\n\n${report}\n\n${summary}\n`,
    );
    process.exit(1);
  }

  console.log(`\nSnippet bypass allowlist check passed.\n\n${summary}\n`);
}

// Only run main if executed directly via CLI
if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, "/") || process.argv[1]?.endsWith("check-snippet-allowlist.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
