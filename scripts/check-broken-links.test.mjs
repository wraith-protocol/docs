import test from "node:test";
import assert from "node:assert/strict";
import {
  EXTERNAL_DEFAULTS,
  buildPageIndex,
  checkExternalUrl,
  classifyNetworkError,
  classifyStatus,
  collectExternalSources,
  decideExitCode,
  docsJsonAssets,
  extractAnchors,
  extractLinks,
  fileToUrl,
  formatReport,
  internalPathname,
  isPublicAddress,
  normalizeUrl,
  parseArgs,
  requestWithRetries,
  resolveExternalTarget,
  runExternalChecks,
  slugify,
  splitTarget,
  validateInternalLink,
  validateRedirects,
} from "./check-broken-links.mjs";

function config(overrides = {}) {
  return { ...EXTERNAL_DEFAULTS, backoffMs: [1], budgetMs: 10_000, startedAt: 0, ...overrides };
}

function fakeDeps({ responses = [], resolver, now } = {}) {
  const requests = [];
  return {
    requests,
    deps: {
      resolveHost:
        resolver ??
        (async () => [
          { address: "93.184.216.34", family: 4 },
        ]),
      request: async (request) => {
        requests.push(request);
        if (responses.length === 0) return { error: Object.assign(new Error("no fake response"), { code: "EFAKE" }) };
        return responses.shift();
      },
      sleep: async () => {},
      now: now ?? (() => 0),
    },
  };
}

test("parses supported flags and rejects unknown options", () => {
  assert.deepEqual(parseArgs(["--internal-only"]), {
    internal: true,
    external: false,
    strictExternal: false,
    verbose: false,
    jsonPath: null,
    help: false,
  });
  assert.equal(parseArgs(["--external-only"]).internal, false);
  assert.equal(parseArgs(["--strict-external", "--verbose"]).strictExternal, true);
  assert.equal(parseArgs(["--json", "out.json"]).jsonPath, "out.json");
  assert.equal(parseArgs(["--json=out.json"]).jsonPath, "out.json");
  assert.throws(() => parseArgs(["--internl-only"]), /Unknown option/);
  assert.throws(() => parseArgs(["--json"]), /needs a file path/);
});

test("extracts markdown, reference, HTML/JSX, and autolinks but not code", () => {
  const markdown = [
    "[guide](/guides/one#step) and ![diagram](/assets/one.svg)",
    '<Card href="/guides/two" />',
    '<iframe src="/scripts/playground/index.html?step=send" />',
    "",
    "[ref]: https://example.com/reference",
    "<https://example.com/auto>",
    "",
    "```ts",
    "const link = [notALink](/missing-page);",
    "```",
    "Inline `[alsoNot](/missing-code)` span.",
    "{/* [commented](/missing-comment) */}",
    "```",
    "## Heading inside a fence",
    "```",
  ].join("\n");

  const targets = extractLinks(markdown).map((link) => link.target);
  assert.deepEqual(targets, [
    "/guides/one#step",
    "/assets/one.svg",
    "/guides/two",
    "/scripts/playground/index.html?step=send",
    "https://example.com/reference",
    "https://example.com/auto",
  ]);
});

test("ignores lookalike MDX in code but keeps line numbers stable", () => {
  const markdown = ["# Title", "", "```mdx", "[broken](/nowhere)", "```", "", "[real](/target)"].join("\n");
  const links = extractLinks(markdown);
  assert.deepEqual(links, [{ target: "/target", line: 7 }]);
});

test("slugifies headings the way Mintlify renders them", () => {
  assert.equal(slugify("Getting Started"), "getting-started");
  assert.equal(slugify("Swap + Announce"), "swap-+-announce");
  assert.equal(slugify("Soroban RPC / Indexer Errors"), "soroban-rpc-/-indexer-errors");
  assert.equal(slugify("SDK Errors — Stellar Chain Primitives"), "sdk-errors-—-stellar-chain-primitives");
  assert.equal(slugify("18. `op_no_trust` / Missing Trustline"), "18-op_no_trust-/-missing-trustline");
  assert.equal(slugify("2. Imperative `stream.cancel()` Method"), "2-imperative-stream-cancel-method");
  assert.equal(slugify("The Problem: Naive Scanning Costs O(N) ECDH"), "the-problem-naive-scanning-costs-o-n-ecdh");
  assert.equal(slugify("Why ed25519?"), "why-ed25519");
  assert.equal(slugify("Account & Balance Errors"), "account-&-balance-errors");
});

