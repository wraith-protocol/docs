#!/usr/bin/env node
/**
 * check-compatibility-matrix.mjs
 *
 * Verifies that every deployment identifier published in
 * reference/compatibility-matrix.mdx is also present in the page that owns it,
 * so the matrix cannot drift from the per-chain deployment references.
 *
 * Deployment identifiers are:
 *   - 0x-prefixed EVM addresses (40 hex chars)
 *   - 0x-prefixed CKB code hashes and transaction hashes (64 hex chars)
 *   - C... Stellar contract strkeys (56 chars, base32)
 *
 * Run after changing a deployment:
 *
 *   node scripts/check-compatibility-matrix.mjs
 *
 * Wired into `npm test`, so a matrix row that no longer matches its owning page
 * fails the docs build.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const matrixPath = path.join(repoRoot, "reference", "compatibility-matrix.mdx");

/** Pages that own the deployment identifiers the matrix transcribes. */
const sourcePaths = [
  "contracts/evm.mdx",
  "contracts/stellar.mdx",
  "contracts/solana.mdx",
  "contracts/ckb.mdx",
  "reference/stellar-networks.mdx",
  "sdk/chains/evm.mdx",
  "sdk/chains/stellar.mdx",
  "sdk/chains/solana.mdx",
  "sdk/chains/ckb.mdx",
];

const EVM_ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const CKB_HASH = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
const STELLAR_STRKEY = /\bC[A-Z2-7]{55}\b/g;

async function main() {
  const matrix = await readFile(matrixPath, "utf8");
  const identifiers = collectIdentifiers(matrix);

  if (identifiers.size === 0) {
    fail([
      "No deployment identifiers found in reference/compatibility-matrix.mdx.",
      "Expected at least one EVM address, CKB code hash, or Stellar contract strkey.",
    ]);
  }

  const sources = [];
  for (const relative of sourcePaths) {
    try {
      sources.push({
        relative,
        text: await readFile(path.join(repoRoot, relative), "utf8"),
      });
    } catch {
      // A chain that has no primitives page yet is not a failure on its own;
      // the identifiers it owns still have to be found in another source page.
    }
  }
  const haystack = sources.map((source) => source.text).join("\n");

  const missing = [...identifiers].filter((id) => !haystack.includes(id)).sort();

  if (missing.length > 0) {
    fail([
      "Deployment identifiers in reference/compatibility-matrix.mdx were not found",
      "in any of the pages that own them:",
      ...missing.map((id) => `  - ${id}`),
      "",
      `Searched: ${sources.map((source) => source.relative).join(", ")}`,
      "Update the owning page (or re-run `npm run generate:stellar-reference`) and",
      "the matrix together so the two cannot disagree.",
    ]);
  }

  console.log(
    `Compatibility matrix passed: ${identifiers.size} deployment identifiers ` +
      `verified against ${sources.length} source pages.`,
  );
}

function collectIdentifiers(markdown) {
  const ids = new Set();
  for (const pattern of [EVM_ADDRESS, CKB_HASH, STELLAR_STRKEY]) {
    for (const match of markdown.matchAll(pattern)) {
      ids.add(match[0]);
    }
  }
  return ids;
}

function fail(lines) {
  console.error(["Compatibility matrix check failed.", "", ...lines].join("\n"));
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
