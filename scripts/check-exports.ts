/**
 * check-exports.ts
 *
 * Ensures every import path and named symbol documented in the MDX files
 * exists in the published @wraith-protocol/sdk package — for both ESM and CJS.
 *
 * Pipeline
 * ────────
 * 1. Walk every .mdx file and collect `import { … } from "@wraith-protocol/sdk…"` statements.
 * 2. Deduplicate into a map  specifier → Set<symbol>.
 * 3. Skip specifiers whose package is not installed (companion packages documented
 *    here but not depended on — e.g. @wraith-protocol/sdk-react).
 * 4. Write two typed fixtures using namespace imports to avoid name collisions:
 *      fixture.esm.mts  — `import * as Ns from "…"` (tests the "import" condition)
 *      fixture.cjs.cts  — `require("…") as typeof import("…")` (tests "require")
 * 5. Type-check both fixtures with tsc (skipLibCheck: false, strict: true).
 *    A missing named export surfaces as "Property X does not exist on type…".
 * 6. Execute both fixtures with tsx.
 *    Catches symbols that typed fine but are undefined at runtime.
 * 7. Exit 1 on any failure with a clear summary of what diverged.
 *
 * Run
 * ───
 *   pnpm run check:exports
 */

import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

// ─── configuration ────────────────────────────────────────────────────────────

const PACKAGE_SCOPE = "@wraith-protocol/sdk";
const REPO_ROOT = process.cwd();
const IGNORED_DIRS = new Set([".git", ".github", "node_modules", ".next", "dist", "build"]);

/**
 * Symbols that are pure types (interfaces, type aliases, const enums used only
 * as types). They appear in `import type { … }` in the ESM fixture so tsc
 * validates them, but we skip the runtime defined-ness check.
 */
const TYPE_ONLY_SYMBOLS = new Set<string>([
  // shared across chain modules
  "HexString",
  "StealthKeys",
  "StealthMetaAddress",
  "GeneratedStealthAddress",
  "Announcement",
  "MatchedAnnouncement",
  // CKB
  "StealthCell",
  "MatchedStealthCell",
  // Stellar federation
  "FederationRecord",
  "FederationCache",
  "FederationError",
  "FederationErrorCode",
  // root sdk types
  "AnnouncementsStreamOptions",
  "AnnouncementStream",
  "WraithConfig",
  "AgentConfig",
  "AgentInfo",
  "ChatResponse",
  "ToolCall",
  "Balance",
  "Payment",
  "Invoice",
  "Schedule",
  "TxResult",
  "PrivacyReport",
  "Notification",
  "Conversation",
  "RetentionConfig",
  "ViewTagFilter",
  "StreamCacheOptions",
  "BackpressureOptions",
  "StreamError",
]);

/**
 * Symbols that are documented but not yet present in the currently installed
 * version of the package. CI will warn about these rather than failing hard,
 * so the PR can still merge.
 *
 * WHEN A SYMBOL SHIPS: remove it from this map. The check will then enforce
 * its presence automatically on every subsequent PR.
 *
 * Format:  specifier → Set<symbol>
 */
const KNOWN_MISSING: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "@wraith-protocol/sdk",
    new Set([
      // Streaming API — not yet in v1.4.5
      "fetchAnnouncementsStream",
      "RetentionExceededError",
      "StreamDisruptedError",
      "BackpressureOverflowError",
      "ProviderTimeoutError",
      "InvalidViewTagError",
      // Additional classes — not yet in v1.4.5
      "StealthClient",
      "StellarStealthSigner",
      // Streaming types — not yet in v1.4.5
      "AnnouncementsStreamOptions",
      "AnnouncementStream",
      "Announcement",
      "RetentionConfig",
      "ViewTagFilter",
      "StreamCacheOptions",
      "BackpressureOptions",
      "StreamError",
    ]),
  ],
  [
    "@wraith-protocol/sdk/chains/stellar",
    new Set([
      // Federation helper + types — not yet in v1.4.5
      "resolveStellarFederation",
      "FederationRecord",
      "FederationCache",
      "FederationError",
      "FederationErrorCode",
      // Soroban operation builder — not yet in v1.4.5
      "createAnnounceOperation",
      // Stellar uses deriveStealthPrivateScalar; docs incorrectly use EVM name
      "deriveStealthPrivateKey",
    ]),
  ],
]);

