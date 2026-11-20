import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import test from "node:test";
import { Address, Networks, TransactionBuilder, scValToNative } from "@stellar/stellar-sdk";
import { decodeStealthMetaAddress } from "@wraith-protocol/sdk/chains/stellar";

test("the sponsored batch guide builds unsigned envelopes from valid recipients", async (t) => {
  const guide = await readFile("guides/stellar/sponsored-batch-send.mdx", "utf8");
  const example = guide.split("## Use real recipient input")[0];
  const snippets = [...example.matchAll(/^\x60{3}typescript\n([\s\S]*?)^\x60{3}$/gm)].map(match => match[1]);
  const dir = await mkdtemp(resolve("node_modules/.sponsored-batch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sample = join(dir, "guide.mts");
  await writeFile(sample, snippets.join("\n") +
    "\nexport { testRecipients, batch, buildSponsoredBatch, sponsor, sender, fixtureContract, fixtureMetaAddress };");
  const { testRecipients, batch, buildSponsoredBatch, sponsor, sender, fixtureContract, fixtureMetaAddress } =
    await import(pathToFileURL(sample).href);

  assert.equal(new Set(testRecipients).size, 100);
  assert.deepEqual(testRecipients, Array.from({ length: 100 }, (_, i) => fixtureMetaAddress(i)));
  for (const address of testRecipients) decodeStealthMetaAddress(address);
  const visible = guide.match(/st:xlm:[^\s"`]+/g) ?? [];
  assert.ok(visible.includes(testRecipients[0]));
  for (const address of visible) decodeStealthMetaAddress(address);

  const reopen = tx => TransactionBuilder.fromXDR(tx.toXDR(), Networks.TESTNET);
  const reserves = reopen(batch.reserves);
  const payment = reopen(batch.payment);
  assert.equal(reserves.signatures.length, 0);
  assert.equal(payment.signatures.length, 0);
  assert.equal(reserves.operations.length, 72);
  assert.equal(payment.operations.length, 1);
  const invoke = payment.operations[0].func.invokeContract();
  assert.equal(invoke.functionName().toString(), "batch_send");
  const [, , , addresses, keys, metadata, amounts] = invoke.args();
  for (const vector of [addresses, keys, metadata, amounts]) assert.equal(vector.vec().length, 24);
  for (let i = 0; i < 24; i++) {
    const [begin, create, end] = reserves.operations.slice(i * 3, i * 3 + 3);
    const destination = Address.fromScVal(addresses.vec()[i]).toString();
    assert.deepEqual([begin.type, create.type, end.type],
      ["beginSponsoringFutureReserves", "createAccount", "endSponsoringFutureReserves"]);
    const recipient = batch.recipients[i];
    assert.equal(recipient.stealthAddress, destination);
    assert.deepEqual(keys.vec()[i].bytes(), Buffer.from(recipient.ephemeralPubKey));
    assert.deepEqual(metadata.vec()[i].bytes(), Buffer.from([recipient.viewTag]));
    assert.equal(begin.sponsoredId, destination);
    assert.equal(create.destination, destination);
    assert.equal(end.source, destination);
    assert.equal(scValToNative(amounts.vec()[i]), 10_000_000n);
  }

  const malformed = testRecipients[1].slice(0, -1);
  assert.throws(() => buildSponsoredBatch([testRecipients[0], malformed], sponsor, sender, fixtureContract),
    /length|invalid/i);
});
