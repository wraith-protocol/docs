#!/usr/bin/env node
/**
 * check-broken-links.mjs
 *
 * Checks every internal route, heading anchor, and shipped asset reference
 * found in docs pages, plus every external URL.
 *
 * Exit codes
 *   0  – all links healthy
 *   1  – one or more broken links (permanent failures or missing internals)
 *
 * Retry behaviour (external links only)
 *   Up to MAX_RETRIES attempts with exponential back-off + jitter.
 *   HTTP 429 / 503 / 5xx → retryable (network/rate-limit).
 *   HTTP 4xx (except 429) or connection refused → permanent failure.
 *   Timeouts are retried; exhausted retries are reported as permanent.
 *
 * Usage
 *   node scripts/check-broken-links.mjs [--no-external]
 *
 *   --no-external   skip external URL checks (useful for offline / draft PRs)
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// ─── Configuration ────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const CHECK_EXTERNAL = !process.argv.includes("--no-external");

/** Directories whose pages and assets ship in the published site. */
const SHIPPED_PAGE_DIRS = [
  "api-reference",
  "architecture",
  "concepts",
  "contracts",
  "docs",
  "guides",
  "reference",
  "sdk",
];

/** Directories whose files count as shipped assets reachable at /<path>. */
const SHIPPED_ASSET_DIRS = ["assets", "scripts/playground"];

/** Extensions treated as documentation pages. */
const PAGE_EXTS = new Set([".md", ".mdx"]);

/** Patterns that are always allowed without checking (anchors, mailto, etc.). */
const ALWAYS_SKIP = [
  /^mailto:/i,
  /^tel:/i,
  /^javascript:/i,
  // Localhost / loopback – not meaningful in CI
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\./,
  /^https?:\/\/\[::1\]/,
];

/**
 * Per-file link exclusions for placeholder/example content.
 * Map of source file → Set of link patterns to skip.
 */
const EXCLUDED_LINKS = new Map([
  ["docs/i18n.md", new Set(["/guides/my-guide", "/guides/my-guide.es", "/guides/my-guide.pt"])],
  ["reference/error-codes.mdx", new Set(["/scripts/generate-stellar-reference.ts"])],
  ["DEPENDENCY-POLICY.md", new Set([".github/workflows/dependency-audit.yml", "/.github/workflows/dependency-audit.yml"])],
]);

/**
 * Some domains reliably return 403/429 to headless clients but are not broken.
 * HEAD is tried first; GET is the fallback; these are skipped entirely.
 */
const EXTERNAL_SKIP_DOMAINS = new Set([
  // Add known bot-blocking CDNs here if needed, e.g.:
  // "fonts.googleapis.com",
]);

