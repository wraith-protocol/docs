#!/usr/bin/env node
/**
 * build-preview.mjs
 *
 * Builds a deterministic, offline preview of the documentation site from
 * docs.json and the shipped .mdx pages. The preview mirrors the production
 * navigation (tabs, groups, page paths) and renders the subset of MDX the docs
 * actually use: headings, links, images, tables, code fences, callouts, cards,
 * accordions, steps, code groups, and embedded iframes.
 *
 * It exists so the render/navigation smoke tests can load a real page tree over
 * HTTP without a Mintlify account, a deployed preview, or any live service.
 *
 * Output: node_modules/.cache/docs-preview (override with PREVIEW_DIR).
 *
 *   node scripts/preview/build-preview.mjs
 *   node scripts/preview/build-preview.mjs --check   # build, then verify only
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const outDir = path.resolve(
  repoRoot,
  process.env.PREVIEW_DIR || "node_modules/.cache/docs-preview",
);

const SHIPPED_DIRS = new Set([
  "api-reference",
  "architecture",
  "concepts",
  "contracts",
  "guides",
  "reference",
  "sdk",
]);

const CALLOUT_TAGS = new Set(["Note", "Warning", "Info", "Tip", "Check"]);

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

export function slugify(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseAttrs(source) {
  const attrs = {};
  const re = /([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[match[1]] = value.trim();
  }
  return attrs;
}

/** Collect nav pages with their tab/group context, in docs.json order. */
export function collectNavigation(docsJson) {
  const pages = [];
  const seen = new Set();
  const tabs = [];

  for (const tab of docsJson.navigation?.tabs ?? []) {
    const tabInfo = { name: tab.tab, groups: [], pages: [] };
    for (const group of tab.groups ?? []) {
      const groupInfo = { name: group.group, pages: [] };
      for (const entry of group.pages ?? []) {
        const pagePath =
          typeof entry === "string" ? entry : entry?.page ?? null;
        if (!pagePath || seen.has(pagePath)) continue;
        seen.add(pagePath);
        const page = {
          path: pagePath,
          url: `/${pagePath}`,
          tab: tab.tab,
          group: group.group,
        };
        pages.push(page);
        tabInfo.pages.push(page);
        groupInfo.pages.push(page);
      }
      tabInfo.groups.push(groupInfo);
    }
    tabs.push(tabInfo);
  }

  return { tabs, pages };
}

/** Derive the landing route for each tab from docs.json `tabs[].url`. */
export function attachTabEntries(tabs, rawTabs) {
  const urls = new Map();
  for (const entry of rawTabs ?? []) {
    if (entry?.name && entry?.url) urls.set(entry.name, entry.url);
  }
  return tabs.map((tab) => {
    const configured = urls.get(tab.name);
    const entry =
      configured && tab.pages.find((page) => page.path.startsWith(`${configured}/`) || page.path === configured);
    return { ...tab, entry: (entry ?? tab.pages[0])?.path ?? null };
  });
}

// ---------------------------------------------------------------------------
// Inline markdown
// ---------------------------------------------------------------------------

function renderInline(source) {
  const codes = [];
  let text = String(source).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });

  text = escapeHtml(text);

  // Images before links (they share bracket syntax).
  text = text.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_, alt, src) => `<img src="${src}" alt="${alt}" loading="lazy" />`,
  );
  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_, label, href) => `<a href="${href}" data-internal="${href.startsWith("/") ? "true" : "false"}">${label}</a>`,
  );
  text = text.replace(/&lt;br\s*\/?&gt;/gi, "<br />");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codes[Number(index)]);
  return text;
}

// ---------------------------------------------------------------------------
// Block components
// ---------------------------------------------------------------------------

function renderCallout(tag, attrs, inner) {
  const title = attrs.title ?? tag;
  return `<div class="callout callout-${tag.toLowerCase()}" data-component="${tag}">` +
    `<p class="callout-title">${escapeHtml(title)}</p>` +
    `<div class="callout-body">${renderBlocks(inner)}</div></div>`;
}

