#!/usr/bin/env node
/**
 * check-links.mjs
 *
 * Crawls every .mdx/.md file in the repo and verifies:
 *   - Internal page links resolve to an existing file.
 *   - Anchor fragments (#section) match a heading id in the target page.
 *   - Local asset paths (images, diagrams) exist on disk.
 *   - External HTTP(S) links return 2xx (with a HEAD request, retried once).
 *
 * URLs listed in link-exceptions.yaml are skipped for external checks.
 *
 * Usage:
 *   node scripts/check-links.mjs [--report <path>]
 *
 * Exits 0 on success, 1 if any broken links are found.
 * Writes a failure report to --report (default: link-check-report.json).
 */

import fs from "node:fs";
import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    report: { type: "string", default: "link-check-report.json" },
  },
  strict: false,
});

const REPORT_PATH = args.report;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const EXCEPTIONS_FILE = path.join(ROOT, "link-exceptions.yaml");

// ---------------------------------------------------------------------------
// Load exception list (tiny hand-rolled YAML parser — no deps needed)
// ---------------------------------------------------------------------------
/**
 * Parses the `exceptions` block from link-exceptions.yaml.
 * Returns an array of URL prefixes to skip.
 * @returns {string[]}
 */
function loadExceptions() {
  if (!fs.existsSync(EXCEPTIONS_FILE)) return [];
  const raw = fs.readFileSync(EXCEPTIONS_FILE, "utf8");
  const urls = [];
  let inExceptions = false;
  for (const line of raw.split("\n")) {
    if (/^exceptions:/.test(line)) { inExceptions = true; continue; }
    if (!inExceptions) continue;
    const urlMatch = line.match(/^\s+-\s+url:\s+"?([^"]+)"?\s*$/);
    if (urlMatch) urls.push(urlMatch[1].trim());
  }
  return urls;
}

const EXCEPTION_PREFIXES = loadExceptions();

function isExcepted(url) {
  return EXCEPTION_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/** Check whether an internal path (e.g. /reference/stellar-event-schemas) is excepted. */
function isInternalExcepted(absPath) {
  // Convert absolute disk path back to a root-relative path for matching
  const rel = "/" + absPath.replace(/\\/g, "/").split(ROOT.replace(/\\/g, "/") + "/")[1];
  return EXCEPTION_PREFIXES
    .filter((p) => p.startsWith("internal:"))
    .map((p) => p.slice("internal:".length))
    .some((prefix) => rel.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Collect source files
// ---------------------------------------------------------------------------
async function collectFiles(dir, exts = [".mdx", ".md"]) {
  const results = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectFiles(full, exts)));
    } else if (exts.includes(path.extname(entry.name))) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Extract links and headings from file content
// ---------------------------------------------------------------------------
const LINK_RE = /\[(?:[^\]]*)\]\(([^)]+)\)/g;
const IMAGE_RE = /!?\[(?:[^\]]*)\]\(([^)]+)\)/g;
// MDX/JSX image src and href props
const JSX_HREF_RE = /(?:href|src)=["']([^"']+)["']/g;
// Heading lines to derive anchor ids  (# Title, ## Title, etc.)
const HEADING_RE = /^#{1,6}\s+(.+)$/gm;

/**
 * Derives the GitHub-flavoured Markdown anchor id from a heading string.
 * Strips MDX/HTML tags, lowercases, replaces spaces with hyphens.
 */
function headingToAnchor(heading) {
  // 1. If a Mintlify/MDX explicit id is present — {#custom-id} — use it directly.
  const explicitId = heading.match(/\{#([\w-]+)\}\s*$/);
  if (explicitId) return explicitId[1];

  return heading
    .replace(/<[^>]+>/g, "")        // strip HTML/JSX tags
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1)) // strip backtick wrapping
    .replace(/&amp;/g, "-")          // HTML entity &amp; → hyphen (GFM behaviour)
    .replace(/&/g, "-")              // bare & → hyphen (GFM behaviour)
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")        // remove remaining punctuation except hyphen
    .trim()
    .replace(/\s+/g, "-")            // spaces → hyphens
    .replace(/-{2,}/g, "-");         // collapse consecutive hyphens
}

function extractHeadings(content) {
  const ids = new Set();
  let m;
  HEADING_RE.lastIndex = 0;
  while ((m = HEADING_RE.exec(content)) !== null) {
    ids.add(headingToAnchor(m[1]));
  }
  return ids;
}

function extractLinks(content) {
  const links = new Set();
  let m;
  for (const re of [LINK_RE, JSX_HREF_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      links.add(m[1].trim());
    }
  }
  return [...links];
}

// ---------------------------------------------------------------------------
// Resolve internal paths
// ---------------------------------------------------------------------------
/**
 * Given a link href relative to `fromFile`, resolve to an absolute disk path.
 * Handles:
 *   - relative paths  (./foo, ../bar)
 *   - root-relative   (/guides/foo)
 *   - anchor-only     (#section)
 * Returns null for external or mailto links.
 */
