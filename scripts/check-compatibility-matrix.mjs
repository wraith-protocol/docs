#!/usr/bin/env node
/**
 * check-compatibility-matrix.mjs
 *
 * Validates reference/compatibility-matrix.mdx row by row against the entry
 * that OWNS each value, instead of checking that an identifier merely appears
 * somewhere in the docs.
 *
 * Each chain section of the matrix is owned by a specific source:
 *
 *   - EVM    -> contracts/evm.mdx      (the "Deployed Addresses (Horizen Testnet)" table)
 *   - Stellar-> scripts/contract-registry.json  (networks["stellar-testnet"], address + version)
 *   - Solana -> contracts/solana.mdx   (no program IDs are published yet)
 *   - CKB    -> contracts/ckb.mdx      (each script's "Deployed Code Hash" / "Cell Dep")
 *
 * Additionally, the "SDK core" table at the top of the matrix is validated
 * against the version of the package that is actually installed:
 *
 *   - @wraith-protocol/sdk version must match the installed SDK version
 *   - Peer dep versions for @stellar/stellar-sdk and @solana/web3.js must
 *     match the same fields in package.json.
 *
 * The installed version is read from `node_modules/<pkg>/package.json` when the
 * dependency is installed from a local path — CI installs the packed SDK
 * tarball, which leaves a `file:/tmp/…tgz` specifier in package.json that
 * carries no version. The matrix is therefore compared against the version
 * of the artifact under test, not against that path.
 *
 * Every row is resolved to its contract's entry in its owner, and the check
 * fails when:
 *   - the row's contract has no entry in the owner,
 *   - the row's identifier is not the owner's identifier for that contract,
 *   - the identifier belongs to a different chain or contract,
 *   - the row's version does not match the owner's version,
 *   - the owner publishes a value but the matrix marks the row pending, or
 *   - a Solana/no-identifier row is used for a contract the owner has deployed.
 *
 * Run after changing a deployment:
 *
 *   node scripts/check-compatibility-matrix.mjs
 *
 * Wired into `npm test` and the check-snippets CI job, so a matrix row that
 * no longer matches its owning entry fails the docs build.
 *
 * Internal helpers are exported so check-compatibility-matrix.test.mjs can
 * import them for unit-level regression fixtures without spawning a subprocess.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// Allow callers (tests) to override the repo root so fixtures can be used
// without touching the live docs tree.
export const repoRoot = process.env.MATRIX_CHECK_ROOT ?? process.cwd();
const matrixRel = "reference/compatibility-matrix.mdx";

export const EVM_ADDRESS = /\b0x[0-9a-fA-F]{40}\b/g;
export const CKB_HASH = /\b0x[0-9a-fA-F]{64}\b/g;
export const STELLAR_STRKEY = /\bC[A-Z2-7]{55}\b/g;

/** Cells that stand in for "no value published yet". */
export const PENDING = /^(pending( deployment)?|not deployed|not published( in these docs)?|tbd|—+|-+)$/i;

