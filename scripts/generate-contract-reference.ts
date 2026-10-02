import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type ParamSpec = { name: string; type: string; indexed?: boolean };

type FunctionSpec = {
  name: string;
  visibility?: string;
  authRequired: string;
  accounts?: { name: string; type: string }[];
  params: ParamSpec[];
  returns: ParamSpec[] | string;
};

type EventSpec = { name: string; params: ParamSpec[] };
type ErrorSpec = string;

type UnitSpec = {
  name: string;
  kind: string;
  functions: FunctionSpec[];
  instructions?: FunctionSpec[];
  events: EventSpec[];
  storageKeys?: string[];
  errors: ErrorSpec[];
  lock?: Record<string, string>;
  types?: { name: string; fields: ParamSpec[] }[];
};

type SpecFile = {
  chain: string;
  specVersion: string;
  source: { repository: string; path: string; commit: string };
  contracts?: UnitSpec[];
  programs?: UnitSpec[];
  scripts?: UnitSpec[];
};

type SnapshotUnit = {
  functions?: { name: string; signature?: string }[];
  instructions?: { name: string }[];
  events?: { name: string }[];
  storageKeys?: string[];
  errors?: string[];
};

type Snapshot = {
  version: string;
  chains: Record<string, Record<string, SnapshotUnit>>;
  migrations: {
    chain: string;
    unit: string;
    kind: "function" | "event" | "error" | "storageKey";
    name: string;
    removedIn: string;
    note: string;
  }[];
};

const repoRoot = process.cwd();
const specsDir = path.join(repoRoot, "contracts", "specs");

const chainOrder: { chain: string; doc: string; marker: string; unitKey: keyof Snapshot["chains"][string]; unitList: keyof SpecFile }[] = [
  { chain: "evm", doc: "contracts/evm.mdx", marker: "evm-reference", unitKey: "contracts", unitList: "contracts" },
  { chain: "solana", doc: "contracts/solana.mdx", marker: "solana-reference", unitKey: "programs", unitList: "programs" },
  { chain: "ckb", doc: "contracts/ckb.mdx", marker: "ckb-reference", unitKey: "scripts", unitList: "scripts" },
  { chain: "stellar", doc: "contracts/stellar.mdx", marker: "stellar-reference", unitKey: "contracts", unitList: "contracts" },
];

const args = new Set(process.argv.slice(2));
const checkMode = args.has("--check");

function main() {
  const snapshot = readJson<Snapshot>(path.join(specsDir, "api-snapshot.json"));
  const specs = chainOrder.map((entry) => ({
    entry,
    spec: readJson<SpecFile>(path.join(specsDir, `${entry.chain}.json`)),
  }));

  const removals = collectRemovals(snapshot, specs);
  if (removals.undocumented.length > 0) {
    reportUndocumentedRemovals(removals);
  }

  const updates: { doc: string; content: string }[] = [];
  for (const { entry, spec } of specs) {
    const docPath = path.join(repoRoot, entry.doc);
    const current = readFileSync(docPath, "utf8");
    const generated = renderSection(entry, spec, snapshot.version, removals);
    const updated = replaceBetweenMarkers(current, generated, entry.marker);
    if (updated !== current) updates.push({ doc: entry.doc, content: updated });
  }

  if (checkMode) {
    if (updates.length > 0) {
      const list = updates.map((update) => `  - ${update.doc}`).join("\n");
      throw new Error(
        `Generated contract reference is stale in:\n${list}\nRun \`npm run generate:contract-reference\` and commit the result.`,
      );
    }
    console.log("Contract reference is in sync with the checked-in specs.");
    return;
  }

  for (const update of updates) {
    writeFileSync(path.join(repoRoot, update.doc), update.content, "utf8");
    console.log(`Updated ${update.doc}`);
  }
}

type Removal = { chain: string; unit: string; kind: string; name: string };

