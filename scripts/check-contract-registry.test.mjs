import test from "node:test";
import assert from "node:assert/strict";
import {
  checkGovernance,
  checkUpgradeableAcrossNetworks,
  parseGovernanceSection,
  validateRegistry,
} from "./check-contract-registry.mjs";

const manifest = `## Governance Configuration

### Frozen Contracts (No Admin)

**stealth-announcer:**
- No admin role
- **stealth-registry:** a nested label, not an entry

### Non-Upgradeable Contracts (Pause Admin)

**stealth-batch-sender:**
- No upgrade mechanism

### Upgradeable Contracts (Multisig + Timelock)

**stealth-sender:**
- **Admin:** 3-of-5 Multisig

### Multisig Guardians

**wraith-names:**
`;

const row = (upgradeable, version = "v1") => ({ sdkKey: null, address: null, version, artifactHash: null, deploymentLedger: null, upgradeable });
const networks = (testnet, mainnet) => ({
  "stellar-testnet": { contracts: testnet },
  "stellar-mainnet": { contracts: mainnet },
});

test("parses every governance subsection and only line-start entries inside them", () => {
  const governance = parseGovernanceSection(manifest);
  assert.deepEqual([...governance.keys()].sort(), ["stealth-announcer", "stealth-batch-sender", "stealth-sender"]);
  assert.equal(governance.get("stealth-announcer").upgradeable, false);
  assert.equal(governance.get("stealth-batch-sender").upgradeable, false);
  assert.match(governance.get("stealth-batch-sender").label, /^non-upgradeable/);
  assert.equal(governance.get("stealth-sender").upgradeable, true);
});

test("a mainnet contract without a governance entry fails", () => {
  const failures = checkGovernance(
    networks({}, { "stealth-announcer": row(false), "stealth-splitter": row(false) }),
    parseGovernanceSection(manifest),
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^stealth-splitter: no governance entry in the pinned contracts manifest/);
});

test("a contract listed only on testnet still needs a governance entry", () => {
  const failures = checkGovernance(
    networks({ "stealth-vault": row(true) }, { "stealth-announcer": row(false) }),
    parseGovernanceSection(manifest),
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^stealth-vault: no governance entry/);
});

test("a mainnet upgradeable flag that disagrees with the manifest fails", () => {
  const failures = checkGovernance(
    networks({}, { "stealth-batch-sender": row(true), "stealth-sender": row(true) }),
    parseGovernanceSection(manifest),
  );
  assert.deepEqual(failures, [
    "stealth-batch-sender: registry upgradeable=true but the pinned manifest classifies it as " +
      "non-upgradeable (pause admin, no upgrade mechanism).",
  ]);
});

test("matching entries pass", () => {
  const rows = { "stealth-announcer": row(false), "stealth-batch-sender": row(false), "stealth-sender": row(true) };
  assert.deepEqual(checkGovernance(networks(rows, rows), parseGovernanceSection(manifest)), []);
});

test("the same contract version must have the same upgradeable flag on every network", () => {
  const failures = checkUpgradeableAcrossNetworks({
    "stellar-testnet": { contracts: { "stealth-splitter": row(true), "wraith-names": row(true) } },
    "stellar-futurenet": { contracts: { "stealth-splitter": row(false, null) } },
    "stellar-mainnet": { contracts: { "stealth-splitter": row(false), "wraith-names": row(true) } },
  });
  assert.deepEqual(failures, [
    "scripts/contract-registry.json: stealth-splitter v1 is upgradeable=true on stellar-testnet " +
      "but upgradeable=false on stellar-mainnet.",
  ]);
});

test("different contract versions may differ", () => {
  assert.deepEqual(
    checkUpgradeableAcrossNetworks(networks({ "stealth-announcer": row(true, "v1") }, { "stealth-announcer": row(false, "v2") })),
    [],
  );
});

test("upgradeable must be a boolean", () => {
  const registry = {
    sdkVersion: "1.0.0",
    pinnedContractsRepoCommit: "0".repeat(40),
    networks: {
      "stellar-mainnet": {
        label: "Stellar Mainnet",
        network: "mainnet",
        passphrase: "p",
        status: "pending",
        explorerBase: "e",
        contracts: { "stealth-splitter": { ...row("false"), upgradable: false } },
      },
    },
  };
  const failures = [];
  validateRegistry(registry, failures);
  assert.deepEqual(failures, ['scripts/contract-registry.json: stellar-mainnet/stealth-splitter needs a boolean "upgradeable".']);
});
