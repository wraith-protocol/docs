/**
 * check-rust-quickstart.ts
 *
 * Deterministic extraction check between the Rust quickstart guide and the
 * crate that compiles it.
 *
 *   guides/quickstarts/rust.mdx   — what readers copy (source of truth)
 *   snippets/rust-quickstart/     — the crate CI builds with cargo
 *
 * Every ```rust fence in the guide whose first line is a `// src/<file>`
 * marker belongs to the crate and must be classified:
 *
 *   ```rust crate       → extracted and byte-compared against src/<file>.rs
 *   ```rust no-check    → exempt, but only with an entry in EXEMPT below
 *   (no marker, no attr)→ compiled standalone by check-snippets-extended.ts
 *
 * The first fence for a file keeps its `// src/<file>` marker line. Later
 * fences start with `// src/<file> (continued)`; that line is dropped when the
 * fences are concatenated, so the crate file reads as one normal source file.
 *
 * A crate source may contain regions that are not shown in the guide (unit
 * tests, fixtures). They are delimited by:
 *
 *   // crate-only-begin: <reason>
 *   ...
 *   // crate-only-end
 *
 * and are stripped before comparison. Blank lines touching the markers belong
 * to the region.
 *
 * Cargo.toml is compared structurally: feature names, default features, and
 * dependency names (including which are optional) must match. Version strings
 * may differ so the guide can pin looser ranges than the crate lockfile.
 *
 * Usage:
 *   tsx scripts/check-rust-quickstart.ts                     # check
 *   tsx scripts/check-rust-quickstart.ts --emit stealth.rs   # print the
 *         crate-only-free source for a file, ready to paste into the guide
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const GUIDE = "guides/quickstarts/rust.mdx";
const CRATE = "snippets/rust-quickstart";
const CARGO_TOML = path.join(CRATE, "Cargo.toml");
const SRC_DIR = path.join(CRATE, "src");

/**
 * Guide fences that intentionally diverge from the crate. Keyed by the file
 * named in the fence's `// src/<file>` marker, with the reason it is exempt.
 */
const EXEMPT: Record<string, string> = {
  "scan.rs":
    "the guide shows a self-contained example with its own main; the crate " +
    "keeps a feature-gated variant behind `--features network`",
  "send.rs":
    "illustrative soroban-client builder call — that API is not stable " +
    "enough to compile against yet",
};

const FENCE_PATTERN = /^```([A-Za-z0-9_-]+)([^\n]*)\n([\s\S]*?)^```/gm;
const MARKER_PATTERN = /^\/\/ src\/([A-Za-z0-9_.-]+\.rs)( \(continued\))?$/;
const CRATE_ONLY_BEGIN = /^\/\/ crate-only-begin\b/;
const CRATE_ONLY_END = /^\/\/ crate-only-end\b/;

type Fence = {
  attrs: string;
  code: string;
  line: number;
};

type Group = {
  file: string;
  fences: Fence[];
  exempt: boolean;
};

type Report = {
  problems: string[];
  summary: string[];
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const emitTarget = readEmitTarget();

  if (emitTarget) {
    // Print the crate file with crate-only regions stripped: exactly what
    // the guide's fences must concatenate to.
    const cratePath = path.join(SRC_DIR, emitTarget);
    const source = await readFile(cratePath, "utf8").catch(() => null);
    if (!source) {
      fail([`crate file src/${emitTarget} not found`]);
    }
    const problems: string[] = [];
    process.stdout.write(stripCrateOnly(source, problems, cratePath));
    return;
  }

  const report = await check();

  if (report.problems.length > 0) {
    console.error(
      `${report.summary.join("\n")}\n\n` +
        `${"=".repeat(60)}\nFAILURES\n${"=".repeat(60)}\n\n` +
        report.problems.join("\n\n"),
    );
    process.exit(1);
  }

  console.log(report.summary.join("\n"));
}