function renderCard(attrs, inner) {
  const href = attrs.href ?? attrs.url ?? "";
  const title = attrs.title ?? "";
  const body = inner.trim() ? renderBlocks(inner) : "";
  const tag = href ? "a" : "div";
  const hrefAttr = href ? ` href="${escapeHtml(href)}" data-internal="${href.startsWith("/") ? "true" : "false"}"` : "";
  return `<${tag} class="card"${hrefAttr} data-component="Card">` +
    (title ? `<p class="card-title">${renderInline(title)}</p>` : "") +
    body +
    `</${tag}>`;
}

function renderAccordion(attrs, inner) {
  return `<details class="accordion" data-component="Accordion">` +
    `<summary>${renderInline(attrs.title ?? "Details")}</summary>` +
    `<div class="accordion-body">${renderBlocks(inner)}</div></details>`;
}

/** Render known MDX/JSX components recursively, preserving unknown text. */
function renderComponents(source) {
  let text = source;

  // Self-closing cards and buttons first.
  text = text.replace(/<Card\b([^>]*?)\/>/g, (_, attrs) => renderCard(parseAttrs(attrs), ""));
  text = text.replace(
    /<Button\b([^>]*)>([\s\S]*?)<\/Button>/g,
    (_, attrs, label) => {
      const a = parseAttrs(attrs);
      const href = a.href ?? a.url ?? "";
      return `<a class="button" href="${escapeHtml(href)}" data-internal="${href.startsWith("/") ? "true" : "false"}" data-component="Button">${renderInline(label.trim())}</a>`;
    },
  );

  const simple = [
    ["CardGroup", (attrs, inner) => `<div class="card-group" data-component="CardGroup">${renderCards(inner)}</div>`],
    ["Card", renderCard],
    ["AccordionGroup", (attrs, inner) => `<div class="accordion-group" data-component="AccordionGroup">${renderBlocks(inner)}</div>`],
    ["Accordion", renderAccordion],
    ["CodeGroup", (attrs, inner) => `<div class="code-group" data-component="CodeGroup">${renderBlocks(inner)}</div>`],
    ["Steps", (attrs, inner) => `<div class="steps" data-component="Steps">${renderBlocks(inner)}</div>`],
    ["Step", (attrs, inner) => `<div class="step" data-component="Step"><p class="step-title">${renderInline(attrs.title ?? "")}</p>${renderBlocks(inner)}</div>`],
    ["Columns", (attrs, inner) => `<div class="columns" data-component="Columns">${renderBlocks(inner)}</div>`],
    ["Column", (attrs, inner) => `<div class="column" data-component="Column">${renderBlocks(inner)}</div>`],
    ["Frame", (attrs, inner) => `<figure class="frame" data-component="Frame">${renderBlocks(inner)}</figure>`],
    ["ClientOnly", (attrs, inner) => `<div class="client-only" data-component="ClientOnly">${renderBlocks(inner)}</div>`],
  ];

  for (const [tag, render] of simple) {
    if (tag === "Card") continue; // handled by the generic tag pass below
    const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "g");
    text = text.replace(re, (_, attrs, inner) => render(parseAttrs(attrs), inner));
  }

  for (const tag of CALLOUT_TAGS) {
    const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "g");
    text = text.replace(re, (_, attrs, inner) => renderCallout(tag, parseAttrs(attrs), inner));
  }

  // Cards with children (non self-closing).
  text = text.replace(/<Card\b([^>]*)>([\s\S]*?)<\/Card>/g, (_, attrs, inner) =>
    renderCard(parseAttrs(attrs), inner),
  );

  return text;
}

function renderCards(inner) {
  // renderBlocks already expands Card children; this keeps group markup simple.
  return renderBlocks(inner);
}

