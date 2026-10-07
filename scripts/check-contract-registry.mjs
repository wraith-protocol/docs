#!/usr/bin/env node
/**
 * check-contract-registry.mjs
 *
 * Enforces the canonical Wraith contract registry defined in
 * scripts/contract-registry.json. Run it after editing any page that mentions a
 * contract address, or after bumping @wraith-protocol/sdk:
 *
 *   node scripts/check-contract-registry.mjs
 *
 * A registry that only validates its own shape is not canonical, so this check
 * cross-verifies every recorded fact against pinned authoritative sources:
 *
 *   1. Registry shape and address validity.
 *   2. Addresses must match the @wraith-protocol/sdk `getDeployment()` manifest
 *      resolved from the lockfile (the same package version CI installs).
 *   3. Artifact hashes and deployment timestamps must match on-chain state
 *      reported by the Stellar Expert API and Horizon.
 *   4. Upgradeability claims and mainnet deployment status must match the
 *      contracts-repo deployment manifest, fetched at the commit pinned in the
 *      registry.
 *   5. A shipped .mdx page still carries a stale placeholder contract id.
 *   6. A deployed registry address is not documented anywhere.
 *   7. The network guide, SDK, quickstart (demo), or contracts page stopped
 *      linking to the canonical registry.
 *
 * Checks 2-4 hit the network and the installed SDK. Skip them locally with
 * --offline; CI always runs the full verification.
 *
 * Wired into CI via the "Compile docs snippets" job in
 * .github/workflows/snippets.yml.
 */
import { readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const registryPath = path.join(repoRoot, "scripts", "contract-registry.json");

const OFFLINE = process.argv.includes("--offline");
/** Per-request timeout for each remote verification step, in milliseconds. */
const FETCH_TIMEOUT_MS = 15_000;
/** Transient failures (429/5xx/network) are retried this many times. */
const FETCH_RETRIES = 2;

/** Top-level directories whose pages ship in the navigation. */
const shippedDirs = ["api-reference", "architecture", "contracts", "guides", "reference", "sdk"];

/** Pages that must link to the canonical registry. */
const requiredRegistryLinks = [
  "reference/stellar-networks.mdx",
  "guides/stellar-mainnet-deployment.mdx",
  "contracts/stellar.mdx",
  "sdk/chains/stellar.mdx",
  "guides/stellar/stellar-quickstart.mdx",
];

/** A Stellar contract id: "C" followed by 55 base-32 characters. */
const STELLAR_CONTRACT_ID = /^C[A-Z2-7]{55}$/;

/** Stale placeholder contract ids that must never ship again. */
const bannedPatterns = [
  { pattern: /CPLACEHOLDER[_A-Z0-9]*/g, label: "stale CPLACEHOLDER contract id" },
  { pattern: /\bC\[TBD[^\]]*\]/g, label: "C[TBD] contract id placeholder" },
  { pattern: /\bG\[TBD[^\]]*\]/g, label: "G[TBD] account placeholder" },
  { pattern: /\b0xPLACEHOLDER[A-Za-z0-9]*/g, label: "0xPLACEHOLDER address" },
  { pattern: /<STELLAR_[A-Z_]*CONTRACT_ID>/g, label: "unresolved STELLAR_*_CONTRACT_ID placeholder" },
];

const registryPage = "reference/contract-registry";

/** The only network with live deployments and, therefore, on-chain checks. */
const onChainVerifiedNetworks = new Set(["stellar-testnet"]);

