import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

type ContractReference = {
  slug: string;
  title: string;
  addresses: Record<string, string>;
  functions: FunctionReference[];
  events: string[];
  storageKeys: string[];
};

type FunctionReference = {
  name: string;
  params: ParamReference[];
  returnType: string;
  authRequired: string;
};

type ParamReference = {
  name: string;
  type: string;
};

const repoRoot = process.cwd();
const stellarDocPath = path.join(repoRoot, "contracts", "stellar.mdx");
const startMarker = "{/* stellar-reference:start */}";
const endMarker = "{/* stellar-reference:end */}";

const contractTitles: Record<string, string> = {
  "stealth-announcer": "Stealth announcer",
  "stealth-registry": "Stealth registry",
  "stealth-sender": "Stealth sender",
  "wraith-names": "Wraith names",
};

const args = new Set(process.argv.slice(2));
const checkMode = args.has("--check");
const allowMissing = args.has("--allow-missing");

function main() {
  const references = loadReferencesOrExit();
  const generated = renderReference(references);
  const current = readFileSync(stellarDocPath, "utf8");
  const updated = replaceBetweenMarkers(current, generated);

  if (checkMode) {
    if (current !== updated) {
      throw new Error(
        "contracts/stellar.mdx is stale. Run `npm run generate:stellar-reference` and commit the result.",
      );
    }
    return;
  }

  writeFileSync(stellarDocPath, updated, "utf8");
}

