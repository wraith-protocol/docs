import { expect, test } from "@playwright/test";
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

function annotate(route: string, group: string, tab: string, info: import("@playwright/test").TestInfo) {
  info.annotations.push({ type: "route", description: route });
  info.annotations.push({ type: "nav-group", description: group });
  info.annotations.push({ type: "nav-tab", description: tab });
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

  test("not-found path renders the built 404 page", async ({ page }) => {
    const res = await page.goto("/this-page-does-not-exist-xyz");
    expect(res?.status()).toBeGreaterThanOrEqual(400);
    await expect(page.locator("[data-preview-not-found]")).toBeVisible();
  });
});
