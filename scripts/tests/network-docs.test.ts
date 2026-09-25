import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NETWORK_REGISTRY,
  checkCommandSyntax,
  extractSection,
  hasUnbalancedQuotes,
  findConflicts,
  findStaleStamps,
  isPlaceholder,
  normalisePlaceholders,
  resolveBlockNetwork,
  validateAgainstRegistry,
  validateEnvNames,
} from "../lib/network-docs.js";

const TESTNET_BLOCK = [
  "# Networks",
  "",
  "```bash",
  "STELLAR_NETWORK=testnet",
  'STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"',
  "STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org",
  "STELLAR_RPC_URL=https://soroban-testnet.stellar.org",
  "```",
  "",
].join("\n");

test("isPlaceholder recognises documented placeholder shapes", () => {
  assert.equal(isPlaceholder("CPLACEHOLDER_REGISTRY_TESTNET"), true);
  assert.equal(isPlaceholder("<YOUR_API_KEY>"), true);
  assert.equal(isPlaceholder("MAINNET_****"), true);
  assert.equal(isPlaceholder("https://horizon-testnet.stellar.org"), false);
});

test("extractSection pulls env assignments and commands out of bash fences", () => {
  const markdown = [
    "```bash",
    "STELLAR_NETWORK=testnet",
    'curl "https://friendbot.stellar.org?addr=GABC"',
    "```",
    "",
    "```typescript",
    "const ignored = 1;",
    "```",
    "",
  ].join("\n");

  const section = extractSection("reference/stellar-networks.mdx", markdown);
  assert.equal(section.env.length, 1);
  assert.equal(section.env[0].name, "STELLAR_NETWORK");
  assert.equal(section.commands.length, 1);
  assert.match(section.commands[0].command, /^curl/);
});

test("extractSection reads passphrase values from connection tables", () => {
  const markdown = [
    "| Property | Value |",
    "|---|---|",
    `| Network passphrase | \`${NETWORK_REGISTRY.testnet.passphrase}\` |`,
    "",
  ].join("\n");

  const section = extractSection("reference/stellar-networks.mdx", markdown);
  assert.equal(section.tableValues.length, 1);
  assert.equal(section.tableValues[0].value, NETWORK_REGISTRY.testnet.passphrase);
});

test("validateEnvNames reports unrecognised Stellar variables as warnings", () => {
  const section = extractSection(
    "guides/ops/example.mdx",
    ["```bash", "STELLAR_TYPO_URL=https://example.org", "```", ""].join("\n"),
  );
  const findings = validateEnvNames([section]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "ENV_NAME_UNRECOGNISED");
  assert.equal(findings[0].severity, "warning");
});

test("validateEnvNames rejects malformed names outright", () => {
  const section = extractSection(
    "guides/ops/example.mdx",
    ["```bash", "stellar_network=testnet", "```", ""].join("\n"),
  );
  const findings = validateEnvNames([section]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "ENV_NAME_FORMAT");
  assert.equal(findings[0].severity, "error");
});

test("hasUnbalancedQuotes keeps multi-line quoted payloads as one command", () => {
  const markdown = [
    "```bash",
    "curl -X POST https://api.usewraith.xyz/agent/create \\",
    '  -H "Content-Type: application/json" \\',
    "  -d '{",
    '    "chain": "stellar"',
    "  }'",
    "```",
    "",
  ].join("\n");

  const section = extractSection("docs/x.mdx", markdown);
  assert.equal(section.commands.length, 1);
  assert.match(section.commands[0].command, /"chain": "stellar"/);
  assert.match(section.commands[0].command, /^curl -X POST/);
});

test("validateEnvNames accepts the documented allowlist", () => {
  const findings = validateEnvNames([extractSection("reference/stellar-networks.mdx", TESTNET_BLOCK)]);
  assert.deepEqual(findings, []);
});

test("resolveBlockNetwork reports the declared network per block", () => {
  const section = extractSection("reference/stellar-networks.mdx", TESTNET_BLOCK);
  assert.equal(resolveBlockNetwork(section, section.env[0].blockIndex), "testnet");
});

