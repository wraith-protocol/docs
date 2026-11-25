#!/usr/bin/env node
/**
 * build.mjs
 *
 * Builds an offline, static preview of the docs from docs.json and the
 * shipped .mdx pages. Playwright drives this preview (see tests/) so render
 * and navigation regressions are caught without a live Mintlify deployment.
 *
 *   node scripts/preview/build.mjs [--out <dir>]
 *
 * The build fails when a navigation entry cannot render, when a page renders
 * empty, when a local image is missing, or when an internal link points at a
 * route that does not exist. Those are content problems, not test flakiness.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readNavigation } from "./nav.mjs";
import { renderMdx } from "./render.mjs";
import { FIXTURE_ROUTE_PREFIX, GENERATED_REFERENCE_FAMILIES } from "./fixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const outIndex = process.argv.indexOf("--out");
const outDir = path.resolve(repoRoot, outIndex === -1 ? "preview-dist" : process.argv[outIndex + 1]);

const SITE_NAME = "Wraith Protocol Docs";

async function main() {
  const navigation = await readNavigation(repoRoot);
  const config = JSON.parse(await readFile(path.join(repoRoot, "docs.json"), "utf8"));
  const redirects = Object.fromEntries(
    (config.redirects || []).map((entry) => [entry.source, entry.destination]),
  );

  const routes = new Map();
  const tabs = [];

  for (const tab of navigation) {
    const groups = [];
    for (const group of tab.groups) {
      const pages = [];
      for (const route of group.pages) {
        if (routes.has(route)) {
          throw new Error(`Duplicate navigation entry for "${route}".`);
        }
        const page = await loadPage(route, { tab: tab.tab, group: group.group });
        routes.set(route, page);
        pages.push({ route, title: page.title });
      }
      groups.push({ group: group.group, pages });
    }
    const firstRoute = groups.flatMap((group) => group.pages)[0]?.route;
    if (!firstRoute) throw new Error(`Navigation tab "${tab.tab}" has no pages.`);
    tabs.push({ tab: tab.tab, groups, firstRoute });
  }

  if (routes.size === 0) throw new Error("No pages found in docs.json navigation.");

  // Pages that ship on disk but are not in the sidebar (for example the raw
  // audit report linked from reference/audits). They still need to render so
  // internal links to them resolve in the preview.
  for (const route of await discoverUnlistedPages(new Set(routes.keys()))) {
    const page = await loadPage(route, { tab: tabs[0].tab, group: "Unlisted" });
    page.unlisted = true;
    routes.set(route, page);
  }

  const assets = await collectAssets();
  const manifest = {
    siteName: SITE_NAME,
    routes: {},
    tabs,
    representatives: tabs.flatMap((tab) =>
      tab.groups
        .filter((group) => group.pages.length > 0)
        .map((group) => ({ tab: tab.tab, group: group.group, route: group.pages[0].route })),
    ),
    generatedFamilies: GENERATED_REFERENCE_FAMILIES,
    redirects,
    assets: [...assets],
    fixtureRoutes: [],
  };

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const routeLinks = buildRouteLinks(routes);

  for (const [route, page] of routes) {
    const html = pageShell({
      ...page,
      tabs,
      route,
      routes,
      body: page.html,
    });
    await writeRoute(route, html);
    manifest.routes[route] = {
      title: page.title,
      description: page.description,
      tab: page.tab,
      group: page.group,
      unlisted: Boolean(page.unlisted),
      anchors: page.anchors,
      generated: page.generated,
      href: routeLinks.get(route),
    };
  }

  const notFound = notFoundPage(tabs, routes);
  await writeFile(path.join(outDir, "404.html"), notFound, "utf8");

  await writeFixtures({ tabs, routes });
  manifest.fixtureRoutes = [
    `${FIXTURE_ROUTE_PREFIX}blank`,
    `${FIXTURE_ROUTE_PREFIX}console-error`,
    `${FIXTURE_ROUTE_PREFIX}unhydrated`,
    `${FIXTURE_ROUTE_PREFIX}missing-asset`,
    `${FIXTURE_ROUTE_PREFIX}broken-tab`,
    `${FIXTURE_ROUTE_PREFIX}unresolved-link`,
    `${FIXTURE_ROUTE_PREFIX}tabs-ok`,
    `${FIXTURE_ROUTE_PREFIX}tabs-broken`,
  ];

  await cp(path.join(__dirname, "static"), path.join(outDir, "_preview"), { recursive: true });
  await cp(path.join(repoRoot, "assets"), path.join(outDir, "assets"), { recursive: true });
  await writeFile(
    path.join(outDir, "_preview", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  validateGeneratedFamilies(routes);
  validatePages(routes, { manifest, assets });
  validateInternalLinks(routes, manifest);

  console.log(
    `Preview built: ${routes.size} pages across ${tabs.length} tabs in ${path.relative(repoRoot, outDir)}/`,
  );
  console.log(
    `Representative routes: ${manifest.representatives.length}; generated families: ${GENERATED_REFERENCE_FAMILIES.length}.`,
  );
}

const SHIPPED_DIRS = ["api-reference", "architecture", "concepts", "contracts", "guides", "reference", "sdk"];

/** Every .md/.mdx page on disk that docs.json does not list in the sidebar. */
async function discoverUnlistedPages(navRoutes) {
  const pages = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && /\.mdx?$/.test(entry.name)) {
        const route = path.relative(repoRoot, full).split(path.sep).join("/").replace(/\.mdx?$/, "");
        if (!navRoutes.has(route)) pages.push(route);
      }
    }
  };
  for (const dir of SHIPPED_DIRS) {
    try {
      await walk(path.join(repoRoot, dir));
    } catch {
      // Directory is optional (e.g. concepts/).
    }
  }
  return pages.sort();
}

