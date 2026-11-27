import test from "node:test";
import assert from "node:assert/strict";
import { replaceShellPlaceholders } from "./shell-snippet-utils.ts";

test("replaces angle-bracket placeholders in shell examples", () => {
  assert.equal(
    replaceShellPlaceholders(
      "deploy --network <chain>\nSECRET=<your-secret-key>\nURL=https://example.com/<API_KEY>",
    ),
    "deploy --network placeholder\nSECRET=placeholder\nURL=https://example.com/placeholder",
  );
});

test("leaves shell redirections without placeholder tokens unchanged", () => {
  assert.equal(replaceShellPlaceholders("command < input.txt"), "command < input.txt");
});
