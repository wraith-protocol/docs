---
title: Deployment Manifest Consumer Guide
---

# Deployment Manifest Consumer Guide

This guide explains how **SDK**, **application**, **indexer**, and **operator** code consume the cross‑chain deployment manifest published by the contracts repository.

## Table of Contents
1. [Choosing a Network](#choosing-a-network)
2. [Handling Undeployed Contracts](#handling-undeployed-contracts)
3. [Pinning Provenance (source & hash)](#pinning-provenance)
4. [Reacting to Manifest Upgrades](#reacting-to-manifest-upgrades)
5. [Compatibility Matrix](#compatibility-matrix)
6. [Example Fixtures](#example-fixtures)
7. [Testing Consumption Patterns](#testing-consumption-patterns)

---

## Choosing a Network

Consumers must select a network identifier that matches one of the entries in the manifest's `networks` array. The SDK provides the helper `selectNetwork(networkId: string)` which validates the presence of the network and returns the network configuration.

```ts
import { selectNetwork } from "@wraith-protocol/sdk";

const network = selectNetwork("stellar:testnet"); // throws if not found
```

## Handling Undeployed Contracts

When a contract entry has `deployed: false` the consumer should treat it as unavailable. The SDK exposes `isDeployed(contract)` which returns a boolean. Consumers should fail‑closed for any required contract.

```ts
if (!isDeployed(contract)) {
  throw new Error(`Contract ${contract.id} is not deployed on ${network.id}`);
}
```

## Pinning Provenance (source & hash)

Each contract entry includes:
- `source`: URL to the original source repository (e.g., GitHub commit SHA).
- `hash`: SHA‑256 of the compiled bytecode.

Consumers should verify that the on‑chain bytecode matches the recorded `hash`. The SDK supplies `verifyProvenance(contract, onChainHash)`.

```ts
await verifyProvenance(contract, onChainHash);
```

## Reacting to Manifest Upgrades

The manifest is versioned (field `version`). Consumers should compare the cached version with the remote version and, if newer, re‑run the validation pipeline.

```ts
if (remoteManifest.version > localManifest.version) {
  await updateCache(remoteManifest);
  // re‑validate all contracts
}
```

---

## Compatibility Matrix

| Consumer | Supported Networks | First‑Party Contracts | External Contracts | Provenance Check |
|----------|-------------------|----------------------|-------------------|------------------|
| SDK | Stellar, EVM, Solana, CKB | ✅ | ✅ | ✅ |
| Application | Stellar, EVM | ✅ | ✅ | ✅ |
| Indexer | All | ✅ | ✅ | ✅ |
| Operator | All | ✅ | ✅ | ✅ |

See the full matrix in [reference/compatibility-matrix.mdx](../reference/compatibility-matrix.mdx).

---

## Example Fixtures

The repository ships a set of JSON fixtures under `scripts/fixtures/manifest-consumer/` that model realistic manifests. They are used by the test suite.

* `valid-manifest.json` – a complete manifest with all contracts deployed.
* `missing-contract.json` – a manifest where a required contract is omitted.
* `undeployed-contract.json` – a contract flagged as `deployed: false`.
* `hash-mismatch.json` – a contract whose `hash` does not match the on‑chain bytecode.

---

## Testing Consumption Patterns

The test suite located at `scripts/tests/manifest-consumer.test.mjs` validates the following acceptance criteria:
1. Network selection succeeds for a known network and throws for an unknown one.
2. Contracts marked as undeployed cause the consumer to throw.
3. Provenance verification succeeds for matching hashes and fails otherwise.
4. The consumer fails closed when a required contract is missing.
5. All snippets compile against the pinned SDK (`@wraith-protocol/sdk`).

Run the tests with:

```bash
npm run test -- scripts/tests/manifest-consumer.test.mjs
```

---

*This guide is tied to Wave 11 #217 and supersedes the earlier Wave 10 work.*