/** HTTP status codes that mean "try again later". */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 599]);

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 800;
const REQUEST_TIMEOUT_MS = 12_000;
const CONCURRENCY = 8; // simultaneous external requests

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const pageFiles = await collectPageFiles();
  const assetFiles = await collectAssetFiles();

  // Build lookup maps for O(1) membership tests.
  const pageUrls = buildPageUrlSet(pageFiles);
  const assetUrls = buildAssetUrlSet(assetFiles);

  // Parse every page and collect links.
  const linksBySource = new Map(); // source file → Set<string> (raw link values)
  for (const file of pageFiles) {
    const content = await readFile(path.join(ROOT, file), "utf8");
    const links = extractLinks(content);
    if (links.length > 0) linksBySource.set(file, new Set(links));
  }

  const internalErrors = [];
  const externalQueue = new Map(); // url → Set<source file>
  const docsJson = await readDocsJson();
  const redirectSources = new Set(
    (docsJson.redirects ?? []).map((r) => r.source).filter(Boolean),
  );

  // ── Internal validation ────────────────────────────────────────────────────

  // Build anchor map (file → Set<slug>) for heading / id anchor checks.
  const anchorMap = new Map();
  for (const file of pageFiles) {
    const content = await readFile(path.join(ROOT, file), "utf8");
    anchorMap.set(file, extractAnchors(content));
  }

  for (const [source, links] of linksBySource) {
    for (const raw of links) {
      if (shouldSkipAlways(raw)) continue;

      // Check per-file exclusions for placeholder/example content.
      const sourceExclusions = EXCLUDED_LINKS.get(source);
      if (sourceExclusions && sourceExclusions.has(raw)) continue;

      if (isExternal(raw)) {
        if (CHECK_EXTERNAL) {
          const normalized = normalizeExternalUrl(raw);
          if (normalized) {
            if (!externalQueue.has(normalized)) externalQueue.set(normalized, new Set());
            externalQueue.get(normalized).add(source);
          }
        }
        continue;
      }

      // Internal link.
      const [pathname, rawAnchor] = raw.split("#", 2);
      const anchor = rawAnchor ? decodeFragmentSafe(rawAnchor) : "";
      const resolved = resolveInternalUrl(source, pathname, pageUrls);

      // Check against redirect sources (a redirect source is a valid link target).
      const isRedirectSource = redirectSources.has(resolved.url);

      if (!resolved.found && !isRedirectSource) {
        // Could be a shipped asset. Strip query parameters for asset lookup.
        const assetPath = resolved.url.replace(/^\//, "").split("?")[0];
        if (!assetUrls.has(assetPath)) {
          internalErrors.push(
            `${source}: broken internal link "${raw}" → "${resolved.url}" (no matching page or asset)`,
          );
        }
        continue;
      }

      // Anchor check (only when the target page exists on disk).
      if (anchor && resolved.file) {
        const anchors = anchorMap.get(resolved.file) ?? new Set();
        if (!anchors.has(anchor) && !anchors.has(slugify(anchor))) {
          internalErrors.push(
            `${source}: broken anchor "${raw}" → "#${anchor}" not found in "${resolved.file}"`,
          );
        }
      }
    }
  }

  // ── External validation ────────────────────────────────────────────────────

  const externalErrors = [];
  if (CHECK_EXTERNAL && externalQueue.size > 0) {
    console.log(`Checking ${externalQueue.size} unique external URL(s)…`);
    const results = await checkExternalUrlsConcurrent([...externalQueue.keys()]);
    for (const { url, status, error, permanent } of results) {
      if (!error && status < 400) continue;
      const sources = [...(externalQueue.get(url) ?? [])].join(", ");
      const detail = error ?? `HTTP ${status}`;
      const tag = permanent ? "PERMANENT" : "RETRYABLE";
      externalErrors.push(`[${tag}] ${url}\n    → ${detail}\n    → referenced in: ${sources}`);
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────────

  const allErrors = [...internalErrors, ...externalErrors];
  if (allErrors.length === 0) {
    const externalMsg = CHECK_EXTERNAL
      ? `, ${externalQueue.size} external URL(s) verified`
      : " (external checks skipped)";
    console.log(
      `Broken-link check passed: ${pageFiles.length} pages, ` +
        `${[...linksBySource.values()].reduce((n, s) => n + s.size, 0)} link(s) checked` +
        externalMsg +
        `.`,
    );
    process.exit(0);
  }

  console.error("Broken-link check FAILED:\n");
  if (internalErrors.length > 0) {
    console.error(`── Internal errors (${internalErrors.length}) ──`);
    for (const e of internalErrors) console.error(`  ✖ ${e}`);
  }
  if (externalErrors.length > 0) {
    console.error(`\n── External errors (${externalErrors.length}) ──`);
    for (const e of externalErrors) console.error(`  ✖ ${e}`);
  }
  console.error(
    `\nTotal: ${internalErrors.length} internal + ${externalErrors.length} external broken link(s).`,
  );
  process.exit(1);
}

// ─── File collection ──────────────────────────────────────────────────────────

async function collectPageFiles() {
  const files = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(path.join(ROOT, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) await walk(rel);
      else if (e.isFile() && PAGE_EXTS.has(path.extname(e.name).toLowerCase()))
        files.push(rel);
    }
  };
  for (const d of SHIPPED_PAGE_DIRS) await walk(d);
  // Root-level .mdx pages (e.g. getting-started.mdx, introduction.mdx).
  for (const e of await readdir(ROOT, { withFileTypes: true })) {
    if (e.isFile() && PAGE_EXTS.has(path.extname(e.name).toLowerCase()))
      files.push(e.name);
  }
  return files;
}

async function collectAssetFiles() {
  const files = new Set();
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(path.join(ROOT, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) await walk(rel);
      else if (e.isFile()) files.add(rel);
    }
  };
  for (const d of SHIPPED_ASSET_DIRS) await walk(d);
  return files;
}

