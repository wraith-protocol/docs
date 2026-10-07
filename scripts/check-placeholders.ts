/**
 * check-placeholders.ts
 *
 * Scans shipped MDX pages and docs.json for placeholder contract IDs,
 * pending-deployment prose, and TODO markers that must not reach production.
 *
 * Exit codes
 *   0 — clean
 *   1 — one or more violations found (or the allowlist file is malformed)
 *
 * Allowlist
 *   scripts/placeholder-allowlist.json  — relative paths (from repo root) of
 *   pages where placeholders are intentional, e.g. research / roadmap pages.
 *
 * Usage
 *   pnpm run check:placeholders
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const repoRoot = process.cwd();

/** Directories that are never shipped docs. */
const ignoredDirs = new Set([
  ".git",
  ".github",
  ".agents",
  ".claude",
  "node_modules",
  ".next",
  "dist",
  "build",
  "scripts",        // the scripts themselves are not docs pages
  "assets",
  "docs",           // /docs/ holds internal markdown (CONTRIBUTING etc.), not MDX pages
]);

/**
 * Navigation groups whose pages must be clean.
 * These match the `group` values in docs.json navigation tabs.
 */
const ENFORCED_GROUPS = new Set([
  "Quickstarts",
  "API Reference",
  "Reference",
  // Operations guides (the "Operations" group and ops/ sub-pages)
  "Operations",
]);

/**
 * Navigation tabs whose pages must be clean (all pages in the tab).
 * Currently we enforce the API Reference tab entirely.
 */
const ENFORCED_TABS = new Set([
  "API Reference",
]);

/**
 * Patterns that indicate a placeholder or unresolved TODO.
 *
 * Each entry has:
 *   pattern  — regex applied per line (case-sensitive unless `i` flag present)
 *   label    — human-readable category shown in output
 */