test("numbers duplicate headings from 2 and honours explicit ids", () => {
  const anchors = extractAnchors(
    [
      "## StealthKeys",
      "## StealthKeys",
      "## StealthKeys",
      "## Custom {#my-anchor}",
      '<a id="legacy"></a>',
      '<h3 id="html-heading">Rendered heading</h3>',
    ].join("\n"),
  );
  for (const anchor of ["stealthkeys", "stealthkeys-2", "stealthkeys-3", "my-anchor", "legacy", "html-heading"]) {
    assert.ok(anchors.has(anchor), anchor);
  }
});

test("keeps inline code in heading slugs but drops fenced heading lookalikes", () => {
  const anchors = extractAnchors(["```", "## Not A Heading", "```", "## `stealth-registry`"].join("\n"));
  assert.ok(anchors.has("stealth-registry"));
  assert.equal(anchors.has("not-a-heading"), false);
});

test("maps files to URLs and supports directory index pages", () => {
  assert.equal(fileToUrl("sdk/overview.mdx"), "/sdk/overview");
  assert.equal(normalizeUrl("/guides/one/"), "/guides/one");
  const index = buildPageIndex(["guides/index.mdx", "sdk/overview.mdx", "README.mdx"]);
  assert.equal(index.get("/guides"), "guides/index.mdx");
  assert.equal(index.get("/sdk/overview"), "sdk/overview.mdx");
  assert.equal(index.get("/"), "README.mdx");
});

test("resolves internal paths with Mintlify semantics", () => {
  assert.equal(internalPathname("sdk/overview.mdx", "agent-client"), "/agent-client");
  assert.equal(internalPathname("sdk/overview.mdx", "./agent-client"), "/sdk/agent-client");
  assert.equal(internalPathname("api-reference/stealth-keys.mdx", "../guides/stellar/passkey-signing.mdx"), "/guides/stellar/passkey-signing");
  assert.equal(internalPathname("getting-started.mdx", "guides/single-chain-agent"), "/guides/single-chain-agent");
  assert.equal(internalPathname("guides/one.mdx", ""), "/guides/one");
  assert.deepEqual(splitTarget("/guides/one?tab=ts#step-two"), { pathname: "/guides/one", query: "?tab=ts", anchor: "step-two" });
});

