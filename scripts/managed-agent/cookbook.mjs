// File labels in the cookbook identify modules and their continuation blocks.
export function cookbook(fences) {
  const files = new Map();
  for (const { code, line } of fences) {
    const name = /^\s*\/\/ ([a-z0-9-]+\.ts)\b/.exec(code)?.[1];
    if (!name) throw new Error(`Cookbook line ${line}: expected a filename comment`);
    files.set(name, (files.get(name) ?? "") + "\n" + code + "\n");
  }
  // Only the host application's database, alerts and scheduler are supplied here.
  files.set("cookbook-app.d.ts", `
    declare const db: {
      payments: { create(input: { amount: string, token: string, stealthAddress: string, receivedAt: string }): Promise<void> };
      contributors: { update(input: { where: { id: string }, data: { wraithName: string } }): Promise<void> };
      privacyReports: { create(input: { data: import("./privacy-analysis.js").PrivacyReport }): Promise<void> };
    };
    declare function alertOpsTeam(message: string): Promise<void>;
    declare module "node-cron" {
      const cron: { schedule(expression: string, task: () => Promise<void>): unknown };
      export default cron;
    }
  `);
  files.set("cookbook.ts", `
    import assert from "node:assert/strict";
    import { Keypair } from "@stellar/stellar-sdk";

    const owner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
    process.env.OWNER_SECRET = owner.secret();
    process.env.WRAITH_API_KEY = "fixture-api-key";
    const calls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      calls.push(path);
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer fixture-api-key");
      const body = JSON.parse(String(init.body));
      if (path === "/agent/create") {
        assert.equal(body.chain, "stellar");
        assert.equal(body.name, "payments");
        assert.equal(body.wallet, owner.publicKey());
        assert.ok(owner.verify(Buffer.from(body.message), Buffer.from(body.signature, "hex")));
        return Response.json({ id: "payments-id", name: body.name, chains: [body.chain],
          addresses: { stellar: owner.publicKey() }, metaAddresses: { stellar: "fixture-meta" } });
      }
      assert.equal(path, "/agent/payments-id/chat");
      assert.deepEqual(body, { message: "fund my wallet" });
      return Response.json({ response: "Funded on testnet", conversationId: "fixture-chat" });
    };
    const { agent, funding } = await import("./create-payments.js");
    assert.deepEqual(calls, ["/agent/create", "/agent/payments-id/chat"]);
    assert.equal(agent.info.addresses.stellar, owner.publicKey());
    assert.equal(funding.response, "Funded on testnet");
  `);
  return files;
}