function loadReferencesOrExit(): ContractReference[] {
  try {
    return loadReferences();
  } catch (error) {
    if (checkMode && allowMissing) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Skipping Stellar reference check: ${message}`);
      process.exit(0);
    }
    throw error;
  }
}

function loadReferences(): ContractReference[] {
  const bindingRoot = findBindingRoot();
  if (bindingRoot) {
    return loadFromBindings(bindingRoot);
  }

  const inspected = loadFromStellarInspect();
  if (inspected.length > 0) {
    return inspected;
  }

  throw new Error(
    [
      "Could not find Stellar contract bindings or inspect configuration.",
      "Set STELLAR_BINDINGS_DIR to wraith-protocol/contracts/stellar/bindings/typescript",
      "or set STELLAR_CONTRACT_IDS to a JSON object of {\"contract-slug\":\"contract-id\"}.",
    ].join(" "),
  );
}

function findBindingRoot(): string | undefined {
  const configured = process.env.STELLAR_BINDINGS_DIR?.split(path.delimiter).filter(Boolean) ?? [];
  const candidates = [
    ...configured,
    "wraith-protocol/contracts/stellar/bindings/typescript",
    "../wraith-protocol/contracts/stellar/bindings/typescript",
    "contracts/stellar/bindings/typescript",
    "../contracts/stellar/bindings/typescript",
  ].map((candidate) => path.resolve(repoRoot, candidate));

  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isDirectory());
}

function loadFromBindings(bindingRoot: string): ContractReference[] {
  const contractDirs = readdirSync(bindingRoot)
    .map((entry) => path.join(bindingRoot, entry))
    .filter((entry) => statSync(entry).isDirectory())
    .filter((entry) => listFiles(entry, ".ts").length > 0);

  const dirs = contractDirs.length > 0 ? contractDirs : [bindingRoot];
  const references = dirs.map((dir) => parseContractBinding(dir)).filter((reference) => reference.functions.length > 0);

  if (references.length === 0) {
    throw new Error(`No TypeScript binding functions found under ${bindingRoot}.`);
  }

  return references.sort((a, b) => a.slug.localeCompare(b.slug));
}

function parseContractBinding(contractDir: string): ContractReference {
  const files = listFiles(contractDir, ".ts");
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n\n");
  const slug = contractSlug(contractDir, source);

  return {
    slug,
    title: contractTitles[slug] ?? slug,
    addresses: contractAddresses(slug, contractDir),
    functions: parseFunctions(source),
    events: parseEvents(source),
    storageKeys: parseStorageKeys(source),
  };
}

function parseFunctions(source: string): FunctionReference[] {
  const byName = new Map<string, FunctionReference>();
  const interfacePattern = /export\s+interface\s+([A-Za-z0-9_]+)Args\s*{([\s\S]*?)\n}/g;
  let match: RegExpExecArray | null;

  while ((match = interfacePattern.exec(source))) {
    const name = toSnakeCase(match[1]);
    byName.set(name, {
      name,
      params: parseParams(match[2]),
      returnType: inferReturnType(source, match[1], name),
      authRequired: inferAuth(name, parseParams(match[2])),
    });
  }

  const methodPattern = /(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*:\s*Promise<([^>]+)>/g;
  while ((match = methodPattern.exec(source))) {
    const rawName = match[1];
    if (["constructor", "parseResult", "txFromJSON"].includes(rawName)) continue;
    const name = toSnakeCase(rawName);
    if (!byName.has(name)) {
      const params = parseInlineParams(match[2]);
      byName.set(name, {
        name,
        params,
        returnType: normalizeType(match[3]),
        authRequired: inferAuth(name, params),
      });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function parseParams(body: string): ParamReference[] {
  return body
    .split("\n")
    .map((line) => line.trim().replace(/,$/, "").replace(/;$/, ""))
    .map((line) => line.match(/^([A-Za-z_][A-Za-z0-9_]*)(\?)?:\s*(.+)$/))
    .filter((line): line is RegExpMatchArray => Boolean(line))
    .map((line) => ({ name: line[1], type: normalizeType(line[3]) }));
}

function parseInlineParams(body: string): ParamReference[] {
  const argsMatch = body.match(/{([\s\S]*)}/);
  if (!argsMatch) return [];
  return argsMatch[1]
    .split(",")
    .map((param) => param.trim())
    .filter(Boolean)
    .map((param) => ({ name: param, type: "unknown" }));
}

function inferReturnType(source: string, pascalName: string, snakeName: string): string {
  const patterns = [
    new RegExp(`${pascalName}Result\\s*=\\s*([^;\\n]+)`),
    new RegExp(`${pascalName}Response\\s*=\\s*([^;\\n]+)`),
    new RegExp(`${snakeName}\\s*\\([^)]*\\)\\s*:\\s*Promise<([^>]+)>`),
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return normalizeType(match[1]);
  }

  return "void";
}

function inferAuth(name: string, params: ParamReference[]): string {
  const authParam = params.some((param) => ["admin", "caller", "registrant", "owner"].includes(param.name));
  const readonlyName = /^(resolve|name_of|stealth_meta_address_of|get|has|is_)/.test(name);
  if (readonlyName && !authParam) return "No";
  if (authParam || /^(init|register|update|release|send|batch_send|announce)/.test(name)) return "Yes";
  return "Unknown";
}

function parseEvents(source: string): string[] {
  const events = new Set<string>();
  const eventPattern =
    /(?:export\s+)?(?:type|interface)\s+([A-Za-z0-9_]*Event[A-Za-z0-9_]*)\b[^{=]*(?:=\s*)?{([\s\S]*?)\n}\s*;?/g;
  let match: RegExpExecArray | null;

  while ((match = eventPattern.exec(source))) {
    const eventName = toSnakeCase(match[1].replace(/Event$/, ""));
    const fields = parseParams(match[2])
      .map((param) => `${param.name}: ${param.type}`)
      .join(", ");
    events.add(fields ? `${eventName}(${fields})` : eventName);
  }

  return [...events].sort();
}

function parseStorageKeys(source: string): string[] {
  const keys = new Set<string>();
  const enumPattern = /(?:export\s+)?enum\s+([A-Za-z0-9_]*(?:DataKey|StorageKey)[A-Za-z0-9_]*)\s*{([\s\S]*?)}/g;
  let match: RegExpExecArray | null;

  while ((match = enumPattern.exec(source))) {
    match[2]
      .split("\n")
      .map((line) => line.trim().replace(/,$/, ""))
      .filter(Boolean)
      .forEach((line) => keys.add(line));
  }

  const unionPattern = /(?:DataKey|StorageKey)\s*=\s*([^;\n]+)/g;
  while ((match = unionPattern.exec(source))) {
    match[1]
      .split("|")
      .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean)
      .forEach((part) => keys.add(part));
  }

  return [...keys].sort();
}

function contractSlug(contractDir: string, source: string): string {
  const packageJson = path.join(contractDir, "package.json");
  if (existsSync(packageJson)) {
    const parsed = readJsonFile<{ name?: string }>(packageJson);
    if (parsed.name) return parsed.name.split("/").at(-1) ?? parsed.name;
  }

  const contractName = source.match(/contractName\s*[:=]\s*["']([^"']+)["']/)?.[1];
  return contractName ? toKebabCase(contractName) : path.basename(contractDir);
}

function contractAddresses(slug: string, contractDir: string): Record<string, string> {
  const addresses: Record<string, string> = {};
  const envKey = `STELLAR_${slug.toUpperCase().replace(/-/g, "_")}_CONTRACT_ID`;
  if (process.env[envKey]) addresses.testnet = process.env[envKey]!;

  if (process.env.STELLAR_CONTRACT_IDS) {
    const configured = parseContractIdsEnv();
    const entry = configured[slug];
    if (typeof entry === "string") addresses.testnet = entry;
    if (entry && typeof entry === "object") Object.assign(addresses, entry);
  }

  for (const file of listFiles(contractDir, ".json")) {
    const lower = path.basename(file).toLowerCase();
    if (!/(deploy|address|network|contract)/.test(lower)) continue;
    const parsed = readJsonFile<unknown>(file);
    collectAddresses(parsed, addresses);
  }

  return addresses;
}

function collectAddresses(value: unknown, addresses: Record<string, string>, network = "testnet") {
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && /^C[A-Z0-9]{55,}$/.test(entry)) {
      addresses[/testnet|mainnet|futurenet/i.test(key) ? key : network] = entry;
    } else if (entry && typeof entry === "object") {
      collectAddresses(entry, addresses, /testnet|mainnet|futurenet/i.test(key) ? key : network);
    }
  }
}

function loadFromStellarInspect(): ContractReference[] {
  if (!process.env.STELLAR_CONTRACT_IDS) return [];
  const configured = parseContractIdsEnv();
  const network = process.env.STELLAR_NETWORK ?? "testnet";
  const cli = process.env.STELLAR_CLI ?? "stellar";

  return Object.entries(configured).map(([slug, entry]) => {
    const contractId = typeof entry === "string" ? entry : entry[network] ?? entry.testnet ?? Object.values(entry)[0];
    const output = execFileSync(cli, ["contract", "inspect", "--id", contractId, "--network", network], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    return {
      slug,
      title: contractTitles[slug] ?? slug,
      addresses: { [network]: contractId },
      functions: parseInspectFunctions(output),
      events: parseInspectList(output, "Events"),
      storageKeys: parseInspectList(output, "Storage"),
    };
  });
}

function parseContractIdsEnv(): Record<string, string | Record<string, string>> {
  try {
    const parsed = JSON.parse(process.env.STELLAR_CONTRACT_IDS ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("value must be a JSON object");
    }
    return parsed as Record<string, string | Record<string, string>>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`STELLAR_CONTRACT_IDS must be JSON like {"stealth-announcer":"C..."}. ${message}`);
  }
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as T;
}

function parseInspectFunctions(output: string): FunctionReference[] {
  const functions: FunctionReference[] = [];
  const fnPattern = /(?:^|\n)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*([^\n]+))?/g;
  let match: RegExpExecArray | null;

  while ((match = fnPattern.exec(output))) {
    const name = match[1];
    if (["fn", "contract"].includes(name)) continue;
    const params = match[2]
      .split(",")
      .map((param) => param.trim())
      .filter(Boolean)
      .map((param) => {
        const [paramName, ...typeParts] = param.split(":");
        return { name: paramName.trim(), type: normalizeType(typeParts.join(":").trim() || "unknown") };
      });
    functions.push({
      name,
      params,
      returnType: normalizeType(match[3] ?? "void"),
      authRequired: inferAuth(name, params),
    });
  }

  return functions;
}

function parseInspectList(output: string, heading: string): string[] {
  const match = output.match(new RegExp(`${heading}:?\\s*\\n([\\s\\S]*?)(?:\\n\\S|$)`, "i"));
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean)
    .sort();
}

function renderReference(references: ContractReference[]): string {
  return [
    startMarker,
    "",
    "<!-- This section is generated by scripts/generate-stellar-reference.ts. Do not edit by hand. -->",
    "",
    "## Generated contract reference",
    "",
    ...references.flatMap(renderContract),
    endMarker,
  ].join("\n");
}

function renderContract(contract: ContractReference): string[] {
  return [
    `### ${contract.title}`,
    "",
    "#### Addresses",
    "",
    renderAddresses(contract.addresses),
    "",
    "#### Functions",
    "",
    renderFunctionTable(contract.functions),
    "",
    "#### Events",
    "",
    renderList(contract.events),
    "",
    "#### Storage keys",
    "",
    renderList(contract.storageKeys),
    "",
  ];
}

