import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

/**
 * Shared health checks for the offline docs preview.
 *
 * Every gate returns a structured issue with a stable code, so specs can both
 * fail with an actionable message and prove (in detectors.spec.ts) that each
 * gate still catches its regression.
 */

export type PreviewManifest = {
  routes: Record<
    string,
    {
      title: string;
      description?: string;
      tab: string;
      group: string;
      unlisted?: boolean;
      anchors: string[];
      generated: string[];
      href: string;
    }
  >;
  tabs: { tab: string; firstRoute: string; groups: { group: string; pages: { route: string; title: string }[] }[] }[];
  representatives: { tab: string; group: string; route: string }[];
  generatedFamilies: { family: string; route: string; marker?: string; expectText: string; description: string }[];
  redirects: Record<string, string>;
  fixtureRoutes: string[];
};

export type PreviewIssue = {
  code:
    | "blank-page"
    | "hydration-missing"
    | "console-error"
    | "page-error"
    | "external-request"
    | "missing-asset"
    | "unresolved-link"
    | "missing-anchor"
    | "tab-state"
    | "tabs-widget"
    | "title-missing";
  message: string;
};

export type Observation = {
  consoleErrors: string[];
  pageErrors: string[];
  externalRequests: string[];
  failedAssetResponses: string[];
};