async function main() {
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const failures = [];
  const warnings = [];

  const deployedAddresses = validateRegistry(registry, failures);

  const pages = await collectPages();
  const offenders = [];
  const pagesWithLinks = new Set();

  for (const page of pages) {
    const source = await readFile(path.join(repoRoot, page), "utf8");

    for (const { pattern, label } of bannedPatterns) {
      const matches = [...source.matchAll(pattern)];
      if (matches.length > 0) {
        const lines = matches.map((match) => lineNumberAt(source, match.index)).join(", ");
        offenders.push(`  - ${page} (${label}) line ${lines}`);
      }
    }

    if (source.includes(`/${registryPage}`) || source.includes(registryPage)) {
      pagesWithLinks.add(page);
    }
  }

  if (offenders.length > 0) {
    failures.push(
      [
        "Shipped pages contain stale contract placeholders. Replace them with the",
        "canonical values from scripts/contract-registry.json:",
        ...offenders,
      ].join("\n"),
    );
  }

  const allSource = (
    await Promise.all(pages.map((page) => readFile(path.join(repoRoot, page), "utf8")))
  ).join("\n");
  const missingAddresses = [...deployedAddresses].filter((address) => !allSource.includes(address));
  if (missingAddresses.length > 0) {
    failures.push(
      [
        "Deployed contracts are not documented anywhere in the shipped pages:",
        ...missingAddresses.map((address) => `  - ${address}`),
      ].join("\n"),
    );
  }

  const missingLinks = requiredRegistryLinks.filter((page) => !pagesWithLinks.has(page));
  if (missingLinks.length > 0) {
    failures.push(
      [
        "These pages must link to the canonical registry (/reference/contract-registry):",
        ...missingLinks.map((page) => `  - ${page}`),
      ].join("\n"),
    );
  }

  // ------------------------------------------------------------------
  // Cross-verification against pinned authoritative sources.
  // ------------------------------------------------------------------

  // 1. SDK manifest: addresses must match getDeployment() from the lockfile.
  const sdkManifest = loadSdkManifest(registry, failures);
  if (sdkManifest) {
    verifyAgainstSdk(registry, sdkManifest, failures);
  }

  // 2-4. On-chain state + pinned contracts manifest (network checks).
  if (OFFLINE) {
    warnings.push("Remote verification skipped (--offline): on-chain and contracts-manifest checks not run.");
  } else {
    await verifyAgainstChain(registry, failures, warnings);
    await verifyAgainstContractsManifest(registry, failures, warnings);
  }

  if (warnings.length > 0) {
    console.warn(
      ["Contract registry check warnings:", ...warnings.map((warning) => `  - ${warning}`)].join("\n"),
    );
  }

  if (failures.length > 0) {
    console.error(
      [
        "Contract registry check failed.",
        "",
        ...failures,
        "",
        "The registry is the single source of truth: update scripts/contract-registry.json",
        "first, then update the pages that reference it. Addresses, hashes, ledgers, and",
        "versions must match the pinned SDK, the on-chain state, and the pinned",
        "contracts-repo manifest — the check fails when any of them disagree.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const verified = OFFLINE
    ? "local checks only (--offline)"
    : "verified against the pinned SDK, on-chain state, and the pinned contracts manifest";
  console.log(
    `Contract registry check passed: ${deployedAddresses.size} deployed contract(s) verified ` +
      `across ${Object.keys(registry.networks).length} networks, ${pages.length} shipped pages scanned (${verified}).`,
  );
}

// ----------------------------------------------------------------------
// Registry shape
// ----------------------------------------------------------------------

/** Validate the registry shape and return the set of deployed contract ids. */
function validateRegistry(registry, failures) {
  const deployed = new Set();
  const networks = registry.networks;

  if (!networks || typeof networks !== "object" || Object.keys(networks).length === 0) {
    failures.push("scripts/contract-registry.json has no networks.");
    return deployed;
  }

  if (typeof registry.sdkVersion !== "string" || registry.sdkVersion.length === 0) {
    failures.push('scripts/contract-registry.json is missing "sdkVersion".');
  }
  if (!/^[0-9a-f]{40}$/.test(registry.pinnedContractsRepoCommit ?? "")) {
    failures.push(
      "scripts/contract-registry.json is missing a 40-hex pinnedContractsRepoCommit " +
        "(CI fetches the contracts manifest at that exact commit).",
    );
  }

  for (const [networkKey, network] of Object.entries(networks)) {
    for (const field of ["label", "network", "passphrase", "status", "explorerBase", "contracts"]) {
      if (network[field] === undefined || network[field] === null) {
        failures.push(`scripts/contract-registry.json: ${networkKey} is missing "${field}".`);
      }
    }

    for (const [contractKey, contract] of Object.entries(network.contracts ?? {})) {
      const where = `${networkKey}/${contractKey}`;

      // sdkKey: name of the contract in the SDK manifest, or null when the SDK
      // does not publish it. A non-null sdkKey with a null address (or vice
      // versa) is a registry bug, so both directions are validated.
      if (contract.sdkKey != null && typeof contract.sdkKey !== "string") {
        failures.push(`scripts/contract-registry.json: ${where} has a non-string "sdkKey".`);
      }

      if (contract.address === null) {
        if (contract.sdkKey != null) {
          failures.push(
            `scripts/contract-registry.json: ${where} sets sdkKey "${contract.sdkKey}" but has no address; ` +
              "the SDK publishes that contract, so the registry row is inconsistent.",
          );
        }
        if (contract.artifactHash !== null || contract.deploymentLedger !== null) {
          failures.push(`scripts/contract-registry.json: ${where} has artifact metadata without an address.`);
        }
        continue;
      }

      if (typeof contract.address !== "string" || !STELLAR_CONTRACT_ID.test(contract.address)) {
        failures.push(`scripts/contract-registry.json: ${where} has an invalid Stellar contract id.`);
        continue;
      }
      if (!/^[0-9a-f]{64}$/.test(contract.artifactHash ?? "")) {
        failures.push(`scripts/contract-registry.json: ${where} needs a 64-char lowercase artifact hash.`);
      }
      if (!Number.isInteger(contract.deploymentLedger)) {
        failures.push(`scripts/contract-registry.json: ${where} needs a deployment ledger.`);
      }
      if (typeof contract.version !== "string" || contract.version.length === 0) {
        failures.push(`scripts/contract-registry.json: ${where} needs a version.`);
      }
      deployed.add(contract.address);
    }
  }

  return deployed;
}

// ----------------------------------------------------------------------
// Cross-check 1: pinned SDK manifest (addresses + which contracts exist)
// ----------------------------------------------------------------------

/** Read the installed SDK's Stellar deployment manifest, or null. */
function loadSdkManifest(registry, failures) {
  const sdkDir = path.join(repoRoot, "node_modules", "@wraith-protocol", "sdk");

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(path.join(sdkDir, "package.json"), "utf8"));
  } catch {
    failures.push(
      [
        "Could not read @wraith-protocol/sdk from node_modules.",
        "CI installs dependencies before this check; locally run `pnpm install` first,",
        "or pass --offline to skip the network-dependent checks entirely.",
      ].join("\n"),
    );
    return null;
  }

  if (registry.sdkVersion !== packageJson.version) {
    failures.push(
      [
        `Registry sdkVersion is "${registry.sdkVersion}" but node_modules has`,
        `"${packageJson.version}". The registry is only canonical for the SDK version`,
        "it was verified against: bump @wraith-protocol/sdk in package.json and",
        "sdkVersion in scripts/contract-registry.json together, re-verify every",
        "recorded address against the new getDeployment() output, and update the",
        "verifiedAt date.",
      ].join("\n"),
    );
    return null;
  }

  const bundlePath = path.join(sdkDir, "dist", "chains", "stellar", "index.js");
  let source;
  try {
    source = readFileSync(bundlePath, "utf8");
  } catch {
    failures.push(`Could not read ${path.relative(repoRoot, bundlePath)} from the installed SDK.`);
    return null;
  }

  const match = source.match(/var DEPLOYMENTS = (\{[\s\S]*?\n\});/);
  if (!match) {
    failures.push("Could not locate the DEPLOYMENTS manifest in the installed SDK bundle.");
    return null;
  }

  try {
    // The literal is a plain JavaScript object (unquoted keys), so evaluate it
    // in a controlled context rather than JSON.parse-ing bundle output.
    const deployments = new Function(`return (${match[1]});`)();
    const entries = Object.values(deployments ?? {});
    if (entries.length === 0 || entries.some((deployment) => typeof deployment?.network !== "string")) {
      throw new Error("unexpected DEPLOYMENTS shape");
    }
    return deployments;
  } catch (error) {
    failures.push(`Could not parse the SDK DEPLOYMENTS manifest: ${error.message}`);
    return null;
  }
}

/**
 * Every contract the SDK publishes must be recorded with the exact same
 * address, and every registry row claiming an sdkKey must actually be
 * published by this SDK version. Both directions are checked: a registry that
 * silently drops an SDK contract, or invents one, is wrong either way.
 *
 * sdkDeployments is the SDK's DEPLOYMENTS literal, keyed by chain entry point
 * (e.g. "stellar") with each value carrying its `network` name (e.g. "testnet")
 * and its `contracts` map.
 */
function verifyAgainstSdk(registry, sdkDeployments, failures) {
  // Flatten the SDK manifest: network name -> { sdkKey -> address }.
  const byNetwork = new Map();
  for (const deployment of Object.values(sdkDeployments)) {
    const contracts = byNetwork.get(deployment.network) ?? {};
    for (const [sdkKey, address] of Object.entries(deployment.contracts ?? {})) {
      if (contracts[sdkKey] && contracts[sdkKey] !== address) {
        failures.push(
          `The SDK publishes "${sdkKey}" with two different addresses on "${deployment.network}".`,
        );
      }
      contracts[sdkKey] = address;
    }
    byNetwork.set(deployment.network, contracts);
  }

  // All published (sdkKey -> addresses) pairs across every deployment.
  const published = new Map();
  for (const contracts of byNetwork.values()) {
    for (const [sdkKey, address] of Object.entries(contracts)) {
      if (!published.has(sdkKey)) published.set(sdkKey, new Set());
      published.get(sdkKey).add(address);
    }
  }

  // Forward: every SDK contract must be recorded with the exact same address.
  for (const [sdkKey, addresses] of published) {
    const rows = [...eachDeployedRegistryRow(registry)].filter((row) => row.contract.sdkKey === sdkKey);
    if (rows.length === 0) {
      failures.push(
        `The SDK publishes "${sdkKey}" (${[...addresses].join(", ")}) but no registry row claims it — the registry is missing a deployment.`,
      );
      continue;
    }
    for (const { networkKey, contractKey, contract } of rows) {
      if (!addresses.has(contract.address)) {
        failures.push(
          `${networkKey}/${contractKey}: registry address does not match the SDK manifest for "${sdkKey}":\n` +
            `    registry: ${contract.address}\n    sdk:      ${[...addresses].join(", ")}`,
        );
      }
    }
  }

  // Reverse: every registry row with an sdkKey must be published by this SDK.
  for (const { networkKey, contractKey, contract } of eachDeployedRegistryRow(registry)) {
    if (contract.sdkKey != null && !published.has(contract.sdkKey)) {
      failures.push(
        `${networkKey}/${contractKey}: registry row claims sdkKey "${contract.sdkKey}" ` +
          `but the SDK does not publish it under that name.`,
      );
    }
  }
}

/** Iterate every deployed (non-null address) registry row. */
function* eachDeployedRegistryRow(registry) {
  for (const [networkKey, network] of Object.entries(registry.networks)) {
    for (const [contractKey, contract] of Object.entries(network.contracts ?? {})) {
      if (contract.address !== null) {
        yield { networkKey, contractKey, contract };
      }
    }
  }
}

// ----------------------------------------------------------------------
// Cross-check 2: on-chain state (Stellar Expert + Horizon)
// ----------------------------------------------------------------------

async function verifyAgainstChain(registry, failures, warnings) {
  for (const [networkKey, network] of Object.entries(registry.networks)) {
    for (const [contractKey, contract] of Object.entries(network.contracts ?? {})) {
      if (contract.address === null) continue;

      if (!onChainVerifiedNetworks.has(networkKey)) {
        warnings.push(
          `${networkKey}/${contractKey}: not verified on-chain (no on-chain checks wired for this network yet).`,
        );
        continue;
      }

      await verifyContractOnChain(networkKey, contractKey, contract, failures, warnings);
    }
  }
}

async function verifyContractOnChain(networkKey, contractKey, contract, failures, warnings) {
  const expert = await fetchJson(
    `https://api.stellar.expert/explorer/testnet/contract/${contract.address}`,
  );
  if (!expert) {
    warnings.push(
      `${networkKey}/${contractKey}: Stellar Expert API unreachable; on-chain hash/date not verified this run.`,
    );
    return;
  }

  // The WASM installed on-chain must hash to exactly what the registry records.
  if (expert.wasm !== contract.artifactHash) {
    failures.push(
      `${networkKey}/${contractKey}: registry artifactHash does not match the WASM hash on-chain:\n` +
        `    registry: ${contract.artifactHash}\n    on-chain: ${expert.wasm}`,
    );
  }

  // The on-chain creation timestamp must land on the recorded deployment date.
  const createdDay = new Date(expert.created * 1000).toISOString().slice(0, 10);
  if (createdDay !== contract.deployedAt) {
    failures.push(
      `${networkKey}/${contractKey}: registry deployedAt (${contract.deployedAt}) does not match ` +
        `the on-chain creation time (${createdDay}).`,
    );
  }

  // The recorded deployment ledger must close on the recorded deployment date.
  const ledger = await fetchJson(`https://horizon-testnet.stellar.org/ledgers/${contract.deploymentLedger}`);
  if (!ledger) {
    warnings.push(
      `${networkKey}/${contractKey}: Horizon ledger ${contract.deploymentLedger} unreachable; deployment ledger not verified this run.`,
    );
    return;
  }
  const ledgerDay = ledger.closed_at?.slice(0, 10);
  if (ledgerDay !== contract.deployedAt) {
    failures.push(
      `${networkKey}/${contractKey}: ledger ${contract.deploymentLedger} closed on ${ledgerDay ?? "unknown"}, ` +
        `but the registry says deployedAt is ${contract.deployedAt}.`,
    );
  }
}

// ----------------------------------------------------------------------
// Cross-check 3: pinned contracts-repo manifest (governance + mainnet status)
// ----------------------------------------------------------------------

async function verifyAgainstContractsManifest(registry, failures, warnings) {
  const pin = registry.pinnedContractsRepoCommit;
  const manifestUrl = `https://raw.githubusercontent.com/wraith-protocol/contracts/${pin}/audit-prep/DEPLOYMENT_MANIFEST.md`;

  const manifest = await fetchText(manifestUrl);
  if (!manifest) {
    warnings.push(
      `Contracts manifest at pinned commit ${pin.slice(0, 8)} unreachable; upgradeability cross-check skipped this run.`,
    );
    return;
  }

  const mainnetContracts = registry.networks["stellar-mainnet"]?.contracts ?? {};
  if (Object.keys(mainnetContracts).length === 0) {
    failures.push("scripts/contract-registry.json has no stellar-mainnet entry.");
    return;
  }

  // Mainnet is pre-deployment on both sides today. Neither side may drift from
  // the other: the registry stays address-less while the pinned manifest still
  // carries C[TBD] placeholders, and both flip together when deployment lands.
  const registryHasMainnetAddresses = Object.values(mainnetContracts).some(
    (contract) => contract.address !== null,
  );
  const manifestHasPlaceholders = /\bC\[TBD[^\]]*\]/.test(manifest);

  if (registryHasMainnetAddresses && manifestHasPlaceholders) {
    failures.push(
      [
        "The registry records mainnet addresses, but the pinned contracts manifest",
        "still contains C[TBD] placeholders. Re-pin pinnedContractsRepoCommit to a",
        "commit where the manifest records the real deployment, or update the registry.",
      ].join("\n"),
    );
  }
  if (!registryHasMainnetAddresses && !manifestHasPlaceholders) {
    failures.push(
      [
        "All mainnet registry rows are unaddressed, but the pinned contracts manifest",
        "no longer contains C[TBD] placeholders — the manifest was updated (deployment",
        "landed?) and the registry was not. Re-pin pinnedContractsRepoCommit and fill",
        "in the mainnet addresses in scripts/contract-registry.json.",
      ].join("\n"),
    );
  }

  // Upgradeability claims must match the manifest's governance section.
  const governance = parseGovernanceSection(manifest);
  for (const [contractKey, contract] of Object.entries(mainnetContracts)) {
    const expected = governance.get(contractKey);
    if (!expected) {
      warnings.push(`${contractKey}: no governance entry found in the pinned manifest.`);
      continue;
    }
    if (Boolean(contract.upgradeable) !== expected.upgradeable) {
      failures.push(
        `${contractKey}: registry upgradeable=${contract.upgradeable} but the pinned manifest ` +
          `classifies it as ${expected.label}.`,
      );
    }
  }
}