test("validateAgainstRegistry passes when values match the registry", () => {
  const findings = validateAgainstRegistry([
    extractSection("reference/stellar-networks.mdx", TESTNET_BLOCK),
  ]);
  assert.deepEqual(findings, []);
});

test("validateAgainstRegistry flags a drifted passphrase", () => {
  const markdown = [
    "```bash",
    "STELLAR_NETWORK=testnet",
    'STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2016"',
    "```",
    "",
  ].join("\n");
  const findings = validateAgainstRegistry([extractSection("reference/stellar-networks.mdx", markdown)]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "REGISTRY_MISMATCH");
});

test("validateAgainstRegistry ignores placeholder endpoints", () => {
  const markdown = [
    "```bash",
    "STELLAR_NETWORK=mainnet",
    "STELLAR_RPC_URL=https://mainnet.stellar.validationcloud.io/v1/<YOUR_API_KEY>",
    "```",
    "",
  ].join("\n");
  const findings = validateAgainstRegistry([extractSection("reference/stellar-networks.mdx", markdown)]);
  assert.deepEqual(findings, []);
});

test("validateAgainstRegistry rejects an unknown network", () => {
  const markdown = ["```bash", "STELLAR_NETWORK=localnet", "```", ""].join("\n");
  const findings = validateAgainstRegistry([extractSection("docs/x.mdx", markdown)]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "NETWORK_UNKNOWN");
});

test("findConflicts reports the same variable with two different values", () => {
  const a = extractSection("docs/a.mdx", ["```bash", "STELLAR_RPC_URL=https://one.example.org", "```", ""].join("\n"));
  const b = extractSection("docs/b.mdx", ["```bash", "STELLAR_RPC_URL=https://two.example.org", "```", ""].join("\n"));
  const findings = findConflicts([a, b]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "ENV_VALUE_CONFLICT");
});

test("findConflicts ignores repeated identical values", () => {
  const a = extractSection("docs/a.mdx", ["```bash", "STELLAR_RPC_URL=https://one.example.org", "```", ""].join("\n"));
  const b = extractSection("docs/b.mdx", ["```bash", "STELLAR_RPC_URL=https://one.example.org", "```", ""].join("\n"));
  assert.deepEqual(findConflicts([a, b]), []);
});

test("findConflicts scopes comparison per network", () => {
  const testnet = extractSection(
    "reference/stellar-networks.mdx",
    ["```bash", "STELLAR_NETWORK=testnet", "STELLAR_RPC_URL=https://soroban-testnet.stellar.org", "```", ""].join("\n"),
  );
  const mainnet = extractSection(
    "guides/stellar-mainnet-deployment.mdx",
    ["```bash", "STELLAR_NETWORK=mainnet", "STELLAR_RPC_URL=https://mainnet.example.org", "```", ""].join("\n"),
  );
  assert.deepEqual(findConflicts([testnet, mainnet]), []);
});

test("normalisePlaceholders neutralises redirection-looking placeholders", () => {
  const raw = "curl https://mainnet.stellar.validationcloud.io/v1/<API_KEY>";
  assert.equal(raw.includes("<API_KEY>"), true);
  const safe = normalisePlaceholders(raw);
  assert.equal(safe.includes("<API_KEY>"), false);
  assert.equal(safe.includes(">"), false);
});

test("checkCommandSyntax reports failures from the injected checker", () => {
  const section = extractSection("docs/x.mdx", ["```bash", "curl https://example.org", "```", ""].join("\n"));
  const findings = checkCommandSyntax([section], (command) =>
    command.includes("example.org") ? "unexpected EOF" : null,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "COMMAND_SYNTAX");
});

test("findStaleStamps flags verification stamps older than the limit", () => {
  const files = [
    { file: "reference/stellar-networks.mdx", markdown: "<!-- Last verified: 2026-01-01. -->\n" },
  ];
  const findings = findStaleStamps(files, new Date("2026-09-25T00:00:00Z"), 120);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "STALE_VERIFICATION");
});

test("findStaleStamps ignores fresh stamps", () => {
  const files = [
    { file: "reference/stellar-networks.mdx", markdown: "<!-- Last verified: 2026-07-29. -->\n" },
  ];
  assert.deepEqual(findStaleStamps(files, new Date("2026-09-25T00:00:00Z"), 120), []);
});
