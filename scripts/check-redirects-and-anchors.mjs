#!/usr/bin/env node
/** Check Git-detected documentation renames, redirects, and internal anchors. */
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const extensions = new Set([".md", ".mdx"]);
const shippedDirs = ["api-reference", "architecture", "concepts", "contracts", "docs", "guides", "reference", "sdk"];
const excludedLinks = new Map([["docs/i18n.md", new Set(["/guides/my-guide"])]]);

async function main() {
  const docs = await readDocs(root);
  const changedRenames = await getRenamesFromEnvironment();
  const pageFiles = await collectPages(root);
  const changedPages = await getChangedPagesFromEnvironment();
  const pageByUrl = new Map(pageFiles.map((file) => [fileToUrl(file), file]));
  const redirects = docs.redirects === undefined ? [] : docs.redirects;
  const errors = [];

  if (!Array.isArray(redirects)) errors.push('docs.json "redirects" must be an array when present.');
  const redirectList = Array.isArray(redirects) ? redirects : [];
  errors.push(...validateRedirects(redirectList, pageByUrl, changedRenames));

  const pageAnchors = new Map();
  for (const file of pageFiles) pageAnchors.set(file, extractAnchors(await readFile(path.join(root, file), "utf8")));
  const scanFiles = getScanFiles(pageFiles, changedPages, changedRenames);
  for (const file of scanFiles) {
    const content = await readFile(path.join(root, file), "utf8");
    for (const link of extractLinks(content)) {
      if (isExcludedLink(file, link)) continue;
      const parsed = resolveLink(file, link, pageByUrl);
      if (parsed.external) continue;
      const stale = validateRenamedPageLink(file, link, changedRenames);
      errors.push(...validateLinkAnchor(file, link, pageByUrl, pageAnchors));
      if (stale) errors.push(stale);
    }
  }

  if (errors.length) {
    console.error(["Redirect and anchor check failed:", ...errors.map((e) => `  - ${e}`)].join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Redirect and anchor check passed: ${changedRenames.length} Git rename(s), ${pageFiles.length} pages, ${redirectList.length} redirect(s).`);
  }
}

export function getScanFiles(pageFiles, changedPages, changedRenames = []) {
  const scanFiles = changedPages.size ? new Set(pageFiles) : new Set();
  if (changedRenames.length) {
    for (const file of pageFiles) scanFiles.add(file);
  }
  return scanFiles;
}

export function isExcludedLink(source, link) {
  return excludedLinks.get(source)?.has(link) ?? false;
}

export function fileToUrl(file) {
  return `/${file.replaceAll("\\", "/").replace(/\.(md|mdx)$/i, "")}`;
}

export function parseRenameRecords(output) {
  const lines = output.split(/\r?\n/);
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split("\t");
    if (/^R\d+$/.test(fields[0] ?? "") && isPage(fields[1]) && isPage(fields[2])) result.push([fields[1], fields[2]]);
  }
  return result;
}

export function validateRedirects(redirects, pageByUrl, renames = []) {
  const errors = [];
  const sources = new Set();
  for (const [index, redirect] of redirects.entries()) {
    if (!redirect || typeof redirect.source !== "string" || typeof redirect.destination !== "string") {
      errors.push(`docs.json redirects[${index}] must have string source and destination fields.`);
      continue;
    }
    if (sources.has(redirect.source)) errors.push(`Duplicate redirect source ${redirect.source} in docs.json.`);
    sources.add(redirect.source);
    if (!redirect.destination.startsWith("/") || redirect.destination.includes("#") || redirect.destination.includes("?")) {
      errors.push(`Redirect ${redirect.source} has invalid destination ${redirect.destination}; use a root-relative page URL without an anchor or query.`);
    } else if (!pageByUrl.has(redirect.destination)) {
      errors.push(`Redirect ${redirect.source} points to missing page ${redirect.destination}.`);
    }
  }
  for (const [oldPath, newPath] of renames) {
    const source = fileToUrl(oldPath);
    const destination = fileToUrl(newPath);
    if (source === destination) continue;
    if (!redirects.some((r) => r?.source === source && r?.destination === destination)) {
      errors.push(`Renamed page ${oldPath} -> ${newPath} requires docs.json redirect { "source": "${source}", "destination": "${destination}" }.`);
    }
    if (!pageByUrl.has(destination)) errors.push(`Renamed page destination ${destination} does not resolve to a current documentation page.`);
  }
  return errors;
}

export function validateLinkAnchor(source, link, pageByUrl, pageAnchors) {
  const parsed = resolveLink(source, link, pageByUrl);
  if (parsed.external) return [];
  if (path.posix.extname(parsed.url) && !/\.(?:md|mdx)$/i.test(parsed.url)) return [];
  if (!parsed.file || !pageAnchors.has(parsed.file)) return [`${source}: internal link "${link}" points to a missing documentation page.`];
  const anchors = pageAnchors.get(parsed.file);
  if (parsed.anchor && !anchors.has(parsed.anchor) && !anchors.has(slugify(parsed.anchor))) return [`${source}: internal link "${link}" points to missing anchor "${parsed.anchor}" in ${parsed.file}.`];
  return [];
}

export function validateRenamedPageLink(source, link, renames) {
  const parsed = resolveLink(source, link, new Map());
  if (parsed.external) return null;
  const moved = renames.find(([oldPath]) => fileToUrl(oldPath) === parsed.url);
  return moved ? `${source}: link "${link}" still uses renamed page URL ${parsed.url}; update it to ${fileToUrl(moved[1])}.` : null;
}

export function extractAnchors(markdown) {
  const anchors = new Set();
  for (const match of markdown.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*(?:\{#([^}]+)\})?\s*$/gm)) {
    const title = match[1].replace(/\s+\{#[^}]+\}\s*$/, "");
    const id = match[2];
    if (id) { anchors.add(id); continue; }
    const base = slugify(title);
    let slug = base;
    let suffix = 1;
    while (anchors.has(slug)) slug = `${base}-${suffix++}`;
    anchors.add(slug);
  }
  for (const match of markdown.matchAll(/<a\s+[^>]*id=["']([^"']+)["'][^>]*>/gi)) anchors.add(match[1]);
  return anchors;
}

export function slugify(title) {
  return title.toLowerCase().trim().replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*_~]/g, "").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "");
}

export function extractLinks(markdown) {
  const links = [];
  for (const m of markdown.matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g)) links.push(m[1] ?? m[2]);
  for (const m of markdown.matchAll(/\bhref=["']([^"']+)["']/gi)) links.push(m[1]);
  return links;
}

export function resolveLink(sourceFile, link, pageByUrl) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link)) return { external: true };
  const [pathname, rawAnchor] = link.split("#", 2);
  const anchor = rawAnchor ? decodeFragment(rawAnchor) : "";
  let url;
  if (!pathname) url = fileToUrl(sourceFile);
  else if (pathname.startsWith("/")) url = pathname.replace(/\.(?:md|mdx)$/i, "");
  else url = fileToUrl(path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), pathname)));
  let file = pageByUrl.get(url);
  return { external: false, url, anchor, file };
}

function decodeFragment(fragment) {
  try { return decodeURIComponent(fragment); } catch { return fragment; }
}
function isPage(file) { return typeof file === "string" && extensions.has(path.posix.extname(file).toLowerCase()); }
async function readDocs(directory) { return JSON.parse(await readFile(path.join(directory, "docs.json"), "utf8")); }
async function collectPages(directory) {
  const result = [];
  async function walk(dir) {
    for (const entry of await readdir(path.join(directory, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) await walk(rel);
      else if (isPage(rel)) result.push(rel);
    }
  }
  for (const dir of shippedDirs) {
    try { await walk(dir); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith(".mdx")) result.push(entry.name);
  return result;
}
async function getRenamesFromEnvironment() {
  const base = process.env.DOCS_DIFF_BASE;
  const head = process.env.DOCS_DIFF_HEAD;
  if (!base || !head) return [];
  const output = execFileSync("git", ["diff", "--find-renames", "--name-status", `${base}...${head}`, "--"], { encoding: "utf8" });
  return parseRenameRecords(output);
}

async function getChangedPagesFromEnvironment() {
  const base = process.env.DOCS_DIFF_BASE;
  const head = process.env.DOCS_DIFF_HEAD;
  if (!base || !head) return new Set();
  const output = execFileSync("git", ["diff", "--name-only", `${base}...${head}`, "--"], { encoding: "utf8" });
  const result = new Set();
  for (const file of output.split(/\r?\n/)) {
    if (isPage(file) && await fileExists(path.join(root, file))) result.add(file.replaceAll("\\", "/"));
  }
  return result;
}

async function fileExists(file) {
  try { await readFile(file); return true; } catch { return false; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Redirect and anchor check could not complete: ${error.message}`); process.exitCode = 1; });
}