function collectRemovals(
  snapshot: Snapshot,
  specs: { entry: (typeof chainOrder)[number]; spec: SpecFile }[],
): { all: Removal[]; undocumented: Removal[] } {
  const all: Removal[] = [];

  for (const { entry, spec } of specs) {
    const previous = snapshot.chains[entry.chain] ?? {};
    const units = (spec[entry.unitList] as UnitSpec[] | undefined) ?? [];
    const previousUnits = Object.entries(previous[entry.unitKey] as Record<string, SnapshotUnit>);

    for (const [unitName, before] of previousUnits) {
      const after = units.find((unit) => unit.name === unitName);
      if (!after) {
        for (const fn of before.functions ?? []) all.push({ chain: entry.chain, unit: unitName, kind: "function", name: fn.name });
        for (const fn of before.instructions ?? []) all.push({ chain: entry.chain, unit: unitName, kind: "function", name: fn.name });
        for (const event of before.events ?? []) all.push({ chain: entry.chain, unit: unitName, kind: "event", name: event.name });
        for (const key of before.storageKeys ?? []) all.push({ chain: entry.chain, unit: unitName, kind: "storageKey", name: key });
        for (const error of before.errors ?? []) all.push({ chain: entry.chain, unit: unitName, kind: "error", name: error });
        continue;
      }

      const afterFunctions = new Set([...(after.functions ?? []), ...(after.instructions ?? [])].map((fn) => fn.name));
      for (const fn of [...(before.functions ?? []), ...(before.instructions ?? [])]) {
        if (!afterFunctions.has(fn.name)) all.push({ chain: entry.chain, unit: unitName, kind: "function", name: fn.name });
      }
      for (const event of before.events ?? []) {
        if (!(after.events ?? []).some((candidate) => candidate.name === event.name)) {
          all.push({ chain: entry.chain, unit: unitName, kind: "event", name: event.name });
        }
      }
      for (const key of before.storageKeys ?? []) {
        if (!(after.storageKeys ?? []).includes(key)) {
          all.push({ chain: entry.chain, unit: unitName, kind: "storageKey", name: key });
        }
      }
      for (const error of before.errors ?? []) {
        if (!(after.errors ?? []).includes(error)) {
          all.push({ chain: entry.chain, unit: unitName, kind: "error", name: error });
        }
      }
    }
  }

  const documented = new Set(
    snapshot.migrations.map((entry) => `${entry.chain}|${entry.unit}|${entry.kind}|${entry.name}`),
  );
  const undocumented = all.filter(
    (removal) => !documented.has(`${removal.chain}|${removal.unit}|${removal.kind}|${removal.name}`),
  );

  return { all, undocumented };
}

function reportUndocumentedRemovals(removals: { all: Removal[]; undocumented: Removal[] }): void {
  if (removals.undocumented.length === 0) return;

  const lines = removals.undocumented
    .map((removal) => `  - ${removal.chain}/${removal.unit}: ${removal.kind} \`${removal.name}\``)
    .join("\n");

  throw new Error(
    [
      "Public API members disappeared from the checked-in specs without a migration note:",
      lines,
      "",
      "Either restore them, or record the removal in contracts/specs/api-snapshot.json `migrations`",
      "with the version they were removed in, then regenerate.",
    ].join("\n"),
  );
}