const PLACEHOLDER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Soroban contract ID placeholders — starts with C, all uppercase + underscores
  {
    pattern: /CPLACEHOLDER[A-Z0-9_]*/,
    label: "placeholder contract ID",
  },
  // Generic placeholder sentinel text
  {
    pattern: /\bPLACEHOLDER\b/,
    label: "PLACEHOLDER sentinel",
  },
  // Pending deployment prose
  {
    pattern: /pending\s+deployment/i,
    label: "pending deployment text",
  },
  // "Pending mainnet" prose
  {
    pattern: /pending\s+mainnet/i,
    label: "pending mainnet text",
  },
  // TODO markers in MDX content (not inside fenced code blocks — we check all lines anyway
  // so devs are warned about code-fence TODOs too)
  {
    pattern: /\bTODO\b/,
    label: "TODO marker",
  },
  // FIXME markers
  {
    pattern: /\bFIXME\b/,
    label: "FIXME marker",
  },
  // "Coming soon" prose — common in integration tables
  {
    pattern: /\bcoming\s+soon\b/i,
    label: "coming soon text",
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Violation {
  file: string;        // repo-relative path
  line: number;        // 1-based
  column: number;      // 1-based, start of match
  label: string;
  matchedText: string;
}

interface NavPage {
  path: string;  // repo-relative, no extension — e.g. "guides/quickstarts/python"
  group: string;
  tab: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // 1. Load allowlist
  const allowlist = await loadAllowlist();

  // 2. Parse docs.json to know which pages are enforced
  const enforcedPaths = await resolveEnforcedPaths();

  // 3. Find all MDX files
  const mdxFiles = await findMdxFiles(repoRoot);

  // 4. Scan enforced files
  const violations: Violation[] = [];
  let scanned = 0;
  let skipped = 0;

  for (const absPath of mdxFiles) {
    const rel = path.relative(repoRoot, absPath);
    const pageKey = rel.replace(/\.mdx$/, "");

    if (allowlist.has(pageKey)) {
      skipped += 1;
      continue;
    }

    if (!enforcedPaths.has(pageKey)) {
      // Not in an enforced navigation group — skip silently
      continue;
    }

    const fileViolations = await scanFile(absPath, rel);
    violations.push(...fileViolations);
    scanned += 1;
  }

  // 5. Also scan docs.json itself for placeholder contract IDs
  const docsJsonViolations = await scanFile(
    path.join(repoRoot, "docs.json"),
    "docs.json",
  );
  if (docsJsonViolations.length > 0) {
    violations.push(...docsJsonViolations);
  }

  // 6. Report
  const summary = [
    `MDX files scanned : ${scanned}`,
    `MDX files skipped (allowlist): ${skipped}`,
    `docs.json violations: ${docsJsonViolations.length}`,
    `Total violations  : ${violations.length}`,
  ].join("\n");

  if (violations.length > 0) {
    const report = violations
      .map(
        (v) =>
          `  ${v.file}:${v.line}:${v.column}  [${v.label}]  ${v.matchedText.trim()}`,
      )
      .join("\n");

    console.error(
      `\nPlaceholder check FAILED\n\n${report}\n\n${summary}\n\n` +
        `Fix the violations above, or add the page to scripts/placeholder-allowlist.json\n` +
        `if the placeholder is intentional (e.g. a research or roadmap page).\n`,
    );
    process.exit(1);
  }

  console.log(`\nPlaceholder check passed.\n\n${summary}\n`);
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

async function loadAllowlist(): Promise<Set<string>> {
  const allowlistPath = path.join(repoRoot, "scripts", "placeholder-allowlist.json");
  try {
    const raw = await readFile(allowlistPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((item): item is string => typeof item === "string")
    ) {
      console.error(
        `placeholder-allowlist.json must be a JSON array of strings.\nGot: ${JSON.stringify(parsed, null, 2)}`,
      );
      process.exit(1);
    }
    return new Set(parsed);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No allowlist file → treat as empty
      return new Set();
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// docs.json navigation parsing
// ---------------------------------------------------------------------------

interface DocsJson {
  navigation: {
    tabs: Array<{
      tab: string;
      groups: Array<{
        group: string;
        pages: string[];
      }>;
    }>;
  };
}

async function resolveEnforcedPaths(): Promise<Set<string>> {
  const raw = await readFile(path.join(repoRoot, "docs.json"), "utf8");
  const config: DocsJson = JSON.parse(raw);

  const enforced = new Set<string>();

  for (const tabEntry of config.navigation.tabs) {
    const tabName = tabEntry.tab;
    const tabEnforced = ENFORCED_TABS.has(tabName);

    for (const groupEntry of tabEntry.groups) {
      const groupEnforced = ENFORCED_GROUPS.has(groupEntry.group);

      if (!tabEnforced && !groupEnforced) {
        continue;
      }

      for (const page of groupEntry.pages) {
        enforced.add(page);
      }
    }
  }

  return enforced;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

async function findMdxFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return ignoredDirs.has(entry.name) ? [] : findMdxFiles(fullPath);
      }
      if (entry.isFile() && entry.name.endsWith(".mdx")) {
        return [fullPath];
      }
      return [];
    }),
  );
  return results.flat().sort();
}

// ---------------------------------------------------------------------------
// Per-file scanning
// ---------------------------------------------------------------------------

async function scanFile(absPath: string, relPath: string): Promise<Violation[]> {
  let content: string;
  try {
    content = await readFile(absPath, "utf8");
  } catch {
    return [];
  }

  const lines = content.split("\n");
  const violations: Violation[] = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineText = lines[lineIdx];

    for (const { pattern, label } of PLACEHOLDER_PATTERNS) {
      // Reset lastIndex for global patterns between lines
      pattern.lastIndex = 0;

      const match = pattern.exec(lineText);
      if (match === null) continue;

      violations.push({
        file: relPath,
        line: lineIdx + 1,
        column: match.index + 1,
        label,
        matchedText: lineText,
      });

      // Report at most one violation per pattern per line to avoid noise
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
