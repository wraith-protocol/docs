/**
 * Validate the Stellar network guides.
 *
 * Checks documented environment variables, network URLs and passphrases against
 * the canonical registry, runs placeholder-normalised shell syntax checks, and
 * reports stale or conflicting values.
 *
 * Commands are only ever parsed (`bash -n`), never executed, so no real
 * transaction can be sent from CI.
 *
 * Run: pnpm run check:network-docs
 */
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  checkCommandSyntax,
  extractSection,
  findConflicts,
  findStaleStamps,
  formatFinding,
  looksLikeNetworkDoc,
  summarise,
  validateAgainstRegistry,
  validateEnvNames,
  type DocSection,
  type Finding,
} from "./lib/network-docs.js";

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".agents",
  ".claude",
  ".github",
  "assets",
]);
const DOC_EXTENSIONS = new Set([".mdx", ".md"]);

async function collectDocs(dir: string, found: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectDocs(full, found);
      continue;
    }
    if (DOC_EXTENSIONS.has(path.extname(entry.name))) found.push(full);
  }
  return found;
}

/** Parse-only shell syntax check — never executes the command. */
function bashSyntaxCheck(command: string): string | null {
  const result = spawnSync("bash", ["-n", "-c", command], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`Unable to run bash for syntax checks: ${result.error.message}`);
  }
  if (result.status === 0) return null;
  const message = (result.stderr || "").trim().split("\n")[0] ?? "unknown syntax error";
  return message;
}

async function main() {
  const all = await collectDocs(ROOT);
  const docs = await Promise.all(
    all.map(async (file) => ({ file: path.relative(ROOT, file), markdown: await readFile(file, "utf8") })),
  );

  const networkDocs = docs.filter((doc) => looksLikeNetworkDoc(doc.markdown));
  if (networkDocs.length === 0) {
    throw new Error("No network guides found — expected at least one document with STELLAR_NETWORK.");
  }

  const sections: DocSection[] = networkDocs.map((doc) => extractSection(doc.file, doc.markdown));

  const findings: Finding[] = [
    ...validateEnvNames(sections),
    ...validateAgainstRegistry(sections),
    ...checkCommandSyntax(sections, bashSyntaxCheck),
    ...findConflicts(sections),
    ...findStaleStamps(networkDocs, new Date()),
  ];

  const envCount = sections.reduce((total, section) => total + section.env.length, 0);
  const commandCount = sections.reduce((total, section) => total + section.commands.length, 0);

  for (const finding of findings) console.log(formatFinding(finding));

  const counts = summarise(findings);
  console.log(
    [
      "",
      `Network docs scanned: ${networkDocs.length}`,
      `Environment variables validated: ${envCount}`,
      `Commands syntax-checked (not executed): ${commandCount}`,
      `Findings: ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info`,
    ].join("\n"),
  );

  if (counts.error > 0) {
    throw new Error(`${counts.error} network documentation error(s) found.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