// ─── URL sets ────────────────────────────────────────────────────────────────

function buildPageUrlSet(files) {
  const urls = new Set();
  for (const f of files) urls.add(fileToUrl(f));
  return urls;
}

function buildAssetUrlSet(files) {
  // Asset files are served at their path relative to root: assets/images/logo.png → /assets/images/logo.png
  const paths = new Set();
  for (const f of files) paths.add(f); // keep as relative path for lookup
  return paths;
}

// ─── Internal link resolution ─────────────────────────────────────────────────

function resolveInternalUrl(sourceFile, pathname, pageUrls) {
  let url;
  if (!pathname || pathname === ".") {
    url = fileToUrl(sourceFile);
  } else if (pathname.startsWith("/")) {
    url = pathname.replace(/\.(?:md|mdx)$/i, "");
  } else {
    const sourceDir = path.posix.dirname(sourceFile);
    url = fileToUrl(path.posix.normalize(path.posix.join(sourceDir, pathname)));
  }
  // Strip trailing slash for consistency.
  const normalizedUrl = url.replace(/\/$/, "") || "/";
  const found = pageUrls.has(normalizedUrl);
  // Derive file path from url for anchor checking.
  const file = found
    ? [...pageUrls].find((u) => u === normalizedUrl) !== undefined
      ? urlToFile(normalizedUrl)
      : undefined
    : undefined;
  return { url: normalizedUrl, found, file };
}

function urlToFile(url) {
  // url is like /guides/foo — try .mdx first, then .md
  const rel = url.replace(/^\//, "");
  return rel + ".mdx"; // nav-coverage confirms these exist
}

function fileToUrl(file) {
  return (
    "/" +
    file
      .replace(/\\/g, "/")
      .replace(/\.(?:md|mdx)$/i, "")
  );
}

// ─── Link extraction ──────────────────────────────────────────────────────────

function extractLinks(content) {
  const links = new Set();
  // Markdown links: [text](url) and ![alt](url)
  for (const m of content.matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)#"']+(?:#[^\s)]*)?))(?:\s[^)]*)?\)/g)) {
    const raw = (m[1] ?? m[2] ?? "").trim();
    if (raw) links.add(raw);
  }
  // HTML href attributes
  for (const m of content.matchAll(/\bhref=["']([^"']+)["']/gi)) {
    links.add(m[1].trim());
  }
  // HTML src attributes (images, scripts)
  for (const m of content.matchAll(/\bsrc=["']([^"']+)["']/gi)) {
    links.add(m[1].trim());
  }
  // JSX/MDX src and href props (unquoted or single-quoted are caught above)
  for (const m of content.matchAll(/\b(?:href|src)=\{["']([^"']+)["']\}/gi)) {
    links.add(m[1].trim());
  }
  return [...links];
}

// ─── Anchor extraction ────────────────────────────────────────────────────────

