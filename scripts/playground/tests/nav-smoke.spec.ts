import { expect, test, type Page, type TestInfo } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Nav smoke tests for issue #223. They run against the disposable preview
// built and served by nav-smoke.config.ts (see the webServer entry), so there
// is no skip path: a preview that cannot build fails the suite.
const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "nav-smoke-routes.json",
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

function annotate(route: string, group: string, tab: string, info: TestInfo) {
  info.annotations.push({ type: "route", description: route });
  info.annotations.push({ type: "nav-group", description: group });
  info.annotations.push({ type: "nav-tab", description: tab });
}

type TabState = {
  mainTab: string;
  sidebarTab: string | null;
  selectedTabs: string[];
};

async function readTabState(page: Page): Promise<TabState> {
  return page.evaluate(() => ({
    mainTab: document.querySelector("#preview-main")?.getAttribute("data-tab") ?? "",
    sidebarTab: document.querySelector("#preview-sidebar")?.getAttribute("data-tab") ?? null,
    selectedTabs: Array.from(
      document.querySelectorAll(".topbar-tabs [role='tab'][aria-selected='true']"),
    ).map((tab) => tab.getAttribute("data-tab-link") ?? ""),
  }));
}

/** Reasons the selected docs tab, page tab and sidebar tab disagree. */
function tabStateIssues(state: TabState): string[] {
  const issues: string[] = [];
  if (state.selectedTabs.length !== 1) {
    issues.push(
      `expected exactly one selected docs tab, found ${state.selectedTabs.length} (${state.selectedTabs.join(", ") || "none"})`,
    );
  } else if (state.selectedTabs[0] !== state.mainTab) {
    issues.push(
      `selected docs tab "${state.selectedTabs[0]}" does not match the page tab "${state.mainTab}"`,
    );
  }
  if (state.sidebarTab !== state.mainTab) {
    issues.push(
      `sidebar tab "${state.sidebarTab ?? "none"}" does not match the page tab "${state.mainTab}"`,
    );
  }
  return issues;
}

async function expectTabState(page: Page, expectedTab: string) {
  const state = await readTabState(page);
  expect(state.mainTab, `Page tab should be "${expectedTab}"`).toBe(expectedTab);
  expect(tabStateIssues(state), `Docs tab state: ${JSON.stringify(state)}`).toEqual([]);
}

