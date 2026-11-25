// Source: ../../../architecture/chain-connectors.mdx#public-sdk-fixture

import { Chain, type Payment, type WraithAgent } from "@wraith-protocol/sdk";
import {
  type Announcement as EvmAnnouncement,
  type HexString,
  type MatchedAnnouncement as EvmMatchedAnnouncement,
  fetchAnnouncements as fetchEvmAnnouncements,
  scanAnnouncements as scanEvmAnnouncements,
} from "@wraith-protocol/sdk/chains/evm";
import {
  type Announcement as StellarAnnouncement,
  type MatchedAnnouncement as StellarMatchedAnnouncement,
  fetchAnnouncements as fetchStellarAnnouncements,
  scanAnnouncements as scanStellarAnnouncements,
} from "@wraith-protocol/sdk/chains/stellar";

export interface AgentScanner {
  readonly chain: Chain;
  scanPayments(): Promise<Payment[]>;
}

export function createAgentScanner(agent: WraithAgent, chain: Chain): AgentScanner {
  return {
    chain,
    scanPayments: () => agent.scanPayments(),
  };
}

export function evmAnnouncementFields(announcement: EvmAnnouncement): {
  stealthAddress: HexString;
  ephemeralPubKey: HexString;
  metadata: HexString;
} {
  return {
    stealthAddress: announcement.stealthAddress,
    ephemeralPubKey: announcement.ephemeralPubKey,
    metadata: announcement.metadata,
  };
}

export function stellarAnnouncementFields(announcement: StellarAnnouncement): {
  stealthAddress: string;
  ephemeralPubKey: string;
  metadata: string;
} {
  return {
    stealthAddress: announcement.stealthAddress,
    ephemeralPubKey: announcement.ephemeralPubKey,
    metadata: announcement.metadata,
  };
}

export async function scanEvm(
  viewingKey: HexString,
  spendingPubKey: HexString,
  spendingKey: HexString,
): Promise<EvmMatchedAnnouncement[]> {
  const announcements = await fetchEvmAnnouncements(Chain.Horizen);
  return scanEvmAnnouncements(announcements, viewingKey, spendingPubKey, spendingKey);
}

export async function scanStellar(
  viewingKey: Uint8Array,
  spendingPubKey: Uint8Array,
  spendingScalar: bigint,
): Promise<StellarMatchedAnnouncement[]> {
  const announcements = await fetchStellarAnnouncements(Chain.Stellar);
  return scanStellarAnnouncements(announcements, viewingKey, spendingPubKey, spendingScalar);
}

export function evmSpendKey(match: EvmMatchedAnnouncement): HexString {
  return match.stealthPrivateKey;
}

export function stellarSpendScalar(match: StellarMatchedAnnouncement): bigint {
  return match.stealthPrivateScalar;
}
