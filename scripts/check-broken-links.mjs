#!/usr/bin/env node
/**
 * check-broken-links.mjs
 *
 * Deterministic internal link checking plus bounded external link checking for
 * the shipped documentation. Run it locally before pushing:
 *
 *   node scripts/check-broken-links.mjs                 # internal + external
 *   node scripts/check-broken-links.mjs --internal-only # no network, fast
 *   node scripts/check-broken-links.mjs --external-only
 *   node scripts/check-broken-links.mjs --strict-external --json link-report.json
 *
 * Internal checks are deterministic and always fatal:
 *
 *   1. Every internal link resolves to a documentation page, a docs.json
 *      redirect source, or a file that actually ships in the repository.
 *   2. Every `#fragment` exists as a heading slug or an explicit `id`/`name`
 *      attribute on the target page.
 *   3. Every root-relative asset reference (`/assets/...`, `/scripts/...`) and
 *      every docs.json brand asset exists on disk.
 *   4. Every docs.json redirect destination resolves to a live page.
 *
 * Link resolution matches Mintlify: `/path` and a bare `path` are both resolved
 * from the site root, while `./path` and `../path` are resolved from the source
 * page directory. Bare nested paths such as `agent-client` inside
 * `sdk/overview.mdx` therefore need to be written `/sdk/agent-client`.
 *
 * External checks are bounded and advisory by default:
 *
 *   - Each URL gets at most EXTERNAL.maxAttempts attempts (HEAD, with a GET
 *     fallback for servers that reject HEAD) and a per-request timeout.
 *   - Retries only happen for transient classifications (429, 408, 425, 5xx,
 *     timeouts, DNS hiccups) with a small fixed backoff.
 *   - The whole external pass shares one wall-clock budget and a maximum URL
 *     count. Work that does not fit is reported as skipped, never as a failure,
 *     so a slow upstream cannot grow the job without limit.
 *   - Every host is resolved once per hop and pinned to the validated address.
 *     Private, loopback, link-local, multicast, reserved, and IPv4-mapped
 *     addresses are never contacted, and redirects are followed manually so
 *     each hop is revalidated. This keeps a repository-controlled URL from
 *     turning CI into an SSRF proxy.
 *
 * Exit codes: 0 on success (external warnings allowed), 1 on any internal
 * failure or, with --strict-external, on a permanent external failure.
 */
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = process.cwd();

/** Directories whose Markdown files belong to the docs site or docs tooling. */
const SHIPPED_DIRS = ["api-reference", "architecture", "concepts", "contracts", "docs", "guides", "reference", "sdk"];

const PAGE_EXTENSIONS = new Set([".md", ".mdx"]);

/** Defaults for the bounded external pass. All values are reviewed here. */
export const EXTERNAL_DEFAULTS = Object.freeze({
  concurrency: 6,
  timeoutMs: 8_000,
  maxAttempts: 3,
  backoffMs: [250, 750],
  budgetMs: 120_000,
  maxRedirects: 5,
  maxUrls: 300,
  userAgent: "wraith-docs-link-check/1.0 (+https://github.com/wraith-protocol/docs)",
});

const USAGE = `Usage: node scripts/check-broken-links.mjs [options]

Options:
  --internal-only     Check routes, anchors, and assets without network calls.
  --external-only     Check external URLs only (internal findings are not reported).
  --strict-external   Fail on permanent external failures (404/410, redirect loops).
                      Transient, blocked, and skipped URLs stay advisory.
  --json <path>       Write a machine-readable report to <path>.
  --verbose           Print every external URL result, not only failures.
  -h, --help          Show this message.

External checks are advisory unless --strict-external is passed.`;

/**
 * Parse CLI flags. Unknown flags are rejected so a typo cannot silently turn a
 * required check into a no-op.
 */
export function parseArgs(argv) {
  const options = { internal: true, external: true, strictExternal: false, verbose: false, jsonPath: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--internal-only") {
      options.external = false;
    } else if (arg === "--external-only") {
      options.internal = false;
    } else if (arg === "--strict-external") {
      options.strictExternal = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--json") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--json needs a file path.");
      options.jsonPath = value;
      i += 1;
    } else if (arg.startsWith("--json=")) {
      options.jsonPath = arg.slice("--json=".length);
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.internal && !options.external) options.internal = true;
  return options;
}

