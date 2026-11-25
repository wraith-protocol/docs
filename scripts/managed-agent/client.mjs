import { readFileSync } from "node:fs";

// The setup fences introduce the client and agent used throughout each page.
// Later fences are independent examples and may reuse local variable names.
export function client(fences, singleChain) {
  const setupCount = singleChain ? 1 : 2;
  const setup = fences.slice(0, setupCount).map(({ code }) => code).join("\n");
  const examples = fences.slice(setupCount).map(({ code, line }) =>
    `// MDX line ${line}\n{\n${code}\n}`,
  );
  const source = [
    'import assert from "node:assert/strict";',
    'import { installClientFixture, wallet, walletAddress } from "./client-fixture.js";',
    'const fixture = installClientFixture();',
    setup,
    'assert.equal(agent.info.id, "fixture-agent");',
    ...examples,
    'fixture.verify();',
  ].join("\n");
  return new Map([
    [singleChain ? "single-chain.ts" : "client.ts", source],
    ["client-fixture.ts", readFileSync(new URL("./client-fixture.ts", import.meta.url), "utf8")],
  ]);
}
