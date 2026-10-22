/**
 * check-solana-contracts.ts
 *
 * Compares the Solana contract guide (`contracts/solana.mdx`) and its
 * reference workspace (`snippets/solana-contracts/`) against the canonical
 * program sources and the chain-generated deployment record in the
 * `wraith-protocol/contracts` repository — the same sources the SDK's
 * `getDeployment("solana")` manifest is generated from.
 *
 * These checks are STRUCTURAL: they compare published API shape (instruction
 * signatures, account contexts, account layouts, events, error codes) and
 * program IDs. They do not execute the programs, deploy them, or verify
 * runtime on-chain behaviour, and they do not compare instruction bodies —
 * the workspace crates are documentation fixtures whose bodies are abbreviated.
 *
 * Run it after editing either the guide or the workspace:
 *
 *   pnpm run check:solana-contracts
 *   pnpm run check:solana-contracts -- --offline   # skip the network fetches
 *
 * Checks performed:
 *
 *   1. guide      — every checked `rust` fence in contracts/solana.mdx is a
 *                   verbatim excerpt of its program's crate in the workspace;
 *                   `no-check` fences must be allowlisted with a reason;
 *   2. coverage   — every instruction, account context, event, account
 *                   layout, and error enum in the workspace is documented by
 *                   a fence in the matching guide section;
 *   3. program id — each crate's `declare_id!` is a valid canonical base58
 *                   pubkey and equals BOTH the pinned SDK's
 *                   `getDeployment("solana")` manifest AND the chain-generated
 *                   deployment record `deployments/solana/solana-devnet.json`
 *                   in the canonical contracts repository;
 *   4. layout     — instructions (names, arguments, return types), account
 *                   contexts (field order, field types, account constraints),
 *                   account layouts, events, and error codes in the workspace
 *                   match the canonical program sources pinned below;
 *   5. discriminator — each instruction's Anchor sighash
 *                   (`sha256("global:<name>")[..8]`) matches the *_DISC
 *                   constant the pinned SDK ships for it.
 *
 * Checks 3 (chain manifest) and 4 need network access to fetch the pinned
 * canonical sources. Skip them locally with --offline; CI always runs the
 * full comparison.
 *
 * Wired into CI via the "Compile Rust / Python / shell / config snippets" job
 * in .github/workflows/snippets.yml.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { PublicKey } from "@solana/web3.js";

const repoRoot = process.cwd();

const OFFLINE = process.argv.includes("--offline");

const GUIDE_REL = "contracts/solana.mdx";
const WORKSPACE_REL = "snippets/solana-contracts";

/**
 * The canonical Solana programs and the chain-generated deployment record are
 * fetched from `wraith-protocol/contracts` at this exact commit, mirroring how
 * check-contract-registry.mjs pins its contracts-repo manifest. The pin tracks
 * the `develop` branch (the repo's default branch). Bump it when the programs
 * or the deployment record change.
 */
const CONTRACTS_REPO = "wraith-protocol/contracts";
const PINNED_CONTRACTS_COMMIT = "4f6189e24746852287d245b42a0cc324caf53d4e";
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_RETRIES = 2;

/** Workspace crate <-> guide section <-> SDK deployment key. */
const PROGRAMS = [
  { crate: "wraith-announcer", sdkKey: "announcer" },
  { crate: "wraith-sender", sdkKey: "sender" },
  { crate: "wraith-names", sdkKey: "names" },
] as const;

/**
 * `rust no-check` fences that are intentionally not compiled or extracted.
 *
 * Every entry must carry a reason; a `no-check` fence outside this list fails
 * the check. Keys are a distinctive substring of the fence body.
 */
const NO_CHECK_ALLOWLIST: Record<string, string> = {
  'seeds = [b"name", name.as_bytes()]':
    "Anchor account-attribute fragment, not a standalone Rust item. " +
    "The full Register account context shows the seed in place.",
};

// ----------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------

type RustField = { name: string; type: string; attr: string };

type Instruction = {
  name: string;
  args: Array<{ name: string; type: string }>;
  ret: string;
};

type AccountsStruct = {
  name: string;
  instructionAttr: string | null;
  fields: RustField[];
  body: string; // normalised text of the whole item
};

type PlainStruct = { name: string; fields: RustField[]; body: string };

type ErrorEnum = {
  name: string;
  variants: Array<{ name: string; msg: string | null }>;
  body: string;
};