/** Replace an entire match with blank space while preserving line numbers. */
function blank(match) {
  return match.replace(/[^\n]/g, "");
}

/**
 * Remove content that can never contain a real link or heading: fenced code
 * blocks, MDX/HTML comments, and import/export statements. Line numbers are
 * preserved so reported positions stay useful.
 */
export function stripBlocks(markdown) {
  let source = markdown;
  source = source.replace(/^\s{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s{0,3}\1[^\n]*$/gm, blank);
  source = source.replace(/^\s{0,3}(`{3,}|~{3,})[^\n]*$/gm, blank);
  source = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, blank);
  source = source.replace(/<!--[\s\S]*?-->/g, blank);
  source = source.replace(/^\s*(?:import|export)\s[^\n]*$/gm, blank);
  return source;
}

/**
 * Strip blocks plus inline code spans. Inline code is removed only for link
 * extraction: a heading such as ``### `stealth-registry` `` keeps its text.
 */
export function stripCode(markdown) {
  return stripBlocks(markdown).replace(/`[^`\n]*`/g, blank);
}

/** 1-based line number for a match offset. */
function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

/**
 * Extract unique link targets from a Markdown/MDX page. Covers inline links and
 * images, reference definitions, HTML/JSX href and src attributes, and
 * autolinks. Anything inside code or comments is ignored.
 */
export function extractLinks(markdown) {
  const source = stripCode(markdown);
  const found = new Map();
  const add = (target, index) => {
    if (typeof target !== "string") return;
    const clean = target.trim();
    if (!clean || found.has(clean)) return;
    found.set(clean, { index, line: lineAt(source, index) });
  };

  for (const match of source.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)"']+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g)) {
    add(match[1] ?? match[2], match.index ?? 0);
  }
  for (const match of source.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm)) {
    add(match[1] ?? match[2], match.index ?? 0);
  }
  for (const match of source.matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{"([^"]*)"\})/g)) {
    add(match[1] ?? match[2] ?? match[3] ?? match[4], match.index ?? 0);
  }
  for (const match of source.matchAll(/<(https?:\/\/[^>\s]+)>/g)) {
    add(match[1], match.index ?? 0);
  }

  // Report in document order regardless of which pattern matched first.
  return [...found]
    .sort((a, b) => a[1].index - b[1].index)
    .map(([target, match]) => ({ target, line: match.line }));
}

/**
 * Mintlify heading slug, verified against the ids rendered by `mint dev`:
 * lowercase, drop Markdown formatting, turn sentence punctuation into dashes,
 * keep symbols such as `/`, `+`, `&`, `—`, and `_`, then collapse runs of
 * dashes. `## Swap + Announce` becomes `swap-+-announce`, and
 * `## Soroban RPC / Indexer Errors` becomes `soroban-rpc-/-indexer-errors`.
 */