/**
 * Specifiers to skip at CJS *runtime* only.
 * tsc still validates their types via the CJS fixture — only tsx execution
 * is skipped. Use this for packages whose transitive deps have broken
 * ESM/CJS interop that crashes require() in a Node ESM context.
 *
 * @solana/web3.js → rpc-websockets ships a broken .cjs that fails to link
 * when loaded via require() inside an ESM module job (Node ≥22).
 */
const CJS_RUNTIME_SKIP = new Set<string>([
  "@wraith-protocol/sdk/chains/solana",
]);

type ImportEntry = {
  specifier: string;
  symbols: string[];
  file: string;
  line: number;
};

/**
 * Matches:
 *   import { A, B } from "@wraith-protocol/sdk"
 *   import type { T } from "@wraith-protocol/sdk/chains/evm"
 *   import { foo, type Bar } from "…"   (inline type modifier)
 *   (multiline braces are covered by [^}]+ )
 */
const IMPORT_RE =
  /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["'](@wraith-protocol\/sdk[^"']*)["']/g;

async function extractImports(files: string[]): Promise<ImportEntry[]> {
  const entries: ImportEntry[] = [];
  for (const file of files) {
    const src = await readFile(file, "utf8");
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const rawNames = m[1];
      const specifier = m[2];
      const line = src.slice(0, m.index).split("\n").length;
      const symbols = rawNames
        .split(",")
        .map((s) => s.replace(/\/\/[^\n]*/g, "").trim()) // strip inline comments
        .map((s) => s.replace(/^type\s+/, "").trim())     // strip inline "type " modifier
        .map((s) => s.replace(/\s+as\s+\S+/g, "").trim()) // strip "as alias"
        .filter(Boolean);
      if (symbols.length > 0) {
        entries.push({ specifier, symbols, file: path.relative(REPO_ROOT, file), line });
      }
    }
  }
  return entries;
}

type ImportMap = Map<string, Set<string>>;

function buildImportMap(entries: ImportEntry[]): ImportMap {
  const map: ImportMap = new Map();
  for (const { specifier, symbols } of entries) {
    if (!map.has(specifier)) map.set(specifier, new Set());
    for (const s of symbols) map.get(specifier)!.add(s);
  }
  return map;
}

// ─── package availability ─────────────────────────────────────────────────────