async function loadPage(route, { tab, group }) {
  let source;
  try {
    source = await readFile(path.join(repoRoot, `${route}.mdx`), "utf8");
  } catch {
    source = await readFile(path.join(repoRoot, `${route}.md`), "utf8");
  }
  const { frontmatter, html, anchors, generated } = renderMdx(source);
  const title = frontmatter.title || route.split("/").pop();
  return {
    route,
    title,
    description: frontmatter.description || "",
    tab,
    group,
    html,
    anchors,
    generated,
  };
}

/** Canonical preview URL for every page. Root-level pages stay at /<route>. */
function buildRouteLinks(routes) {
  const links = new Map();
  for (const route of routes.keys()) links.set(route, `/${route}`);
  return links;
}

function topbarTabs(tabs, activeTab) {
  return tabs
    .map((tab) => {
      const targetRoute = tab.groups.flatMap((group) => group.pages)[0].route;
      const selected = tab.tab === activeTab;
      return `<a role="tab" href="/${targetRoute}" data-tab-link="${escapeAttr(tab.tab)}" aria-selected="${selected}"${
        selected ? ' aria-current="true"' : ""
      }>${escapeHtml(tab.tab)}</a>`;
    })
    .join("\n        ");
}

function sidebar(tabs, activeTab, activeRoute) {
  const tab = tabs.find((entry) => entry.tab === activeTab) || tabs[0];
  const groups = tab.groups
    .filter((group) => group.pages.length > 0)
    .map(
      (group) => `<div class="nav-group" data-nav-group="${escapeAttr(group.group)}">
        <h2>${escapeHtml(group.group)}</h2>
        <ul>
          ${group.pages
            .map((page) => {
              const href = `/${page.route}`;
              return `<li><a href="${href}" data-nav-route="${page.route}" data-nav-group="${escapeAttr(group.group)}"${
                page.route === activeRoute ? ' aria-current="page"' : ""
              }>${escapeHtml(page.title)}</a></li>`;
            })
            .join("\n          ")}
        </ul>
      </div>`,
    )
    .join("\n      ");

  return `<nav id="preview-sidebar" aria-label="${escapeAttr(tab.tab)} navigation" data-tab="${escapeAttr(tab.tab)}">
      ${groups}
    </nav>`;
}