export function slugify(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*~]/g, "")
    .replace(/[.,:;!?()[\]#]/g, "-")
    .replace(/\s/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Every anchor a reader can link to on a page. */
export function extractAnchors(markdown) {
  const source = stripBlocks(markdown);
  const anchors = new Set();

  for (const match of source.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*(?:\{#([^}]+)\})?\s*$/gm)) {
    const title = match[1].replace(/\s*\{#[^}]+\}\s*$/, "");
    if (match[2]) {
      anchors.add(match[2]);
      continue;
    }
    const base = slugify(title);
    if (!base) continue;
    // Mintlify numbers duplicates from 2: the second "StealthKeys" heading on
    // a page gets id "stealthkeys-2".
    let slug = base;
    let suffix = 2;
    while (anchors.has(slug)) slug = `${base}-${suffix++}`;
    anchors.add(slug);
  }
  for (const match of source.matchAll(/<[A-Za-z][^>]*\bid\s*=\s*["']([^"']+)["']/g)) anchors.add(match[1]);
  for (const match of source.matchAll(/<a\s+[^>]*\bname\s*=\s*["']([^"']+)["']/gi)) anchors.add(match[1]);

  return anchors;
}

/** Repository path -> root-relative extensionless URL. */
export function fileToUrl(file) {
  return `/${file.replaceAll("\\", "/").replace(/\.(md|mdx)$/i, "")}`;
}

/** Normalize a root-relative URL: leading slash, no trailing slash. */
export function normalizeUrl(url) {
  let normalized = path.posix.normalize(url.startsWith("/") ? url : `/${url}`);
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  while (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

/**
 * Build the URL -> page index. `foo/index.mdx` also answers `/foo`, matching
 * how Mintlify serves directory index pages.
 */
export function buildPageIndex(files) {
  const index = new Map();
  for (const file of files) {
    const url = fileToUrl(file);
    if (!index.has(url)) index.set(url, file);
    for (const suffix of ["/index", "/README"]) {
      if (!url.endsWith(suffix)) continue;
      const parent = url.slice(0, -suffix.length) || "/";
      if (!index.has(parent)) index.set(parent, file);
    }
  }
  return index;
}

/** Split a link into path, query, and decoded anchor. */
export function splitTarget(target) {
  const hashIndex = target.indexOf("#");
  const withoutHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const rawAnchor = hashIndex === -1 ? "" : target.slice(hashIndex + 1);
  const queryIndex = withoutHash.indexOf("?");
  const pathname = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : withoutHash.slice(queryIndex);
  return { pathname, query, anchor: decodeFragment(rawAnchor) };
}

function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/**
 * Resolve a non-external pathname to a site URL. Bare paths resolve from the
 * site root, like Mintlify; only `./` and `../` are page-relative.
 */
export function internalPathname(sourceFile, pathname) {
  if (!pathname) return fileToUrl(sourceFile);
  const withoutExtension = pathname.replace(/\.(md|mdx)$/i, "");
  if (withoutExtension.startsWith("/")) return normalizeUrl(withoutExtension);
  if (withoutExtension.startsWith("./") || withoutExtension.startsWith("../")) {
    return normalizeUrl(path.posix.join(path.posix.dirname(sourceFile), withoutExtension));
  }
  return normalizeUrl(withoutExtension);
}

/** True when a URL points at a concrete file rather than a docs page. */
export function isStaticPath(url) {
  const last = url.split("/").pop() ?? "";
  return /\.[A-Za-z0-9]+$/.test(last) && !/\.(md|mdx)$/i.test(last);
}

/** A helpful correction for a bare nested path, when one exists. */
function suggestPath(sourceFile, target, pageIndex) {
  const { pathname, anchor } = splitTarget(target);
  if (!pathname || pathname.startsWith("/") || pathname.startsWith("./") || pathname.startsWith("../")) return null;
  const relative = normalizeUrl(path.posix.join(path.posix.dirname(sourceFile), pathname));
  const rooted = normalizeUrl(pathname);
  const suggestion = pageIndex.has(relative) ? relative : pageIndex.has(rooted) ? rooted : null;
  return suggestion ? `${suggestion}${anchor ? `#${anchor}` : ""}` : null;
}

function failure(source, target, reason, detail) {
  return { source, target, reason, detail };
}

/**
 * Validate one internal link. Returns null when the link is fine, otherwise a
 * structured failure carrying both the source page and the target.
 */
export function validateInternalLink({ source, target, pageIndex, anchorsByFile, redirectSources, staticExists }) {
  const { pathname, anchor } = splitTarget(target);
  const url = internalPathname(source, pathname);

  if (redirectSources.has(url)) return null;

  const page = pageIndex.get(url);
  if (page) {
    if (!anchor) return null;
    const anchors = anchorsByFile.get(page) ?? new Set();
    // Anchors are compared exactly: Mintlify anchors are lowercase, so a
    // case-mangled or punctuation-mangled fragment is a broken link.
    if (anchors.has(anchor)) return null;
    return failure(source, target, "missing-anchor", `no anchor "#${anchor}" on ${url}`);
  }

  if (isStaticPath(url)) {
    if (staticExists(url)) return null;
    return failure(source, target, "missing-asset", `no shipped file at ${url}`);
  }

  const suggestion = suggestPath(source, target, pageIndex);
  const hint = suggestion ? ` Did you mean ${suggestion}?` : "";
  return failure(source, target, "missing-page", `no docs page at ${url}.${hint}`);
}

/** Validate docs.json redirects: unique sources, real page destinations. */
export function validateRedirects(redirects, pageIndex) {
  const failures = [];
  const sources = new Set();
  for (const [index, redirect] of redirects.entries()) {
    if (!redirect || typeof redirect.source !== "string" || typeof redirect.destination !== "string") {
      failures.push(failure("docs.json", `redirects[${index}]`, "invalid-redirect", "source and destination must be strings"));
      continue;
    }
    const source = normalizeUrl(redirect.source);
    if (sources.has(source)) failures.push(failure("docs.json", redirect.source, "duplicate-redirect", `duplicate redirect source ${source}`));
    sources.add(source);
    const destination = redirect.destination;
    if (!destination.startsWith("/") || destination.includes("#") || destination.includes("?")) {
      failures.push(failure("docs.json", redirect.source, "invalid-redirect", `destination ${destination} must be a root-relative page URL`));
    } else if (!pageIndex.has(normalizeUrl(destination))) {
      failures.push(failure("docs.json", redirect.source, "missing-page", `redirect destination ${destination} has no docs page`));
    }
  }
  return failures;
}

/** docs.json brand assets must ship with the repository. */
export function docsJsonAssets(docsJson) {
  return [docsJson?.logo?.dark, docsJson?.logo?.light, docsJson?.favicon].filter(
    (asset) => typeof asset === "string" && asset.startsWith("/"),
  );
}

/** Classify an external HTTP status. */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 404 || status === 410) return "permanent";
  if (status === 408 || status === 425 || status === 429) return "transient";
  if (status >= 500 && status <= 599) return "transient";
  if (status === 401 || status === 403 || status === 405 || status === 451) return "inaccessible";
  if (status >= 300 && status < 400) return "transient";
  return "permanent";
}

function isRetryableStatus(status) {
  // Redirects are handled by checkExternalUrl, which revalidates each hop.
  // Retrying them here would burn the attempt budget before the hop is read.
  if (isRedirectStatus(status)) return false;
  return classifyStatus(status) === "transient";
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

const RETRYABLE_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
]);

function isRetryableError(error) {
  return RETRYABLE_ERROR_CODES.has(error?.code);
}

/** Classify a network error that survived the retry budget. */
export function classifyNetworkError(error) {
  if (error?.code === "ERR_TLS_CERT_ALTNAME_INVALID" || error?.code === "CERT_HAS_EXPIRED" || error?.code === "DEPTH_ZERO_SELF_SIGNED_CERT") {
    return "insecure";
  }
  return "transient";
}

/** Convert a dotted IPv4 quad to an unsigned integer, or null if invalid. */
export function ipv4ToNumber(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** Reserved, private, loopback, link-local, multicast, and documentation ranges. */
const BLOCKED_IPV4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function inIpv4Range(value, base, bits) {
  const shift = 32 - bits;
  // >>> works on the unsigned low 32 bits; base is always a valid uint32.
  return value >>> shift === base >>> shift;
}

/** True only for globally routable IPv4 addresses. */
export function isPublicIpv4(ip) {
  const value = ipv4ToNumber(ip);
  if (value === null) return false;
  for (const [base, bits] of BLOCKED_IPV4) {
    const baseValue = ipv4ToNumber(base);
    if (baseValue !== null && inIpv4Range(value, baseValue, bits)) return false;
  }
  return true;
}

/** Expand an IPv6 address (including embedded IPv4) to eight 16-bit groups. */
export function expandIpv6(input) {
  let ip = input;
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);

  if (ip.includes(".")) {
    const lastColon = ip.lastIndexOf(":");
    if (lastColon === -1) return null;
    const embedded = ipv4ToNumber(ip.slice(lastColon + 1));
    if (embedded === null) return null;
    ip = `${ip.slice(0, lastColon + 1)}${Math.floor(embedded / 65536).toString(16)}:${(embedded % 65536).toString(16)}`;
  }

  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parse = (part) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : null;
  let groups;
  if (tail === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;

  const numbers = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    numbers.push(parseInt(group, 16));
  }
  return numbers;
}

function ipv4FromGroups(high, low) {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** True only for globally routable IPv6 addresses. */
export function isPublicIpv6(ip) {
  const groups = expandIpv6(ip);
  if (!groups) return false;
  const [first, second, third, fourth] = groups;

  const allZeroPrefix = (count) => groups.slice(0, count).every((group) => group === 0);

  // :: and ::1
  if (allZeroPrefix(8)) return false;
  if (allZeroPrefix(7) && groups[7] === 1) return false;

  // IPv4-mapped (::ffff:0:0/96) and the deprecated IPv4-compatible ::/96.
  if (allZeroPrefix(5) && groups[5] === 0xffff) return isPublicIpv4(ipv4FromGroups(groups[6], groups[7]));
  if (allZeroPrefix(6)) return isPublicIpv4(ipv4FromGroups(groups[6], groups[7]));

  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast.
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xff00) === 0xff00) return false;

  // 2001:db8::/32 documentation, 100::/64 discard-only, 2001::/32 Teredo.
  if (first === 0x2001 && second === 0x0db8) return false;
  if (first === 0x0100 && second === 0 && third === 0 && fourth === 0) return false;
  if (first === 0x2001 && second === 0x0) return false;

  // 64:ff9b::/96 NAT64 embeds an IPv4 address in the last 32 bits.
  if (first === 0x0064 && second === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return isPublicIpv4(ipv4FromGroups(groups[6], groups[7]));
  }

  // 2002::/16 6to4 embeds an IPv4 address in groups 1-2.
  if (first === 0x2002) return isPublicIpv4(ipv4FromGroups(second, third));

  // Anything not covered above is globally routable (e.g. 2606:4700::1111).
  return true;
}

/** True only for globally routable IP addresses. Unparseable input is unsafe. */
export function isPublicAddress(input) {
  if (typeof input !== "string") return false;
  const family = net.isIP(input);
  if (family === 4) return isPublicIpv4(input);
  if (family === 6) return isPublicIpv6(input);
  return false;
}

/**
 * Resolve a URL and confirm every address it answers with is publicly
 * routable. The first validated address is returned for DNS pinning.
 */
export async function resolveExternalTarget(rawUrl, { resolveHost }) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, kind: "permanent", reason: "invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, kind: "skipped", reason: `unsupported scheme ${url.protocol}` };
  }
  if (!url.hostname) return { ok: false, kind: "permanent", reason: "missing hostname" };

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  if (net.isIP(hostname)) {
    addresses = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    try {
      addresses = await resolveHost(hostname);
    } catch (error) {
      return { ok: false, kind: "transient", reason: `DNS lookup failed (${error?.code ?? error?.message ?? "unknown error"})` };
    }
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { ok: false, kind: "permanent", reason: "DNS returned no addresses" };
  }

  // Reject the host if *any* answer is non-public. This blocks DNS-rebinding
  // setups that mix a public and a private answer.
  const blocked = addresses.find((entry) => !isPublicAddress(entry.address));
  if (blocked) {
    return { ok: false, kind: "blocked", reason: `resolves to non-public address ${blocked.address}` };
  }

  return {
    ok: true,
    url,
    hostname,
    address: addresses[0].address,
    family: addresses[0].family ?? net.isIP(addresses[0].address),
  };
}

/** A single HEAD request pinned to an already validated address. */
export function requestOnce({ url, address, family, method, timeoutMs, userAgent = EXTERNAL_DEFAULTS.userAgent }) {
  return new Promise((resolve) => {
    const isHttps = url.protocol === "https:";
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const options = {
      hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      agent: false,
      headers: { accept: "*/*", "user-agent": userAgent },
      // Pin the connection to the address that passed validation. Node 20+
      // asks for all addresses when autoSelectFamily is enabled.
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions && lookupOptions.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    };
    if (isHttps && !net.isIP(hostname)) options.servername = hostname;

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let request;
    try {
      const client = isHttps ? https : http;
      request = client.request(options, (response) => {
        const status = response.statusCode ?? 0;
        const location = typeof response.headers.location === "string" ? response.headers.location : null;
        response.destroy();
        finish({ status, location });
      });
    } catch (error) {
      finish({ error });
      return;
    }

    request.setTimeout(timeoutMs, () => {
      const error = new Error(`request timed out after ${timeoutMs}ms`);
      error.code = "ETIMEDOUT";
      request.destroy(error);
    });
    request.on("error", (error) => finish({ error }));
    request.end();
  });
}

/**
 * Request one hop with a HEAD -> GET fallback and the bounded retry budget.
 * Returns the last response and how many attempts were made.
 */
export async function requestWithRetries(resolved, deps, config) {
  let last = { error: Object.assign(new Error("request was never attempted"), { code: "EUNATTEMPTED" }) };
  let attempts = 0;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    let method = "HEAD";
    for (let fallback = 0; fallback < 2; fallback += 1) {
      attempts += 1;
      last = await deps.request({
        url: resolved.url,
        address: resolved.address,
        family: resolved.family,
        method,
        timeoutMs: config.timeoutMs,
        userAgent: config.userAgent,
      });
      const rejectedHead = !last.error && method === "HEAD" && (last.status === 403 || last.status === 405 || last.status === 501);
      if (rejectedHead) {
        method = "GET";
        continue;
      }
      break;
    }

    const retryable = last.error ? isRetryableError(last.error) : isRetryableStatus(last.status);
    if (!retryable || attempt === config.maxAttempts) break;

    const delay = config.backoffMs[Math.min(attempt - 1, config.backoffMs.length - 1)] ?? 0;
    if (delay > 0) await deps.sleep(delay);
  }

  return { ...last, attempts };
}

/**
 * Check one external URL. Redirects are followed manually so every hop is
 * re-resolved and revalidated against the public-address policy.
 */
export async function checkExternalUrl(target, deps, config) {
  const startedAt = deps.now();
  let current = target.replace(/#.*$/, "");
  const redirects = [];

  for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
    if (deps.now() - startedAt > config.budgetMs) {
      return { target, status: "skipped", detail: "external check budget exhausted", redirects };
    }

    const resolved = await resolveExternalTarget(current, deps);
    if (!resolved.ok) {
      return { target, status: resolved.kind, detail: resolved.reason, redirects };
    }

    const response = await requestWithRetries(resolved, deps, config);
    if (response.error) {
      const status = classifyNetworkError(response.error);
      return {
        target,
        status,
        detail: `network error (${response.error.code ?? response.error.message}) after ${response.attempts} attempt(s)`,
        redirects,
      };
    }

    if (isRedirectStatus(response.status) && response.location) {
      const next = new URL(response.location, resolved.url);
      next.hash = "";
      redirects.push(next.toString());
      current = next.toString();
      continue;
    }

    return {
      target,
      status: classifyStatus(response.status),
      detail: `HTTP ${response.status} after ${response.attempts} attempt(s)`,
      redirects,
    };
  }

  return { target, status: "permanent", detail: `more than ${config.maxRedirects} redirects`, redirects };
}

/**
 * Check external URLs with fixed concurrency and one shared wall-clock budget.
 * Results are returned in input order so reports are stable.
 */
export async function runExternalChecks(urls, deps, config) {
  const results = new Array(urls.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < urls.length) {
      const index = cursor;
      cursor += 1;
      if (deps.now() - config.startedAt > config.budgetMs) {
        results[index] = { target: urls[index], status: "skipped", detail: "external check budget exhausted", redirects: [] };
        continue;
      }
      results[index] = await checkExternalUrl(urls[index], deps, config);
    }
  };

  const workers = Array.from({ length: Math.min(config.concurrency, urls.length) }, worker);
  await Promise.all(workers);
  return results;
}

/** Exit status for the whole run. Internal findings are always fatal. */
export function decideExitCode({ internalFailures, externalResults, strictExternal }) {
  if (internalFailures.length > 0) return 1;
  if (strictExternal && externalResults.some((result) => result.status === "permanent")) return 1;
  return 0;
}

/** Group external URLs by the pages that link to them. */
export function collectExternalSources(pages) {
  const sources = new Map();
  for (const page of pages) {
    for (const { target } of page.links) {
      if (!/^https?:\/\//i.test(target)) continue;
      const url = target.replace(/#.*$/, "");
      if (!sources.has(url)) sources.set(url, new Set());
      sources.get(url).add(page.file);
    }
  }
  return sources;
}

function summarize(results) {
  const summary = { ok: 0, permanent: 0, transient: 0, inaccessible: 0, blocked: 0, skipped: 0, insecure: 0 };
  for (const result of results) summary[result.status] = (summary[result.status] ?? 0) + 1;
  return summary;
}

/**
 * Human-readable report. Every finding names the source page and the target so
 * a reader can fix it without re-running the tool.
 */
export function formatReport({ internalFailures, externalResults = [], externalSources = new Map(), stats, verbose = false, strictExternal = false }) {
  const lines = [];
  const externalSummary = summarize(externalResults);
  const includeInternal = stats.includeInternal !== false;
  lines.push("Broken link check");
  if (includeInternal) {
    lines.push(
      `  Internal: ${stats.pageCount} pages, ${stats.internalLinkCount} links, ${internalFailures.length} failure(s), ${stats.staticAssetCount} asset references`,
    );
  }
  if (externalResults.length > 0) {
    lines.push(
      `  External: ${externalResults.length} URLs — ${externalSummary.ok} ok, ${externalSummary.permanent} permanent, ` +
        `${externalSummary.transient} transient, ${externalSummary.inaccessible} inaccessible, ${externalSummary.blocked} blocked, ` +
        `${externalSummary.skipped} skipped, ${externalSummary.insecure} insecure (${(stats.externalElapsedMs / 1000).toFixed(1)}s)`,
    );
  }

  if (internalFailures.length > 0) {
    lines.push("", `Broken internal links (${internalFailures.length})`);
    for (const item of internalFailures) lines.push(`  FAIL ${item.source}: "${item.target}" -> ${item.detail}`);
  }

  const externalFindings = externalResults.filter((result) => result.status !== "ok");
  if (externalFindings.length > 0) {
    lines.push("", `External link findings (${externalFindings.length})`);
    for (const result of externalFindings) {
      const sources = [...(externalSources.get(result.target) ?? [])].sort();
      const pages = sources.length > 0 ? sources.join(", ") : "(unknown source)";
      lines.push(`  ${result.status.toUpperCase()} ${pages}: ${result.target} -> ${result.detail}`);
    }
  }

  if (verbose) {
    lines.push("", "All external results");
    for (const result of externalResults) lines.push(`  ${result.status.toUpperCase()} ${result.target} -> ${result.detail}`);
  }

  if (externalFindings.length > 0 && !strictExternal) {
    lines.push("", "External findings are advisory in this run. Pass --strict-external to fail on permanent failures.");
  }

  if ((!includeInternal || internalFailures.length === 0) && externalFindings.length === 0) lines.push("", "All links resolve.");
  return lines.join("\n");
}

/** Files that make up the documentation, in stable order. */
async function collectDocsFiles(directory) {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(path.join(directory, dir), { withFileTypes: true })) {
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await walk(relative);
      } else if (entry.isFile() && PAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(relative);
      }
    }
  };

  for (const dir of SHIPPED_DIRS) {
    try {
      await walk(dir);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && PAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(entry.name);
  }

  return files.sort();
}

/** True when a root-relative URL points at a file that exists in the repo. */
export function createStaticFileProbe(root) {
  const cache = new Map();
  return async (url) => {
    if (cache.has(url)) return cache.get(url);
    const relative = decodeFragment(url).replace(/^\/+/, "");
    let exists = false;
    if (relative && !relative.split("/").includes("..")) {
      const absolute = path.resolve(root, relative);
      const fromRoot = path.relative(root, absolute);
      if (!fromRoot.startsWith("..") && !path.isAbsolute(fromRoot)) {
        try {
          exists = (await stat(absolute)).isFile();
        } catch {
          exists = false;
        }
      }
    }
    cache.set(url, exists);
    return exists;
  };
}

function readDocsJson(source) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`docs.json could not be parsed: ${error.message}`);
  }
}

