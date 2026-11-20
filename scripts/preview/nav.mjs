/**
 * nav.mjs
 *
 * Reads docs.json and returns the preview navigation model:
 *
 *   [{ tab, groups: [{ group, pages: [route, ...] }] }, ...]
 *
 * Only local page entries are returned; external links are ignored here and
 * validated by the source-level checks.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function readNavigation(repoRoot) {
  const raw = await readFile(path.join(repoRoot, "docs.json"), "utf8");
  return parseNavigation(JSON.parse(raw));
}

export function parseNavigation(config) {
  const tabs = Array.isArray(config?.navigation?.tabs) ? config.navigation.tabs : [];
  return tabs.map((tab) => ({
    tab: tab.tab,
    groups: (tab.groups || []).map((group) => ({
      group: group.group,
      pages: collectPages(group.pages),
    })),
  }));
}

function collectPages(pages = []) {
  const collected = [];
  const walk = (entry) => {
    if (typeof entry === "string") {
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(entry) && !entry.startsWith("//")) {
        collected.push(entry);
      }
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach(walk);
      return;
    }
    if (entry && typeof entry === "object") {
      if (typeof entry.page === "string") walk(entry.page);
      for (const [key, value] of Object.entries(entry)) {
        if (key === "pages") walk(value);
      }
    }
  };
  walk(pages);
  return collected;
}

/**
 * One representative page per navigation group. The first page in each group
 * is used; group pages intentionally stay stable so test titles map cleanly
 * to a navigation group in failure artifacts.
 */
export function representativePages(navigation) {
  const reps = [];
  for (const tab of navigation) {
    for (const group of tab.groups) {
      if (group.pages.length === 0) continue;
      reps.push({ tab: tab.tab, group: group.group, route: group.pages[0] });
    }
  }
  return reps;
}