function pageShell({ title, description, tab, group, route, tabs, routes, body, hydrated = true }) {
  const activeTab = tab || tabs[0].tab;
  const safeTitle = escapeHtml(title);    const content =
      body && body.trim().length > 0 ? body : '<div class="preview-empty" data-preview-empty></div>';
  return `<!doctype html>
<html lang="en" data-hydrated="false" data-route="${escapeAttr(route)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle} — ${SITE_NAME}</title>
  <meta name="description" content="${escapeAttr(description || "")}" />
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext y='13' font-size='13'%3EW%3C/text%3E%3C/svg%3E" />
  <link rel="stylesheet" href="/_preview/preview.css" />
</head>
<body>
  <a class="skip-link" href="#preview-main">Skip to content</a>
  <header class="topbar">
    <a class="brand" href="/introduction">Wraith Docs</a>
    <button id="preview-menu-button" type="button" aria-expanded="false" aria-controls="preview-sidebar">Menu</button>
    <nav class="topbar-tabs" role="tablist" aria-label="Documentation sections">
        ${topbarTabs(tabs, activeTab)}
    </nav>
  </header>
  <div class="shell">
    <aside class="sidebar" aria-label="Docs navigation">
      ${sidebar(tabs, activeTab, route)}
    </aside>
    <main id="preview-main" data-route="${escapeAttr(route)}" data-tab="${escapeAttr(activeTab)}" data-group="${escapeAttr(group || "")}">
      <p class="page-eyebrow">${escapeHtml(activeTab)}${group ? ` / ${escapeHtml(group)}` : ""}</p>
      <h1>${safeTitle}</h1>
      ${content}
    </main>
  </div>
  <footer class="footer">Wraith Protocol developer documentation · Offline preview</footer>
  ${hydrated ? '<script src="/_preview/preview.js" defer></script>' : ""}
</body>
</html>
`;
}

function notFoundPage(tabs, routes) {
  const first = routes.get(tabs[0].groups.flatMap((group) => group.pages)[0].route);
  const html = `<section data-preview-not-found class="not-found">
      <h1>Page not found</h1>
      <p>The page you requested is not part of the documentation preview.</p>
      <p><a href="/${first.route}">Return to ${escapeHtml(first.title)}</a></p>
    </section>`;
  return `<!doctype html>
<html lang="en" data-hydrated="false" data-route="__not-found">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Page not found — ${SITE_NAME}</title>
  <link rel="stylesheet" href="/_preview/preview.css" />
</head>
<body>
  <header class="topbar"><a class="brand" href="/introduction">Wraith Docs</a></header>
  <div class="shell">
    <main id="preview-main" data-route="__not-found" data-tab="${escapeAttr(tabs[0].tab)}" data-group="Not found">
      ${html}
    </main>
  </div>
  <script src="/_preview/preview.js" defer></script>
</body>
</html>
`;
}

async function writeRoute(route, html) {
  const filePath = path.join(outDir, `${route}.html`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, html, "utf8");
}

async function collectAssets() {
  const assetsDir = path.join(repoRoot, "assets");
  const files = new Set();
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.add(`/assets/${path.relative(assetsDir, full).split(path.sep).join("/")}`);
    }
  };
  await walk(assetsDir);
  return files;
}

