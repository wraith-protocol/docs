// Source: ../../../architecture/overview.mdx#public-sdk-fixture

import { Chain, type Payment, Wraith } from "@wraith-protocol/sdk";

export async function createAgentAndScan(
  wraith: Wraith,
  wallet: string,
  signature: string,
): Promise<Payment[]> {
  const agent = await wraith.createAgent({
    name: "alice",
    chain: Chain.Ethereum,
    wallet,
    signature,
  });

  return agent.scanPayments();
}
