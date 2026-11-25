import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  annotateRoute,
  expectHealthy,
  loadManifest,
  observe,
  openPreview,
} from "./preview.js";

const manifest = loadManifest();

test.describe("docs preview navigation and render", () => {
  for (const representative of manifest.representatives) {
    test(`[${representative.group}] ${representative.route} renders with navigation`, async ({ page }) => {
      annotateRoute(representative.route, representative.group, representative.tab, test.info());
      const observation = observe(page);
      const response = await openPreview(page, representative.route);
      expect(response?.status(), `Expected 200 for /${representative.route}`).toBe(200);

      await expect(page.locator("#preview-main h1")).toBeVisible();
      await expect(page.locator(`#preview-sidebar [data-nav-route="${representative.route}"]`)).toHaveAttribute(
        "aria-current",
        "page",
      );

      await expectHealthy(page, observation, manifest, {
        route: representative.route,
        group: representative.group,
        tab: representative.tab,
      });
    });
  }

  for (const family of manifest.generatedFamilies) {
    test(`[generated:${family.family}] ${family.route} renders its generated family`, async ({ page }) => {
      const route = manifest.routes[family.route];
      test.skip(!route, `Generated family route ${family.route} is not in docs.json navigation.`);
      annotateRoute(family.route, route.group, route.tab, test.info());
      const observation = observe(page);
      await openPreview(page, family.route);

      await expect(page.locator("#preview-main")).toContainText(family.expectText);

      if (family.marker) {
        const generated = page.locator(`[data-generated="${family.marker}"]`);
        await expect(generated, `Missing generated section "${family.marker}"`).toHaveCount(1);
        await expect(generated).not.toBeEmpty();
      }

      // Generated reference pages must render their tables and code blocks,
      // not just a heading (a partial generator run should fail here).
      await expect(page.locator("#preview-main table, #preview-main pre").first()).toBeVisible();

      await expectHealthy(page, observation, manifest, {
        route: family.route,
        group: route.group,
        tab: route.tab,
      });
    });
  }
});

test.describe("built preview link integrity", () => {
  const distDir = path.resolve(process.cwd(), "preview-dist");

  function builtPages(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "_preview" || entry.name === "assets" || entry.name === "__fixtures") return [];
        return builtPages(full);
      }
      return entry.isFile() && entry.name.endsWith(".html") ? [full] : [];
    });
  }

  test("every internal link and anchor resolves in the built preview", () => {
    const failures: string[] = [];

    for (const file of builtPages(distDir)) {
      const html = fs.readFileSync(file, "utf8");
      const route = path
        .relative(distDir, file)
        .split(path.sep)
        .join("/")
        .replace(/\.html$/, "");
      const sourceRoute = route === "404" ? null : route;
      const pageIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));

      for (const match of html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)) {
        const href = match[1];
        if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) continue;

        if (href.startsWith("#")) {
          const anchor = decodeURIComponent(href.slice(1));
          if (anchor && !pageIds.has(anchor)) {
            failures.push(`${sourceRoute ?? "404"}: in-page anchor "${href}" has no target element.`);
          }
          continue;
        }

        // Relative links resolve against the current page, as they do in a
        // browser and on the docs host.
        const resolved = new URL(
          href,
          sourceRoute ? `http://preview.local/${sourceRoute}` : "http://preview.local/404",
        );
        const pathname = resolved.pathname.replace(/\/$/, "") || "/";
        if (pathname === "/" || pathname.startsWith("/assets/") || pathname.startsWith("/_preview/")) continue;

        if (Object.keys(manifest.redirects).includes(pathname)) continue;
        const target = pathname.replace(/^\//, "");
        const targetRoute = manifest.routes[target];
        if (!targetRoute) {
          failures.push(`${sourceRoute ?? "404"}: link "${href}" does not resolve to a page.`);
          continue;
        }
        if (resolved.hash) {
          const anchor = decodeURIComponent(resolved.hash.replace(/^#/, ""));
          if (!targetRoute.anchors.includes(anchor)) {
            failures.push(`${sourceRoute ?? "404"}: link "${href}" targets a missing anchor on ${target}.`);
          }
        }
      }
    }

    expect(failures, `Broken internal navigation:\n${failures.join("\n")}`).toEqual([]);
  });
});