/** Chain sections of the matrix, in the order they appear under "## Deployment IDs". */
export const CHAINS = [
  { key: "evm", heading: /^###\s+EVM\b/, label: "EVM" },
  { key: "stellar", heading: /^###\s+Stellar\b/, label: "Stellar" },
  { key: "solana", heading: /^###\s+Solana\b/, label: "Solana" },
  { key: "ckb", heading: /^###\s+CKB\b/, label: "CKB" },
];

/**
 * Packages validated in the "SDK core" table against package.json.
 *
 * `matrixLabel`   — the value that appears in the Package column of the matrix
 *                   (used to locate the row; matched case-insensitively after
 *                   stripping backticks).
 * `pkgJsonKey`    — key in package.json `dependencies` or `devDependencies`.
 * `source`        — human-readable description for error messages.
 * `matchMode`     — "exact" requires the version strings to be equal after
 *                   normalisation (removing leading ^/~); "range-prefix" only
 *                   requires the matrix version to start with the pkg.json
 *                   version prefix, to allow `^1.4.5` in the matrix when
 *                   pkg.json records `1.4.5`.
 */
export const SDK_CORE_PACKAGES = [
  {
    matrixLabel: "@wraith-protocol/sdk",
    pkgJsonKey: "@wraith-protocol/sdk",
    source: "dependencies",
    matchMode: "range-prefix",
  },
  {
    matrixLabel: "@stellar/stellar-sdk",
    pkgJsonKey: "@stellar/stellar-sdk",
    source: "dependencies",
    matchMode: "range-prefix",
  },
  {
    matrixLabel: "@solana/web3.js",
    pkgJsonKey: "@solana/web3.js",
    source: "dependencies",
    matchMode: "range-prefix",
  },
];

async function main() {
  const failures = [];

  const owners = {
    evm: await buildEvmOwner(),
    stellar: await buildStellarOwner(),
    ckb: await buildCkbOwner(),
    solana: await buildSolanaOwner(),
  };

  // Global index so a value placed under the wrong chain or contract is caught
  // even when it happens to be *some* valid identifier.
  const globalIndex = new Map();
  for (const owner of Object.values(owners)) {
    for (const entry of owner.entries.values()) {
      for (const id of entry.addresses) {
        const previous = globalIndex.get(id);
        if (
          previous &&
          (previous.chain !== owner.chain ||
            normalizeContract(previous.contract) !== normalizeContract(entry.contract))
        ) {
          failures.push(
            `Identifier ${id} is owned by both ${previous.chain}/${previous.contract} and ` +
              `${owner.chain}/${entry.contract}; owners must be unambiguous.`,
          );
        }
        globalIndex.set(id, { chain: owner.chain, contract: entry.contract });
      }
    }
  }

  const matrix = await readFile(path.join(repoRoot, matrixRel), "utf8");
  const matrixLines = splitLines(matrix);

  let checkedRows = 0;
  let checkedIdentifiers = 0;

  // ------------------------------------------------------------------
  // Validate the "SDK core" table against package.json
  // ------------------------------------------------------------------
  const pkgJson = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  );
  const sdkCoreFailures = validateSdkCoreTable(
    matrixLines,
    pkgJson,
    await resolveInstalledVersions(pkgJson),
  );
  failures.push(...sdkCoreFailures);

  // ------------------------------------------------------------------
  // Validate the per-chain deployment ID sections
  // ------------------------------------------------------------------
  for (const chain of CHAINS) {
    const start = headingIndex(matrixLines, chain.heading);
    if (start < 0) {
      failures.push(`${matrixRel}: missing the "${chain.label}" deployment section.`);
      continue;
    }

    const table = tableAfter(matrixLines, start);
    if (!table || table.rows.length === 0) {
      failures.push(`${matrixRel}: the "${chain.label}" section has no deployment table.`);
      continue;
    }

    const owner = owners[chain.key];
    for (const row of table.rows) {
      checkedRows++;
      const contractCell = row[0] ?? "";
      const valueCell = row[1] ?? "";
      const versionCell = row[2] ?? "";
      const contractKey = normalizeContract(contractCell);
      const ids = identifiersIn(valueCell);
      const entry = owner.entries.get(contractKey);

      if (chain.key === "solana") {
        if (ids.length > 0) {
          failures.push(
            `${matrixRel}: Solana row "${stripCode(contractCell)}" publishes ${ids.join(", ")}, ` +
              `but ${owner.rel} does not own any Solana identifier yet.`,
          );
        } else if (!PENDING.test(stripCode(valueCell))) {
          failures.push(
            `${matrixRel}: Solana row "${stripCode(contractCell)}" should be marked pending ` +
              `(no program IDs are published in ${owner.rel}).`,
          );
        }
        continue;
      }

      if (!entry) {
        failures.push(
          `${matrixRel}: row "${stripCode(contractCell)}" has no owning entry for ` +
            `"${contractKey}" in ${owner.rel}.`,
        );
        continue;
      }

      if (ids.length === 0) {
        if (!PENDING.test(stripCode(valueCell))) {
          failures.push(
            `${matrixRel}: row "${stripCode(contractCell)}" carries no recognizable identifier ` +
              `and is not marked pending.`,
          );
        } else if (entry.addresses.length > 0) {
          failures.push(
            `${matrixRel}: row "${stripCode(contractCell)}" is marked pending, but ${owner.rel} ` +
              `publishes ${entry.addresses.join(", ")} for it.`,
          );
        }
      } else {
        for (const id of ids) {
          checkedIdentifiers++;
          if (entry.addresses.includes(id)) continue;

          const ownerOfId = globalIndex.get(id);
          if (ownerOfId && ownerOfId.chain !== chain.key) {
            failures.push(
              `${matrixRel}: "${stripCode(contractCell)}" lists ${id}, which belongs to the ` +
                `${ownerOfId.chain} chain (${ownerOfId.contract}), not ${chain.label}.`,
            );
          } else if (
            ownerOfId &&
            normalizeContract(ownerOfId.contract) !== contractKey
          ) {
            failures.push(
              `${matrixRel}: "${stripCode(contractCell)}" lists ${id}, which ${owner.rel} owns ` +
                `under "${ownerOfId.contract}", not "${contractKey}".`,
            );
          } else {
            failures.push(
              `${matrixRel}: "${stripCode(contractCell)}" lists ${id}, but ${owner.rel} does not ` +
                `own that value for "${contractKey}".`,
            );
          }
        }
      }

      if (entry.version != null) {
        const version = stripCode(versionCell);
        if (version.toLowerCase() !== String(entry.version).toLowerCase()) {
          failures.push(
            `${matrixRel}: "${stripCode(contractCell)}" version is "${version}", but ` +
              `${owner.rel} records "${entry.version}".`,
          );
        }
      }
    }
  }

  if (checkedIdentifiers === 0) {
    failures.push(
      `${matrixRel}: no deployment identifiers found. Expected at least one EVM address, ` +
        `Stellar contract strkey, or CKB code/transaction hash.`,
    );
  }

  if (failures.length > 0) {
    fail(failures);
  }

  console.log(
    `Compatibility matrix passed: ${checkedRows} rows / ${checkedIdentifiers} deployment ` +
      `identifiers validated against their owning entries (${Object.values(owners)
        .map((owner) => owner.rel)
        .join(", ")}). SDK core package versions validated against the installed packages.`,
  );
}

// ----------------------------------------------------------------------
// SDK core table validation
// ----------------------------------------------------------------------

/**
 * Locate the "## SDK core" table in the matrix and verify each tracked
 * package's version cell against the version of the package that is
 * installed.
 *
 * Exported so tests can call it directly with synthetic inputs.
 *
 * @param {string[]} matrixLines  Lines of the matrix MDX file.
 * @param {object}   pkgJson      Parsed package.json object.
 * @param {object}   installedVersions
 *        Optional map of package name to the canonical version of the
 *        installed artifact. Used for dependencies installed from a local
 *        path, where package.json holds no version.
 * @returns {string[]}            Array of failure messages (empty = pass).
 */
export function validateSdkCoreTable(matrixLines, pkgJson, installedVersions = {}) {
  const failures = [];

  const sectionStart = headingIndex(matrixLines, /^##\s+SDK core\b/);
  if (sectionStart < 0) {
    failures.push(`${matrixRel}: missing "## SDK core" section.`);
    return failures;
  }

  const table = tableAfter(matrixLines, sectionStart);
  if (!table || table.rows.length === 0) {
    failures.push(`${matrixRel}: "## SDK core" section has no table.`);
    return failures;
  }

  const allDeps = {
    ...(pkgJson.dependencies ?? {}),
    ...(pkgJson.devDependencies ?? {}),
  };

  for (const pkg of SDK_CORE_PACKAGES) {
    // Find the matrix row whose Package cell matches this package label.
    const row = table.rows.find((r) =>
      stripCode(r[0] ?? "").toLowerCase() === pkg.matrixLabel.toLowerCase(),
    );
    if (!row) {
      // Package not in the matrix — not an error; only tracked packages are checked.
      continue;
    }

    const matrixVersion = stripCode(row[1] ?? "");
    const declaredVersion = allDeps[pkg.pkgJsonKey];
    // `installedVersions` carries the canonical version of the artifact that is
    // actually installed. It differs from the declared spec only when the
    // dependency is installed from a local path (CI installs the packed SDK
    // tarball, which leaves a `file:…` specifier in package.json).
    const installedVersion = installedVersions?.[pkg.pkgJsonKey] ?? declaredVersion;

    if (!installedVersion) {
      failures.push(
        `${matrixRel}: SDK core row "${pkg.matrixLabel}" is documented but ` +
          `"${pkg.pkgJsonKey}" is not in package.json ${pkg.source}.`,
      );
      continue;
    }

    if (!versionsMatch(matrixVersion, installedVersion, pkg.matchMode)) {
      failures.push(
        `${matrixRel}: SDK core row "${pkg.matrixLabel}" documents version ` +
          `"${matrixVersion}", but the installed version is "${installedVersion}". ` +
          `Update the matrix or package.json so they agree.`,
      );
    }
  }

  return failures;
}

/**
 * Resolve the canonical version of each tracked package that is installed.
 *
 * A dependency declared as a local path (for example the packed SDK tarball
 * that CI installs: `file:/tmp/wraith-protocol-sdk-1.4.5.tgz`) carries no
 * version in package.json. The version of the artifact that is actually
 * installed is read from `node_modules/<pkg>/package.json`, so the matrix is
 * compared against the version under test rather than against a path.
 *
 * Packages declared with a semver range keep that range: it is what the
 * matrix documents and what the lockfile resolves.
 *
 * @param {object} pkgJson Parsed package.json object.
 * @returns {Promise<Record<string, string>>} Map of package name to version.
 */
export async function resolveInstalledVersions(pkgJson) {
  const allDeps = {
    ...(pkgJson.dependencies ?? {}),
    ...(pkgJson.devDependencies ?? {}),
  };

  const resolved = {};
  for (const pkg of SDK_CORE_PACKAGES) {
    const declared = allDeps[pkg.pkgJsonKey];
    if (!declared || !isLocalSpecifier(declared)) continue;

    const installed = await readInstalledVersion(pkg.pkgJsonKey);
    if (installed) {
      resolved[pkg.pkgJsonKey] = installed;
      continue;
    }

    // node_modules is not available — fall back to the version encoded in the
    // artifact's file name (e.g. `wraith-protocol-sdk-1.4.5.tgz`).
    const fromName = versionFromArtifactName(declared);
    if (fromName) resolved[pkg.pkgJsonKey] = fromName;
  }
  return resolved;
}

/** True when a dependency specifier points at a local path rather than a range. */
export function isLocalSpecifier(spec) {
  const value = String(spec ?? "").trim();
  if (!value) return false;
  if (/^(file|link|portal|workspace):/i.test(value)) return true;
  return /[\\/]/.test(value) && !/^[~^><=\d]/.test(value);
}

/** Read the `version` field of an installed package, or null when absent. */
async function readInstalledVersion(pkgJsonKey) {
  try {
    const manifest = JSON.parse(
      await readFile(
        path.join(repoRoot, "node_modules", pkgJsonKey, "package.json"),
        "utf8",
      ),
    );
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

/** Extract `1.4.5` from `wraith-protocol-sdk-1.4.5.tgz`. */
export function versionFromArtifactName(spec) {
  const match = String(spec ?? "").match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

/**
 * Return true when `matrixVersion` is consistent with `installedVersion`
 * under the given match mode.
 *
 * "range-prefix": strips ^ and ~ from both sides, then checks that the
 * bare version numbers are equal.  This accepts matrix `^1.4.5` vs
 * package.json `1.4.5`, and matrix `1.4.5` vs package.json `^1.4.5`.
 *
 * Exported for tests.
 */
export function versionsMatch(matrixVersion, installedVersion, mode) {
  if (mode === "range-prefix") {
    return bare(matrixVersion) === bare(installedVersion);
  }
  // "exact" — after stripping range operators the versions must be identical.
  return bare(matrixVersion) === bare(installedVersion);
}

/** Strip leading range operators (^, ~, >=, <=, >, <) and whitespace. */
function bare(v) {
  return String(v ?? "").replace(/^[~^><=\s]+/, "").trim();
}

// ----------------------------------------------------------------------
// Owners — one per chain, keyed by contract name
// ----------------------------------------------------------------------

export async function buildEvmOwner() {
  const rel = "contracts/evm.mdx";
  const text = await readFile(path.join(repoRoot, rel), "utf8");
  const ls = splitLines(text);
  const start = headingIndex(
    ls,
    /^###\s+Deployed Addresses \(Horizen Testnet\)/,
  );
  if (start < 0) {
    throw new Error(
      `${rel}: could not find "### Deployed Addresses (Horizen Testnet)".`,
    );
  }
  const table = tableAfter(ls, start);
  const entries = new Map();
  for (const row of table?.rows ?? []) {
    const [contract, address] = row;
    if (!contract) continue;
    entries.set(normalizeContract(contract), {
      contract: stripCode(contract),
      addresses: identifiersIn(address ?? ""),
      version: null,
    });
  }
  return { chain: "evm", rel, entries };
}

export async function buildStellarOwner() {
  const rel = "scripts/contract-registry.json";
  const registry = JSON.parse(
    await readFile(path.join(repoRoot, rel), "utf8"),
  );
  const network = registry.networks?.["stellar-testnet"];
  if (!network) {
    throw new Error(`${rel}: networks["stellar-testnet"] is missing.`);
  }
  const entries = new Map();
  for (const [contract, entry] of Object.entries(network.contracts ?? {})) {
    entries.set(normalizeContract(contract), {
      contract,
      addresses: entry.address ? [entry.address.toLowerCase()] : [],
      version: entry.version ?? null,
    });
  }
  return { chain: "stellar", rel, entries };
}

export async function buildCkbOwner() {
  const rel = "contracts/ckb.mdx";
  const text = await readFile(path.join(repoRoot, rel), "utf8");
  const ls = splitLines(text);
  const entries = new Map();

  for (let i = 0; i < ls.length; i++) {
    const match = ls[i].match(/^##\s+(wraith-[a-z0-9-]+)\s*$/);
    if (!match) continue;
    let end = i + 1;
    while (end < ls.length && !/^##\s/.test(ls[end])) end++;
    const section = ls.slice(i, end);
    const codeHash = fencedAfter(section, "### Deployed Code Hash");
    const cellDep = fencedAfter(section, "### Cell Dep");
    const ids = new Set(identifiersIn(codeHash ?? ""));
    if (cellDep) {
      const tx = cellDep.match(/tx:\s*(0x[0-9a-fA-F]{64})/);
      if (tx) ids.add(tx[1].toLowerCase());
      for (const id of identifiersIn(cellDep)) ids.add(id);
    }
    entries.set(normalizeContract(match[1]), {
      contract: match[1],
      addresses: [...ids],
      version: null,
    });
  }

  if (entries.size === 0) {
    throw new Error(`${rel}: found no "## wraith-…" script sections.`);
  }
  return { chain: "ckb", rel, entries };
}

export async function buildSolanaOwner() {
  const rel = "contracts/solana.mdx";
  let text = "";
  try {
    text = await readFile(path.join(repoRoot, rel), "utf8");
  } catch {
    return { chain: "solana", rel, entries: new Map() };
  }
  const published = identifiersIn(text);
  if (published.length > 0) {
    throw new Error(
      `${rel}: now publishes deployment identifiers (${published.join(", ")}); ` +
        `add them to the matrix and validate them here.`,
    );
  }
  return { chain: "solana", rel, entries: new Map() };
}

// ----------------------------------------------------------------------
// Markdown helpers
// ----------------------------------------------------------------------

export function splitLines(text) {
  return text.split("\n");
}

export function headingIndex(lines, pattern) {
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i;
  }
  return -1;
}

/** Parse the first GitHub-flavoured table at or after `fromIndex`. */
export function tableAfter(lines, fromIndex) {
  let i = fromIndex;
  while (i < lines.length && !lines[i].trim().startsWith("|")) i++;
  if (i >= lines.length) return null;

  const raw = [];
  while (i < lines.length && lines[i].trim().startsWith("|")) {
    raw.push(lines[i].trim());
    i++;
  }
  const cells = raw.map((line) =>
    line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim()),
  );
  if (cells.length < 2) return null; // header + separator
  return { header: cells[0], rows: cells.slice(2) };
}

/** Value inside the first fenced block that follows `heading` within `lines`. */
export function fencedAfter(lines, heading) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== heading) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim().startsWith("```")) j++;
    if (j >= lines.length) return null;
    const buffer = [];
    j++;
    while (j < lines.length && !lines[j].trim().startsWith("```")) {
      buffer.push(lines[j]);
      j++;
    }
    return buffer.join("\n").trim();
  }
  return null;
}

// ----------------------------------------------------------------------
// Value helpers
// ----------------------------------------------------------------------

export function stripCode(value) {
  return String(value ?? "").replace(/`/g, "").trim();
}

/** Collapse a row label to a contract key ("`WraithNames`" -> "wraithnames"). */
export function normalizeContract(value) {
  return stripCode(value)
    .toLowerCase()
    .replace(/\s*\((cell[- ]?dep|deployment cell dep)\)\s*$/, "")
    .replace(/\s+(deployment\s+)?cell[- ]?dep$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every deployment identifier present in a cell, lower-cased. */
export function identifiersIn(value) {
  const found = new Set();
  const text = String(value ?? "");
  for (const pattern of [CKB_HASH, EVM_ADDRESS, STELLAR_STRKEY]) {
    for (const match of text.matchAll(pattern)) found.add(match[0].toLowerCase());
  }
  return [...found];
}

export function fail(lines) {
  console.error(["Compatibility matrix check failed.", "", ...lines].join("\n"));
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