function extractAnchors(content) {
  const anchors = new Set();
  // ATX headings with optional explicit id
  for (const m of content.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*(?:\{#([^}]+)\})?\s*$/gm)) {
    const id = m[2];
    if (id) {
      anchors.add(id);
      continue;
    }
    const title = m[1].replace(/\s+\{#[^}]+\}\s*$/, "");
    const base = slugify(title);
    let slug = base;
    let n = 1;
    while (anchors.has(slug)) slug = `${base}-${n++}`;
    anchors.add(slug);
  }
  // HTML id attributes
  for (const m of content.matchAll(/<[^>]+\bid=["']([^"']+)["'][^>]*>/gi)) {
    anchors.add(m[1]);
  }
  return anchors;
}

function slugify(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
}

// ─── External URL checking ────────────────────────────────────────────────────

/**
 * IPv4 address ranges that are private, loopback, or link-local.
 * These must never be fetched from CI to prevent SSRF.
 */
const PRIVATE_IPV4_RANGES = [
  { start: 0x0a000000 >>> 0, mask: 0xff000000 >>> 0 },    // 10.0.0.0/8
  { start: 0xac100000 >>> 0, mask: 0xfff00000 >>> 0 },    // 172.16.0.0/12
  { start: 0xc0a80000 >>> 0, mask: 0xffff0000 >>> 0 },    // 192.168.0.0/16
  { start: 0x7f000000 >>> 0, mask: 0xff000000 >>> 0 },    // 127.0.0.0/8 (loopback)
  { start: 0xa9fe0000 >>> 0, mask: 0xffff0000 >>> 0 },    // 169.254.0.0/16 (link-local)
];

/**
 * IPv6 address ranges that are private, loopback, or link-local.
 */
const PRIVATE_IPV6_RANGES = [
  "::1",                     // loopback
  "fe80::/10",              // link-local
  "fc00::/7",               // unique local
  "fd00::/8",               // unique local
  "::ffff:0:0/96",          // IPv4-mapped IPv6
];

/**
 * Check if an IP address is private, loopback, or link-local.
 * Returns true if the address should be rejected to prevent SSRF.
 */
function isPrivateAddress(ip) {
  // IPv4 check
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    const parts = ip.split(".").map(Number);
    const numeric = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    for (const { start, mask } of PRIVATE_IPV4_RANGES) {
      if (((numeric & mask) >>> 0) === start) return true;
    }
    return false;
  }

  // IPv6 check
  if (ip.includes(":")) {
    const normalized = ip.toLowerCase();
    for (const range of PRIVATE_IPV6_RANGES) {
      const [rangeStart, prefixLength] = range.split("/");
      if (isIp6InRange(normalized, rangeStart, parseInt(prefixLength, 10))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if an IPv6 address is within a CIDR range.
 */
function isIp6InRange(ip, rangeStart, prefixLength) {
  if (prefixLength === undefined) return ip === rangeStart;
  // Simplified check - for full implementation would need proper IPv6 parsing
  return ip.startsWith(rangeStart.slice(0, prefixLength / 4 + 2));
}

/**
 * Resolve a hostname to its IP addresses and check if any are private.
 * Returns { isPrivate: boolean, error?: string }
 */
async function checkHostnameIsPrivate(hostname) {
  try {
    const dns = await import("node:dns").then((m) => m.promises);
    const addresses = await dns.lookup(hostname, { all: true });
    for (const { address, family } of addresses) {
      if (isPrivateAddress(address)) {
        return { isPrivate: true, error: `hostname resolves to private address: ${address}` };
      }
    }
    return { isPrivate: false };
  } catch (err) {
    // If DNS lookup fails, treat as suspicious but don't block (might be DNS rebinding)
    return { isPrivate: false, error: `DNS lookup failed: ${err.message}` };
  }
}

/**
 * Process external URLs in batches of CONCURRENCY, collecting results.
 * Returns an array of { url, status, error, permanent } objects.
 */
async function checkExternalUrlsConcurrent(urls) {
  const results = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(batch.map((url) => checkExternalUrl(url)));
    results.push(...settled);
  }
  return results;
}

async function checkExternalUrl(url) {
  const hostname = safeHostname(url);
  if (hostname && EXTERNAL_SKIP_DOMAINS.has(hostname)) {
    return { url, status: 200, error: null, permanent: false };
  }

  // SSRF protection: check if hostname resolves to private address
  if (hostname) {
    const { isPrivate, error: dnsError } = await checkHostnameIsPrivate(hostname);
    if (isPrivate) {
      return { url, status: 0, error: dnsError, permanent: true };
    }
  }

  let lastStatus = 0;
  let lastError = null;
  let currentUrl = url;
  const maxRedirects = 5;
  let redirectCount = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 200;
      await sleep(delay);
    }

    const result = await fetchWithTimeout(currentUrl, attempt === 0 ? "HEAD" : "GET", redirectCount >= maxRedirects);

    if (result.error) {
      lastError = result.error;
      lastStatus = 0;
      // Network errors are retryable unless we've exhausted attempts.
      continue;
    }

    lastStatus = result.status;
    lastError = null;

    // Handle redirects manually to validate each hop
    if (result.status >= 300 && result.status < 400 && result.location) {
      redirectCount++;
      if (redirectCount > maxRedirects) {
        return { url, status: lastStatus, error: "too many redirects", permanent: true };
      }

      // Validate redirect target
      const redirectHostname = safeHostname(result.location);
      if (redirectHostname) {
        const { isPrivate, error: redirectDnsError } = await checkHostnameIsPrivate(redirectHostname);
        if (isPrivate) {
          return { url, status: 0, error: `redirect to private address blocked: ${redirectDnsError}`, permanent: true };
        }
      }

      currentUrl = result.location;
      continue; // follow redirect
    }

    if (lastStatus < 400) return { url, status: lastStatus, error: null, permanent: false };

    // HEAD method sometimes returns 405/403 from servers that only handle GET;
    // retry with GET automatically.
    if (attempt === 0 && (lastStatus === 405 || lastStatus === 403)) continue;

    if (RETRYABLE_STATUSES.has(lastStatus)) continue;

    // Permanent failure.
    return { url, status: lastStatus, error: `HTTP ${lastStatus}`, permanent: true };
  }

  const permanent = lastError
    ? isPermanentNetworkError(lastError)
    : !RETRYABLE_STATUSES.has(lastStatus);
  return {
    url,
    status: lastStatus,
    error: lastError ?? `HTTP ${lastStatus}`,
    permanent,
  };
}

async function fetchWithTimeout(url, method = "HEAD", manualRedirect = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; wraith-docs-link-checker/1.0; +https://github.com/wraith-protocol)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: manualRedirect ? "manual" : "follow",
    });
    const location = res.headers.get("Location");
    return { status: res.status, error: null, location };
  } catch (err) {
    if (err.name === "AbortError") return { status: 0, error: "timeout", location: null };
    return { status: 0, error: err.message ?? String(err), location: null };
  } finally {
    clearTimeout(timer);
  }
}

function isPermanentNetworkError(errorMessage) {
  const permanent = [
    "getaddrinfo ENOTFOUND",
    "ENOTFOUND",
    "ECONNREFUSED",
    "ERR_INVALID_URL",
  ];
  return permanent.some((p) => errorMessage.includes(p));
}

function isExternal(url) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url);
}

function shouldSkipAlways(url) {
  return ALWAYS_SKIP.some((re) => re.test(url));
}

function normalizeExternalUrl(raw) {
  // Strip fragment — we only check the page exists, not remote anchors.
  const withoutFragment = raw.split("#")[0];
  try {
    const u = new URL(withoutFragment);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function readDocsJson() {
  try {
    return JSON.parse(await readFile(path.join(ROOT, "docs.json"), "utf8"));
  } catch {
    return {};
  }
}

function decodeFragmentSafe(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(`Broken-link check could not complete: ${err.message}`);
  process.exit(1);
});