function renderSection(
  entry: (typeof chainOrder)[number],
  spec: SpecFile,
  snapshotVersion: string,
  removals: { all: Removal[] },
): string {
  const startMarker = `{/* ${entry.marker}:start */}`;
  const endMarker = `{/* ${entry.marker}:end */}`;
  const units = (spec[entry.unitList] as UnitSpec[] | undefined) ?? [];
  const removedHere = removals.all.filter((removal) => removal.chain === entry.chain);

  return [
    startMarker,
    "",
    "<!-- Generated by scripts/generate-contract-reference.ts from contracts/specs. Do not edit by hand. -->",
    "",
    `- **Spec version:** ${spec.specVersion}`,
    `- **API snapshot version:** ${snapshotVersion}`,
    `- **Source:** \`${spec.source.repository}/${spec.source.path}\` @ \`${spec.source.commit}\``,
    `- **Contracts:** ${units.length}`,
    removedHere.length > 0 ? `- **Removed in this version:** ${removedHere.map((r) => `\`${r.unit}.${r.name}\``).join(", ")}` : "- **Removed in this version:** none",
    "",
    "## Generated contract reference",
    "",
    ...units.flatMap((unit) => renderUnit(unit)),
    endMarker,
  ].join("\n");
}

function renderUnit(unit: UnitSpec): string[] {
  const functions = unit.functions ?? unit.instructions ?? [];
  const lines: string[] = [`### ${unit.name}`, ""];

  if (unit.lock) {
    lines.push(`- **Code hash:** \`${unit.lock.codeHash}\``);
    lines.push(`- **Type script:** \`${unit.lock.typeScript}\``);
    lines.push("");
  }

  lines.push(`- **Source kind:** \`${unit.kind}\``);
  lines.push(`- **Public methods:** ${functions.length}`);
  lines.push(`- **Errors:** ${unit.errors.length}`);
  lines.push("");

  if (functions.length > 0) {
    lines.push("| Method | Params | Returns | Auth required |", "|---|---|---|---|");
    for (const fn of functions) {
      lines.push(
        `| \`${fn.name}\` | ${renderParams(fn.params)} | ${renderReturns(fn.returns)} | ${fn.authRequired} |`,
      );
    }
    lines.push("");
  }

  if (unit.events && unit.events.length > 0) {
    lines.push("| Event | Fields |", "|---|---|");
    for (const event of unit.events) {
      lines.push(`| \`${event.name}\` | ${renderParams(event.params)} |`);
    }
    lines.push("");
  }

  if (unit.storageKeys && unit.storageKeys.length > 0) {
    lines.push("| Storage key |", "|---|");
    for (const key of unit.storageKeys) lines.push(`| \`${key}\` |`);
    lines.push("");
  }

  if (unit.types && unit.types.length > 0) {
    lines.push("| Type | Fields |", "|---|---|");
    for (const type of unit.types) lines.push(`| \`${type.name}\` | ${renderParams(type.fields)} |`);
    lines.push("");
  }

  if (unit.errors.length > 0) {
    lines.push("```", ...unit.errors.map((error) => `  ${error}`), "```", "");
  } else {
    lines.push("No custom errors declared.", "");
  }

  return lines;
}

function renderParams(params: ParamSpec[] | undefined): string {
  if (!params || params.length === 0) return "None";
  return params
    .map((param) => `\`${param.name || "_"}: ${param.type}${param.indexed ? " (indexed)" : ""}\``)
    .join("<br />");
}

function renderReturns(returns: ParamSpec[] | string | undefined): string {
  if (returns === undefined) return "`void`";
  if (typeof returns === "string") return `\`${returns}\``;
  return renderParams(returns);
}

function replaceBetweenMarkers(current: string, generated: string, marker: string): string {
  const startMarker = `{/* ${marker}:start */}`;
  const endMarker = `{/* ${marker}:end */}`;
  const start = current.indexOf(startMarker);
  const end = current.indexOf(endMarker);

  if (start === -1 || end === -1 || end < start) {
    const heading = current.search(/\n#{2,3} /);
    if (heading === -1) {
      throw new Error(`Missing ${startMarker}/${endMarker} markers and no heading to insert before.`);
    }
    return `${current.slice(0, heading).trimEnd()}\n\n${generated}\n\n${current.slice(heading).trimStart()}`;
  }

  const before = current.slice(0, start).trimEnd();
  const after = current.slice(end + endMarker.length).trimStart();
  return `${before}\n\n${generated}\n\n${after}`;
}

function readJson<T>(filePath: string): T {
  if (!existsSync(filePath)) {
    throw new Error(`Missing spec source: ${path.relative(repoRoot, filePath)}`);
  }
  return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as T;
}

main();
