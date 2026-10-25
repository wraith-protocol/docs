/**
 * check-compatibility-matrix.test.mjs
 *
 * Regression fixtures for the compatibility-matrix checker.
 *
 * Tests are split into two layers:
 *
 *  1. Unit tests — call exported pure helpers directly (no filesystem, fast).
 *  2. Integration tests — write fixture files into a tmp directory, spawn the
 *     checker as a subprocess, and assert the exit code and error message.
 *     This proves that real drift in any of the four owner sources is caught
 *     end-to-end.
 *
 * Run with:
 *   node --test scripts/check-compatibility-matrix.test.mjs
 *
 * Wired into package.json as `test:compatibility-matrix`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import {
  versionsMatch,
  validateSdkCoreTable,
  isLocalSpecifier,
  versionFromArtifactName,
  splitLines,
  stripCode,
  normalizeContract,
  identifiersIn,
  headingIndex,
  tableAfter,
  PENDING,
} from "./check-compatibility-matrix.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const checkerPath = path.join(__dirname, "check-compatibility-matrix.mjs");

// ---------------------------------------------------------------------------
// Helper: spawn the checker against a fixture directory
// ---------------------------------------------------------------------------

/**
 * Run the checker with MATRIX_CHECK_ROOT pointing at `fixtureDir`.
 * Returns { exitCode, stdout, stderr }.
 */