async function check(): Promise<Report> {
  const problems: string[] = [];
  const guide = await readFile(GUIDE, "utf8");
  const fences = collectFences(guide);
  const { groups, standalone, errors } = classify(fences);
  problems.push(...errors);

  // Every exemption must still be used, and every crate source must be
  // covered — extracted, exempt, or absent from the guide altogether.
  const covered = new Set<string>();
  for (const group of groups.values()) {
    covered.add(group.file);
    if (group.exempt && !EXEMPT[group.file]) {
      problems.push(
        `${GUIDE}:${group.fences[0].line} — src/${group.file} is \`no-check\` ` +
          `but has no exemption reason. Add it to EXEMPT in ` +
          `scripts/check-rust-quickstart.ts or mark the fence \`crate\`.`,
      );
    }
  }
  for (const file of Object.keys(EXEMPT)) {
    const used = [...groups.values()].some((g) => g.file === file && g.exempt);
    if (!used) {
      problems.push(
        `stale exemption: src/${file} has no \`no-check\` fence in ${GUIDE}`,
      );
    }
  }

  const crateFiles = (await readdir(SRC_DIR))
    .filter((name) => name.endsWith(".rs"))
    .sort();
  for (const file of crateFiles) {
    if (!covered.has(file)) {
      problems.push(
        `src/${file} is neither extracted from ${GUIDE} nor listed in ` +
          `EXEMPT — the crate can drift without CI noticing.`,
      );
    }
  }

  // Byte comparison: guide fences vs crate sources.
  for (const group of groups.values()) {
    if (group.exempt) continue;
    const cratePath = path.join(SRC_DIR, group.file);
    let crateSource: string;
    try {
      crateSource = await readFile(cratePath, "utf8");
    } catch {
      problems.push(
        `${GUIDE}:${group.fences[0].line} — fence targets src/${group.file}, ` +
          `which does not exist. Create it or fix the \`// src/\` marker.`,
      );
      continue;
    }

    const expected = expectedSource(group);
    const actual = stripCrateOnly(crateSource, problems, cratePath);
    if (expected !== actual) {
      problems.push(
        `src/${group.file} has drifted from ${GUIDE}:\n` +
          describeDiff(expected, actual, group.fences[0].line, cratePath),
      );
    }
  }

  problems.push(...(await checkCargoToml(guide)));

  const extracted = [...groups.values()].filter((g) => !g.exempt);
  const exempted = [...groups.values()].filter((g) => g.exempt);
  const summary = [
    "Rust quickstart extraction check",
    `  guide fences      : ${fences.length}`,
    `  extracted (crate) : ${extracted.length} (${extracted.map((g) => g.file).join(", ") || "-"})`,
    `  exempt (no-check) : ${exempted.length} (${exempted.map((g) => g.file).join(", ") || "-"})`,
    `  standalone rustc  : ${standalone.length}`,
    `  crate sources     : ${crateFiles.length}`,
    `  failures          : ${problems.length}`,
  ];

  if (problems.length === 0) {
    summary.push("", `All crate sources match ${GUIDE}.`);
  }

  return { problems, summary };
}

// ---------------------------------------------------------------------------
// Fence collection and classification
// ---------------------------------------------------------------------------

function collectFences(markdown: string): Fence[] {
  const fences: Fence[] = [];
  let match: RegExpExecArray | null;

  while ((match = FENCE_PATTERN.exec(markdown)) !== null) {
    if (match[1].toLowerCase() !== "rust") continue;
    fences.push({
      attrs: match[2] ?? "",
      code: (match[3] ?? "").replace(/\r\n/g, "\n"),
      line: markdown.slice(0, match.index).split("\n").length,
    });
  }

  return fences;
}

