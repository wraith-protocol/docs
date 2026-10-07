/**
 * check-snippets-extended.ts
 *
 * Checks Rust, Python, shell, JSON, TOML, and YAML code fences in all MDX
 * files. TypeScript/JavaScript is handled by the existing check-snippets.ts.
 *
 * Language dispatch:
 *   rust        → rustc --edition 2021 --crate-type lib  (syntax + type check)
 *   python / py → python3 -m py_compile                  (syntax only)
 *   bash / sh   → bash -n                                 (syntax only)
 *   json        → JSON.parse                              (structure check)
 *   toml        → built-in structural linter              (structure check)
 *   yaml / yml  → js-yaml or yaml package if present      (structure check)
 *
 * Escape hatch: add `no-check` anywhere in the fence info string, e.g.
 *   ```rust no-check
 *   ```python no-check
 *   ```bash no-check
 *
 * Every failure is reported as:
 *   [rust] guides/quickstarts/rust.mdx:67
 *   ----------------------------------------
 *   <compiler message>
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Lang = "rust" | "python" | "shell" | "json" | "toml" | "yaml";

type Snippet = {
  attrs: string;
  code: string;
  file: string;  // repo-relative path
  index: number;
  lang: Lang;
  line: number;  // 1-based line of the opening fence
};

type CheckResult = {
  snippet: Snippet;
  passed: boolean;
  message: string;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const repoRoot = process.cwd();

const ignoredDirs = new Set([
  ".git", ".github", "node_modules", ".next", "dist", "build",
]);

/** Map from raw fence language tag (lower-case) to canonical Lang value. */
const langMap: Record<string, Lang> = {
  rust:   "rust",
  python: "python",
  py:     "python",
  bash:   "shell",
  sh:     "shell",
  shell:  "shell",
  json:   "json",
  toml:   "toml",
  yaml:   "yaml",
  yml:    "yaml",
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const files = await findMdxFiles(repoRoot);
  const allSnippets = await collectSnippets(files);

  const skipped   = allSnippets.filter((s) =>  /\bno-check\b/.test(s.attrs));
  const checkable = allSnippets.filter((s) => !/\bno-check\b/.test(s.attrs));

  const byLang = groupBy(checkable, (s) => s.lang);

  const tmp = await mkdtemp(path.join(tmpdir(), "wraith-snippets-ext-"));
  const failures: CheckResult[] = [];

  try {
    const groups = Object.entries(byLang) as Array<[Lang, Snippet[]]>;
    for (const [lang, snippets] of groups) {
      const results = await checkLanguage(lang, snippets, tmp);
      failures.push(...results.filter((r) => !r.passed));
    }
  } finally {
    await rm(tmp, { force: true, recursive: true });
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const counts = countBy(checkable, (s) => s.lang);
  const summary = [
    `MDX files scanned  : ${files.length}`,
    `Snippets found     : ${allSnippets.length}`,
    `  rust             : ${counts["rust"]   ?? 0}`,
    `  python           : ${counts["python"] ?? 0}`,
    `  shell            : ${counts["shell"]  ?? 0}`,
    `  json             : ${counts["json"]   ?? 0}`,
    `  toml             : ${counts["toml"]   ?? 0}`,
    `  yaml             : ${counts["yaml"]   ?? 0}`,
    `Skipped (no-check) : ${skipped.length}`,
    `Checked            : ${checkable.length}`,
    `Failures           : ${failures.length}`,
  ].join("\n");

  if (failures.length > 0) {
    const report = failures.map(formatFailure).join("\n\n");
    console.error(
      `${summary}\n\n${"=".repeat(60)}\nFAILURES\n${"=".repeat(60)}\n\n${report}`,
    );
    process.exit(1);
  }

  console.log(`${summary}\n\nAll extended snippet checks passed.`);
}

// ---------------------------------------------------------------------------
// Per-language dispatch
// ---------------------------------------------------------------------------

function checkLanguage(lang: Lang, snippets: Snippet[], tmp: string): Promise<CheckResult[]> {
  switch (lang) {
    case "rust":   return checkRust(snippets, tmp);
    case "python": return checkPython(snippets, tmp);
    case "shell":  return checkShell(snippets, tmp);
    case "json":   return checkJson(snippets);
    case "toml":   return checkToml(snippets);
    case "yaml":   return checkYaml(snippets);
  }
}

// ---------------------------------------------------------------------------
// Rust — rustc --edition 2021 --crate-type lib
// ---------------------------------------------------------------------------

async function checkRust(snippets: Snippet[], tmp: string): Promise<CheckResult[]> {
  if (!(await commandExists("rustc"))) {
    console.error(
      "  [rust] rustc not found.\n" +
      "         Install Rust (https://rustup.rs) or use dtolnay/rust-toolchain in CI.",
    );
    process.exit(1);
  }

  const results: CheckResult[] = [];

  for (const snippet of snippets) {
    const basename = `rust_snippet_${snippet.index}.rs`;
    const file     = path.join(tmp, basename);
    await writeFile(file, wrapRust(snippet.code), "utf8");

    const r = await run("rustc", [
      "--edition",      "2021",
      "--crate-type",   "lib",
      "--error-format", "short",
      "--cap-lints",    "warn",
      "-o",             path.join(tmp, `rust_snippet_${snippet.index}.rlib`),
      file,
    ]);

    if (r.exitCode !== 0) {
      results.push({
        snippet,
        passed:  false,
        message: stripTmpPaths(r.output.trim(), tmp, basename),
      });
    } else {
      results.push({ snippet, passed: true, message: "" });
    }
  }

  return results;
}

/**
 * Wraps a Rust snippet so top-level items compile without a main function.
 * Strips ellipsis-only lines that represent illustrative gaps.
 */
function wrapRust(code: string): string {
  const cleaned = code
    .split("\n")
    .filter((l) => !/^\s*\/\/\s*\.\.\.\s*$/.test(l))
    .filter((l) => !/^\s*\.\.\.\s*$/.test(l))
    .join("\n");
  return `#![allow(unused, dead_code, non_snake_case, non_camel_case_types)]\n${cleaned}\n`;
}

// ---------------------------------------------------------------------------
// Python — python3 -m py_compile (syntax check per file)
// ---------------------------------------------------------------------------

async function checkPython(snippets: Snippet[], tmp: string): Promise<CheckResult[]> {
  const bin = (await commandExists("python3")) ? "python3"
            : (await commandExists("python"))  ? "python"
            : null;

  if (!bin) {
    console.error(
      "  [python] python3/python not found.\n" +
      "           Install Python 3 or use actions/setup-python in CI.",
    );
    process.exit(1);
  }

  const results: CheckResult[] = [];

  for (const snippet of snippets) {
    const basename = `py_snippet_${snippet.index}.py`;
    const file     = path.join(tmp, basename);
    await writeFile(file, normalizeCode(snippet.code), "utf8");

    const r = await run(bin, ["-m", "py_compile", file]);

    if (r.exitCode !== 0) {
      results.push({
        snippet,
        passed:  false,
        message: stripTmpPaths(r.output.trim(), tmp, basename),
      });
    } else {
      results.push({ snippet, passed: true, message: "" });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Shell — bash -n (syntax check only, no execution)
// ---------------------------------------------------------------------------

async function checkShell(snippets: Snippet[], tmp: string): Promise<CheckResult[]> {
  if (!(await commandExists("bash"))) {
    console.error(
      "  [shell] bash not found.\n" +
      "          Install bash or run on a Linux/macOS environment.",
    );
    process.exit(1);
  }

  const results: CheckResult[] = [];

  for (const snippet of snippets) {
    const basename = `sh_snippet_${snippet.index}.sh`;
    const file     = path.join(tmp, basename);
    await writeFile(file, stripShellPrompts(snippet.code), "utf8");

    const r = await run("bash", ["-n", file]);

    if (r.exitCode !== 0) {
      results.push({
        snippet,
        passed:  false,
        message: stripTmpPaths(r.output.trim(), tmp, basename),
      });
    } else {
      results.push({ snippet, passed: true, message: "" });
    }
  }

  return results;
}

/**
 * Lines that start with a shell prompt (`$`, `#`, `%`) are output lines in
 * the docs, not commands. Convert them to comments so bash -n doesn't choke.
 */
function stripShellPrompts(code: string): string {
  return code
    .split("\n")
    .map((line) => (/^\s*[$%]\s/.test(line) ? `# ${line}` : line))
    .join("\n");
}

// ---------------------------------------------------------------------------
// JSON — JSON.parse (in-process, no temp files)
// ---------------------------------------------------------------------------

function checkJson(snippets: Snippet[]): Promise<CheckResult[]> {
  return Promise.resolve(
    snippets.map((snippet) => {
      try {
        JSON.parse(snippet.code);
        return { snippet, passed: true, message: "" };
      } catch (err) {
        return {
          snippet,
          passed:  false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// TOML — built-in structural linter (no npm dependency)
// ---------------------------------------------------------------------------

function checkToml(snippets: Snippet[]): Promise<CheckResult[]> {
  return Promise.resolve(
    snippets.map((snippet) => {
      const err = lintToml(snippet.code);
      return err
        ? { snippet, passed: false, message: err }
        : { snippet, passed: true,  message: "" };
    }),
  );
}

/**
 * Minimal TOML structural linter.
 *
 * Accepts:
 *   - Blank lines and comment-only lines
 *   - Table headers: [section], [a.b.c]
 *   - Array-of-tables headers: [[array]]
 *   - Key = value assignments (bare, dotted, and quoted keys)
 *   - Multi-line value continuations (lines starting with value characters)
 *
 * Only rejects lines that are clearly malformed (not a comment, not a
 * header, not a key-value pair, not a value continuation).
 */
function lintToml(src: string): string | null {
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i];
    const line = raw.replace(/#.*$/, "").trim(); // strip inline comments
    if (line === "") continue;

    // [[array-of-tables]]
    if (/^\[\[.+\]\]$/.test(line)) continue;
    // [table]
    if (/^\[.+\]$/.test(line)) continue;
    // key = value  (bare, dotted, or quoted key)
    if (/^["']?[\w.-]+["']?\s*=/.test(line)) continue;
    // value continuation lines (arrays, inline tables, multi-line strings)
    if (/^[\[{"\d\-+tfn]/.test(line)) continue;
    if (/^[,\]}\)]/.test(line)) continue;

    return `line ${i + 1}: unexpected content: ${raw.trim()}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// YAML — js-yaml or yaml package (optional, graceful skip)
// ---------------------------------------------------------------------------

async function checkYaml(snippets: Snippet[]): Promise<CheckResult[]> {
  // Try to resolve a YAML parser from the project's node_modules.
  let parse: ((src: string) => unknown) | null = null;

  for (const [pkg, exported] of [
    ["js-yaml",                    "load"],
    ["yaml",                       "parse"],
  ] as const) {
    try {
      const modPath = path.join(repoRoot, "node_modules", pkg);
      const mod = await import(modPath) as Record<string, unknown>;
      const fn  = mod[exported] ?? mod["default"];
      if (typeof fn === "function") {
        parse = fn as (src: string) => unknown;
        break;
      }
    } catch {
      // not installed — try next
    }
  }

  if (!parse) {
    console.error(
      "  [yaml] Neither js-yaml nor yaml package found.\n" +
      "         Add js-yaml as a dev dependency (pnpm add -D js-yaml @types/js-yaml).",
    );
    process.exit(1);
  }

  return snippets.map((snippet) => {
    try {
      parse!(snippet.code);
      return { snippet, passed: true, message: "" };
    } catch (err) {
      return {
        snippet,
        passed:  false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

// ---------------------------------------------------------------------------
// MDX file discovery
// ---------------------------------------------------------------------------

async function findMdxFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested  = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return ignoredDirs.has(entry.name) ? [] : findMdxFiles(full);
      }
      return entry.isFile() && entry.name.endsWith(".mdx") ? [full] : [];
    }),
  );
  return nested.flat().sort();
}

async function collectSnippets(files: string[]): Promise<Snippet[]> {
  const snippets: Snippet[] = [];
  let index = 0;

  for (const file of files) {
    const markdown     = await readFile(file, "utf8");
    const fencePattern = /^```([A-Za-z0-9_-]+)([^\n]*)\n([\s\S]*?)^```/gm;
    let match: RegExpExecArray | null;

    while ((match = fencePattern.exec(markdown)) !== null) {
      const rawLang = match[1].toLowerCase();
      const lang    = langMap[rawLang];
      if (!lang) continue;

      snippets.push({
        attrs: match[2] ?? "",
        code:  match[3],
        file:  path.relative(repoRoot, file),
        index,
        lang,
        line:  lineNumberAt(markdown, match.index),
      });
      index += 1;
    }
  }

  return snippets;
}

// ---------------------------------------------------------------------------
// Failure formatting
// ---------------------------------------------------------------------------

function formatFailure(r: CheckResult): string {
  const loc     = `${r.snippet.file}:${r.snippet.line}`;
  const header  = `[${r.snippet.lang}] ${loc}`;
  const divider = "-".repeat(Math.max(header.length, 40));
  return `${header}\n${divider}\n${r.message}`;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function normalizeCode(code: string): string {
  return code
    .replace(/^\s*\/\/\s*\.\.\.\s*$/gm, "")
    .replace(/^\s*#\s*\.\.\.\s*$/gm,    "")
    .replace(/^\s*\.\.\.\s*$/gm,         "");
}

/** Replace absolute tmp paths with just the basename in compiler output. */
function stripTmpPaths(output: string, tmp: string, basename: string): string {
  return output.split(path.join(tmp, basename)).join(basename);
}

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

function countBy<T>(arr: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of arr) {
    const k  = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

async function commandExists(cmd: string): Promise<boolean> {
  const r = await run("which", [cmd]);
  return r.exitCode === 0;
}

function run(command: string, args: string[]): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd:   repoRoot,
      env:   process.env,
      shell: false,
    });
    let output = "";
    child.stdout.on("data", (c: Buffer) => { output += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { output += c.toString(); });
    child.on("close", (code) => { resolve({ exitCode: code ?? 1, output }); });
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
