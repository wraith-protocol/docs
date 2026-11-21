import test from "node:test";
import assert from "node:assert/strict";
import {
  validateSnippetAllowlist,
  VALID_CATEGORIES,
} from "./snippet-allowlist.ts";

test("VALID_CATEGORIES contains expected distinct categories", () => {
  assert.ok(VALID_CATEGORIES.has("output"));
  assert.ok(VALID_CATEGORIES.has("pseudocode"));
  assert.ok(VALID_CATEGORIES.has("framework-example"));
  assert.ok(VALID_CATEGORIES.has("snippet-stub"));
});

test("passes on matching non-expired allowlist", () => {
  const allowlist = [
    {
      file: "docs/example.mdx",
      line: 42,
      category: "pseudocode",
      reason: "Illustrative algorithm step",
      owner: "core-team",
      expires: "2027-01-01",
    },
  ];

  const actual = [
    {
      file: "docs/example.mdx",
      line: 42,
      rawFence: "```ts no-check",
    },
  ];

  const failures = validateSnippetAllowlist(allowlist, actual, "2026-11-21");
  assert.equal(failures.length, 0);
});

test("fails on missing allowlist entry for inline bypass", () => {
  const allowlist = [];
  const actual = [
    {
      file: "docs/example.mdx",
      line: 42,
      rawFence: "```ts no-check",
    },
  ];

  const failures = validateSnippetAllowlist(allowlist, actual, "2026-11-21");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].type, "missing");
  assert.match(failures[0].message, /docs\/example\.mdx:42/);
});

test("fails on stale allowlist entry when fence was removed or made runnable", () => {
  const allowlist = [
    {
      file: "docs/old.mdx",
      line: 10,
      category: "output",
      reason: "Raw CLI output",
      owner: "devrel",
      expires: "2027-01-01",
    },
  ];
  const actual = [];

  const failures = validateSnippetAllowlist(allowlist, actual, "2026-11-21");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].type, "stale");
  assert.match(failures[0].message, /stale/);
});

test("fails on expired allowlist entry", () => {
  const allowlist = [
    {
      file: "docs/example.mdx",
      line: 20,
      category: "snippet-stub",
      reason: "Needs external crate",
      owner: "contracts-team",
      expires: "2026-11-20", // expired relative to 2026-11-21
    },
  ];
  const actual = [
    {
      file: "docs/example.mdx",
      line: 20,
      rawFence: "```rust no-check",
    },
  ];

  const failures = validateSnippetAllowlist(allowlist, actual, "2026-11-21");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].type, "expired");
  assert.match(failures[0].message, /expired on 2026-11-20/);
});

test("fails on duplicated allowlist entry", () => {
  const allowlist = [
    {
      file: "docs/example.mdx",
      line: 20,
      category: "snippet-stub",
      reason: "First entry",
      owner: "contracts-team",
      expires: "2027-11-20",
    },
    {
      file: "docs/example.mdx",
      line: 20,
      category: "snippet-stub",
      reason: "Second entry",
      owner: "contracts-team",
      expires: "2027-11-20",
    },
  ];
  const actual = [
    {
      file: "docs/example.mdx",
      line: 20,
      rawFence: "```rust no-check",
    },
  ];

  const failures = validateSnippetAllowlist(allowlist, actual, "2026-11-21");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].type, "duplicated");
  assert.match(failures[0].message, /duplicate/);
});

test("fails on invalid category or missing fields", () => {
  const allowlist = [
    {
      file: "docs/example.mdx",
      line: 20,
      category: "random-category",
      reason: "",
      owner: "",
      expires: "not-a-date",
    },
  ];
  const actual = [
    {
      file: "docs/example.mdx",
      line: 20,
      rawFence: "```rust no-check",
    },
  ];

  const failures = validateSnippetAllowlist(allowlist, actual, "2026-11-21");
  assert.ok(failures.length >= 4);
  assert.ok(failures.some((f) => f.message.includes("invalid category")));
  assert.ok(failures.some((f) => f.message.includes("missing or empty 'reason'")));
  assert.ok(failures.some((f) => f.message.includes("missing or empty 'owner'")));
  assert.ok(failures.some((f) => f.message.includes("invalid 'expires' date format")));
});