/** Convert JSX iframes (with style={{...}}) into plain HTML iframes. */
function renderIframes(source) {
  return source.replace(/<iframe\b([\s\S]*?)(?:\/>|<\/iframe>)/g, (_, attrs) => {
    const cleaned = attrs
      .replace(/\bstyle=\{\{[\s\S]*?\}\}/g, "")
      .replace(/\bclassName=/g, "class=");
    const src = /\bsrc="([^"]+)"/.exec(cleaned)?.[1];
    if (!src) return "";
    const title = /\btitle="([^"]+)"/.exec(cleaned)?.[1] ?? "Embedded content";
    const sandbox = /\bsandbox="([^"]+)"/.exec(cleaned)?.[1];
    const height = /\bheight="([^"]+)"/.exec(cleaned)?.[1] ?? "720";
    return `<iframe src="${escapeHtml(src)}" title="${escapeHtml(title)}" height="${escapeHtml(height)}"` +
      (sandbox ? ` sandbox="${escapeHtml(sandbox)}"` : "") +
      ` loading="lazy"></iframe>`;
  });
}

// ---------------------------------------------------------------------------
// Tables, lists, headings, paragraphs
// ---------------------------------------------------------------------------

function renderTable(lines) {
  const rows = lines
    .filter((line) => !/^\s*\|?\s*:?-{2,}/.test(line))
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
  if (rows.length === 0) return "";
  const [head, ...body] = rows;
  const headHtml = `<thead><tr>${head.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead>`;
  const bodyHtml = `<tbody>${body
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody>`;
  return `<div class="table-wrap"><table>${headHtml}${bodyHtml}</table></div>`;
}

