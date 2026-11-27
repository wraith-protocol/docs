// Source: ../../../architecture/tee.mdx#public-sdk-fixture

import { type WraithAgent } from "@wraith-protocol/sdk";

export async function exportAgentSecret(
  agent: WraithAgent,
  signature: string,
  message: string,
): Promise<string> {
  try {
    const result = await agent.exportKey(signature, message);
    return result.secret;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }

    throw error;
  }
}