export function loadManifest(): PreviewManifest {
  const file = path.resolve(process.cwd(), "preview-dist", "_preview", "manifest.json");
  if (!fs.existsSync(file)) {
    throw new Error(`Preview manifest not found at ${file}. Run "node scripts/preview/build.mjs" first.`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as PreviewManifest;
}

/** Start collecting browser-side failures before navigating. */
export function observe(page: Page): Observation {
  const observation: Observation = {
    consoleErrors: [],
    pageErrors: [],
    externalRequests: [],
    failedAssetResponses: [],
  };

  page.on("console", (message) => {
    if (message.type() === "error") observation.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => observation.pageErrors.push(String(error)));
  page.on("request", (request) => {
    const host = new URL(request.url()).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") observation.externalRequests.push(request.url());
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/assets/") && response.status() >= 400) {
      observation.failedAssetResponses.push(`${response.status()} ${url.pathname}`);
    }
  });

  return observation;
}

export function annotateRoute(route: string, group: string, tab: string, info: TestInfo) {
  info.annotations.push({ type: "route", description: route });
  info.annotations.push({ type: "nav-group", description: group });
  info.annotations.push({ type: "nav-tab", description: tab });
}

export async function openPreview(page: Page, route: string) {
  const response = await page.goto(`/${route.replace(/^\//, "")}`, { waitUntil: "load" });
  expect(response, `No response for /${route}`).not.toBeNull();
  await page.waitForLoadState("domcontentloaded");
  return response;
}

/**
 * Collect every render/navigation issue on the current page.
 *
 * @param requireHydration set false only for the intentional hydration fixture.
 */
export async function collectIssues(
  page: Page,
  observation: Observation,
  manifest: PreviewManifest,
  options: { route: string; requireHydration?: boolean },
): Promise<PreviewIssue[]> {
  const issues: PreviewIssue[] = [];
  const route = options.route;
  const isFixture = route.startsWith("__fixtures/");
  const requireHydration = options.requireHydration !== false;

  const state = await page.evaluate(() => {
    const main = document.querySelector("#preview-main");
    const topTabs = Array.from(document.querySelectorAll(".topbar-tabs [role='tab']")).map((tab) => ({
      label: tab.getAttribute("data-tab-link") || "",
      selected: tab.getAttribute("aria-selected") === "true",
    }));
    const sidebar = document.querySelector("#preview-sidebar");
    const sidebarGroups = sidebar
      ? Array.from(sidebar.querySelectorAll("[data-nav-group]")).map((group) => group.getAttribute("data-nav-group") || "")
      : [];
    const tabs = Array.from(document.querySelectorAll("[data-tabs]")).map((widget) => {
      const buttons = Array.from(widget.querySelectorAll("[data-tab-button]"));
      const panels = Array.from(widget.querySelectorAll("[data-tab-panel]"));
      const selectedIndexes = buttons
        .map((button, index) => (button.getAttribute("aria-selected") === "true" ? index : -1))
        .filter((index) => index >= 0);
      const visiblePanelIndexes = panels
        .map((panel, index) => (panel.hasAttribute("hidden") ? -1 : index))
        .filter((index) => index >= 0);
      return {
        hasError: Boolean(widget.querySelector("[data-tabs-error]")),
        buttonCount: buttons.length,
        panelCount: panels.length,
        selectedIndexes,
        visiblePanelIndexes,
      };
    });
    const images = Array.from(document.querySelectorAll("#preview-main img")).map((img) => ({
      src: img.getAttribute("src") || "",
      loaded: (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0,
    }));
    const links = Array.from(document.querySelectorAll("a[href]")).map((a) => (a as HTMLAnchorElement).href);
    const ids = Array.from(document.querySelectorAll("[id]")).map((node) => node.id);
    const mainText = (main?.textContent || "").trim();
    return {
      hydrated: document.documentElement.getAttribute("data-hydrated") === "true",
      title: document.title,
      mainPresent: Boolean(main),
      mainTab: main?.getAttribute("data-tab") || "",
      mainGroup: main?.getAttribute("data-group") || "",
      headingCount: main ? main.querySelectorAll("h1, h2").length : 0,
      mainText,
      topTabs,
      sidebarGroups,
      tabs,
      images,
      links,
      ids,
      currentNavRoute: document.querySelector("#preview-sidebar [aria-current='page']")?.getAttribute("data-nav-route") || null,
    };
  });

  if (!state.mainPresent) {
    issues.push({ code: "blank-page", message: "The preview main landmark did not render." });
    return issues;
  }
  if (state.mainText.length < 80 || state.headingCount === 0) {
    issues.push({
      code: "blank-page",
      message: `Rendered content is blank or too thin (${state.mainText.length} chars, ${state.headingCount} headings).`,
    });
  }

  if (requireHydration && !state.hydrated) {
    issues.push({ code: "hydration-missing", message: "Client runtime did not mark the document as hydrated." });
  }

  if (!isFixture && state.title.trim().length === 0) {
    issues.push({ code: "title-missing", message: "Document title is empty." });
  }

  for (const message of observation.consoleErrors) {
    issues.push({ code: "console-error", message: `Console error: ${message}` });
  }
  for (const message of observation.pageErrors) {
    issues.push({ code: "page-error", message: `Uncaught page error: ${message}` });
  }
  for (const url of observation.externalRequests) {
    issues.push({ code: "external-request", message: `Requested external origin: ${url}` });
  }
  for (const failure of observation.failedAssetResponses) {
    issues.push({ code: "missing-asset", message: `Generated asset failed to load: ${failure}` });
  }
  for (const image of state.images) {
    if (!image.loaded) {
      issues.push({ code: "missing-asset", message: `Image did not load: ${image.src}` });
    }
  }

  const selectedTabs = state.topTabs.filter((tab) => tab.selected);
  if (selectedTabs.length !== 1) {
    issues.push({
      code: "tab-state",
      message: `Expected exactly one selected top tab, found ${selectedTabs.length}.`,
    });
  } else if (selectedTabs[0].label !== state.mainTab) {
    issues.push({
      code: "tab-state",
      message: `Selected tab "${selectedTabs[0].label}" does not match page tab "${state.mainTab}".`,
    });
  }

  if (!isFixture) {
    const expectedTab = manifest.tabs.find((tab) => tab.tab === state.mainTab);
    if (!expectedTab) {
      issues.push({
        code: "tab-state",
        message: `Page tab "${state.mainTab}" is not declared in docs.json.`,
      });
    } else {
      const expectedGroups = expectedTab.groups.filter((group) => group.pages.length > 0).map((group) => group.group);
      const actualGroups = [...new Set(state.sidebarGroups)];
      if (JSON.stringify(actualGroups) !== JSON.stringify(expectedGroups)) {
        issues.push({
          code: "tab-state",
          message: `Sidebar groups for tab "${state.mainTab}" are ${JSON.stringify(actualGroups)}, expected ${JSON.stringify(expectedGroups)}.`,
        });
      }
      if (!manifest.routes[route]?.unlisted && state.currentNavRoute !== route) {
        issues.push({
          code: "tab-state",
          message: `Sidebar has no aria-current entry for route "${route}" (found "${state.currentNavRoute}").`,
        });
      }
    }
  }

  for (const widget of state.tabs) {
    const broken =
      widget.hasError ||
      widget.buttonCount === 0 ||
      widget.buttonCount !== widget.panelCount ||
      widget.selectedIndexes.length !== 1 ||
      widget.visiblePanelIndexes.length !== 1 ||
      widget.selectedIndexes[0] !== widget.visiblePanelIndexes[0];
    if (broken) {
      issues.push({
        code: "tabs-widget",
        message: `Tab widget state is inconsistent: ${JSON.stringify(widget)}.`,
      });
    }
  }

  const pageOrigin = new URL(page.url()).origin;
  for (const href of state.links) {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    if (url.origin !== pageOrigin) continue;

    const pathname = url.pathname.replace(/\/$/, "") || "/";
    if (pathname === "/" || pathname.startsWith("/assets/") || pathname.startsWith("/_preview/")) continue;

    const hash = decodeURIComponent(url.hash.replace(/^#/, ""));
    if (pathname === new URL(page.url()).pathname.replace(/\/$/, "")) {
      // Same-page anchor (including the skip link): verify the element exists.
      if (hash && !state.ids.includes(hash)) {
        issues.push({
          code: "missing-anchor",
          message: `In-page anchor "#${hash}" has no target element.`,
        });
      }
      continue;
    }

    if (Object.keys(manifest.redirects).includes(pathname)) continue;
    const targetRoute = pathname.replace(/^\//, "");
    if (!manifest.routes[targetRoute]) {
      issues.push({ code: "unresolved-link", message: `Internal link does not resolve: ${url.pathname}` });
      continue;
    }
    if (hash && !manifest.routes[targetRoute].anchors.includes(hash)) {
      issues.push({
        code: "missing-anchor",
        message: `Anchor "${hash}" does not exist on route "${targetRoute}" (link: ${url.pathname}#${hash}).`,
      });
    }
  }

  return dedupe(issues);
}

/** Fail with a message that names the route and navigation group. */
export async function expectHealthy(
  page: Page,
  observation: Observation,
  manifest: PreviewManifest,
  options: { route: string; group: string; tab?: string; requireHydration?: boolean },
) {
  const issues = await collectIssues(page, observation, manifest, {
    route: options.route,
    requireHydration: options.requireHydration,
  });
  if (issues.length > 0) {
    const details = issues.map((issue) => `  - [${issue.code}] ${issue.message}`).join("\n");
    throw new Error(
      `Preview check failed for route "${options.route}" in group "${options.group}" (tab: ${options.tab || "?"}):\n${details}\n\nURL: ${page.url()}`,
    );
  }
  await test.info().attach("console-log", {
    body: JSON.stringify({ consoleErrors: observation.consoleErrors, pageErrors: observation.pageErrors }, null, 2),
    contentType: "application/json",
  });
}

function dedupe(issues: PreviewIssue[]): PreviewIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