type ProgramModel = {
  programId: string | null;
  instructions: Instruction[];
  accounts: AccountsStruct[];
  events: PlainStruct[];
  accountData: PlainStruct[];
  errors: ErrorEnum[];
};

type Fence = {
  attrs: string;
  code: string;
  line: number;
  section: string | null; // "wraith-announcer" etc.
};

type Issue = { file: string; line: number; message: string };

// ----------------------------------------------------------------------
// Normalisation helpers
// ----------------------------------------------------------------------

/**
 * Whitespace- and comma-free text, for verbatim containment comparisons.
 * Dropping commas lets multi-line signatures (which rustfmt ends with a
 * trailing comma) match their one-line forms and vice versa.
 */
function norm(text: string): string {
  return text.replace(/\s+/g, "").replace(/,/g, "");
}

/** Strip line and block comments (none of the compared code embeds `//` in strings). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** `pub fn name(args) -> ret` in its whitespace/comma-free form. */
function signatureOf(ix: Instruction): string {
  return norm(`pub fn ${ix.name}(${ix.args.map((a) => `${a.name}: ${a.type}`).join(", ")}) -> ${ix.ret}`);
}

// ----------------------------------------------------------------------
// Rust parsing (line-based; the sources are rustfmt-formatted)
// ----------------------------------------------------------------------