function validateGeneratedFamilies(routes) {
  const failures = [];
  for (const family of GENERATED_REFERENCE_FAMILIES) {
    const page = routes.get(family.route);
    if (!page) {
      failures.push(`${family.family}: route "${family.route}" is not in docs.json navigation.`);
      continue;
    }
    if (family.marker && !page.generated.includes(family.marker)) {
      failures.push(
        `${family.family}: "${family.route}" has no generated "${family.marker}" section. ` +
          "Run the family's generator script and register the page.",
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`Generated reference family validation failed:\n- ${failures.join("\n- ")}`);
  }
}

function validatePages(routes, { manifest, assets }) {
  const failures = [];
  for (const [route, page] of routes) {
    const text = stripTags(page.html).trim();
    if (text.length < 80) {
      failures.push(`${route} (${manifest.routes[route].group}): rendered content is blank.`);
    }
    for (const src of imageSources(page.html)) {
      if (src.startsWith("/assets/") && !assets.has(src)) {
        failures.push(`${route}: missing asset ${src}`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`Preview render validation failed:\n- ${failures.join("\n- ")}`);
  }
}

function validateInternalLinks(routes, manifest) {
  const known = new Set([...routes.keys()].map((route) => `/${route}`));
  for (const destination of Object.values(manifest.redirects)) known.add(destination);
  const failures = [];
  for (const [route, page] of routes) {
    for (const href of internalLinks(page.html)) {
      const pathname = href.split("#")[0].split("?")[0];
      if (!pathname.startsWith("/")) continue;
      if (pathname.startsWith("/assets/") || pathname.startsWith("/_preview/")) continue;
      if (known.has(pathname.replace(/\/$/, ""))) continue;
      failures.push(`${route}: internal link "${href}" does not resolve to a page or redirect.`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Preview navigation validation failed:\n- ${failures.join("\n- ")}`);
  }
}

function imageSources(html) {
  return [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);
}

function internalLinks(html) {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((href) => href.startsWith("/"));
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

/**
 * Fixtures that intentionally violate one acceptance gate each. The detector
 * spec asserts the shared assertions catch every one of them, which keeps the
 * gates themselves from silently rotting.
 */
async function writeFixtures({ tabs, routes }) {
  const activeRoute = routes.keys().next().value;
  const activePage = routes.get(activeRoute);
  const base = {
    tabs,
    routes,
    title: "Preview fixture",
    description: "Intentional preview failure fixture",
    tab: activePage.tab,
    group: "Fixture",
  };

  const write = async (name, html) => {
    const filePath = path.join(outDir, FIXTURE_ROUTE_PREFIX, `${name}.html`);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, html, "utf8");
  };

  await write(
    "blank",
    pageShell({ ...base, route: `${FIXTURE_ROUTE_PREFIX}blank`, body: "" }),
  );

  const consoleErrorPage = pageShell({
    ...base,
    route: `${FIXTURE_ROUTE_PREFIX}console-error`,
    body: `<h2>Fixture</h2><p>${"content ".repeat(30)}</p><script>console.error("fixture: deliberate console error");</script>`,
  });
  await write("console-error", consoleErrorPage);

  await write(
    "unhydrated",
    pageShell({
      ...base,
      route: `${FIXTURE_ROUTE_PREFIX}unhydrated`,
      body: `<h2>Fixture</h2><p>${"content ".repeat(30)}</p>`,
      hydrated: false,
    }),
  );

  await write(
    "missing-asset",
    pageShell({
      ...base,
      route: `${FIXTURE_ROUTE_PREFIX}missing-asset`,
      body: `<h2>Fixture</h2><p>${"content ".repeat(30)}</p><img src="/assets/images/does-not-exist.png" alt="missing" />`,
    }),
  );

  // The page's tab disagrees with the selected top tab; the smoke check must
  // report a broken tab state rather than silently rendering the wrong group.
  const brokenTab = pageShell({
    ...base,
    route: `${FIXTURE_ROUTE_PREFIX}broken-tab`,
    body: `<h2>Fixture</h2><p>${"content ".repeat(30)}</p>`,
  }).replace(/(<main id="preview-main"[^>]*data-tab=")[^"]*(")/, '$1SDK$2');
  await write("broken-tab", brokenTab);

  await write(
    "unresolved-link",
    pageShell({
      ...base,
      linkOverride: true,
      route: `${FIXTURE_ROUTE_PREFIX}unresolved-link`,
      body: `<h2>Fixture</h2><p>${"content ".repeat(30)}</p><p><a href="/definitely-not-a-page">Broken internal link</a></p>`,
    }),
  );

  const tabsMdx = `<Tabs>
  <Tab title="TypeScript">
    TypeScript tab content.

    \`\`\`ts
    const chain = "stellar";
    \`\`\`
  </Tab>
  <Tab title="Python">
    Python tab content.
  </Tab>
</Tabs>`;
  const tabsRendered = renderMdx(tabsMdx).html;
  await write(
    "tabs-ok",
    pageShell({
      ...base,
      route: `${FIXTURE_ROUTE_PREFIX}tabs-ok`,
      body: `<h2>Working tabs</h2>${tabsRendered}<p>${"content ".repeat(30)}</p>`,
    }),
  );

  await write(
    "tabs-broken",
    pageShell({
      ...base,
      route: `${FIXTURE_ROUTE_PREFIX}tabs-broken`,
      body: `<h2>Broken tabs</h2>
        <div class="tabs" data-tabs>
          <div class="tablist" role="tablist">
            <button type="button" role="tab" aria-selected="true">One</button>
            <button type="button" role="tab" aria-selected="false">Two</button>
          </div>
          <div class="tabpanels">
            <div role="tabpanel">Panel one</div>
            <div role="tabpanel">Panel two</div>
          </div>
        </div>
        <p>${"content ".repeat(30)}</p>`,
    }),
  );

}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