function resolveInternal(href, fromFile) {
  if (/^https?:\/\//i.test(href)) return null; // external
  if (/^mailto:/i.test(href)) return null;
  if (href.startsWith("#")) return { file: fromFile, anchor: href.slice(1) };

  // Strip query string before resolving — query params are not filesystem paths
  const hrefNoQuery = href.split("?")[0];
  const [pathPart, anchor] = hrefNoQuery.split("#");

  let resolved;
  if (pathPart.startsWith("/")) {
    resolved = path.join(ROOT, pathPart);
  } else {
    resolved = path.resolve(path.dirname(fromFile), pathPart);
  }

  // Try exact match, then append extensions
  return { file: resolved, anchor: anchor || null };
}

async function fileExists(filePath) {
  const candidates = [
    filePath + ".mdx",
    filePath + ".md",
    path.join(filePath, "index.mdx"),
    path.join(filePath, "index.md"),
    filePath, // bare path last — only accepted if it's a file, not a dir
  ];
  for (const c of candidates) {
    try {
      const s = await stat(c);
      if (s.isFile()) return c;
    } catch { /* continue */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// External link checker with retry
// ---------------------------------------------------------------------------
async function checkExternal(url, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        headers: { "User-Agent": "docs-link-checker/1.0 (+CI)" },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok || res.status === 429) return { ok: res.ok, status: res.status };
      // Some servers reject HEAD; retry with GET on last attempt
      if (attempt === retries) {
        const res2 = await fetch(url, {
          method: "GET",
          redirect: "follow",
          headers: { "User-Agent": "docs-link-checker/1.0 (+CI)" },
          signal: AbortSignal.timeout(10_000),
        });
        return { ok: res2.ok, status: res2.status };
      }
    } catch (err) {
      if (attempt === retries) return { ok: false, status: 0, error: err.message };
    }
    // Back off before retry
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("🔗 Collecting source files…");
  const files = await collectFiles(ROOT);
  console.log(`   Found ${files.length} MDX/MD files.`);

  /** @type {Map<string, Set<string>>} file → set of anchor ids */
  const headingCache = new Map();

  async function getHeadings(filePath) {
    if (headingCache.has(filePath)) return headingCache.get(filePath);
    const resolved = await fileExists(filePath);
    if (!resolved) return new Set();
    const content = await readFile(resolved, "utf8");
    const ids = extractHeadings(content);
    headingCache.set(filePath, ids);
    return ids;
  }

  /** @type {{ file: string; href: string; reason: string }[]} */
  const broken = [];

  // ── External URLs de-duped across all files ──────────────────────────────
  /** @type {Map<string, string[]>} url → list of source files */
  const externalMap = new Map();

  console.log("🔍 Checking internal links and assets…");

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const links = extractLinks(content);
    const relFile = path.relative(ROOT, file);

    for (const href of links) {
      if (!href || href.startsWith("mailto:") || href.startsWith("data:")) continue;

      // ── External ──────────────────────────────────────────────────────────
      if (/^https?:\/\//i.test(href)) {
        const bare = href.split("#")[0]; // ignore fragment for external
        if (!externalMap.has(bare)) externalMap.set(bare, []);
        externalMap.get(bare).push(relFile);
        continue;
      }

      // ── Internal ──────────────────────────────────────────────────────────
      const resolved = resolveInternal(href, file);
      if (!resolved) continue;

      const existingFile = await fileExists(resolved.file);

      if (!existingFile) {
        if (isInternalExcepted(resolved.file)) continue; // known stub
        broken.push({ file: relFile, href, reason: "File not found" });
        continue;
      }

      if (resolved.anchor) {
        if (isInternalExcepted(resolved.file)) continue; // excepted file — skip anchor check too
        const headings = await getHeadings(existingFile);
        if (!headings.has(resolved.anchor)) {
          broken.push({
            file: relFile,
            href,
            reason: `Anchor #${resolved.anchor} not found in ${path.relative(ROOT, existingFile)}`,
          });
        }
      }
    }
  }

  // ── External checks (concurrent, capped) ─────────────────────────────────
  const externalUrls = [...externalMap.keys()];
  console.log(`🌐 Checking ${externalUrls.length} unique external URLs…`);

  const CONCURRENCY = 10;
  for (let i = 0; i < externalUrls.length; i += CONCURRENCY) {
    const batch = externalUrls.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (url) => {
        if (isExcepted(url)) {
          console.log(`   ⏭  Skipped (exception): ${url}`);
          return;
        }
        const result = await checkExternal(url);
        if (!result.ok) {
          const sources = externalMap.get(url);
          for (const src of sources) {
            broken.push({
              file: src,
              href: url,
              reason: result.error
                ? `Network error: ${result.error}`
                : `HTTP ${result.status}`,
            });
          }
        }
      })
    );
  }

  // ── Report ────────────────────────────────────────────────────────────────
  if (broken.length === 0) {
    console.log("\n✅ No broken links found.");
    return;
  }

  console.error(`\n❌ Found ${broken.length} broken link(s):\n`);

  // Group by file for readability
  const byFile = new Map();
  for (const item of broken) {
    if (!byFile.has(item.file)) byFile.set(item.file, []);
    byFile.get(item.file).push(item);
  }

  for (const [file, items] of [...byFile.entries()].sort()) {
    console.error(`  ${file}`);
    for (const { href, reason } of items) {
      console.error(`    • ${href}  →  ${reason}`);
    }
  }

  // Write structured report
  const report = {
    generatedAt: new Date().toISOString(),
    totalBroken: broken.length,
    byFile: Object.fromEntries(
      [...byFile.entries()].sort().map(([file, items]) => [
        file,
        items.map(({ href, reason }) => ({ href, reason })),
      ])
    ),
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.error(`\nReport written to ${REPORT_PATH}`);

  process.exit(1);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
