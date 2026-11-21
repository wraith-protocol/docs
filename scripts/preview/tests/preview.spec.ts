import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// Smoke tests for the docs preview. Every navigation group and every generated
// reference family is loaded directly, then client navigation, anchor
// navigation, tab state, and the not-found path are exercised. Each test fails
// on a blank page, console error, hydration failure, missing generated asset,
// failed request, or unresolved internal navigation.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const previewDir = path.resolve(
  repoRoot,
  process.env.PREVIEW_DIR || "node_modules/.cache/docs-preview",
);

type PageEntry = {
  path: string;
  tab: string;
  group: string;
  title?: string;
  headings?: { id: string; level: number; text: string }[];
  localAssets?: string[];
};

type Manifest = {
  tabs: { name: string; entry: string | null; groups: { name: string; pages: string[] }[] }[];
  pages: PageEntry[];
  representativePages: PageEntry[];
  generatedReferencePages: PageEntry[];
};

const manifest: Manifest = JSON.parse(
  readFileSync(path.join(previewDir, "preview-manifest.json"), "utf8"),
);

type Diagnostics = {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  badResponses: string[];
};

const ORIGIN = new URL(process.env.PREVIEW_BASE_URL || "http://127.0.0.1:4174").origin;

function trackDiagnostics(page: Page): Diagnostics {
  const diagnostics: Diagnostics = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    badResponses: [],
  };
  const origin = ORIGIN;

  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("favicon")) {
      diagnostics.consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(String(error)));
  page.on("requestfailed", (request) => {
    if (request.url().startsWith(origin)) {
      diagnostics.failedRequests.push(`${request.url()} (${request.failure()?.errorText ?? "failed"})`);
    }
  });
  page.on("response", (response) => {
    if (response.url().startsWith(origin) && response.status() >= 400) {
      diagnostics.badResponses.push(`${response.status()} ${response.url()}`);
    }
  });
  return diagnostics;
}

function attachContext(entry: PageEntry, diagnostics?: Diagnostics) {
  test.info().annotations.push(
    { type: "route", description: `/${entry.path}` },
    { type: "tab", description: entry.tab },
    { type: "group", description: entry.group },
  );
  if (diagnostics) {
    test.info().attach("route-context.json", {
      contentType: "application/json",
      body: JSON.stringify({ entry, diagnostics }, null, 2),
    });
  }
}

function expectClean(diagnostics: Diagnostics) {
  expect(diagnostics.pageErrors, "uncaught page errors").toEqual([]);
  expect(diagnostics.consoleErrors, "console errors").toEqual([]);
  expect(diagnostics.failedRequests, "failed same-origin requests").toEqual([]);
  expect(diagnostics.badResponses, "same-origin responses with status >= 400").toEqual([]);
}

async function expectRendered(page: Page, entry: PageEntry, diagnostics: Diagnostics) {
  const response = await page.goto(`/${entry.path}`, { waitUntil: "networkidle" });
  expect(response?.status(), `GET /${entry.path}`).toBe(200);

  // Hydration: the preview client marks the document only after it has wired
  // tabs, active links, and the router.
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");

  const content = page.locator("#page-content");
  await expect(content).toBeVisible();
  await expect(content).toHaveAttribute("data-page", entry.path);

  const heading = content.locator("h1").first();
  await expect(heading).toBeVisible();
  await expect(heading).not.toHaveText("");

  const text = ((await content.textContent()) ?? "").replace(/\s+/g, " ").trim();
  expect(text.length, `blank page at /${entry.path}`).toBeGreaterThan(200);

  // Generated assets referenced from this page must exist and load.
  for (const asset of manifestAssetList(entry.path)) {
    const assetResponse = await page.request.get(asset);
    expect(assetResponse.status(), `asset ${asset} referenced by /${entry.path}`).toBe(200);
  }

  for (const image of await page.locator("#page-content img").all()) {
    // Images below the fold are lazy-loaded; scroll them into view first.
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(async () => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0), {
        message: `image failed to load on /${entry.path}: ${await image.getAttribute("src")}`,
      })
      .toBe(true);
  }

  expectClean(diagnostics);
}

function manifestAssetList(pagePath: string): string[] {
  return manifest.pages.find((page) => page.path === pagePath)?.localAssets ?? [];
}

