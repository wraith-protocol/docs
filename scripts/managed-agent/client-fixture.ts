import assert from "node:assert/strict";

export const walletAddress = "0xYourWallet";
export const wallet = { signMessage: async (message: string) => "fixture:" + message };

export function installClientFixture() {
  // Each page runs in a fresh Node process. Intercept every request before
  // constructing the real SDK client so no example can reach the network.
  process.env.WRAITH_API_KEY = "fixture-key";
  const info = {
    id: "fixture-agent", name: "alice", chains: ["horizen"],
    addresses: { horizen: "0x01" }, metaAddresses: { horizen: "st:eth:fixture" },
  };
  const routes = new Map<string, unknown>([
    ["GET /agents", [info]],
    ["GET /agent/wallet/0xYourWallet", info],
    ["GET /agent/wallet/0xMyWallet", info],
    ["GET /agent/info/alice", info],
    ["GET /agent/fixture-agent/status", { balance: "1.5", tokens: { USDC: "50" } }],
    ["GET /agent/fixture-agent/conversations", []],
    ["GET /agent/fixture-agent/conversations/conv-uuid/messages", []],
    ["DELETE /agent/fixture-agent/conversations/conv-uuid", {}],
    ["GET /agent/fixture-agent/notifications", { notifications: [], unreadCount: 0 }],
    ["POST /agent/fixture-agent/notifications/read", {}],
    ["DELETE /agent/fixture-agent/notifications", {}],
  ]);
  const seen = new Set<string>();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.wraith.dev");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
    const route = init?.method + " " + url.pathname;
    seen.add(route);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (route === "POST /agent/create") {
      assert.equal(body.chain, "horizen");
      assert.equal(body.name, info.name);
      assert.equal(body.wallet, walletAddress);
      assert.equal(body.signature, body.message ? await wallet.signMessage(body.message) : "0xSignatureFromWallet");
      return Response.json(info);
    }
    if (route === "POST /agent/fixture-agent/chat") {
      assert.equal(typeof body.message, "string");
      if (body.message === "what was the tx hash?") assert.equal(body.conversationId, "conv-uuid");
      if (body.message === "send 100 ETH to bob.wraith") return new Response(null, { status: 400 });
      return Response.json({ response: "Fixture reply", conversationId: "conv-uuid" });
    }
    if (route === "POST /agent/fixture-agent/export") {
      assert.equal(body.message, "Export private key for agent " + info.id);
      assert.equal(body.signature, await wallet.signMessage(body.message));
      return Response.json({ secret: "fixture-only" });
    }
    assert.ok(routes.has(route), "Unexpected request: " + route);
    return Response.json(routes.get(route));
  };
  return {
    verify() {
      for (const route of ["POST /agent/create", "GET /agent/fixture-agent/status", "POST /agent/fixture-agent/chat"]) {
        assert.ok(seen.has(route), "Missing request: " + route);
      }
    },
  };
}