function classify(fences: Fence[]): {
  groups: Map<string, Group>;
  standalone: Fence[];
  errors: string[];
} {
  const groups = new Map<string, Group>();
  const standalone: Fence[] = [];
  const errors: string[] = [];

  for (const fence of fences) {
    const wantsCrate = /\bcrate\b/.test(fence.attrs);
    const wantsSkip = /\bno-check\b/.test(fence.attrs);
    const marker = MARKER_PATTERN.exec(firstLine(fence));

    if (wantsCrate && wantsSkip) {
      errors.push(
        `${GUIDE}:${fence.line} — a fence cannot be both \`crate\` and \`no-check\`.`,
      );
      continue;
    }

    if (!marker) {
      if (wantsCrate) {
        errors.push(
          `${GUIDE}:${fence.line} — \`crate\` fence has no \`// src/<file>\` ` +
            `marker line, so it cannot be extracted.`,
        );
      } else if (wantsSkip) {
        errors.push(
          `${GUIDE}:${fence.line} — \`no-check\` fence has no \`// src/<file>\` ` +
            `marker line, so nothing ties it to the crate. Give it a marker ` +
            `and an EXEMPT reason, or make it checkable.`,
        );
      } else {
        standalone.push(fence);
      }
      continue;
    }

    const file = marker[1];
    const continued = marker[2] !== undefined;

    if (!wantsCrate && !wantsSkip) {
      errors.push(
        `${GUIDE}:${fence.line} — src/${file} has a \`// src/\` marker but is ` +
          `neither \`crate\` (extracted) nor \`no-check\` (exempt).`,
      );
    }

    const group = groups.get(file);

    if (!group) {
      if (continued) {
        errors.push(
          `${GUIDE}:${fence.line} — src/${file} starts with a ` +
            `\`(continued)\` marker but has no opening fence.`,
        );
        continue;
      }
      groups.set(file, { file, fences: [fence], exempt: wantsSkip });
    } else {
      if (!continued) {
        errors.push(
          `${GUIDE}:${fence.line} — src/${file} has a second opening fence; ` +
            `use \`// src/${file} (continued)\`.`,
        );
      }
      if (group.exempt !== wantsSkip) {
        errors.push(
          `${GUIDE}:${fence.line} — all fences for src/${file} must share ` +
            `the same attributes (\`crate\` or \`no-check\`).`,
        );
      }
      group.fences.push(fence);
    }
  }

  return { groups, standalone, errors };
}

