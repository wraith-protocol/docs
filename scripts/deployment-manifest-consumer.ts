import { blake2b } from "@noble/hashes/blake2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema, ErrorObject } from "ajv";
import { Chain } from "@wraith-protocol/sdk";

export const ManifestChain = {
  Evm: "evm",
  Stellar: "stellar",
  Solana: "solana",
  Ckb: "ckb",
} as const;
export type ManifestChain = (typeof ManifestChain)[keyof typeof ManifestChain];
export type ArtifactHashAlgorithm = "keccak256" | "sha256" | "blake2b-256";

export interface ManifestContract {
  name: string;
  id: string;
  version: string | null;
  sourceCommit: string | null;
  provenance?: {
    status: "source-verified" | "unverifiable";
    reason?: string;
  };
  external?: boolean;
  artifactHash: {
    algorithm: ArtifactHashAlgorithm;
    value: string;
  };
  deployment: {
    height: number;
  };
}

export interface ManifestDeployment {
  chain: ManifestChain;
  network: string;
  networkId: string;
  rpcUrl?: string;
  recordedBy: "deploy-script" | "chain-query";
  contracts: ManifestContract[];
  undeployed?: Array<{ name: string; reason: string }>;
}

export interface DeploymentManifest {
  schemaVersion: 1;
  deployments: ManifestDeployment[];
}

const COMMIT = /^[0-9a-f]{40}$/;
const CKB_PERSONALIZATION = utf8ToBytes("ckb-default-hash");

export function loadManifest(value: unknown, schema: AnySchema): DeploymentManifest {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile<DeploymentManifest>(schema);

  if (!validate(value)) {
    const errors = validate.errors?.map(
      (error: ErrorObject) => `${error.instancePath || "/"} ${error.message}`,
    );
    throw new Error(
      `Deployment manifest does not match schema v1: ${errors?.join("; ") || "validation failed"}`,
    );
  }

  const manifest = value as DeploymentManifest;
  const deploymentKeys = new Set<string>();

  for (const deployment of manifest.deployments) {
    const deploymentKey = `${deployment.chain}/${deployment.network}`;
    if (deploymentKeys.has(deploymentKey)) {
      throw new Error(`Duplicate deployment record: ${deploymentKey}`);
    }
    deploymentKeys.add(deploymentKey);

    const deployedNames = new Set<string>();
    for (const contract of deployment.contracts) {
      if (deployedNames.has(contract.name)) {
        throw new Error(`Duplicate contract ${contract.name} in ${deploymentKey}`);
      }
      deployedNames.add(contract.name);

      if (!contract.external) {
        if (!contract.provenance) {
          throw new Error(`${deploymentKey}/${contract.name} is missing first-party provenance`);
        }
        if (contract.provenance.status === "source-verified" && !COMMIT.test(contract.sourceCommit ?? "")) {
          throw new Error(`${deploymentKey}/${contract.name} has invalid source-verified provenance`);
        }
        if (
          contract.provenance.status === "unverifiable" &&
          (contract.sourceCommit !== null || !contract.provenance.reason)
        ) {
          throw new Error(`${deploymentKey}/${contract.name} has invalid unverifiable provenance`);
        }
      }
    }

    const undeployedNames = new Set<string>();
    for (const record of deployment.undeployed ?? []) {
      if (deployedNames.has(record.name)) {
        throw new Error(`${deploymentKey}/${record.name} is both deployed and undeployed`);
      }
      if (undeployedNames.has(record.name)) {
        throw new Error(`${deploymentKey}/${record.name} is listed as undeployed more than once`);
      }
      undeployedNames.add(record.name);
    }
  }

  return manifest;
}

export function manifestChainForSdk(chain: Chain): ManifestChain {
  switch (chain) {
    case Chain.Horizen:
    case Chain.Ethereum:
    case Chain.Polygon:
    case Chain.Base:
      return ManifestChain.Evm;
    case Chain.Stellar:
      return ManifestChain.Stellar;
    case Chain.Solana:
      return ManifestChain.Solana;
    case Chain.All:
      throw new Error("Chain.All does not identify a single manifest network");
  }
  throw new Error(`Unsupported SDK chain: ${String(chain)}`);
}

export function selectDeployment(
  manifest: DeploymentManifest,
  chain: ManifestChain,
  network: string,
  expectedNetworkId: string,
): ManifestDeployment {
  const matches = manifest.deployments.filter(
    (deployment) => deployment.chain === chain && deployment.network === network,
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No ${chain} deployment recorded for ${network}`
        : `Multiple ${chain} deployment records found for ${network}`,
    );
  }

  const [deployment] = matches;
  if (deployment.networkId !== expectedNetworkId) {
    throw new Error(
      `Network identity mismatch for ${chain}/${network}: expected ${expectedNetworkId}, manifest has ${deployment.networkId}`,
    );
  }
  return deployment;
}

export function selectContract(
  deployment: ManifestDeployment,
  name: string,
): ManifestContract {
  const matches = deployment.contracts.filter((contract) => contract.name === name);
  if (matches.length > 1) {
    throw new Error(`Multiple records for ${deployment.chain}/${deployment.network}/${name}`);
  }
  const [contract] = matches;
  if (contract) return contract;

  const undeployed = deployment.undeployed?.find((record) => record.name === name);
  if (undeployed) {
    throw new Error(
      `${deployment.chain}/${deployment.network}/${name} is undeployed: ${undeployed.reason}`,
    );
  }
  throw new Error(`${deployment.chain}/${deployment.network}/${name} is not recorded`);
}

export function artifactHash(bytes: Uint8Array, algorithm: ArtifactHashAlgorithm): string {
  switch (algorithm) {
    case "keccak256":
      return `0x${bytesToHex(keccak_256(bytes))}`;
    case "sha256":
      return `0x${bytesToHex(sha256(bytes))}`;
    case "blake2b-256":
      return `0x${bytesToHex(blake2b(bytes, { dkLen: 32, personalization: CKB_PERSONALIZATION }))}`;
  }
}

export function verifyArtifactHash(contract: ManifestContract, bytes: Uint8Array): string {
  const actual = artifactHash(bytes, contract.artifactHash.algorithm);
  if (actual !== contract.artifactHash.value) {
    throw new Error(
      `${contract.name} artifact hash mismatch: expected ${contract.artifactHash.value}, got ${actual}`,
    );
  }
  return actual;
}

export function verifySourceProvenance(
  contract: ManifestContract,
  bytes: Uint8Array,
): string {
  if (contract.external) {
    throw new Error(`${contract.name} is third-party code and has no first-party source provenance`);
  }
  const sourceCommit = contract.sourceCommit;
  if (
    contract.provenance?.status !== "source-verified" ||
    sourceCommit === null ||
    !COMMIT.test(sourceCommit)
  ) {
    throw new Error(`${contract.name} source is not verified; do not claim first-party provenance`);
  }
  verifyArtifactHash(contract, bytes);
  return sourceCommit;
}