function parseProgram(src: string): ProgramModel {
  const code = stripComments(src);
  const lines = code.split("\n");

  const model: ProgramModel = {
    programId: /declare_id!\("([^"]+)"\)/.exec(code)?.[1] ?? null,
    instructions: [],
    accounts: [],
    events: [],
    accountData: [],
    errors: [],
  };

  let pending: string[] = []; // item-level attributes collected before an item
  let attrStart = 0; // line index where `pending` started
  let i = 0;

  /** Collect a brace-balanced block starting at `start`; returns it plus the next line index. */
  const takeBalanced = (start: number, open: string, close: string): { text: string; next: number } => {
    let depth = 0;
    let text = "";
    let j = start;
    for (; j < lines.length; j++) {
      const line = lines[j];
      text += line + "\n";
      for (const ch of line) {
        if (ch === open) depth++;
        else if (ch === close) depth--;
      }
      if (depth === 0 && text.trim() !== "") return { text, next: j + 1 };
    }
    return { text, next: j };
  };

  const ITEM_ATTRS = ["#[derive(Accounts)]", "#[event]", "#[account]", "#[error_code]"];

  while (i < lines.length) {
    const line = lines[i].trim();

    // Instructions inside `#[program] pub mod <name> { ... }`.
    if (line === "#[program]" && /^pub mod \w+ \{/.test(lines[i + 1]?.trim() ?? "")) {
      const modBody = takeBalanced(i + 1, "{", "}");
      const fnRe = /pub fn (\w+)\s*\(([\s\S]*?)\)\s*->\s*([^{]+)\{/g;
      let m: RegExpExecArray | null;
      while ((m = fnRe.exec(modBody.text)) !== null) {
        model.instructions.push({
          name: m[1],
          args: m[2]
            .split(",")
            .map((a) => a.trim())
            .filter((a) => a.length > 0)
            .map((a) => {
              const at = a.indexOf(":");
              return { name: a.slice(0, at).trim(), type: a.slice(at + 1).trim() };
            }),
          ret: m[3].trim(),
        });
      }
      i = modBody.next;
      pending = [];
      continue;
    }

    if (line.startsWith("#[")) {
      if (ITEM_ATTRS.includes(line)) {
        pending = [line];
        attrStart = i;
      } else if (line.startsWith("#[instruction(") && pending.includes("#[derive(Accounts)]")) {
        pending.push(line);
      } else {
        pending = [];
      }
      i++;
      continue;
    }

    const structMatch = /^pub struct (\w+)/.exec(line);
    if (structMatch && pending.length > 0) {
      const name = structMatch[1];
      const attrs = pending;
      pending = [];
      const body = takeBalanced(i, "{", "}");
      const fields = parseFields(body.text);

      if (attrs.includes("#[derive(Accounts)]")) {
        model.accounts.push({
          name,
          instructionAttr: attrs.find((a) => a.startsWith("#[instruction(")) ?? null,
          fields,
          body: norm(lines.slice(attrStart, body.next).join("\n")),
        });
      } else if (attrs.includes("#[event]")) {
        model.events.push({ name, fields, body: norm(lines.slice(attrStart, body.next).join("\n")) });
      } else if (attrs.includes("#[account]")) {
        model.accountData.push({ name, fields, body: norm(lines.slice(attrStart, body.next).join("\n")) });
      }
      i = body.next;
      continue;
    }

    const enumMatch = /^pub enum (\w+)/.exec(line);
    if (enumMatch && pending.includes("#[error_code]")) {
      const name = enumMatch[1];
      pending = [];
      const body = takeBalanced(i, "{", "}");
      const variants: Array<{ name: string; msg: string | null }> = [];
      let msg: string | null = null;
      for (const raw of body.text.split("\n")) {
        const t = raw.trim();
        const msgMatch = /^#\[msg\("([^"]*)"\)\]$/.exec(t);
        if (msgMatch) {
          msg = msgMatch[1];
          continue;
        }
        const variant = /^(\w+),?$/.exec(t);
        if (variant && variant[1] !== "pub") {
          variants.push({ name: variant[1], msg });
          msg = null;
        }
      }
      model.errors.push({ name, variants, body: norm(lines.slice(attrStart, body.next).join("\n")) });
      i = body.next;
      continue;
    }

    pending = [];
    i++;
  }

  return model;
}

/** Parse `pub name: Type,` fields (with a possible preceding `#[account(...)]`) from a struct body. */
function parseFields(structBody: string): RustField[] {
  const fields: RustField[] = [];
  let attr: string | null = null;
  let depth = 0;
  let collecting: string[] = [];

  for (const raw of structBody.split("\n")) {
    const t = raw.trim();
    if (collecting.length > 0 || t.startsWith("#[account(")) {
      collecting.push(t);
      for (const ch of t) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      if (depth === 0) {
        attr = collecting.join(" ");
        collecting = [];
      }
      continue;
    }
    const field = /^pub (\w+):\s*(.+?),?$/.exec(t);
    if (field) {
      fields.push({ name: field[1], type: field[2].replace(/,$/, "").trim(), attr: attr ?? "" });
      attr = null;
    } else if (t.startsWith("#[") || t === "") {
      attr = null;
    }
  }
  return fields;
}

// ----------------------------------------------------------------------
// Guide parsing
// ----------------------------------------------------------------------

async function parseGuide(): Promise<Fence[]> {
  const markdown = await readFile(path.join(repoRoot, GUIDE_REL), "utf8");
  const fencePattern = /^```([A-Za-z0-9_-]+)([^\n]*)\n([\s\S]*?)^```/gm;
  const headings = [...markdown.matchAll(/^##\s+(wraith-[a-z-]+)\s*$/gm)];
  const fences: Fence[] = [];
  let match: RegExpExecArray | null;

  const sectionAt = (index: number): string | null => {
    let current: string | null = null;
    for (const h of headings) {
      if (h.index! > index) break;
      current = h[1];
    }
    return current;
  };

  while ((match = fencePattern.exec(markdown)) !== null) {
    if (match[1].toLowerCase() !== "rust") continue;
    fences.push({
      attrs: match[2] ?? "",
      code: match[3],
      line: lineNumberAt(markdown, match.index),
      section: sectionAt(match.index),
    });
  }
  return fences;
}

// ----------------------------------------------------------------------
// Canonical + SDK artifacts
// ----------------------------------------------------------------------

async function fetchText(url: string): Promise<string | null> {
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (response.ok) return await response.text();
      if (response.status === 404) return null;
    } catch {
      // transient — retry
    }
  }
  return null;
}

async function fetchCanonicalPrograms(): Promise<Map<string, ProgramModel> | null> {
  const programs = new Map<string, ProgramModel>();
  for (const { crate } of PROGRAMS) {
    const url = `https://raw.githubusercontent.com/${CONTRACTS_REPO}/${PINNED_CONTRACTS_COMMIT}/solana/programs/${crate}/src/lib.rs`;
    const src = await fetchText(url);
    if (src === null) return null;
    programs.set(crate, parseProgram(src));
  }
  return programs;
}

async function fetchChainManifest(): Promise<Map<string, string> | null> {
  const url = `https://raw.githubusercontent.com/${CONTRACTS_REPO}/${PINNED_CONTRACTS_COMMIT}/deployments/solana/solana-devnet.json`;
  const text = await fetchText(url);
  if (text === null) return null;
  try {
    const json = JSON.parse(text);
    const ids = new Map<string, string>();
    for (const contract of json.contracts ?? []) {
      if (contract?.name && contract?.id) ids.set(contract.name, contract.id);
    }
    return ids;
  } catch {
    return null;
  }
}

type SdkArtifacts = { contracts: Record<string, string>; discriminators: Map<string, number[]> };

async function loadSdkArtifacts(failures: Issue[]): Promise<SdkArtifacts | null> {
  const bundlePath = path.join(
    repoRoot,
    "node_modules",
    "@wraith-protocol",
    "sdk",
    "dist",
    "chains",
    "solana",
    "index.js",
  );
  let source: string;
  try {
    source = await readFile(bundlePath, "utf8");
  } catch {
    failures.push({
      file: "node_modules/@wraith-protocol/sdk",
      line: 1,
      message:
        "Could not read @wraith-protocol/sdk from node_modules.\n" +
        "CI installs dependencies before this check; locally run `pnpm install` first.",
    });
    return null;
  }

  const manifestMatch = /var DEPLOYMENTS = (\{[\s\S]*?\n\});/.exec(source);
  let contracts: Record<string, string> = {};
  try {
    const deployments = new Function(`return (${manifestMatch?.[1]});`)();
    contracts = deployments?.solana?.contracts ?? {};
  } catch {
    /* fall through to the emptiness check below */
  }
  if (Object.keys(contracts).length === 0) {
    failures.push({
      file: "node_modules/@wraith-protocol/sdk",
      line: 1,
      message: "Could not locate the Solana DEPLOYMENTS manifest in the installed SDK bundle.",
    });
    return null;
  }

  const discriminators = new Map<string, number[]>();
  for (const m of source.matchAll(/var (\w+)_DISC = new Uint8Array\(\[([\d,\s]+)\]\)/g)) {
    discriminators.set(m[1].toLowerCase(), m[2].split(",").map((n) => Number(n.trim())));
  }

  return { contracts, discriminators };
}

// ----------------------------------------------------------------------
// Check 1 + 2: guide fences against the workspace crates
// ----------------------------------------------------------------------

function checkGuide(fences: Fence[], models: Map<string, ProgramModel>, sources: Map<string, string>): Issue[] {
  const issues: Issue[] = [];
  const crateNorm = new Map<string, string>();
  for (const { crate } of PROGRAMS) {
    crateNorm.set(crate, norm(stripComments(sources.get(crate)!)));
  }

  for (const fence of fences) {
    const noCheck = /\bno-check\b/.test(fence.attrs);
    const body = norm(stripComments(fence.code));

    if (noCheck) {
      const allowlisted = Object.keys(NO_CHECK_ALLOWLIST).some((k) => norm(body).includes(norm(k)));
      if (!allowlisted) {
        issues.push({
          file: GUIDE_REL,
          line: fence.line,
          message:
            "Rust fence is marked `no-check` but is not allowlisted.\n" +
            "Either remove `no-check` so it is verified against the workspace, or add it\n" +
            "to NO_CHECK_ALLOWLIST in scripts/check-solana-contracts.ts with a reason.",
        });
      }
      continue;
    }

    if (!fence.section || !crateNorm.has(fence.section)) {
      issues.push({
        file: GUIDE_REL,
        line: fence.line,
        message:
          "Checked Rust fences must sit under a `## wraith-…` program section so this\n" +
          "checker knows which workspace crate verifies them.",
      });
      continue;
    }

    const crate = fence.section;
    if (!crateNorm.get(crate)!.includes(norm(body))) {
      issues.push({
        file: GUIDE_REL,
        line: fence.line,
        message:
          `This fence is not a verbatim excerpt of ${WORKSPACE_REL}/programs/${crate}/src/lib.rs.\n` +
          "Update the guide or the crate so the two agree — CI compiles the crate, so the\n" +
          "guide must show exactly what compiles.",
      });
      continue;
    }

    const model = models.get(crate)!;
    const isItem = [
      ...model.accounts.map((a) => a.body),
      ...model.events.map((e) => e.body),
      ...model.accountData.map((a) => a.body),
      ...model.errors.map((e) => e.body),
      ...model.instructions.map((ix) => signatureOf(ix)),
    ].some((item) => item.includes(norm(body)));
    if (!isItem) {
      issues.push({
        file: GUIDE_REL,
        line: fence.line,
        message:
          `This fence matches ${crate} source text but not a documented item\n` +
          "(instruction, account context, event, account layout, or error enum).",
      });
    }
  }

  // Coverage: every workspace item must be documented by a fence in its section.
  for (const { crate } of PROGRAMS) {
    const model = models.get(crate)!;
    const sectionFences = fences
      .filter((f) => f.section === crate && !/\bno-check\b/.test(f.attrs))
      .map((f) => norm(stripComments(f.code)));

    for (const ix of model.instructions) {
      if (!sectionFences.includes(signatureOf(ix))) {
        issues.push({
          file: GUIDE_REL,
          line: 1,
          message: `${crate}: instruction \`${ix.name}\` is not documented by a fence in the "## ${crate}" section.`,
        });
      }
    }
    for (const item of [...model.accounts, ...model.events, ...model.accountData]) {
      if (!sectionFences.some((f) => item.body.includes(f))) {
        issues.push({
          file: GUIDE_REL,
          line: 1,
          message: `${crate}: \`${item.name}\` is not documented by a fence in the "## ${crate}" section.`,
        });
      }
    }
    for (const err of model.errors) {
      if (!sectionFences.some((f) => f.includes(norm(`pub enum ${err.name}`)))) {
        issues.push({
          file: GUIDE_REL,
          line: 1,
          message: `${crate}: error enum \`${err.name}\` is not documented by a fence in the "## ${crate}" section.`,
        });
      }
    }
  }

  return issues;
}

// ----------------------------------------------------------------------
// Check 3: program IDs against generated artifacts
// ----------------------------------------------------------------------

function checkProgramIds(
  models: Map<string, ProgramModel>,
  sdk: SdkArtifacts | null,
  chainIds: Map<string, string> | null,
  failures: Issue[],
): void {
  for (const { crate, sdkKey } of PROGRAMS) {
    const id = models.get(crate)!.programId;
    const file = `${WORKSPACE_REL}/programs/${crate}/src/lib.rs`;
    if (!id) {
      failures.push({ file, line: 1, message: `${crate}: no declare_id! found.` });
      continue;
    }

    try {
      if (new PublicKey(id).toBase58() !== id) {
        failures.push({ file, line: 1, message: `${crate}: declare_id! "${id}" is not canonical base58.` });
      }
    } catch {
      failures.push({ file, line: 1, message: `${crate}: declare_id! "${id}" is not a valid 32-byte Solana pubkey.` });
      continue;
    }

    if (sdk) {
      const sdkId = sdk.contracts[sdkKey];
      if (sdkId !== id) {
        failures.push({
          file,
          line: 1,
          message:
            `${crate}: declare_id! does not match the pinned SDK's getDeployment("solana") manifest.\n` +
            `    crate: ${id}\n    sdk:    ${sdkId ?? "(not published)"}`,
        });
      }
    }

    if (chainIds) {
      const chainId = chainIds.get(crate.replace(/-/g, "_"));
      if (chainId !== id) {
        failures.push({
          file,
          line: 1,
          message:
            `${crate}: declare_id! does not match the chain-generated deployment record\n` +
            `(${CONTRACTS_REPO}@${PINNED_CONTRACTS_COMMIT.slice(0, 8)} deployments/solana/solana-devnet.json).\n` +
            `    crate:  ${id}\n    record: ${chainId ?? "(missing)"}`,
        });
      }
    }
  }
}

// ----------------------------------------------------------------------
// Check 5: instruction discriminators vs the SDK's sighash constants
// ----------------------------------------------------------------------

function checkDiscriminators(models: Map<string, ProgramModel>, sdk: SdkArtifacts | null, failures: Issue[]): void {
  if (!sdk) return;
  const known = new Set<string>();
  for (const { crate } of PROGRAMS) {
    for (const ix of models.get(crate)!.instructions) {
      known.add(ix.name);
      const shipped = sdk.discriminators.get(ix.name);
      if (!shipped) continue; // The SDK does not build every instruction client-side.
      const expected = Array.from(createHash("sha256").update(`global:${ix.name}`).digest().subarray(0, 8));
      if (shipped.join(",") !== expected.join(",")) {
        failures.push({
          file: "node_modules/@wraith-protocol/sdk",
          line: 1,
          message:
            `SDK ${ix.name.toUpperCase()}_DISC does not match Anchor's sighash for \`${ix.name}\`.\n` +
            `    sdk:     ${shipped.join(", ")}\n    sighash: ${expected.join(", ")}`,
        });
      }
    }
  }
  for (const name of sdk.discriminators.keys()) {
    if (!known.has(name)) {
      failures.push({
        file: "node_modules/@wraith-protocol/sdk",
        line: 1,
        message: `SDK ships a discriminator for unknown instruction \`${name}\`.`,
      });
    }
  }
}

// ----------------------------------------------------------------------
// Check 4: workspace layouts vs the canonical program sources
// ----------------------------------------------------------------------

function compareModels(crate: string, docs: ProgramModel, canonical: ProgramModel, failures: Issue[]): void {
  const file = `${WORKSPACE_REL}/programs/${crate}/src/lib.rs`;
  const fail = (message: string) => failures.push({ file, line: 1, message });

  if (docs.programId === null) {
    fail(`${crate}: no declare_id! in the workspace crate.`);
  } else if (docs.programId !== canonical.programId) {
    fail(
      `${crate}: declare_id! does not match the canonical program.\n` +
        `    workspace: ${docs.programId}\n    canonical: ${canonical.programId}`,
    );
  }

  const byName = <T extends { name: string }>(items: T[]) => new Map(items.map((i) => [i.name, i]));

  const ixDocs = byName(docs.instructions);
  const ixCanonical = byName(canonical.instructions);
  for (const [name, ix] of ixCanonical) {
    const other = ixDocs.get(name);
    if (!other) {
      fail(`${crate}: workspace crate is missing instruction \`${name}\`.`);
      continue;
    }
    if (signatureOf(ix) !== signatureOf(other)) {
      fail(
        `${crate}: instruction \`${name}\` signature differs from the canonical program.\n` +
          `    canonical: ${ix.args.map((a) => `${a.name}: ${a.type}`).join(", ")} -> ${ix.ret}\n` +
          `    workspace: ${other.args.map((a) => `${a.name}: ${a.type}`).join(", ")} -> ${other.ret}`,
      );
    }
  }
  for (const name of ixDocs.keys()) {
    if (!ixCanonical.has(name)) fail(`${crate}: workspace crate has extra instruction \`${name}\`.`);
  }

  const compareStructs = (
    kind: string,
    docs2: Array<{ name: string; fields: RustField[] }>,
    canonical2: Array<{ name: string; fields: RustField[]; instructionAttr?: string | null }>,
  ) => {
    const cBy = byName(canonical2);
    const dBy = byName(docs2);
    for (const [name, cItem] of cBy) {
      const dItem = dBy.get(name);
      if (!dItem) {
        fail(`${crate}: workspace crate is missing ${kind} \`${name}\`.`);
        continue;
      }
      const layout = (s: { fields: RustField[] }) =>
        s.fields.map((f) => `${f.name}:${norm(f.type)}#${norm(f.attr)}`).join("|");
      if (layout(cItem) !== layout(dItem)) {
        fail(
          `${crate}: ${kind} \`${name}\` layout differs from the canonical program.\n` +
            `    canonical: ${cItem.fields.map((f) => `${f.name}: ${f.type}${f.attr ? ` [${f.attr}]` : ""}`).join(", ")}\n` +
            `    workspace: ${dItem.fields.map((f) => `${f.name}: ${f.type}${f.attr ? ` [${f.attr}]` : ""}`).join(", ")}`,
        );
      }
      if ("instructionAttr" in cItem || "instructionAttr" in dItem) {
        const cAttr = norm((cItem as AccountsStruct).instructionAttr ?? "");
        const dAttr = norm((dItem as AccountsStruct & { instructionAttr?: string | null }).instructionAttr ?? "");
        if (cAttr !== dAttr) {
          fail(
            `${crate}: ${kind} \`${name}\` #[instruction(...)] attribute differs from the canonical program.\n` +
              `    canonical: ${(cItem as AccountsStruct).instructionAttr ?? "(none)"}\n` +
              `    workspace: ${(dItem as AccountsStruct).instructionAttr ?? "(none)"}`,
          );
        }
      }
    }
    for (const name of dBy.keys()) {
      if (!cBy.has(name)) fail(`${crate}: workspace crate has extra ${kind} \`${name}\`.`);
    }
  };

  compareStructs("account context", docs.accounts, canonical.accounts);
  compareStructs("event", docs.events, canonical.events);
  compareStructs("account layout", docs.accountData, canonical.accountData);

  const eCanonical = byName(canonical.errors);
  const eDocs = byName(docs.errors);
  const errSig = (e: ErrorEnum) => e.variants.map((v) => `${v.name}:${v.msg ?? ""}`).join("|");
  for (const [name, err] of eCanonical) {
    const other = eDocs.get(name);
    if (!other) {
      fail(`${crate}: workspace crate is missing error enum \`${name}\`.`);
      continue;
    }
    if (errSig(err) !== errSig(other)) {
      fail(
        `${crate}: error enum \`${name}\` differs from the canonical program.\n` +
          `    canonical: ${err.variants.map((v) => `${v.name} ("${v.msg ?? ""}")`).join(", ")}\n` +
          `    workspace: ${other.variants.map((v) => `${v.name} ("${v.msg ?? ""}")`).join(", ")}`,
      );
    }
  }
  for (const name of eDocs.keys()) {
    if (!eCanonical.has(name)) fail(`${crate}: workspace crate has extra error enum \`${name}\`.`);
  }
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

async function main() {
  const failures: Issue[] = [];
  const warnings: string[] = [];

  const models = new Map<string, ProgramModel>();
  const sources = new Map<string, string>();
  for (const { crate } of PROGRAMS) {
    const rel = `${WORKSPACE_REL}/programs/${crate}/src/lib.rs`;
    let src: string;
    try {
      src = await readFile(path.join(repoRoot, rel), "utf8");
    } catch {
      console.error(`Missing ${rel}. The Solana reference workspace is not checked out.`);
      process.exit(1);
    }
    sources.set(crate, src);
    models.set(crate, parseProgram(src));
  }

  const fences = await parseGuide();
  failures.push(...checkGuide(fences, models, sources));

  const sdk = await loadSdkArtifacts(failures);
  checkDiscriminators(models, sdk, failures);

  let chainIds: Map<string, string> | null = null;
  if (OFFLINE) {
    warnings.push(
      "Remote verification skipped (--offline): canonical program layouts and the chain-generated deployment record were not checked.",
    );
  } else {
    const canonical = await fetchCanonicalPrograms();
    if (!canonical) {
      failures.push({
        file: GUIDE_REL,
        line: 1,
        message:
          `Could not fetch the canonical Solana programs from ${CONTRACTS_REPO}@${PINNED_CONTRACTS_COMMIT.slice(0, 8)}.\n` +
          "Re-run with --offline to skip this verification locally, or retry later.",
      });
    } else {
      for (const { crate } of PROGRAMS) {
        compareModels(crate, models.get(crate)!, canonical.get(crate)!, failures);
      }
    }

    chainIds = await fetchChainManifest();
    if (!chainIds) {
      failures.push({
        file: GUIDE_REL,
        line: 1,
        message:
          `Could not fetch deployments/solana/solana-devnet.json from ${CONTRACTS_REPO}@${PINNED_CONTRACTS_COMMIT.slice(0, 8)}.\n` +
          "Re-run with --offline to skip this verification locally, or retry later.",
      });
    }
  }

  checkProgramIds(models, sdk, chainIds, failures);

  if (warnings.length > 0) {
    console.warn(["Solana contract check warnings:", ...warnings.map((w) => `  - ${w}`)].join("\n"));
  }

  if (failures.length > 0) {
    console.error(
      [
        "Solana contract check failed.",
        "",
        ...failures.map((f) => `${f.file}:${f.line}\n${"-".repeat(40)}\n${f.message}`),
        "",
        `${GUIDE_REL} and ${WORKSPACE_REL} must mirror the canonical programs in`,
        `${CONTRACTS_REPO} and the program IDs the SDK publishes.`,
      ].join("\n\n"),
    );
    process.exit(1);
  }

  const compared = OFFLINE
    ? "guide, workspace, SDK manifest (offline)"
    : "guide, workspace, SDK manifest, canonical programs, chain-generated deployment record";
  console.log(
    `Solana contract structure check passed: ${fences.length} guide fence(s), ${PROGRAMS.length} program(s) compared against: ${compared}.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