/** Render a block of markdown (components already expanded). */
function renderBlocks(source, headings = []) {
  const placeholders = [];
  let text = String(source).replace(/\r\n/g, "\n");

  // Protect fenced code blocks before any other parsing.
  text = text.replace(/^([ \t]*)```([^\n]*)\n([\s\S]*?)^\1```[ \t]*$/gm, (_, indent, info, code) => {
    const attrs = info.trim();
    const lang = (attrs.split(/\s+/)[0] || "text").toLowerCase();
    const title = /title="([^"]+)"/.exec(attrs)?.[1];
    const html =
      `<div class="code-block" data-lang="${escapeHtml(lang)}">` +
      (title ? `<p class="code-title">${escapeHtml(title)}</p>` : "") +
      `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code.replace(/\n$/, ""))}</code></pre></div>`;
    placeholders.push(html);
    return `\n\n\u0000BLOCK${placeholders.length - 1}\u0000\n\n`;
  });

  text = renderIframes(text);
  text = renderComponents(text);

  const lines = text.split("\n");
  const out = [];
  let index = 0;

  const flushParagraph = (buffer) => {
    if (buffer.length === 0) return;
    out.push(`<p>${renderInline(buffer.join(" ").trim())}</p>`);
    buffer.length = 0;
  };

  const paragraph = [];

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph(paragraph);
      index += 1;
      continue;
    }

    const blockMatch = /^\u0000BLOCK(\d+)\u0000$/.exec(trimmed);
    if (blockMatch) {
      flushParagraph(paragraph);
      out.push(placeholders[Number(blockMatch[1])]);
      index += 1;
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      const level = heading[1].length;
      const rawTitle = heading[2].replace(/\s+\{#[^}]+\}\s*$/, "");
      const explicit = /\{#([^}]+)\}\s*$/.exec(heading[2])?.[1];
      const base = explicit ?? slugify(rawTitle);
      let id = base;
      let suffix = 1;
      while (headings.some((entry) => entry.id === id)) id = `${base}-${suffix++}`;
      const headingText = renderInline(rawTitle);
      headings.push({ id, level, text: stripInline(headingText) });
      out.push(`<h${level} id="${escapeHtml(id)}">${headingText}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph(paragraph);
      out.push("<hr />");
      index += 1;
      continue;
    }

    if (trimmed.startsWith("|") && lines[index + 1]?.includes("---")) {
      flushParagraph(paragraph);
      const tableLines = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        tableLines.push(lines[index]);
        index += 1;
      }
      out.push(renderTable(tableLines));
      continue;
    }

    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      flushParagraph(paragraph);
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (index < lines.length && /^\s*(?:[-*+]|\d+\.)\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*(?:[-*+]|\d+\.)\s+/, ""));
        index += 1;
      }
      out.push(
        `<${ordered ? "ol" : "ul"}>${items
          .map((item) => `<li>${renderInline(item)}</li>`)
          .join("")}</${ordered ? "ol" : "ul"}>`,
      );
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph(paragraph);
      const quote = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      out.push(`<blockquote>${renderBlocks(quote.join("\n"), headings)}</blockquote>`);
      continue;
    }

    // Raw HTML block (already-sanitised iframes, or explicit anchors).
    if (/^<(?:iframe|img|a|div|span|details|summary|picture|source|video|br)\b/i.test(trimmed)) {
      flushParagraph(paragraph);
      const html = [];
      let inTag = false;
      while (index < lines.length) {
        const current = lines[index];
        html.push(current);
        if (/^<(?:img|br)\b/i.test(trimmed)) {
          index += 1;
          break;
        }
        if (/<\/[a-z-]+>\s*$/i.test(current)) {
          index += 1;
          break;
        }
        inTag = inTag || !current.includes(">");
        index += 1;
        if (!inTag) break;
      }
      out.push(html.join("\n"));
      continue;
    }

    paragraph.push(trimmed);
    index += 1;
  }

  flushParagraph(paragraph);
  return out.join("\n");
}

function stripInline(html) {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Page rendering
// ---------------------------------------------------------------------------

export function parseFrontmatter(source) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  if (!match) return { data: {}, body: source };
  const data = {};
  for (const line of match[1].split("\n")) {
    const field = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (!field) continue;
    data[field[1]] = field[2].replace(/^["']|["']$/g, "");
  }
  return { data, body: source.slice(match[0].length) };
}

function stripMdxImports(body) {
  let inFence = false;
  return body
    .split("\n")
    .filter((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return true;
      }
      // Import/export statements are MDX scaffolding, never page content, but
      // the same words are legitimate first lines inside code fences.
      return inFence || !/^(?:import|export)\s/.test(line);
    })
    .join("\n");
}

export function renderPage(source, page, navigation) {
  const { data, body } = parseFrontmatter(source);
  const headings = [];
  const html = renderBlocks(stripMdxImports(body), headings);
  const title = data.title || page.path;

  const localAssets = new Set();
  const assetExtension = /\.(?:svg|png|jpe?g|gif|webp|ico|css|js|mjs|json|wasm|woff2?|ttf|mp4|webm)$/i;
  // Only files the preview actually serves count as assets. Other /scripts/
  // links point at repo sources referenced in prose, not site assets.
  const isAsset = (url) =>
    url.startsWith("/assets/") ||
    url.startsWith("/scripts/playground/") ||
    assetExtension.test(url.split("#")[0].split("?")[0]);
  for (const match of html.matchAll(/\bsrc="([^"]+)"/g)) {
    const url = match[1];
    if (!url.startsWith("/") || url.startsWith("//") || url.startsWith("/_preview")) continue;
    localAssets.add(url.split("#")[0].split("?")[0]);
  }
  for (const match of html.matchAll(/\bhref="([^"]+)"/g)) {
    const url = match[1];
    if (!url.startsWith("/") || url.startsWith("//") || url.startsWith("/_preview")) continue;
    const clean = url.split("#")[0].split("?")[0];
    if (isAsset(clean)) localAssets.add(clean);
  }

  const tab = navigation.tabs.find((entry) => entry.name === page.tab);
  const toc = headings
    .filter((heading) => heading.level <= 3)
    .map(
      (heading) =>
        `<a data-anchor href="#${escapeHtml(heading.id)}" data-level="${heading.level}">${escapeHtml(heading.text)}</a>`,
    )
    .join("");

  const sidebar = navigation.tabs
    .map(
      (entry) =>
        `<section class="nav-tab" data-nav-tab="${escapeHtml(entry.name)}"${entry.name === page.tab ? "" : " hidden"}>` +
        entry.groups
          .map(
            (group) =>
              `<div class="nav-group" data-nav-group="${escapeHtml(group.name)}">` +
              `<p class="nav-group-title">${escapeHtml(group.name)}</p>` +
              group.pages
                .map(
                  (item) =>
                    `<a class="nav-link${item.path === page.path ? " active" : ""}" data-internal="true" data-page="${escapeHtml(item.path)}" data-tab="${escapeHtml(entry.name)}" href="${escapeHtml(item.url)}">${escapeHtml(item.title ?? item.path.split("/").pop())}</a>`,
                )
                .join("") +
              `</div>`,
          )
          .join("") +
        `</section>`,
    )
    .join("");

  const tabs = navigation.tabs
    .map((entry) => {
      const target = entry.entry ? `/${entry.entry}` : "/introduction";
      return `<a class="tab-link${entry.name === page.tab ? " active" : ""}" data-internal="true" data-tab="${escapeHtml(entry.name)}" href="${escapeHtml(target)}">${escapeHtml(entry.name)}</a>`;
    })
    .join("");

  const description = data.description
    ? `<p class="page-description">${renderInline(data.description)}</p>`
    : "";

  return {
    title,
    description: data.description ?? "",
    headings,
    localAssets: [...localAssets],
    body: `<article class="mdx" id="page-content" data-page="${escapeHtml(page.path)}" data-tab="${escapeHtml(page.tab)}" data-group="${escapeHtml(page.group)}">` +
      `<h1>${escapeHtml(title)}</h1>${description}${html}</article>`,
    page: { ...page, title },
    toc,
    sidebar,
    tabs,
  };
}

function documentTemplate(view) {
  return `<!doctype html>
<html lang="en" data-hydrated="false">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(view.title)} — Wraith Protocol</title>
<link rel="icon" href="/assets/images/logo-black.png" />
<link rel="stylesheet" href="/_preview/style.css" />
<script src="/_preview/client.js" defer></script>
</head>
<body data-page="${escapeHtml(view.page.path)}" data-tab="${escapeHtml(view.page.tab)}">
<header class="topbar">
  <a class="brand" href="/introduction" data-internal="true">Wraith Protocol</a>
  <nav class="tabs" aria-label="Documentation tabs">${view.tabs}</nav>
</header>
<div class="layout">
  <nav class="sidebar" aria-label="Documentation navigation">${view.sidebar}</nav>
  <main class="content">${view.body}</main>
  <aside class="toc" aria-label="On this page"><p class="toc-title">On this page</p>${view.toc}</aside>
</div>
<footer class="footer"><a href="/introduction" data-internal="true">Wraith Protocol documentation</a></footer>
</body>
</html>
`;
}

function notFoundTemplate() {
  return `<!doctype html>
<html lang="en" data-hydrated="false">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Page not found — Wraith Protocol</title>
<link rel="icon" href="/assets/images/logo-black.png" />
<link rel="stylesheet" href="/_preview/style.css" />
<script src="/_preview/client.js" defer></script>
</head>
<body data-page="__not_found__" data-tab="">
<header class="topbar"><a class="brand" href="/introduction" data-internal="true">Wraith Protocol</a></header>
<main class="content not-found" id="page-content" data-page="__not_found__" data-not-found="true">
  <h1>404 — Page not found</h1>
  <p>The page you requested does not exist in this documentation preview.</p>
  <p><a href="/introduction" data-internal="true">Return to the introduction</a> or use the navigation.</p>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

async function listMdx(dir) {
  const found = [];
  const walk = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".mdx")) found.push(full);
    }
  };
  for (const dirName of SHIPPED_DIRS) await walk(path.join(repoRoot, dirName));
  for (const entry of await readdir(repoRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".mdx")) {
      found.push(path.join(repoRoot, entry.name));
    }
  }
  return found.map((file) => path.relative(repoRoot, file).split(path.sep).join("/"));
}

