#!/usr/bin/env node
/**
 * check-nav-coverage.mjs
 *
 * Verifies that every .mdx page in the shipped taxonomy is registered in the
 * docs.json navigation tree, and that every docs.json navigation entry
 * resolves to a real file. Run it after adding, renaming, or removing pages:
 *
 *   node scripts/check-nav-coverage.mjs
 *
 * Wired into CI via the "Compile docs snippets" job in
 * .github/workflows/snippets.yml, so a PR that adds an .mdx page without
 * registering it in docs.json fails the build.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const docsJsonPath = path.join(repoRoot, "docs.json");

/** Top-level directories whose pages ship in the navigation. */
const shippedDirs = [
  "api-reference",
  "architecture",
  "concepts",
  "contracts",
  "guides",
  "reference",
  "sdk",
];

async function main() {
  const docsJson = JSON.parse(stripComments(await readFile(docsJsonPath, "utf8")));
  const navEntries = collectNavEntries(docsJson.navigation);

  const pagePaths = await collectPagePaths();
  const missingFromNav = [...pagePaths]
    .filter((page) => !navEntries.has(page))
    .sort();
  const missingOnDisk = [...navEntries]
    .filter((entry) => !isExternal(entry) && !pagePaths.has(entry))
    .sort();

  const failures = [];
  if (missingFromNav.length > 0) {
    failures.push(
      [
        "Pages exist on disk but are missing from docs.json navigation:",
        ...missingFromNav.map((page) => `  - ${page}`),
      ].join("\n"),
    );
  }
  if (missingOnDisk.length > 0) {
    failures.push(
      [
        "docs.json navigation entries with no matching .mdx file on disk:",
        ...missingOnDisk.map((entry) => `  - ${entry}`),
      ].join("\n"),
    );
  }

  if (failures.length > 0) {
    console.error(
      [
        "Nav coverage check failed.",
        "",
        ...failures,
        "",
        "Register new pages in their natural group in docs.json, and remove nav",
        "entries that point at files that no longer exist.",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(
    `Nav coverage passed: ${pagePaths.size} pages checked, ` +
      `${navEntries.size} nav entries verified.`,
  );
}

/**
 * Collect every page path referenced anywhere in the navigation tree.
 * Handles nested groups, per-locale variants (e.g. guides/foo.es), and
 * object entries with a `page` field. External links are collected too and
 * filtered out by the on-disk check.
 */
function collectNavEntries(navigation) {
  const entries = new Set();
  const walk = (value, inPages) => {
    if (typeof value === "string") {
      if (inPages) entries.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, inPages));
      return;
    }
    if (value && typeof value === "object") {
      if (typeof value.page === "string") entries.add(value.page);
      for (const [key, child] of Object.entries(value)) {
        walk(child, inPages || key === "pages");
      }
    }
  };
  walk(navigation, false);
  return entries;
}

/** Collect the nav path of every .mdx page in the shipped taxonomy. */
async function collectPagePaths() {
  const pages = new Set();

  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Directory does not exist (e.g. concepts/).
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
        pages.add(toNavPath(fullPath));
      }
    }
  };

  for (const dir of shippedDirs) {
    await walk(path.join(repoRoot, dir));
  }

  // Root-level pages live next to docs.json, outside the shipped dirs.
  const rootEntries = await readdir(repoRoot, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name.endsWith(".mdx")) {
      pages.add(entry.name.replace(/\.mdx$/, ""));
    }
  }

  return pages;
}

/** Absolute path -> navigation path (relative, forward slashes, no .mdx). */
function toNavPath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/").replace(/\.mdx$/, "");
}

function isExternal(entry) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(entry) || entry.startsWith("//");
}

/**
 * Strip line comments (//) and block comments (slash-star ... star-slash)
 * from JSONC so docs.json can carry the audit-script comment header.
 * Respects string literals so URLs like "https://..." are untouched.
 */
function stripComments(source) {
  let result = "";
  let inString = false;
  let i = 0;

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (inString) {
      result += char;
      if (char === "\\" && next !== undefined) {
        result += next;
        i += 2;
        continue;
      }
      if (char === '"') inString = false;
      i += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      i += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    result += char;
    i += 1;
  }

  return result;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