test("validates routes, anchors, redirects, and assets", () => {
  const pageIndex = buildPageIndex(["sdk/overview.mdx", "sdk/agent-client.mdx", "reference/error-codes.mdx"]);
  const anchorsByFile = new Map([
    ["sdk/agent-client.mdx", extractAnchors("## createAgent\n## createAgent")],
    ["reference/error-codes.mdx", extractAnchors("## Soroban RPC / Indexer Errors")],
  ]);
  const redirectSources = new Set(["/old-url"]);
  const staticExists = (url) => url === "/assets/diagrams/flow.svg" || url === "/scripts/playground/index.html";

  const base = { pageIndex, anchorsByFile, redirectSources, staticExists };
  assert.equal(validateInternalLink({ source: "sdk/overview.mdx", target: "/sdk/agent-client#createagent", ...base }), null);
  assert.equal(validateInternalLink({ source: "sdk/overview.mdx", target: "/sdk/agent-client#createagent-2", ...base }), null);
  assert.equal(validateInternalLink({ source: "sdk/overview.mdx", target: "/old-url", ...base }), null);
  assert.equal(validateInternalLink({ source: "sdk/overview.mdx", target: "/assets/diagrams/flow.svg", ...base }), null);
  assert.equal(
    validateInternalLink({ source: "sdk/overview.mdx", target: "/scripts/playground/index.html?step=send", ...base }),
    null,
  );

  const missingPage = validateInternalLink({ source: "sdk/overview.mdx", target: "agent-client", ...base });
  assert.equal(missingPage.reason, "missing-page");
  assert.match(missingPage.detail, /Did you mean \/sdk\/agent-client/);

  const missingAnchor = validateInternalLink({ source: "sdk/overview.mdx", target: "/sdk/agent-client#nope", ...base });
  assert.equal(missingAnchor.reason, "missing-anchor");
  assert.match(missingAnchor.detail, /no anchor "#nope" on \/sdk\/agent-client/);

  // A slash-separated heading keeps its punctuation in the rendered id.
  assert.equal(
    validateInternalLink({ source: "reference/error-codes.mdx", target: "#soroban-rpc-/-indexer-errors", ...base }),
    null,
  );
  assert.equal(
    validateInternalLink({ source: "reference/error-codes.mdx", target: "#soroban-rpc--indexer-errors", ...base }).reason,
    "missing-anchor",
  );

  const missingAsset = validateInternalLink({ source: "sdk/overview.mdx", target: "/assets/diagrams/missing.svg", ...base });
  assert.equal(missingAsset.reason, "missing-asset");
  assert.match(missingAsset.detail, /no shipped file at \/assets\/diagrams\/missing.svg/);
});

test("reports redirect problems and docs.json brand assets", () => {
  const pageIndex = buildPageIndex(["introduction.mdx"]);
  assert.deepEqual(validateRedirects([{ source: "/README", destination: "/introduction" }], pageIndex), []);
  assert.equal(validateRedirects([{ source: "/a", destination: "/missing" }], pageIndex)[0].reason, "missing-page");
  assert.equal(validateRedirects([{ source: "/a", destination: "/introduction#x" }], pageIndex)[0].reason, "invalid-redirect");
  assert.equal(
    validateRedirects(
      [
        { source: "/a", destination: "/introduction" },
        { source: "/a", destination: "/introduction" },
      ],
      pageIndex,
    )[0].reason,
    "duplicate-redirect",
  );
  assert.deepEqual(docsJsonAssets({ logo: { dark: "/assets/dark.png", light: "https://cdn/light.png" }, favicon: "/assets/fav.png" }), [
    "/assets/dark.png",
    "/assets/fav.png",
  ]);
});

test("classifies external HTTP statuses", () => {
  assert.equal(classifyStatus(204), "ok");
  assert.equal(classifyStatus(404), "permanent");
  assert.equal(classifyStatus(410), "permanent");
  assert.equal(classifyStatus(429), "transient");
  assert.equal(classifyStatus(408), "transient");
  assert.equal(classifyStatus(425), "transient");
  assert.equal(classifyStatus(503), "transient");
  assert.equal(classifyStatus(403), "inaccessible");
  assert.equal(classifyStatus(301), "transient");
  assert.equal(classifyNetworkError({ code: "ETIMEDOUT" }), "transient");
  assert.equal(classifyNetworkError({ code: "CERT_HAS_EXPIRED" }), "insecure");
});

test("rejects private, loopback, link-local, reserved, and mapped addresses", () => {
  const blocked = [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.0.10",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "198.18.0.5",
    "192.0.2.10",
    "203.0.113.9",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456:789a::1",
    "ff02::1",
    "2001:db8::1",
    "100::1",
    "2001:0:1::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "2002:7f00:1::",
    "64:ff9b::7f00:1",
    "not-an-ip",
  ];
  for (const address of blocked) assert.equal(isPublicAddress(address), false, address);

  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("resolves public hosts and pins the validated address", async () => {
  const { deps } = fakeDeps({
    resolver: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ],
  });
  const resolved = await resolveExternalTarget("https://example.com/docs", deps);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.address, "93.184.216.34");
  assert.equal(resolved.family, 4);
});