test.describe("nav smoke", () => {
  for (const g of fixture.groups) {
    test(`renders representative page: ${g.tab}/${g.group} -> ${g.representative}`, async ({ page }, testInfo) => {
      annotate(g.representative, g.group, g.tab, testInfo);

      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const failedAssets: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text());
      });
      page.on("pageerror", (e) => pageErrors.push(String(e)));
      page.on("response", (response) => {
        const pathname = new URL(response.url()).pathname;
        if (pathname.startsWith("/assets/") && response.status() >= 400) {
          failedAssets.push(`${response.status()} ${pathname}`);
        }
      });

      const res = await page.goto(`/${g.representative.replace(/^\//, "")}`);
      expect(res?.status()).toBeLessThan(400);
      await expect(page.locator("#preview-main h1")).toBeVisible();
      await expect(page.locator(`#preview-sidebar [data-nav-route="${g.representative}"]`)).toHaveAttribute(
        "aria-current",
        "page",
      );
      // The page must hydrate: client navigation and tab state depend on it.
      await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
      expect(failedAssets, `Generated assets failed to load:\n${failedAssets.join("\n")}`).toEqual([]);
      expect(pageErrors).toEqual([]);
      expect(consoleErrors.filter((t) => !/favicon/i.test(t))).toEqual([]);
    });
  }

  for (const family of fixture.generatedReferenceFamilies) {
    test(`renders generated reference family: ${family}`, async ({ page }, testInfo) => {
      annotate(family, "Generated reference", "Reference", testInfo);
      const res = await page.goto(`/${family.replace(/^\//, "")}`);
      expect(res?.status()).toBeLessThan(400);
      await expect(page.locator("#preview-main")).toContainText(/\w/);
      await expect(page.locator("#preview-main table, #preview-main pre").first()).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
    });
  }

  test("client navigation keeps the document alive and updates the sidebar", async ({ page }, testInfo) => {
    annotate("introduction", "Overview", fixture.groups[0].tab, testInfo);
    await page.goto("/introduction");
    await page.evaluate(() => {
      (window as unknown as { __navMarker: number }).__navMarker = 7;
    });

    // On mobile the sidebar is a drawer that must be opened first.
    if (testInfo.project.name === "mobile") await page.click("#preview-menu-button");

    const target = fixture.groups[1];
    await page.click(`#preview-sidebar [data-nav-route="${target.representative}"]`);

    await expect(page).toHaveURL(new RegExp(`/${target.representative}$`));
    await expect(page.locator(`#preview-sidebar [data-nav-route="${target.representative}"]`)).toHaveAttribute(
      "aria-current",
      "page",
    );
    const marker = await page.evaluate(
      () => (window as unknown as { __navMarker?: number }).__navMarker,
    );
    expect(marker, "navigation must not reload the document").toBe(7);
  });

  test("anchor navigation scrolls the target heading into view", async ({ page }, testInfo) => {
    const route = "guides/stealth-payments";
    const anchor = "key-concepts";
    annotate(`${route}#${anchor}`, "Guides", "Guides", testInfo);

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    const res = await page.goto(`/${route}#${anchor}`);
    expect(res?.status()).toBeLessThan(400);
    await expect(page.locator("html")).toHaveAttribute("data-anchor-ready", "true");
    expect(new URL(page.url()).hash).toBe(`#${anchor}`);

    const target = page.locator(`#${anchor}`);
    await expect(target).toBeVisible();
    const box = await target.boundingBox();
    expect(box, `Anchor #${anchor} has no layout box`).not.toBeNull();
    // Sub-pixel scrolling can leave the heading fractionally above the top.
    expect(box!.y).toBeGreaterThanOrEqual(-1);
    expect(box!.y).toBeLessThan(page.viewportSize()!.height);

    expect(pageErrors, `Page errors:\n${pageErrors.join("\n")}`).toEqual([]);
    expect(consoleErrors.filter((t) => !/favicon/i.test(t))).toEqual([]);
  });

  test("switching a docs tab updates the selected tab, URL and sidebar", async ({ page }, testInfo) => {
    const startTab = fixture.groups[0];
    const targetTab = fixture.groups.find((group) => group.tab !== startTab.tab);
    if (!targetTab) throw new Error("Nav smoke fixture needs at least two navigation tabs.");
    annotate(targetTab.representative, targetTab.group, targetTab.tab, testInfo);

    await page.goto(`/${startTab.representative}`);
    await page.evaluate(() => {
      (window as unknown as { __navMarker: number }).__navMarker = 11;
    });

    await page.click(`.topbar-tabs [data-tab-link="${targetTab.tab}"]`);

    await expect(page).toHaveURL(new RegExp(`/${targetTab.representative}$`));
    await expect(page.locator(".topbar-tabs [aria-selected='true']")).toHaveCount(1);
    await expect(page.locator(`.topbar-tabs [data-tab-link="${targetTab.tab}"]`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("#preview-sidebar")).toHaveAttribute("data-tab", targetTab.tab);
    await expectTabState(page, targetTab.tab);

    const expectedGroups = [
      ...new Set(fixture.groups.filter((group) => group.tab === targetTab.tab).map((group) => group.group)),
    ];
    const sidebarGroups = await page
      .locator("#preview-sidebar [data-nav-group]")
      .evaluateAll((nodes) => [...new Set(nodes.map((node) => node.getAttribute("data-nav-group")))]);
    expect(sidebarGroups, "Sidebar must re-render for the selected docs tab").toEqual(expectedGroups);

    const marker = await page.evaluate(
      () => (window as unknown as { __navMarker?: number }).__navMarker,
    );
    expect(marker, "switching docs tabs must not reload the document").toBe(11);
  });

  test("a broken docs tab state is detected, not rendered silently", async ({ page }, testInfo) => {
    annotate("__fixtures/broken-tab", "Fixture", "Documentation", testInfo);
    const res = await page.goto("/__fixtures/broken-tab");
    expect(res?.status()).toBeLessThan(400);

    const state = await readTabState(page);
    const issues = tabStateIssues(state);
    expect(issues, `Expected a broken tab state: ${JSON.stringify(state)}`).not.toEqual([]);
    expect(issues.join("\n")).toMatch(/does not match the page tab/);
  });

  test("not-found path renders the built 404 page", async ({ page }) => {
    const res = await page.goto("/this-page-does-not-exist-xyz");
    expect(res?.status()).toBeGreaterThanOrEqual(400);
    await expect(page.locator("[data-preview-not-found]")).toBeVisible();
  });
});
