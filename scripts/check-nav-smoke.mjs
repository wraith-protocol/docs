#!/usr/bin/env node
/**
 * check-nav-smoke.mjs
 *
 * Verifies that the documentation navigation has at least one representative
 * page for every navigation group and every generated reference family, and
 * emits a JSON fixture (scripts/fixtures/nav-smoke-routes.json) that the
 * Playwright nav smoke spec consumes.
 *
 * This is the offline (no preview required) half of issue #223. The
 * browser-level render checks live in scripts/playground/tests/nav-smoke.spec.ts
 * and run against MINTLIFY_PREVIEW_URL when available.
 *
 * Run: node scripts/check-nav-smoke.mjs
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const docsJsonPath = path.join(repoRoot, "docs.json");

function stripComments(src) { return src; }

async function main() {
  const raw = await readFile(docsJsonPath, "utf8");
  // strip comments (reuse nav-coverage approach)
  let result = ""; let inString = false; let i = 0;
  while (i < raw.length) {
    const ch = raw[i]; const next = raw[i+1];
    if (inString) { result += ch; if (ch === "\\" && next !== undefined) { result += next; i += 2; continue; } if (ch === '"') inString = false; i++; continue; }
    if (ch === '"') { inString = true; result += ch; i++; continue; }
    if (ch === "/" && next === "/") { while (i < raw.length && raw[i] !== "\n") i++; continue; }
    if (ch === "/" && next === "*") { i += 2; while (i < raw.length && !(raw[i] === "*" && raw[i+1] === "/")) i++; i += 2; continue; }
    result += ch; i++;
  }
  const docs = JSON.parse(result);

  const groups = [];
  const tabs = docs.navigation?.tabs || [];
  for (const tab of tabs) {
    for (const g of tab.groups || []) {
      const pages = g.pages || [];
      if (pages.length === 0) {
        console.error(`Nav group '${g.group}' (tab '${tab.tab}') has no pages`);
        process.exit(1);
      }
      groups.push({ tab: tab.tab, group: g.group, representative: pages[0], count: pages.length });
    }
  }

  // Generated reference families: sdk generated reference, stellar reference, contract registry
  const refFamilies = [
    "reference/contract-registry",
    "reference/compatibility-matrix",
  ];
  const generatedChecks = [];
  for (const r of refFamilies) {
    const full = path.join(repoRoot, r + ".mdx");
    const { existsSync } = await import("node:fs");
    if (!existsSync(full)) {
      console.error(`Generated reference family missing: ${r}`);
      process.exit(1);
    }
    generatedChecks.push(r);
  }
  // stellar generated reference output (if present)
  const stellarRef = path.join(repoRoot, "reference", "stellar-contracts.mdx");
  // not required; record presence
  const { existsSync } = await import("node:fs");
  const stellarPresent = existsSync(stellarRef);

  // Write fixture
  const fixtureDir = path.join(repoRoot, "scripts", "fixtures");
  await mkdir(fixtureDir, { recursive: true });
  const fixture = {
    groups,
    groupCount: groups.length,
    generatedReferenceFamilies: generatedChecks,
    stellarReferencePresent: stellarPresent,
    viewports: [
      { name: "desktop", width: 1280, height: 800 },
      { name: "mobile", width: 390, height: 844 },
    ],
  };
  await writeFile(path.join(fixtureDir, "nav-smoke-routes.json"), JSON.stringify(fixture, null, 2) + "\n");

  console.log(`Nav smoke coverage: ${groups.length} nav groups verified.`);
  for (const g of groups) console.log(`  - [${g.tab}/${g.group}] -> ${g.representative} (${g.count} pages)`);
  console.log(`Generated reference families: ${generatedChecks.join(", ")}`);
  console.log("Fixture written: scripts/fixtures/nav-smoke-routes.json");
}

main().catch((err) => { console.error(err); process.exit(1); });