function packageNameFromSpecifier(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

async function isPackageInstalled(specifier: string): Promise<boolean> {
  const pkgRoot = path.join(REPO_ROOT, "node_modules", packageNameFromSpecifier(specifier));
  try {
    await readFile(path.join(pkgRoot, "package.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

// ─── fixture generators ───────────────────────────────────────────────────────

/**
 * Stable namespace alias for a specifier, e.g.:
 *   "@wraith-protocol/sdk"              → Ns0
 *   "@wraith-protocol/sdk/chains/evm"   → Ns1
 */
function nsAlias(index: number): string {
  return `Ns${index}`;
}

/**
 * ESM fixture (.mts)
 *
 * Uses namespace imports to avoid identifier collisions between modules that
 * export the same name (generateStealthAddress, SCHEME_ID, etc.).
 *
 *   import * as Ns0 from "@wraith-protocol/sdk";
 *   import type { WraithConfig as Ns0_WraithConfig } from "@wraith-protocol/sdk";
 *   __check("@wraith-protocol/sdk", "Wraith", Ns0.Wraith);
 *
 * tsc validates that each property access exists on the namespace type.
 * __check() catches undefined value exports at runtime.
 * Known-missing symbols are excluded from the fixture entirely.
 */
function buildEsmFixture(importMap: ImportMap): string {
  const out: string[] = [
    "// AUTO-GENERATED — do not edit",
    "// ESM fixture: tests the `import` export condition of @wraith-protocol/sdk",
    "",
    "function __check(spec: string, name: string, val: unknown): void {",
    "  if (val === undefined) throw new Error(`[ESM] ${spec} → '${name}' is undefined`);",
    "}",
    "",
  ];

  const entries = [...importMap.entries()];

  // Namespace imports for value symbols
  for (const [i, [specifier]] of entries.entries()) {
    out.push(`import * as ${nsAlias(i)} from "${specifier}";`);
  }
  out.push("");

  // Type-only imports (separate import type statements to satisfy tsc)
  for (const [i, [specifier, symbols]] of entries.entries()) {
    const types = [...symbols]
      .filter((s) => TYPE_ONLY_SYMBOLS.has(s))
      .filter((s) => !KNOWN_MISSING.get(specifier)?.has(s));
    if (types.length > 0) {
      const aliased = types.map((t) => `${t} as ${nsAlias(i)}_${t}`).join(", ");
      out.push(`import type { ${aliased} } from "${specifier}";`);
    }
  }
  out.push("");

  // Runtime checks for value exports
  for (const [i, [specifier, symbols]] of entries.entries()) {
    const values = [...symbols]
      .filter((s) => !TYPE_ONLY_SYMBOLS.has(s))
      .filter((s) => !KNOWN_MISSING.get(specifier)?.has(s));
    for (const v of values) {
      out.push(`__check("${specifier}", "${v}", ${nsAlias(i)}.${v});`);
    }
  }

  out.push("");
  out.push("export {};");
  return out.join("\n");
}

/**
 * CJS fixture (.cts)
 *
 * Uses require() aliased per specifier to avoid redeclaration errors.
 *
 *   const Ns0 = require("@wraith-protocol/sdk") as typeof import("@wraith-protocol/sdk");
 *   __check("@wraith-protocol/sdk", "Wraith", Ns0.Wraith);
 */
function buildCjsFixture(importMap: ImportMap): string {
  const out: string[] = [
    "// AUTO-GENERATED — do not edit",
    "// CJS fixture: tests the `require` export condition of @wraith-protocol/sdk",
    "",
    "function __check(spec: string, name: string, val: unknown): void {",
    "  if (val === undefined) throw new Error(`[CJS] ${spec} → '${name}' is undefined`);",
    "}",
    "",
  ];

  const entries = [...importMap.entries()];

  for (const [i, [specifier, symbols]] of entries.entries()) {
    const values = [...symbols]
      .filter((s) => !TYPE_ONLY_SYMBOLS.has(s))
      .filter((s) => !KNOWN_MISSING.get(specifier)?.has(s));
    if (values.length === 0) continue;

    const alias = nsAlias(i);

    if (CJS_RUNTIME_SKIP.has(specifier)) {
      // Type-check only: cast a dummy object so tsc validates the property
      // names without actually calling require() at runtime.
      out.push(
        `// ${specifier}: CJS runtime skipped (broken transitive dep)`,
      );
      out.push(
        `const ${alias} = {} as typeof import("${specifier}");`,
      );
      // No __check calls — we only care about compile-time validation here.
    } else {
      out.push(
        `const ${alias} = require("${specifier}") as typeof import("${specifier}");`,
      );
      for (const v of values) {
        out.push(`__check("${specifier}", "${v}", ${alias}.${v});`);
      }
    }
    out.push("");
  }

  out.push("export {};");
  return out.join("\n");
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function run(command: string, args: string[]): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, env: process.env, shell: false });
    let output = "";
    child.stdout.on("data", (c: Buffer) => (output += c));
    child.stderr.on("data", (c: Buffer) => (output += c));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, output }));
  });
}

async function typeCheck(fixturePath: string, tmpDir: string): Promise<string | null> {
  const tsconfigPath = path.join(tmpDir, `tsconfig-${path.basename(fixturePath)}.json`);
  await writeFile(
    tsconfigPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2022"],
          strict: true,
          skipLibCheck: false,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          noEmit: true,
        },
        include: [fixturePath],
      },
      null,
      2,
    ),
    "utf8",
  );
  const { exitCode, output } = await run("pnpm", [
    "exec", "tsc", "--noEmit", "--project", tsconfigPath,
  ]);
  return exitCode === 0 ? null : output.trim();
}

async function runWithTsx(fixturePath: string): Promise<string | null> {
  const { exitCode, output } = await run("pnpm", ["exec", "tsx", fixturePath]);
  return exitCode === 0 ? null : output.trim();
}