/**
 * Pull the "Frozen Contracts" and "Upgradeable Contracts" blocks out of the
 * manifest markdown and return a map of contract key -> {upgradeable, label}.
 */
function parseGovernanceSection(manifest) {
  const governance = new Map();

  const frozen = manifest.match(/### Frozen Contracts[^\n]*\n([\s\S]*?)(?=\n### |\n## )/);
  if (frozen) {
    for (const match of frozen[1].matchAll(/^\*\*([a-z0-9-]+):\*\*/gm)) {
      governance.set(match[1], { upgradeable: false, label: "frozen (no upgrade mechanism)" });
    }
  }

  const upgradeable = manifest.match(/### Upgradeable Contracts[^\n]*\n([\s\S]*?)(?=\n### |\n## )/);
  if (upgradeable) {
    for (const match of upgradeable[1].matchAll(/^\*\*([a-z0-9-]+):\*\*/gm)) {
      governance.set(match[1], { upgradeable: true, label: "upgradeable (multisig + timelock)" });
    }
  }

  return governance;
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

async function fetchJson(url) {
  return fetchWithRetry(url, (text) => JSON.parse(text));
}

async function fetchText(url) {
  return fetchWithRetry(url, (text) => text);
}

async function fetchWithRetry(url, parse) {
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (response.ok) {
        return parse(await response.text());
      }
      if (response.status === 404) {
        return null; // Definitive: the resource does not exist.
      }
      // Other statuses (429/5xx) are worth retrying.
    } catch {
      // Network error or timeout: retry, then give up with null.
    }
  }
  return null;
}

/** Collect the nav path of every shipped .mdx page (directories + repo root). */
async function collectPages() {
  const pages = [];

  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Directory does not exist.
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
        pages.push(toPagePath(fullPath));
      }
    }
  };

  for (const dir of shippedDirs) {
    await walk(path.join(repoRoot, dir));
  }

  const rootEntries = await readdir(repoRoot, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name.endsWith(".mdx")) {
      pages.push(entry.name);
    }
  }

  return pages.sort();
}

function toPagePath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