test("refuses to fetch a private literal or a host with a private answer", async () => {
  const literal = fakeDeps();
  const literalResult = await resolveExternalTarget("http://127.0.0.1:8080/admin", literal.deps);
  assert.equal(literalResult.ok, false);
  assert.equal(literalResult.kind, "blocked");

  const metadata = fakeDeps();
  const metadataResult = await resolveExternalTarget("http://169.254.169.254/latest/meta-data", metadata.deps);
  assert.equal(metadataResult.kind, "blocked");

  // DNS rebinding: one public and one private answer must block the whole host.
  const mixed = fakeDeps({
    resolver: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ],
  });
  const mixedResult = await resolveExternalTarget("https://rebind.test/", mixed.deps);
  assert.equal(mixedResult.kind, "blocked");
});

test("classifies DNS and scheme failures without requesting", async () => {
  const dnsFailure = fakeDeps({
    resolver: async () => {
      throw Object.assign(new Error("no such host"), { code: "ENOTFOUND" });
    },
  });
  const dnsResult = await checkExternalUrl("https://missing.test/", dnsFailure.deps, config());
  assert.equal(dnsResult.status, "transient");
  assert.match(dnsResult.detail, /DNS lookup failed/);

  const unsupported = fakeDeps();
  const ftpResult = await checkExternalUrl("ftp://example.com/file", unsupported.deps, config());
  assert.equal(ftpResult.status, "skipped");
  assert.equal(unsupported.requests.length, 0);
});

test("retries transient failures within the attempt budget only", async () => {
  const flaky = fakeDeps({ responses: [{ status: 503 }, { status: 503 }, { status: 200 }] });
  const flakyResult = await checkExternalUrl("https://example.com/flaky", flaky.deps, config({ maxAttempts: 3 }));
  assert.equal(flakyResult.status, "ok");
  assert.equal(flaky.requests.length, 3);

  const down = fakeDeps({ responses: [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 200 }] });
  const downResult = await checkExternalUrl("https://example.com/down", down.deps, config({ maxAttempts: 3 }));
  assert.equal(downResult.status, "transient");
  assert.equal(down.requests.length, 3);

  const rateLimited = fakeDeps({ responses: [{ status: 429 }, { status: 200 }] });
  assert.equal((await checkExternalUrl("https://example.com/rate", rateLimited.deps, config())).status, "ok");

  const gone = fakeDeps({ responses: [{ status: 404 }] });
  assert.equal((await checkExternalUrl("https://example.com/gone", gone.deps, config())).status, "permanent");
  assert.equal(gone.requests.length, 1);
});

test("falls back from HEAD to GET when a server rejects HEAD", async () => {
  const { deps, requests } = fakeDeps({ responses: [{ status: 405 }, { status: 200 }] });
  const result = await checkExternalUrl("https://example.com/head-hostile", deps, config({ maxAttempts: 1 }));
  assert.equal(result.status, "ok");
  assert.deepEqual(
    requests.map((request) => request.method),
    ["HEAD", "GET"],
  );
  assert.equal(requests[0].address, "93.184.216.34");
});

test("revalidates every redirect hop and blocks a redirect into private space", async () => {
  let lookups = 0;
  const { deps, requests } = fakeDeps({
    responses: [{ status: 302, location: "https://rebind.test/internal" }],
    resolver: async () => {
      lookups += 1;
      return lookups === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "10.0.0.7", family: 4 }];
    },
  });

  const result = await checkExternalUrl("https://rebind.test/start", deps, config());
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /non-public address 10\.0\.0\.7/);
  assert.equal(requests.length, 1, "the private hop must never be requested");
  assert.equal(lookups, 2);
});