function runChecker(fixtureDir) {
  const result = spawnSync(
    process.execPath,
    [checkerPath],
    {
      cwd: fixtureDir,
      env: { ...process.env, MATRIX_CHECK_ROOT: fixtureDir },
      encoding: "utf8",
    },
  );
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Build a minimal but valid fixture tree from the live repo files, then
 * apply `overrides` (a map of relative path -> new string content) before
 * running the checker.
 *
 * Files not listed in `overrides` are copied from the live repo by reading
 * them from disk at test time — so fixture drift is impossible; the test
 * always starts from the currently-passing state.
 */
async function withFixture(overrides, fn) {
  const tmp = await mkdtemp(path.join(tmpdir(), "matrix-test-"));
  try {
    // Paths the checker reads (relative to repoRoot).
    const needed = [
      "reference/compatibility-matrix.mdx",
      "contracts/evm.mdx",
      "contracts/ckb.mdx",
      "contracts/solana.mdx",
      "scripts/contract-registry.json",
      "package.json",
    ];

    for (const rel of needed) {
      const dest = path.join(tmp, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      const content = overrides.has(rel)
        ? overrides.get(rel)
        : readFileSync(path.join(repoRoot, rel), "utf8");
      await writeFile(dest, content, "utf8");
    }

    return await fn(tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Unit tests — pure helpers, no filesystem
// ---------------------------------------------------------------------------

test("versionsMatch: bare equality works", () => {
  assert.ok(versionsMatch("1.4.5", "1.4.5", "range-prefix"));
  assert.ok(!versionsMatch("1.4.5", "1.4.6", "range-prefix"));
});

test("versionsMatch: strips ^ and ~ from both sides", () => {
  assert.ok(versionsMatch("^1.4.5", "1.4.5", "range-prefix"));
  assert.ok(versionsMatch("1.4.5", "^1.4.5", "range-prefix"));
  assert.ok(versionsMatch("~13.1.0", "^13.1.0", "range-prefix"));
  assert.ok(!versionsMatch("^1.4.5", "^1.5.0", "range-prefix"));
});

test("stripCode: removes backtick wrappers", () => {
  assert.equal(stripCode("`WraithNames`"), "WraithNames");
  assert.equal(stripCode("plain"), "plain");
  assert.equal(stripCode(undefined), "");
});

test("normalizeContract: lowercases and strips cell-dep suffix", () => {
  assert.equal(normalizeContract("`ERC5564Announcer`"), "erc5564announcer");
  assert.equal(normalizeContract("wraith-names-type cell dep"), "wraith-names-type");
  assert.equal(normalizeContract("wraith-names-type (cell dep)"), "wraith-names-type");
  assert.equal(normalizeContract("wraith-names-type (Cell-Dep)"), "wraith-names-type");
});

test("PENDING regex matches expected sentinel values", () => {
  for (const v of [
    "Not deployed",
    "not published in these docs",
    "Pending deployment",
    "pending",
    "TBD",
    "—",
    "---",
    "-",
  ]) {
    assert.ok(PENDING.test(v), `Expected PENDING to match: "${v}"`);
  }
  assert.ok(!PENDING.test("0x8AE65c05E7eb48B9bA652781Bc0a3DBA09A484F3"));
});

test("identifiersIn: extracts EVM addresses", () => {
  const ids = identifiersIn("0x8AE65c05E7eb48B9bA652781Bc0a3DBA09A484F3");
  assert.equal(ids.length, 1);
  assert.equal(ids[0], "0x8ae65c05e7eb48b9ba652781bc0a3dba09a484f3");
});

test("identifiersIn: extracts Stellar strkeys", () => {
  const ids = identifiersIn("CCJLJ2QRBJAAKIG6ELNQVXLLWMKKWVN5O2FKWUETHZGMPAD4MHK7WVWL");
  assert.equal(ids.length, 1);
});

test("identifiersIn: extracts CKB 64-byte hashes", () => {
  const ids = identifiersIn("0xc133817d433f72ea16a2404adaf961524e9572c8378829a21968710d6182e20d");
  assert.equal(ids.length, 1);
});

test("identifiersIn: finds nothing in pending cells", () => {
  assert.deepEqual(identifiersIn("Not deployed"), []);
  assert.deepEqual(identifiersIn("—"), []);
});

test("validateSdkCoreTable: passes when matrix matches package.json", () => {
  // Synthesise a minimal SDK core table matching the live package.json.
  const pkgJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const sdkVer = pkgJson.dependencies["@wraith-protocol/sdk"];
  const stellarVer = pkgJson.dependencies["@stellar/stellar-sdk"];
  const solanaVer = pkgJson.dependencies["@solana/web3.js"];

  const matrix = [
    "## SDK core",
    "",
    `| Package | Version (pinned by these docs) | Used by | Purpose |`,
    `|---|---|---|---|`,
    `| \`@wraith-protocol/sdk\` | \`${sdkVer}\` | All chains | core |`,
    `| \`@stellar/stellar-sdk\` | \`${stellarVer}\` | Stellar | peer |`,
    `| \`@solana/web3.js\` | \`${solanaVer}\` | Solana | peer |`,
  ];

  const failures = validateSdkCoreTable(matrix, pkgJson);
  assert.deepEqual(failures, []);
});

test("validateSdkCoreTable: fails when SDK version in matrix does not match package.json", () => {
  const pkgJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const matrix = [
    "## SDK core",
    "",
    "| Package | Version (pinned by these docs) | Used by | Purpose |",
    "|---|---|---|---|",
    "| `@wraith-protocol/sdk` | `^9.9.9` | All chains | core |",
  ];

  const failures = validateSdkCoreTable(matrix, pkgJson);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /@wraith-protocol\/sdk/);
  assert.match(failures[0], /9\.9\.9/);
});

test("validateSdkCoreTable: compares against the installed version, not a file: specifier", () => {
  // CI installs the packed SDK tarball, so package.json holds a `file:` path
  // with no version. The matrix must be compared against the version of the
  // artifact that is installed.
  const pkgJson = {
    dependencies: {
      "@wraith-protocol/sdk": "file:/tmp/wraith-protocol-sdk-1.4.5.tgz",
    },
  };
  const matrix = [
    "## SDK core",
    "",
    "| Package | Version (pinned by these docs) | Used by | Purpose |",
    "|---|---|---|---|",
    "| `@wraith-protocol/sdk` | `^1.4.5` | All chains | core |",
  ];

  const failures = validateSdkCoreTable(matrix, pkgJson, {
    "@wraith-protocol/sdk": "1.4.5",
  });
  assert.deepEqual(failures, []);
});

test("validateSdkCoreTable: fails when the matrix drifts from the installed version", () => {
  const pkgJson = {
    dependencies: {
      "@wraith-protocol/sdk": "file:/tmp/wraith-protocol-sdk-1.4.5.tgz",
    },
  };
  const matrix = [
    "## SDK core",
    "",
    "| Package | Version (pinned by these docs) | Used by | Purpose |",
    "|---|---|---|---|",
    "| `@wraith-protocol/sdk` | `^1.4.6` | All chains | core |",
  ];

  const failures = validateSdkCoreTable(matrix, pkgJson, {
    "@wraith-protocol/sdk": "1.4.5",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /1\.4\.5/);
});

test("isLocalSpecifier: detects path-based dependency specifiers", () => {
  assert.ok(isLocalSpecifier("file:/tmp/wraith-protocol-sdk-1.4.5.tgz"));
  assert.ok(isLocalSpecifier("link:../sdk"));
  assert.ok(isLocalSpecifier("../local-package"));
  assert.ok(!isLocalSpecifier("^1.4.5"));
  assert.ok(!isLocalSpecifier("1.4.5"));
  assert.ok(!isLocalSpecifier("~13.1.0"));
});

test("versionFromArtifactName: extracts the version from a tarball name", () => {
  assert.equal(
    versionFromArtifactName("file:/tmp/wraith-protocol-sdk-1.4.5.tgz"),
    "1.4.5",
  );
  assert.equal(versionFromArtifactName("/tmp/sdk-2.0.1.tgz"), "2.0.1");
  assert.equal(versionFromArtifactName("file:/tmp/sdk.tgz"), null);
});

test("validateSdkCoreTable: fails when stellar-sdk version drifts", () => {
  const pkgJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const matrix = [
    "## SDK core",
    "",
    "| Package | Version | Used by | Purpose |",
    "|---|---|---|---|",
    "| `@stellar/stellar-sdk` | `^0.0.1` | Stellar | peer |",
  ];

  const failures = validateSdkCoreTable(matrix, pkgJson);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /@stellar\/stellar-sdk/);
});

test("validateSdkCoreTable: fails when solana/web3.js version drifts", () => {
  const pkgJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const matrix = [
    "## SDK core",
    "",
    "| Package | Version | Used by | Purpose |",
    "|---|---|---|---|",
    "| `@solana/web3.js` | `^0.0.1` | Solana | peer |",
  ];

  const failures = validateSdkCoreTable(matrix, pkgJson);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /@solana\/web3\.js/);
});

test("validateSdkCoreTable: fails when SDK core section is missing", () => {
  const pkgJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const failures = validateSdkCoreTable(["## Something else", "no table here"], pkgJson);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /missing "## SDK core"/);
});

test("headingIndex: finds pattern and returns -1 when absent", () => {
  const lines = ["# Title", "## SDK core", "content"];
  assert.equal(headingIndex(lines, /^##\s+SDK core/), 1);
  assert.equal(headingIndex(lines, /^##\s+Missing/), -1);
});

test("tableAfter: parses a simple markdown table", () => {
  const lines = [
    "intro",
    "| Package | Version |",
    "|---|---|",
    "| foo | 1.0 |",
    "| bar | 2.0 |",
  ];
  const table = tableAfter(lines, 0);
  assert.ok(table);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0][0], "foo");
  assert.equal(table.rows[1][1], "2.0");
});

// ---------------------------------------------------------------------------
// Integration tests — full subprocess runs against fixture directories
// ---------------------------------------------------------------------------

// Baseline: the live repo should pass.
test("integration: live repo passes the checker", () => {
  const result = spawnSync(process.execPath, [checkerPath], {
    cwd: repoRoot,
    env: { ...process.env, MATRIX_CHECK_ROOT: repoRoot },
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `Expected exit 0 but got ${result.status}.\nstderr: ${result.stderr}`,
  );
  assert.match(result.stdout, /Compatibility matrix passed/);
  assert.match(result.stdout, /SDK core package versions validated against the installed packages/);
});

// Drift scenario 1: EVM address swapped in the matrix.
test("integration: wrong EVM address in matrix → exit 1", async () => {
  const matrix = readFileSync(
    path.join(repoRoot, "reference/compatibility-matrix.mdx"),
    "utf8",
  );
  // Replace the real ERC5564Announcer address with a wrong one.
  const drifted = matrix.replace(
    "0x8AE65c05E7eb48B9bA652781Bc0a3DBA09A484F3",
    "0x0000000000000000000000000000000000000001",
  );

  const result = await withFixture(
    new Map([["reference/compatibility-matrix.mdx", drifted]]),
    runChecker,
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /ERC5564Announcer/i);
});

// Drift scenario 2: Stellar address wrong in matrix.
test("integration: wrong Stellar address in matrix → exit 1", async () => {
  const matrix = readFileSync(
    path.join(repoRoot, "reference/compatibility-matrix.mdx"),
    "utf8",
  );
  // Corrupt the stealth-announcer strkey — flip one char to make it different.
  const drifted = matrix.replace(
    "CCJLJ2QRBJAAKIG6ELNQVXLLWMKKWVN5O2FKWUETHZGMPAD4MHK7WVWL",
    "CCJLJ2QRBJAAKIG6ELNQVXLLWMKKWVN5O2FKWUETHZGMPAD4MHK7WVWX",
  );

  const result = await withFixture(
    new Map([["reference/compatibility-matrix.mdx", drifted]]),
    runChecker,
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /stealth-announcer/i);
});

// Drift scenario 3: Stellar version wrong in matrix.
test("integration: wrong Stellar version in matrix → exit 1", async () => {
  const matrix = readFileSync(
    path.join(repoRoot, "reference/compatibility-matrix.mdx"),
    "utf8",
  );
  // The registry records stealth-announcer as v2; change matrix to v3.
  const drifted = matrix.replace(
    /(\|\s*`stealth-announcer`[^|]*\|[^|]*\|)\s*v2\s*(\|)/,
    "$1 v3 $2",
  );

  const result = await withFixture(
    new Map([["reference/compatibility-matrix.mdx", drifted]]),
    runChecker,
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /version.*v3|v3.*version/i);
});

// Drift scenario 4: SDK version in matrix bumped without updating package.json.
test("integration: SDK version drift in matrix → exit 1", async () => {
  const matrix = readFileSync(
    path.join(repoRoot, "reference/compatibility-matrix.mdx"),
    "utf8",
  );
  // Replace the documented SDK version cell with a bumped value.
  // The row looks like: | `@wraith-protocol/sdk` | `^1.4.5` | All chains | ...
  const drifted = matrix.replace(
    "| `@wraith-protocol/sdk` | `^1.4.5` |",
    "| `@wraith-protocol/sdk` | `^99.0.0` |",
  );

  // Sanity: confirm the replacement actually changed something.
  assert.notEqual(drifted, matrix, "Fixture replacement did not match — update this test if the matrix row format changed");

  const result = await withFixture(
    new Map([["reference/compatibility-matrix.mdx", drifted]]),
    runChecker,
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /@wraith-protocol\/sdk/);
});

// Drift scenario 5: CKB code hash changed in ckb.mdx without updating matrix.
test("integration: CKB code hash drift in owner → exit 1", async () => {
  const ckb = readFileSync(path.join(repoRoot, "contracts/ckb.mdx"), "utf8");
  // Flip the last char of the wraith-names-type code hash in the owner file.
  const drifted = ckb.replace(
    "0xc133817d433f72ea16a2404adaf961524e9572c8378829a21968710d6182e20d",
    "0xc133817d433f72ea16a2404adaf961524e9572c8378829a21968710d6182e20e",
  );

  const result = await withFixture(
    new Map([["contracts/ckb.mdx", drifted]]),
    runChecker,
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /wraith-names-type/i);
});

// Drift scenario 6: contract-registry.json address updated without matrix update.
test("integration: Stellar address updated in registry without matrix update → exit 1", async () => {
  const registry = JSON.parse(
    readFileSync(path.join(repoRoot, "scripts/contract-registry.json"), "utf8"),
  );
  // Swap wraith-names to a different address.
  registry.networks["stellar-testnet"].contracts["wraith-names"].address =
    "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  // (The matrix still has the old CDEMB3... address, so they diverge.)

  const result = await withFixture(
    new Map([["scripts/contract-registry.json", JSON.stringify(registry)]]),
    runChecker,
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /wraith-names/i);
});

// Drift scenario 7: pending row in matrix when registry now has a real address.
test("integration: matrix row still pending after registry gains address → exit 1", async () => {
  const registry = JSON.parse(
    readFileSync(path.join(repoRoot, "scripts/contract-registry.json"), "utf8"),
  );
  // Give stealth-registry (currently null) a real address.
  registry.networks["stellar-testnet"].contracts["stealth-registry"].address =
    "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  const result = await withFixture(
    new Map([["scripts/contract-registry.json", JSON.stringify(registry)]]),
    runChecker,
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /stealth-registry/i);
});
