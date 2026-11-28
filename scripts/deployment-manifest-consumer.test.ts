import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Chain } from "@wraith-protocol/sdk";
import {
  artifactHash,
  loadManifest,
  ManifestChain,
  manifestChainForSdk,
  selectContract,
  selectDeployment,
  verifyArtifactHash,
  verifySourceProvenance,
  type ManifestContract,
} from "./deployment-manifest-consumer.js";

const source = JSON.parse(
  readFileSync(new URL("./fixtures/deployment-manifest/source.json", import.meta.url), "utf8"),
);
const schema = JSON.parse(
  readFileSync(new URL("./fixtures/deployment-manifest/schema-v1.json", import.meta.url), "utf8"),
);
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/deployment-manifest/manifest.json", import.meta.url), "utf8"),
);
const manifest = loadManifest(fixture, schema);

test("the pinned generated manifest fixture validates against its published schema", () => {
  assert.equal(source.repository, "https://github.com/wraith-protocol/contracts");
  assert.match(source.commit, /^[0-9a-f]{40}$/);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.deployments.length, 3);
});

test("the documented hash functions match known vectors for each manifest algorithm", () => {
  const bytes = new TextEncoder().encode("abc");
  assert.equal(
    artifactHash(bytes, "keccak256"),
    "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
  );
  assert.equal(
    artifactHash(bytes, "sha256"),
    "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    artifactHash(bytes, "blake2b-256"),
    "0x521c604cc09b814b0a9106305395def35d0211b9996a3e0f326ae4d671bd8fc2",
  );
});

test("invalid schemas and inconsistent first-party provenance fail closed", () => {
  assert.throws(
    () => loadManifest({ schemaVersion: 2, deployments: [] }, schema),
    /does not match schema v1/,
  );

  const inconsistent = structuredClone(fixture) as {
    deployments: Array<{ contracts: ManifestContract[] }>;
  };
  inconsistent.deployments[0].contracts[0].provenance = {
    status: "source-verified",
  };
  assert.throws(
    () => loadManifest(inconsistent, schema),
    /invalid source-verified provenance/,
  );
});

test("SDK chain values select a single network and reject a mismatched chain identity", () => {
  assert.equal(manifestChainForSdk(Chain.Ethereum), "evm");
  assert.throws(() => manifestChainForSdk(Chain.All), /does not identify a single manifest network/);

  const deployment = selectDeployment(manifest, ManifestChain.Evm, "horizen-testnet", "2651420");
  assert.equal(deployment.networkId, "2651420");
  assert.throws(
    () => selectDeployment(manifest, ManifestChain.Evm, "horizen-testnet", "1"),
    /Network identity mismatch/,
  );
  assert.throws(
    () => selectDeployment(manifest, ManifestChain.Stellar, "horizen-testnet", "2651420"),
    /No stellar deployment recorded/,
  );
});

test("missing and explicitly undeployed contracts are never treated as deployments", () => {
  const deployment = selectDeployment(manifest, ManifestChain.Evm, "horizen-testnet", "2651420");
  assert.equal(selectContract(deployment, "ERC5564Announcer").id, "0x8AE65c05E7eb48B9bA652781Bc0a3DBA09A484F3");
  assert.throws(
    () => selectContract(deployment, "WraithSender"),
    /is undeployed: Not deployed on horizen-testnet yet/,
  );
  assert.throws(
    () => selectContract(deployment, "UnknownContract"),
    /is not recorded/,
  );
});

test("external records stay distinct from first-party provenance", () => {
  const deployment = selectDeployment(
    manifest,
    ManifestChain.Ckb,
    "ckb-testnet",
    "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606",
  );
  const external = selectContract(deployment, "ckb-auth");
  assert.equal(external.external, true);
  assert.throws(
    () => verifySourceProvenance(external, new Uint8Array()),
    /third-party code/,
  );
});

test("artifact hashes are checked, and only source-verified first-party code passes provenance checks", () => {
  const bytes = new TextEncoder().encode("verified deployment-manifest fixture");
  const contract: ManifestContract = {
    ...selectContract(
      selectDeployment(manifest, ManifestChain.Evm, "horizen-testnet", "2651420"),
      "ERC5564Announcer",
    ),
    sourceCommit: "a".repeat(40),
    provenance: { status: "source-verified" },
    artifactHash: { algorithm: "sha256", value: artifactHash(bytes, "sha256") },
  };

  assert.equal(verifyArtifactHash(contract, bytes), contract.artifactHash.value);
  assert.equal(verifySourceProvenance(contract, bytes), contract.sourceCommit);
  assert.throws(
    () => verifySourceProvenance(contract, new TextEncoder().encode("different artifact")),
    /artifact hash mismatch/,
  );

  const historical = selectContract(
    selectDeployment(manifest, ManifestChain.Evm, "horizen-testnet", "2651420"),
    "ERC5564Announcer",
  );
  assert.throws(
    () => verifySourceProvenance(historical, bytes),
    /source is not verified/,
  );
});