function changedPageFiles(root) {
  const base = process.env.DOCS_DIFF_BASE;
  const head = process.env.DOCS_DIFF_HEAD;
  if (!base || !head) return null;
  try {
    const output = execFileSync("git", ["diff", "--name-only", `${base}...${head}`, "--"], { cwd: root, encoding: "utf8" });
    return new Set(
      output
        .split(/\r?\n/)
        .map((file) => file.trim())
        .filter((file) => file && PAGE_EXTENSIONS.has(path.extname(file).toLowerCase())),
    );
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const startedAt = Date.now();
  const files = await collectDocsFiles(repoRoot);
  const pages = [];
  for (const file of files) {
    pages.push({ file, content: await readFile(path.join(repoRoot, file), "utf8") });
  }
  const pageIndex = buildPageIndex(files);
  const anchorsByFile = new Map(pages.map((page) => [page.file, extractAnchors(page.content)]));
  const docsJson = readDocsJson(await readFile(path.join(repoRoot, "docs.json"), "utf8"));
  const redirects = Array.isArray(docsJson.redirects) ? docsJson.redirects : [];
  const redirectSources = new Set(redirects.filter((item) => typeof item?.source === "string").map((item) => normalizeUrl(item.source)));

  const linkedPages = pages.map((page) => ({ file: page.file, links: extractLinks(page.content) }));
  const externalSources = collectExternalSources(linkedPages);
  const brandAssets = docsJsonAssets(docsJson);

  // Collect the file references first so each one is probed once, then run a
  // single validation pass with the probe results available.
  const staticTargets = new Set(brandAssets);
  let internalLinkCount = 0;
  for (const page of linkedPages) {
    for (const { target } of page.links) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
      internalLinkCount += 1;
      const { pathname } = splitTarget(target);
      const url = internalPathname(page.file, pathname);
      if (!pageIndex.has(url) && isStaticPath(url)) staticTargets.add(url);
    }
  }

  const staticProbe = createStaticFileProbe(repoRoot);
  const staticCache = new Map();
  for (const url of staticTargets) staticCache.set(url, await staticProbe(url));
  const staticExists = (url) => staticCache.get(url) === true;

  const internalFailuresFinal = [];
  for (const page of linkedPages) {
    for (const { target } of page.links) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
      const issue = validateInternalLink({
        source: page.file,
        target,
        pageIndex,
        anchorsByFile,
        redirectSources,
        staticExists,
      });
      if (issue) internalFailuresFinal.push(issue);
    }
  }
  for (const asset of brandAssets) {
    if (!staticExists(asset)) internalFailuresFinal.push(failure("docs.json", asset, "missing-asset", `no shipped file at ${asset}`));
  }
  internalFailuresFinal.push(...validateRedirects(redirects, pageIndex));

  // Deterministic output: sort by source, then target.
  internalFailuresFinal.sort((a, b) => (a.source === b.source ? a.target.localeCompare(b.target) : a.source.localeCompare(b.source)));

  let externalResults = [];
  let externalElapsedMs = 0;
  if (options.external && externalSources.size > 0) {
    const allUrls = [...externalSources.keys()].sort();
    const changed = changedPageFiles(repoRoot);
    const selected = changed && changed.size > 0 ? allUrls.filter((url) => [...externalSources.get(url)].some((page) => changed.has(page))) : allUrls;
    const checked = selected.slice(0, EXTERNAL_DEFAULTS.maxUrls);
    const dropped = selected.length - checked.length;

    const externalStartedAt = Date.now();
    const config = { ...EXTERNAL_DEFAULTS, startedAt: externalStartedAt };
    const deps = {
      resolveHost: (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
      request: requestOnce,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    };

    externalResults = await runExternalChecks(checked, deps, config);
    if (dropped > 0) {
      externalResults.push(
        ...selected.slice(checked.length).map((url) => ({
          target: url,
          status: "skipped",
          detail: `not checked: more than ${EXTERNAL_DEFAULTS.maxUrls} external URLs in this run`,
          redirects: [],
        })),
      );
    }
    externalElapsedMs = Date.now() - externalStartedAt;
  }

  const stats = {
    pageCount: pages.length,
    internalLinkCount,
    staticAssetCount: staticTargets.size,
    externalElapsedMs,
  };

  const report = options.internal
    ? formatReport({
        internalFailures: internalFailuresFinal,
        externalResults,
        externalSources,
        stats: { ...stats, includeInternal: options.internal },
        verbose: options.verbose,
        strictExternal: options.strictExternal,
      })
    : formatReport({
        internalFailures: [],
        externalResults,
        externalSources,
        stats: { ...stats, includeInternal: false },
        verbose: options.verbose,
        strictExternal: options.strictExternal,
      });
  console.log(report);
  console.log(`${options.internal ? "" : "(internal checks skipped) "}Finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);

  if (options.jsonPath) {
    const reportJson = {
      generatedAt: new Date().toISOString(),
      summary: {
        pages: pages.length,
        internalLinks: internalLinkCount,
        internalFailures: internalFailuresFinal.length,
        externalUrls: externalResults.length,
        ...summarize(externalResults),
        strictExternal: options.strictExternal,
      },
      internal: internalFailuresFinal,
      external: externalResults.map((result) => ({
        target: result.target,
        status: result.status,
        detail: result.detail,
        sources: [...(externalSources.get(result.target) ?? [])].sort(),
      })),
    };
    await writeFile(options.jsonPath, `${JSON.stringify(reportJson, null, 2)}\n`, "utf8");
  }

  const exitCode = decideExitCode({
    internalFailures: options.internal ? internalFailuresFinal : [],
    externalResults,
    strictExternal: options.strictExternal,
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Broken link check could not complete: ${error.message}`);
    process.exitCode = 1;
  });
}