function resolveAsset(url) {
  // Static assets only: `/assets/x.svg` -> assets/x.svg,
  // `/scripts/playground/index.html` -> scripts/playground/index.html.
  const clean = url.replace(/^\//, "");
  return existsSync(path.join(repoRoot, clean)) ? clean : null;
}

async function main() {
  const docsJson = JSON.parse(await readFile(path.join(repoRoot, "docs.json"), "utf8"));
  const navigation = collectNavigation(docsJson);
  navigation.tabs = attachTabEntries(navigation.tabs, docsJson.tabs);

  const diskPages = await listMdx();
  const navPaths = new Set(navigation.pages.map((page) => page.path));
  const orphanPages = diskPages.filter((page) => !navPaths.has(page.replace(/\.mdx$/, "")));
  if (orphanPages.length > 0) {
    console.error(`Preview build failed: pages missing from docs.json navigation: ${orphanPages.join(", ")}`);
    process.exit(1);
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await mkdir(path.join(outDir, "_preview"), { recursive: true });

  const assets = await readFile(path.join(repoRoot, "scripts/preview/client.js"), "utf8");
  const styles = await readFile(path.join(repoRoot, "scripts/preview/style.css"), "utf8");
  await writeFile(path.join(outDir, "_preview/client.js"), assets);
  await writeFile(path.join(outDir, "_preview/style.css"), styles);

  await cp(path.join(repoRoot, "assets"), path.join(outDir, "assets"), { recursive: true });
  await cp(path.join(repoRoot, "scripts/playground"), path.join(outDir, "scripts/playground"), {
    recursive: true,
  });

  const rendered = [];
  const allAssets = new Set();
  const missingAssets = [];

  // Titles are read before rendering so the sidebar labels every entry the
  // same way the page header does.
  for (const page of navigation.pages) {
    const sourcePath = path.join(repoRoot, `${page.path}.mdx`);
    if (!existsSync(sourcePath)) {
      console.error(`Preview build failed: nav entry ${page.path} has no ${page.path}.mdx`);
      process.exit(1);
    }
    page.title = parseFrontmatter(await readFile(sourcePath, "utf8")).data.title ?? page.path;
  }
  for (const tab of navigation.tabs) {
    for (const group of tab.groups) {
      for (const page of group.pages) page.title = navigation.pages.find((entry) => entry.path === page.path)?.title;
    }
  }

  for (const page of navigation.pages) {
    const sourcePath = path.join(repoRoot, `${page.path}.mdx`);
    const source = await readFile(sourcePath, "utf8");
    const view = renderPage(source, page, navigation);
    const html = documentTemplate(view);
    await mkdir(path.dirname(path.join(outDir, `${page.path}.html`)), { recursive: true });
    await writeFile(path.join(outDir, `${page.path}.html`), html);
    if (page.path === "introduction") {
      await writeFile(path.join(outDir, "index.html"), html);
    }
    for (const asset of view.localAssets) allAssets.add(asset);
    rendered.push({ ...page, title: view.title, headings: view.headings, localAssets: view.localAssets });
  }

  for (const asset of allAssets) {
    const resolved = resolveAsset(asset);
    if (resolved === null) missingAssets.push(asset);
  }

  if (missingAssets.length > 0) {
    console.error(
      `Preview build failed: rendered pages reference missing local assets:\n${missingAssets
        .map((asset) => `  - ${asset}`)
        .join("\n")}`,
    );
    process.exit(1);
  }

  await writeFile(path.join(outDir, "404.html"), notFoundTemplate());

  const representativePages = [];
  for (const tab of navigation.tabs) {
    for (const group of tab.groups) {
      const first = group.pages[0];
      if (first) {
        representativePages.push({
          path: first.path,
          tab: tab.name,
          group: group.name,
        });
      }
    }
  }

  const generatedReferencePages = rendered
    .filter(
      (page) =>
        page.path.startsWith("reference/") || page.path.startsWith("api-reference/"),
    )
    .map((page) => ({ path: page.path, tab: page.tab, group: page.group, title: page.title }));

  await writeFile(
    path.join(outDir, "preview-manifest.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        tabs: navigation.tabs.map((tab) => ({
          name: tab.name,
          entry: tab.entry,
          groups: tab.groups.map((group) => ({
            name: group.name,
            pages: group.pages.map((page) => page.path),
          })),
        })),
        pages: rendered,
        representativePages,
        generatedReferencePages,
        assetCount: allAssets.size,
      },
      null,
      2,
    ),
  );

  console.log(
    `Preview built: ${rendered.length} pages, ${representativePages.length} navigation groups, ` +
      `${allAssets.size} local assets -> ${path.relative(repoRoot, outDir)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