function renderAddresses(addresses: Record<string, string>): string {
  const entries = Object.entries(addresses);
  if (entries.length === 0) return "No deployed addresses found in bindings or environment configuration.";
  return ["| Network | Contract ID |", "|---|---|", ...entries.map(([network, address]) => `| ${network} | \`${address}\` |`)].join("\n");
}

function renderFunctionTable(functions: FunctionReference[]): string {
  if (functions.length === 0) return "No functions found.";
  return [
    "| Function | Params | Return | Auth required |",
    "|---|---|---|---|",
    ...functions.map((fn) => {
      const params = fn.params.length === 0 ? "None" : fn.params.map((param) => `\`${param.name}: ${param.type}\``).join("<br />");
      return `| \`${fn.name}\` | ${params} | \`${fn.returnType}\` | ${fn.authRequired} |`;
    }),
  ].join("\n");
}

function renderList(values: string[]): string {
  if (values.length === 0) return "None found in generated bindings.";
  return values.map((value) => `- \`${value}\``).join("\n");
}

function replaceBetweenMarkers(current: string, generated: string): string {
  const start = current.indexOf(startMarker);
  const end = current.indexOf(endMarker);

  if (start === -1 || end === -1 || end < start) {
    const insertionPoint = current.indexOf("\n## Deployment");
    if (insertionPoint === -1) {
      throw new Error(`Missing ${startMarker}/${endMarker} markers and could not find Deployment section.`);
    }
    return `${current.slice(0, insertionPoint).trimEnd()}\n\n${generated}\n${current.slice(insertionPoint)}`;
  }

  return `${current.slice(0, start).trimEnd()}\n\n${generated}\n\n${current.slice(end + endMarker.length).trimStart()}`;
}

function listFiles(dir: string, extension: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory() && !["node_modules", "dist", "target"].includes(entry)) {
      files.push(...listFiles(fullPath, extension));
    } else if (stat.isFile() && fullPath.endsWith(extension)) {
      files.push(fullPath);
    }
  }
  return files;
}

function normalizeType(type: string): string {
  return type.replace(/\s+/g, " ").replace(/^Promise<(.+)>$/, "$1").trim() || "void";
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

function toKebabCase(value: string): string {
  return toSnakeCase(value).replace(/_/g, "-");
}

main();
