import { expect, test } from "@playwright/test";
import { collectIssues, expectHealthy, loadManifest, observe } from "./preview.js";
import type { PreviewIssue } from "./preview.js";

/**
 * These fixtures intentionally violate one acceptance gate each. If a gate
 * stops detecting its regression, this spec fails instead of the suite
 * silently passing broken previews.
 */
const manifest = loadManifest();

async function issuesFor(page: Parameters<typeof observe>[0], fixture: string): Promise<PreviewIssue[]> {
  const observation = observe(page);
  await page.goto(`/__fixtures/${fixture}`);
  return collectIssues(page, observation, manifest, {
    route: `__fixtures/${fixture}`,
  });
}

test.describe("preview failure detectors", () => {
  test("blank pages are detected", async ({ page }) => {
    const issues = await issuesFor(page, "blank");
    expect(issues.map((issue) => issue.code)).toContain("blank-page");
  });

  test("console errors are detected", async ({ page }) => {
    const issues = await issuesFor(page, "console-error");
    expect(issues.map((issue) => issue.code)).toContain("console-error");
  });

  test("missing hydration is detected", async ({ page }) => {
    const issues = await issuesFor(page, "unhydrated");
    expect(issues.map((issue) => issue.code)).toContain("hydration-missing");
  });

  test("missing generated assets are detected", async ({ page }) => {
    const issues = await issuesFor(page, "missing-asset");
    expect(issues.map((issue) => issue.code)).toContain("missing-asset");
  });

  test("broken navigation tab state is detected", async ({ page }) => {
    const issues = await issuesFor(page, "broken-tab");
    expect(issues.map((issue) => issue.code)).toContain("tab-state");
  });

  test("broken content tab state is detected", async ({ page }) => {
    const issues = await issuesFor(page, "tabs-broken");
    expect(issues.map((issue) => issue.code)).toContain("tabs-widget");
  });

  test("unresolved internal navigation is detected", async ({ page }) => {
    const issues = await issuesFor(page, "unresolved-link");
    expect(issues.map((issue) => issue.code)).toContain("unresolved-link");
  });

  test("failure reports name the route and navigation group", async ({ page }) => {
    const observation = observe(page);
    await page.goto("/__fixtures/blank");

    await expect(
      expectHealthy(page, observation, manifest, {
        route: "__fixtures/blank",
        group: "Fixture",
        tab: "Documentation",
      }),
    ).rejects.toThrow(/route "__fixtures\/blank" in group "Fixture"/);
  });
});