test("follows public redirects manually and gives up after the hop budget", async () => {
  const redirected = fakeDeps({
    responses: [{ status: 301, location: "/moved" }, { status: 200 }],
  });
  const result = await checkExternalUrl("https://example.com/old", redirected.deps, config());
  assert.equal(result.status, "ok");
  assert.equal(redirected.requests.length, 2);
  assert.equal(redirected.requests[1].url.pathname, "/moved");

  const loop = fakeDeps({
    responses: [
      { status: 302, location: "/one" },
      { status: 302, location: "/two" },
      { status: 302, location: "/three" },
    ],
  });
  const loopResult = await checkExternalUrl("https://example.com/loop", loop.deps, config({ maxRedirects: 2 }));
  assert.equal(loopResult.status, "permanent");
  assert.match(loopResult.detail, /more than 2 redirects/);
});

test("stops issuing requests once the shared budget is exhausted", async () => {
  const { deps, requests } = fakeDeps({ now: () => 5_000, responses: [{ status: 200 }] });
  const results = await runExternalChecks(
    ["https://example.com/a", "https://example.com/b"],
    deps,
    config({ budgetMs: 100, startedAt: 0, concurrency: 1 }),
  );
  assert.deepEqual(
    results.map((result) => result.status),
    ["skipped", "skipped"],
  );
  assert.equal(requests.length, 0);
});

test("keeps external results in input order and marks over-budget work as skipped", async () => {
  const { deps } = fakeDeps({
    responses: [{ status: 200 }, { status: 404 }],
  });
  const results = await runExternalChecks(
    ["https://example.com/a", "https://example.com/b"],
    deps,
    config({ concurrency: 2 }),
  );
  assert.deepEqual(
    results.map((result) => [result.target, result.status]),
    [
      ["https://example.com/a", "ok"],
      ["https://example.com/b", "permanent"],
    ],
  );
});

test("only internal failures and strict permanent externals fail the run", () => {
  const permanent = [{ target: "https://example.com", status: "permanent" }];
  assert.equal(decideExitCode({ internalFailures: [{ source: "a.mdx" }], externalResults: permanent, strictExternal: false }), 1);
  assert.equal(decideExitCode({ internalFailures: [], externalResults: permanent, strictExternal: false }), 0);
  assert.equal(decideExitCode({ internalFailures: [], externalResults: permanent, strictExternal: true }), 1);
  assert.equal(
    decideExitCode({ internalFailures: [], externalResults: [{ target: "https://example.com", status: "transient" }], strictExternal: true }),
    0,
  );
});

test("groups external URLs by source page and reports both sides", () => {
  const sources = collectExternalSources([
    { file: "a.mdx", links: [{ target: "https://example.com/x#one" }, { target: "/internal" }] },
    { file: "b.mdx", links: [{ target: "https://example.com/x" }, { target: "https://example.com/y" }] },
  ]);
  assert.deepEqual([...sources.keys()].sort(), ["https://example.com/x", "https://example.com/y"]);
  assert.deepEqual([...sources.get("https://example.com/x")], ["a.mdx", "b.mdx"]);

  const report = formatReport({
    internalFailures: [{ source: "sdk/overview.mdx", target: "agent-client", reason: "missing-page", detail: "no docs page at /agent-client." }],
    externalResults: [
      { target: "https://example.com/x", status: "permanent", detail: "HTTP 404 after 1 attempt(s)" },
      { target: "https://example.com/ok", status: "ok", detail: "HTTP 200 after 1 attempt(s)" },
    ],
    externalSources: sources,
    stats: { pageCount: 3, internalLinkCount: 4, staticAssetCount: 1, externalElapsedMs: 1000 },
    strictExternal: false,
  });
  assert.match(report, /sdk\/overview\.mdx: "agent-client" -> no docs page at \/agent-client/);
  assert.match(report, /PERMANENT a\.mdx, b\.mdx: https:\/\/example\.com\/x -> HTTP 404/);
  assert.match(report, /advisory/);
});

test("request retries never exceed the configured attempt budget", async () => {
  const { deps, requests } = fakeDeps({ responses: [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }] });
  const response = await requestWithRetries(
    { url: new URL("https://example.com/"), address: "93.184.216.34", family: 4 },
    deps,
    config({ maxAttempts: 2 }),
  );
  assert.equal(requests.length, 2);
  assert.equal(response.status, 500);
  assert.equal(response.attempts, 2);
});