function firstLine(fence: Fence): string {
  return fence.code.split("\n")[0] ?? "";
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Concatenate a file's fences into the source the crate must contain.
 * The opening fence keeps its `// src/<file>` marker line (a normal file
 * header comment); `(continued)` marker lines are dropped. Fences are joined
 * with a blank line, so a crate file always has exactly one blank line at a
 * fence boundary.
 */
function expectedSource(group: Group): string {
  const chunks = group.fences.map((fence, index) => {
    const fenceLines = logicalLines(fence.code);
    if (index > 0) fenceLines.shift(); // drop the `(continued)` marker
    return fenceLines.join("\n");
  });

  return `${chunks.join("\n\n")}\n`;
}

/** Split into lines, dropping the trailing newline artifact. */
function logicalLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Remove `// crate-only-begin` … `// crate-only-end` regions from a crate
 * source, together with any blank lines touching the markers.
 */
function stripCrateOnly(
  source: string,
  problems: string[],
  location: string,
): string {
  const lines = logicalLines(source);
  const kept: string[] = [];
  let inRegion = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (CRATE_ONLY_BEGIN.test(line)) {
      if (inRegion) {
        problems.push(`${location}:${i + 1} — nested crate-only region.`);
        return lines.join("\n");
      }
      inRegion = true;

      // Blank lines touching the markers belong to the region.
      while (kept.length > 0 && kept[kept.length - 1].trim() === "") {
        kept.pop();
      }
      continue;
    }

    if (CRATE_ONLY_END.test(line)) {
      if (!inRegion) {
        problems.push(
          `${location}:${i + 1} — crate-only-end without a matching begin.`,
        );
        return lines.join("\n");
      }
      inRegion = false;

      while (i + 1 < lines.length && lines[i + 1].trim() === "") {
        i += 1;
      }
      continue;
    }

    if (!inRegion) kept.push(line);
  }

  if (inRegion) {
    problems.push(`${location} — crate-only region is never closed.`);
    return lines.join("\n");
  }

  return `${kept.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Diff reporting
// ---------------------------------------------------------------------------

function describeDiff(
  expected: string,
  actual: string,
  guideLine: number,
  cratePath: string,
): string {
  const want = logicalLines(expected);
  const got = logicalLines(actual);

  let prefix = 0;
  while (prefix < want.length && prefix < got.length && want[prefix] === got[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < want.length - prefix &&
    suffix < got.length - prefix &&
    want[want.length - 1 - suffix] === got[got.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const wantMiddle = want.slice(prefix, want.length - suffix);
  const gotMiddle = got.slice(prefix, got.length - suffix);
  const window = 8;

  const format = (label: string, lines: string[], sign: string) => {
    const shown = lines.slice(0, window);
    const head =
      shown.length === 0
        ? `  ${label}: <none>`
        : shown
            .map((l, i) => `  ${sign} ${label} line ${prefix + i + 1}: ${l}`)
            .join("\n");
    const more =
      lines.length > shown.length ? `\n  … ${lines.length - window} more` : "";
    return head + more;
  };

  return [
    `  first difference at guide line ${guideLine + prefix} / ` +
      `${cratePath}:${prefix + 1}:`,
    format("guide", wantMiddle, "+"),
    format("crate", gotMiddle, "-"),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Cargo.toml structural comparison
// ---------------------------------------------------------------------------

async function checkCargoToml(guide: string): Promise<string[]> {
  const fence = firstTomlFence(guide);
  if (!fence) {
    return [`${GUIDE} has no TOML fence for Cargo.toml.`];
  }

  const doc = parseToml(fence.code);
  const crateToml = parseToml(await readFile(CARGO_TOML, "utf8"));
  const problems: string[] = [];

  const compareKeys = (label: string, a: string[], b: string[]) => {
    const missing = a.filter((k) => !b.includes(k));
    const extra = b.filter((k) => !a.includes(k));
    if (missing.length > 0) {
      problems.push(`Cargo.toml ${label} missing from the crate: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      problems.push(`Cargo.toml ${label} missing from the guide: ${extra.join(", ")}`);
    }
  };

  compareKeys("features", Object.keys(doc.features), Object.keys(crateToml.features));
  compareKeys(
    "dependencies",
    Object.keys(doc.dependencies),
    Object.keys(crateToml.dependencies),
  );

  for (const name of Object.keys(doc.features)) {
    if (!crateToml.features[name]) continue;
    const a = [...doc.features[name]].sort().join(",");
    const b = [...crateToml.features[name]].sort().join(",");
    if (a !== b) {
      problems.push(
        `Cargo.toml feature \`${name}\` differs: guide [${a}] vs crate [${b}]`,
      );
    }
  }

  for (const name of Object.keys(doc.dependencies)) {
    const inCrate = crateToml.dependencies[name];
    if (!inCrate) continue;
    if (doc.dependencies[name].optional !== inCrate.optional) {
      problems.push(
        `Cargo.toml dependency \`${name}\`: optional=${String(doc.dependencies[name].optional)} ` +
          `in the guide, optional=${String(inCrate.optional)} in the crate`,
      );
    }
  }

  return problems;
}

function firstTomlFence(guide: string): Fence | null {
  const pattern = /^```toml([^\n]*)\n([\s\S]*?)^```/gm;
  const match = pattern.exec(guide);
  return match ? { attrs: match[1] ?? "", code: match[2] ?? "", line: 0 } : null;
}

function parseToml(source: string): {
  features: Record<string, string[]>;
  dependencies: Record<string, { optional: boolean }>;
} {
  const features: Record<string, string[]> = {};
  const dependencies: Record<string, { optional: boolean }> = {};
  let section = "";

  for (const raw of source.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;

    const header = /^\[+([^\]]+)\]+/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }

    const kv = /^([^=]+?)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim().replace(/^["']|["']$/g, "");
    const value = kv[2].trim();

    if (section === "features") {
      features[key] = (value.match(/"[^"]*"/g) ?? []).map((s) => s.slice(1, -1));
    } else if (section === "dependencies") {
      dependencies[key] = { optional: /optional\s*=\s*true/.test(value) };
    }
  }

  return { features, dependencies };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function readEmitTarget(): string | null {
  const arg = process.argv[2];
  if (!arg) return null;
  if (arg !== "--emit" || !process.argv[3]) {
    fail([
      `unknown argument: ${arg}\n` +
        `usage: tsx scripts/check-rust-quickstart.ts [--emit <file.rs>]`,
    ]);
  }
  return path.basename(process.argv[3]);
}

function fail(problems: string[]): never {
  console.error(problems.join("\n\n"));
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
