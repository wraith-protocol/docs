import { readFile } from "node:fs/promises";

const stellarDocs = "sdk/chains/stellar.mdx";
const testnetBaseUrl = "https://horizon-testnet.stellar.org";

type HorizonCheck = {
  name: string;
  path: string;
  validate: (payload: unknown) => boolean;
};

const checks: HorizonCheck[] = [
  {
    name: "root",
    path: "/",
    validate: (payload) => hasString(payload, "horizon_version"),
  },
  {
    name: "latest ledger",
    path: "/ledgers?order=desc&limit=1",
    validate: (payload) => Array.isArray(readPath(payload, ["_embedded", "records"])),
  },
  {
    name: "fee stats",
    path: "/fee_stats",
    validate: (payload) => hasObject(payload, "fee_charged") && hasObject(payload, "max_fee"),
  },
  {
    name: "native asset",
    path: "/assets?asset_type=native&limit=1",
    validate: (payload) => Array.isArray(readPath(payload, ["_embedded", "records"])),
  },
  {
    name: "operations",
    path: "/operations?order=desc&limit=1",
    validate: (payload) => Array.isArray(readPath(payload, ["_embedded", "records"])),
  },
];

async function main() {
  const markdown = await readFile(stellarDocs, "utf8");
  const snippets = Array.from(
    markdown.matchAll(/^```(?:ts|tsx|typescript|js|javascript)([^\n]*)\n([\s\S]*?)^```/gm),
  )
    .map((match, index) => ({
      attrs: match[1] ?? "",
      code: match[2] ?? "",
      index,
      line: markdown.slice(0, match.index).split("\n").length,
    }))
    .filter((snippet) => !/\bno-check\b/.test(snippet.attrs));

  if (snippets.length < 5) {
    throw new Error(`Expected at least 5 checkable Stellar snippets, found ${snippets.length}.`);
  }

  const selected = snippets.slice(0, 5);
  const results = [];

  for (const check of checks) {
    const response = await fetch(`${testnetBaseUrl}${check.path}`);
    if (!response.ok) {
      throw new Error(`${check.name} returned HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!check.validate(payload)) {
      throw new Error(`${check.name} response did not match the expected Horizon shape.`);
    }
    results.push(check.name);
  }

  console.log(
    [
      `Stellar snippets selected: ${selected.map((snippet) => `${stellarDocs}:${snippet.line}`).join(", ")}`,
      `Stellar testnet checks passed: ${results.join(", ")}`,
    ].join("\n"),
  );
}

function hasString(payload: unknown, key: string) {
  return typeof payload === "object"
    && payload !== null
    && typeof (payload as Record<string, unknown>)[key] === "string";
}

function hasObject(payload: unknown, key: string) {
  return typeof payload === "object"
    && payload !== null
    && typeof (payload as Record<string, unknown>)[key] === "object"
    && (payload as Record<string, unknown>)[key] !== null;
}

function readPath(payload: unknown, path: string[]) {
  return path.reduce<unknown>((value, key) => {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }

    return (value as Record<string, unknown>)[key];
  }, payload);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
