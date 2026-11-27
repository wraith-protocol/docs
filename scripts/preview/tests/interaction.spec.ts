import { expect, test } from "@playwright/test";
import { annotateRoute, expectHealthy, loadManifest, observe, openPreview } from "./preview.js";

const manifest = loadManifest();

test.describe("client navigation", () => {
  test("navigates between pages without a full reload", async ({ page }, testInfo) => {
    annotateRoute("introduction", "Overview", "Documentation", test.info());
    const observation = observe(page);
    await openPreview(page, "introduction");
    await page.evaluate(() => {
      (window as unknown as { __reloadMarker: number }).__reloadMarker = 42;
    });

    // On mobile the sidebar is a drawer that must be opened first.
    if (testInfo.project.name === "mobile") await page.click("#preview-menu-button");

    const targetGroup = manifest.tabs[0].groups[1];
    const target = targetGroup.pages[0];
    await page.click(`#preview-sidebar [data-nav-route="${target.route}"]`);

    await expect(page).toHaveURL(new RegExp(`/${target.route}$`));
    await expect(page.locator("#preview-main h1")).toHaveText(manifest.routes[target.route].title);
    await expect(page.locator(`#preview-sidebar [data-nav-route="${target.route}"]`)).toHaveAttribute(
      "aria-current",
      "page",
    );

    const state = await page.evaluate(() => ({
      navigations: (window as unknown as { __preview: { navigations: number } }).__preview.navigations,
      marker: (window as unknown as { __reloadMarker?: number }).__reloadMarker,
    }));
    expect(state.navigations).toBeGreaterThanOrEqual(1);
    expect(state.marker, "client navigation must not reload the document").toBe(42);    await expectHealthy(page, observation, manifest, {
      route: target.route,
      group: targetGroup.group,
      tab: manifest.tabs[0].tab,
    });

  });

  test("switches navigation tabs and re-renders the sidebar", async ({ page }) => {
    const targetTab = manifest.tabs.find((tab) => tab.tab === "SDK") ?? manifest.tabs[1];
    const targetRoute = targetTab.groups[0].pages[0].route;
    annotateRoute(targetRoute, targetTab.groups[0].group, targetTab.tab, test.info());
    const observation = observe(page);
    await openPreview(page, "introduction");

    await page.click(`.topbar-tabs [data-tab-link="${targetTab.tab}"]`);

    await expect(page).toHaveURL(new RegExp(`/${targetRoute}$`));
    await expect(page.locator("#preview-sidebar")).toHaveAttribute("data-tab", targetTab.tab);
    await expect(page.locator(".topbar-tabs [aria-selected='true']")).toHaveCount(1);
    await expect(page.locator(`.topbar-tabs [data-tab-link="${targetTab.tab}"]`)).toHaveAttribute(
      "aria-selected",
      "true",
    );

    const sidebarGroups = await page
      .locator("#preview-sidebar [data-nav-group]")
      .evaluateAll((nodes) => [...new Set(nodes.map((node) => node.getAttribute("data-nav-group")))]);
    expect(sidebarGroups).toEqual(
      targetTab.groups.filter((group) => group.pages.length > 0).map((group) => group.group),
    );

    await expectHealthy(page, observation, manifest, {
      route: targetRoute,
      group: targetTab.groups[0].group,
      tab: targetTab.tab,
    });
  });

  test("anchor navigation scrolls to the target heading", async ({ page }) => {
    const route = "guides/stealth-payments";
    const anchor = "key-concepts";
    annotateRoute(route, manifest.routes[route].group, manifest.routes[route].tab, test.info());
    const observation = observe(page);

    await page.goto(`/${route}#${anchor}`);
    await expect(page.locator("html")).toHaveAttribute("data-anchor-ready", "true");
    await expect(page.locator(`#${anchor}`)).toBeVisible();

    const box = await page.locator(`#${anchor}`).boundingBox();
    expect(box, `Anchor #${anchor} has no layout box`).not.toBeNull();
    // Sub-pixel scrolling can leave the heading fractionally above the top.
    expect(box!.y).toBeGreaterThanOrEqual(-1);
    expect(box!.y).toBeLessThan(page.viewportSize()!.height);

    await expectHealthy(page, observation, manifest, {
      route,
      group: manifest.routes[route].group,
      tab: manifest.routes[route].tab,
    });
  });

  test("an in-page anchor link updates the hash without a page change", async ({ page }) => {
    const route = "reference/compatibility-matrix";
    annotateRoute(route, manifest.routes[route].group, manifest.routes[route].tab, test.info());
    const observation = observe(page);
    await openPreview(page, route);

    const link = page.locator('#preview-main a[href^="#"]').first();
    await expect(link).toBeVisible();
    const hash = await link.getAttribute("href");
    expect(hash, "The matrix should contain an in-page anchor link").toMatch(/^#[a-z0-9-]+$/);
    await link.click();

    await expect(page).toHaveURL(new RegExp(`${route.replace(/\//g, "\\/")}${hash}$`));
    await expect(page.locator(hash!)).toBeVisible();

    await expectHealthy(page, observation, manifest, {
      route,
      group: manifest.routes[route].group,
      tab: manifest.routes[route].tab,
    });
  });

  test("unknown routes render the not-found page with a way back", async ({ page }) => {
    const observation = observe(page);
    const response = await page.goto("/definitely-not-a-preview-page");
    expect(response?.status()).toBe(404);
    await expect(page.locator("[data-preview-not-found]")).toBeVisible();

    await page.click("[data-preview-not-found] a");
    await expect(page).toHaveURL(/\/introduction$/);
    await expect(page.locator("#preview-main h1")).toBeVisible();

    // The 404 document itself is expected to be logged as a failed resource;
    // every other console error is a real regression.
    const unexpected = observation.consoleErrors.filter(
      (message) => !/Failed to load resource.*404/.test(message),
    );
    expect(unexpected, `Console errors:\n${unexpected.join("\n")}`).toEqual([]);
    expect(observation.pageErrors, `Page errors:\n${observation.pageErrors.join("\n")}`).toEqual([]);
  });
});

test.describe("content tabs", () => {
  test("tab widgets switch panels and keep a single visible panel", async ({ page }) => {
    const route = "__fixtures/tabs-ok";
    annotateRoute(route, "Fixture", "Documentation", test.info());
    const observation = observe(page);
    await page.goto("/__fixtures/tabs-ok");

    const tabs = page.locator("[data-tabs]");
    await expect(tabs.locator("[data-tab-button]")).toHaveCount(2);
    await expect(tabs.locator("[role='tabpanel']:not([hidden])")).toHaveCount(1);

    await tabs.getByRole("tab", { name: "Python" }).click();
    await expect(tabs.getByRole("tab", { name: "Python" })).toHaveAttribute("aria-selected", "true");
    await expect(tabs.locator("[data-tab-panel]:not([hidden])")).toContainText("Python tab content");

    await expectHealthy(page, observation, manifest, {
      route,
      group: "Fixture",
      tab: "Documentation",
    });
  });
});

test.describe("mobile navigation", () => {
  test("the menu button opens the drawer and navigation closes it", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile viewport only");
    annotateRoute("introduction", "Overview", "Documentation", test.info());
    const observation = observe(page);
    await openPreview(page, "introduction");

    await expect(page.locator("#preview-sidebar")).toBeHidden();
    await page.click("#preview-menu-button");
    await expect(page.locator("body")).toHaveAttribute("data-menu-open", "true");
    await expect(page.locator("#preview-menu-button")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#preview-sidebar")).toBeVisible();

    const targetGroup = manifest.tabs[0].groups[1];
    const target = targetGroup.pages[0];
    await page.click(`#preview-sidebar [data-nav-route="${target.route}"]`);
    await expect(page).toHaveURL(new RegExp(`/${target.route}$`));
    await expect(page.locator("body")).not.toHaveAttribute("data-menu-open", "true");    await expectHealthy(page, observation, manifest, {
      route: target.route,
      group: targetGroup.group,
      tab: manifest.tabs[0].tab,
    });

  });
});