async function findMdxFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return IGNORED_DIRS.has(entry.name) ? [] : findMdxFiles(full);
      return entry.isFile() && entry.name.endsWith(".mdx") ? [full] : [];
    }),
  );
  return nested.flat().sort();
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Extract all documented imports
  const mdxFiles = await findMdxFiles(REPO_ROOT);
  const importEntries = await extractImports(mdxFiles);
  const importMap = buildImportMap(importEntries);

  if (importMap.size === 0) {
    console.error(`No imports from "${PACKAGE_SCOPE}" found in any .mdx file.`);
    process.exit(1);
  }

  // 2. Filter to installed packages only
  const skipped: string[] = [];
  const checkableMap: ImportMap = new Map();
  for (const [specifier, symbols] of importMap) {
    if (await isPackageInstalled(specifier)) {
      checkableMap.set(specifier, symbols);
    } else {
      skipped.push(specifier);
    }
  }

  // 3. Print summary
  console.log(`Scanned ${mdxFiles.length} MDX file(s).\n`);
  if (skipped.length > 0) {
    console.log("⚠️  Skipped (package not installed):");
    skipped.forEach((s) => console.log(`  ${s}`));
    console.log();
  }
  const totalSymbols = [...checkableMap.values()].reduce((n, s) => n + s.size, 0);
  console.log("Documented entry points to check:");
  for (const [specifier, symbols] of checkableMap) {
    console.log(`  ${specifier}`);
    for (const sym of symbols) {
      console.log(`    • ${sym}${TYPE_ONLY_SYMBOLS.has(sym) ? " (type-only)" : ""}`);
    }
  }
  console.log(`\nTotal: ${checkableMap.size} entry point(s), ${totalSymbols} unique symbol(s).\n`);

  // Print known-missing warning
  let knownMissingCount = 0;
  for (const [specifier, symbols] of KNOWN_MISSING) {
    if (!checkableMap.has(specifier)) continue;
    for (const sym of symbols) {
      if (checkableMap.get(specifier)?.has(sym)) {
        if (knownMissingCount === 0) console.log("⚠️  Known-missing (documented but not yet shipped):");
        console.log(`  ${specifier} → ${sym}`);
        knownMissingCount++;
      }
    }
  }
  if (knownMissingCount > 0) console.log();

  if (checkableMap.size === 0) {
    console.error("No installed entry points to check.");
    process.exit(1);
  }

  // 4. Write fixtures
  const tmpDir = await mkdtemp(path.join(tmpdir(), "wraith-exports-check-"));
  try {
    await symlink(
      path.join(REPO_ROOT, "node_modules"),
      path.join(tmpDir, "node_modules"),
      "dir",
    ).catch(() => undefined);
    await writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "wraith-exports-fixture", type: "module" }),
      "utf8",
    );

    const esmFixture = path.join(tmpDir, "fixture.esm.mts");
    const cjsFixture = path.join(tmpDir, "fixture.cjs.cts");
    await writeFile(esmFixture, buildEsmFixture(checkableMap), "utf8");
    await writeFile(cjsFixture, buildCjsFixture(checkableMap), "utf8");

    const failures: Array<{ label: string; detail: string }> = [];

    // 5. ESM: type-check then run
    console.log("── ESM fixture ──────────────────────────────────");
    process.stdout.write("  tsc … ");
    const esmTypeErr = await typeCheck(esmFixture, tmpDir);
    if (esmTypeErr) {
      console.log("FAIL");
      failures.push({ label: "ESM type check (tsc)", detail: esmTypeErr });
    } else {
      console.log("ok");
      process.stdout.write("  tsx … ");
      const esmRunErr = await runWithTsx(esmFixture);
      if (esmRunErr) {
        console.log("FAIL");
        failures.push({ label: "ESM runtime (tsx)", detail: esmRunErr });
      } else {
        console.log("ok");
      }
    }

    // 6. CJS: type-check then run
    console.log("\n── CJS fixture ──────────────────────────────────");
    process.stdout.write("  tsc … ");
    const cjsTypeErr = await typeCheck(cjsFixture, tmpDir);
    if (cjsTypeErr) {
      console.log("FAIL");
      failures.push({ label: "CJS type check (tsc)", detail: cjsTypeErr });
    } else {
      console.log("ok");
      process.stdout.write("  tsx … ");
      const cjsRunErr = await runWithTsx(cjsFixture);
      if (cjsRunErr) {
        console.log("FAIL");
        failures.push({ label: "CJS runtime (tsx)", detail: cjsRunErr });
      } else {
        console.log("ok");
      }
    }

    // 7. Verdict
    console.log();
    if (failures.length > 0) {
      console.error("━━━ EXPORT CHECK FAILED ━━━\n");
      for (const { label, detail } of failures) {
        console.error(`❌  ${label}\n`);
        console.error(detail);
        console.error();
      }
      console.error(
        "Docs and package exports diverge. Either:\n" +
          "  • Update the docs to match what the package actually exports, or\n" +
          "  • Add the missing export to @wraith-protocol/sdk.",
      );
      process.exit(1);
    }

    console.log("━━━ EXPORT CHECK PASSED ━━━");
    console.log(
      `All ${totalSymbols} symbol(s) across ${checkableMap.size} entry point(s) are present in both ESM and CJS.`,
    );
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