test.describe("docs preview navigation and rendering", () => {
  test("every navigation group renders a representative page", async ({ page }) => {
    const diagnostics = trackDiagnostics(page);
    test.info().annotations.push({ type: "groups", description: String(manifest.representativePages.length) });

    for (const entry of manifest.representativePages) {
      await test.step(`${entry.tab} / ${entry.group} → /${entry.path}`, async () => {
        attachContext(entry, diagnostics);
        await page.goto("about:blank");
        await expectRendered(page, entry, diagnostics);
        const activeTabs = page.locator(".tab-link.active");
        await expect(activeTabs).toHaveCount(1);
        await expect(activeTabs).toHaveAttribute("data-tab", entry.tab);
        const visibleGroup = page.locator(".nav-tab:not([hidden]) .nav-group-title");
        await expect(visibleGroup.filter({ hasText: entry.group })).toHaveCount(1);
      });
    }
  });

  test("every generated reference family renders", async ({ page }) => {
    const diagnostics = trackDiagnostics(page);
    expect(manifest.generatedReferencePages.length).toBeGreaterThan(0);

    for (const entry of manifest.generatedReferencePages) {
      await test.step(`${entry.tab} / ${entry.group} → /${entry.path}`, async () => {
        attachContext(entry, diagnostics);
        await page.goto("about:blank");
        await expectRendered(page, entry, diagnostics);
      });
    }
  });

  test("client navigation moves across groups and keeps tab state in sync", async ({ page }) => {
    const diagnostics = trackDiagnostics(page);
    const entry: PageEntry = { path: "introduction", tab: "Documentation", group: "Overview" };
    attachContext(entry, diagnostics);

    await page.goto("/introduction");
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
    await expect(page.locator(".tab-link.active")).toHaveAttribute("data-tab", "Documentation");

    // Cross-tab navigation: the Documentation sidebar must hide and the SDK
    // sidebar must become the only visible one.
    await page.locator('.tab-link[data-tab="SDK"]').click();
    await expect(page).toHaveURL(/\/sdk\/overview$/);
    await expect(page.locator("#page-content")).toHaveAttribute("data-page", "sdk/overview");
    await expect(page.locator("body")).toHaveAttribute("data-tab", "SDK");
    await expect(page.locator(".tab-link.active")).toHaveAttribute("data-tab", "SDK");
    await expect(page.locator('.nav-tab[data-nav-tab="Documentation"]')).toBeHidden();
    await expect(page.locator('.nav-tab[data-nav-tab="SDK"]')).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-navigations", "0");

    // In-tab navigation through the sidebar.
    await page.locator('.nav-link[data-page="sdk/chains/evm"]').click();
    await expect(page).toHaveURL(/\/sdk\/chains\/evm$/);
    await expect(page.locator("#page-content")).toHaveAttribute("data-page", "sdk/chains/evm");
    await expect(page.locator('.nav-link[data-page="sdk/chains/evm"]')).toHaveClass(/active/);

    // A third group in a third tab.
    await page.locator('.tab-link[data-tab="Guides"]').click();
    await expect(page).toHaveURL(/\/guides\/quickstarts\/python$/);
    await expect(page.locator("#page-content")).toHaveAttribute("data-page", "guides/quickstarts/python");
    await expect(page.locator('.nav-tab[data-nav-tab="Guides"]')).toBeVisible();
    await expect(page.locator('.nav-tab[data-nav-tab="SDK"]')).toBeHidden();

    expectClean(diagnostics);
  });

  test("anchor navigation reaches every rendered heading target", async ({ page }) => {
    const diagnostics = trackDiagnostics(page);
    const entry: PageEntry = { path: "getting-started", tab: "Documentation", group: "Overview" };
    attachContext(entry, diagnostics);

    await page.goto("/getting-started");
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");

    const tocLinks = page.locator('.toc a[data-anchor]');
    const count = await tocLinks.count();
    expect(count, "getting-started should render an on-page table of contents").toBeGreaterThan(1);

    for (let index = 0; index < count; index += 1) {
      const link = tocLinks.nth(index);
      const href = await link.getAttribute("href");
      expect(href).toMatch(/^#[a-z0-9-]+$/);
      // The table of contents is hidden on narrow viewports, so trigger the
      // anchor from the DOM to exercise the same navigation on both widths.
      await link.evaluate((node) => (node as HTMLElement).click());
      await expect(page).toHaveURL(new RegExp(`${href}$`));
      const target = page.locator(href!);
      await expect(target).toHaveCount(1);
      await expect(target).toBeVisible();
    }

    // Anchor navigation must keep working after a client-side page swap.
    await page.goto("/reference/error-codes");
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
    const firstAnchor = page.locator('.toc a[data-anchor]').first();
    const firstHref = await firstAnchor.getAttribute("href");
    await firstAnchor.evaluate((node) => (node as HTMLElement).click());
    await expect(page).toHaveURL(new RegExp(`${firstHref}$`));
    await expect(page.locator(firstHref!)).toBeVisible();

    expectClean(diagnostics);
  });

  test("the not-found path renders a real 404 page", async ({ page }) => {
    const diagnostics = trackDiagnostics(page);
    test.info().annotations.push({ type: "route", description: "/this-page-does-not-exist" });

    const response = await page.goto("/this-page-does-not-exist");
    expect(response?.status()).toBe(404);
    const notFound = page.locator('[data-not-found="true"]');
    await expect(notFound).toBeVisible();
    await expect(notFound.locator("h1")).toContainText("404");
    await expect(notFound.getByRole("link", { name: /return to the introduction/i })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");

    // The 404 response is expected here; every other signal must be clean.
    // Chromium logs the failed document request itself, so that one message is
    // expected — any other console error still fails the test.
    expect(diagnostics.pageErrors, "uncaught page errors").toEqual([]);
    expect(
      diagnostics.consoleErrors.filter((message) => !/status of 404/i.test(message)),
      "console errors",
    ).toEqual([]);
    expect(diagnostics.failedRequests, "failed same-origin requests").toEqual([]);
  });

  test("embedded playground links resolve in the preview", async ({ page }) => {
    const diagnostics = trackDiagnostics(page);
    const entry: PageEntry = {
      path: "api-reference/stealth-keys",
      tab: "API Reference",
      group: "API Reference",
    };
    attachContext(entry, diagnostics);

    await page.goto(`/${entry.path}`, { waitUntil: "networkidle" });
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");

    const frame = page.locator('iframe[src*="/scripts/playground/index.html"]');
    await expect(frame).toHaveCount(1);
    const src = await frame.getAttribute("src");
    expect(src).toContain("step=derive");

    const playgroundResponse = await page.request.get(src!);
    expect(playgroundResponse.status()).toBe(200);
    const html = await playgroundResponse.text();
    expect(html).toContain("Wraith");
    expect(html).not.toMatch(/<script[^>]+src=["']https?:\/\//i);

    expectClean(diagnostics);
  });
});
