import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Nav smoke tests for issue #223. These run against a deployed/preview docs
// site. Set MINTLIFY_PREVIEW_URL to enable; otherwise the suite is skipped.
const PREVIEW_URL = process.env.MINTLIFY_PREVIEW_URL || "";

const fixturePath = path.resolve(__dirname, "..", "..", "fixtures", "nav-smoke-routes.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

test.describe("nav smoke", () => {
  test.skip(!PREVIEW_URL, "MINTLIFY_PREVIEW_URL not set; skipping render smoke");

  for (const g of fixture.groups) {
    test(`renders representative page: ${g.tab}/${g.group} -> ${g.representative}`, async ({ page }) => {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
      page.on("pageerror", (e) => pageErrors.push(String(e)));

      const url = `${PREVIEW_URL.replace(/\/$/, "")}/${g.representative}`;
      const res = await page.goto(url);
      expect(res?.status()).toBeLessThan(400);
      await expect(page.locator("body")).not.toBeEmpty();
      expect(pageErrors).toEqual([]);
      expect(consoleErrors.filter((t) => !/favicon/i.test(t))).toEqual([]);
    });
  }

  test("not-found path renders", async ({ page }) => {
    const url = `${PREVIEW_URL.replace(/\/$/, "")}/this-page-does-not-exist-xyz`;
    const res = await page.goto(url);
    // Mintlify returns 404 page
    expect(res?.status()).toBeGreaterThanOrEqual(400);
  });
});
