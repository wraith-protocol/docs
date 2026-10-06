import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import ts from "typescript";

type Snippet = {
  attrs: string;
  code: string;
  file: string;
  index: number;
  lang: string;
  line: number;
};

const repoRoot = process.cwd();
const checkableLanguages = new Set(["ts", "tsx", "typescript", "js", "javascript"]);
const ignoredDirs = new Set([".git", ".github", "node_modules", ".next", "dist", "build"]);

const typedPrelude = `
import {
  Wraith as __FixtureWraith,
  WraithAgent as __FixtureWraithAgent,
  Chain as __FixtureChain,
} from "@wraith-protocol/sdk";
import * as __FixtureStellarSdk from "@stellar/stellar-sdk";

import * as __fixtureEvm from "@wraith-protocol/sdk/chains/evm";
import * as __fixtureStellar from "@wraith-protocol/sdk/chains/stellar";
import * as __fixtureSolana from "@wraith-protocol/sdk/chains/solana";
import * as __fixtureCkb from "@wraith-protocol/sdk/chains/ckb";
declare global {
  var Chain: typeof __FixtureChain;
  var wraith: __FixtureWraith;
  var agent: __FixtureWraithAgent;
  var chain: __FixtureChain;
  var wallet: {
    signMessage(message: string | Uint8Array): Promise<string | Uint8Array>;
    address?: string;
    [key: string]: any;
  };
  var apiKey: string;
  var message: string;
  var signature: string;
  var metaAddress: string;
  var recipient: string;
  var stealthAddress: string;
  var seed: Uint8Array;
  var sharedSecret: Uint8Array;
  var ephemeralPubKey: Uint8Array;
  var spendingPubKey: Uint8Array;
  var viewingPubKey: Uint8Array;
  var privateKey: Uint8Array | string;
  var publicKey: Uint8Array;
  var stellarKeypair: any;
  var payment: any;
  var announcement: any;
  var announcements: any;
  var config: any;
  var connector: any;
  var db: any;
  var detected: any;
  var hash: string;
  var keys: any;
  var nameRegistry: any;
  var publicClient: any;
  var address: any;
  var setError: any;
  var recipientSpendingPubKey: any;
  var recipientViewingPubKey: any;
  var response: any;
  var sender: any;
  var stealthKeys: any;
  var walletAddress: string;
  var wraithClient: any;
  var privateKeyBytes: Uint8Array;
  var ephemeralPrivateKey: Uint8Array;
  var account: any;
  var chainRegistry: any;\n
  var parseEther: (value: string) => bigint;
  var stealth: __FixtureWraith;
  var server: __FixtureStellarSdk.rpc.Server;
  var walletClient: { sendTransaction: (tx: any) => Promise<string> };
  var YXLM_ISSUER: string;
  var USDC_ISSUER: string;
  var NETWORK_PASSPHRASE: string;
  var RPC_URL: string;
  var FUTURENET_PASSPHRASE: string;
  var rpc: typeof __FixtureStellarSdk.rpc;
  var TransactionBuilder: typeof __FixtureStellarSdk.TransactionBuilder;
  var Keypair: typeof __FixtureStellarSdk.Keypair;
  var Transaction: typeof __FixtureStellarSdk.Transaction;
  var xdr: typeof __FixtureStellarSdk.xdr;
  var senderAddress: string;
  var destinationAddress: string;
  var withdrawAmount: number;
  var amount: bigint;
  var authData: string;
  var clientData: string;
  var senderKeypair: __FixtureStellarSdk.Keypair;
  var callerKeypair: __FixtureStellarSdk.Keypair;
  var ownerKeypair: __FixtureStellarSdk.Keypair;
  var recipientKeys: any; // Fallback to any to avoid resolution errors
  var viewTag: number;
  var userMetaAddress: string;
  var usdcContractId: string;
  var txXdr: string;
  var signedXdr: string;
  var unsignedXdr: string;
  var withdrawalXdr: string;
  var rawTx: __FixtureStellarSdk.Transaction;
  var signedTx: __FixtureStellarSdk.Transaction;
  var simResult: __FixtureStellarSdk.rpc.Api.SimulateTransactionResponse;
  var userFacingSimError: (res: any) => string;
  var submitSignedTransaction: (tx: any) => Promise<any>;
  var buildAndPrepareContractCall: (params: any) => Promise<__FixtureStellarSdk.Transaction>;
  var generatePaymentLink: (params: any) => string;
  var deployment: any;
  var sorobanServer: __FixtureStellarSdk.rpc.Server;
  var horizon: __FixtureStellarSdk.Horizon.Server;
  var senderAccount: __FixtureStellarSdk.Account;
  var yxlmIssuer: string;
  var usdcIssuer: string;
  var matchedAnnouncement: any;
  var sigA: string;
  var sigB: string;
  var sigC: string;
  var sigFromA: __FixtureStellarSdk.xdr.DecoratedSignature;
  var sigFromB: __FixtureStellarSdk.xdr.DecoratedSignature;
  var sigFromC: __FixtureStellarSdk.xdr.DecoratedSignature;
  var NETWORK: any;
  var SOROSWAP_API_KEY: string;
  var soroswapRequest: any;
  var StellarSession: any;
  var restoreSession: any;
  var StellarWalletId: any;
  var STELLAR_WALLETS: any;
  var saveSession: any;
  var SESSION_KEY: string;
  var StealthRecipient: any;
  var Subscription: any;
  var customResolver: any;
  var EVMConnector: any;
  var getPriceWithLayeredFallback: any;
  var renderPriceWithSource: any;
  var formatFiatSmart: any;
  var build: any;

  
  // Fragments that omit imports still receive the real public API signatures.
  var deriveStealthKeys: typeof __fixtureEvm.deriveStealthKeys;
  var generateStealthAddress: typeof __fixtureEvm.generateStealthAddress;
  var checkStealthAddress: typeof __fixtureEvm.checkStealthAddress;
  var scanAnnouncements: typeof __fixtureEvm.scanAnnouncements;
  var deriveStealthPrivateKey: typeof __fixtureEvm.deriveStealthPrivateKey;
  var deriveStealthPrivateScalar: typeof __fixtureStellar.deriveStealthPrivateScalar;
  var encodeStealthMetaAddress: typeof __fixtureEvm.encodeStealthMetaAddress;
  var decodeStealthMetaAddress: typeof __fixtureEvm.decodeStealthMetaAddress;
  var signNameRegistration: typeof __fixtureEvm.signNameRegistration;
  var fetchAnnouncements: typeof __fixtureEvm.fetchAnnouncements;
  var getDeployment: typeof __fixtureEvm.getDeployment;
  var seedToScalar: typeof __fixtureStellar.seedToScalar;
  var computeSharedSecret: typeof __fixtureStellar.computeSharedSecret;
  var computeViewTag: typeof __fixtureStellar.computeViewTag;
  var hashToScalar: typeof __fixtureStellar.hashToScalar;
  var signWithScalar: typeof __fixtureStellar.signWithScalar;
  var signSolanaTransaction: typeof __fixtureSolana.signSolanaTransaction;
  var signStellarTransaction: typeof __fixtureStellar.signStellarTransaction;
  var pubKeyToSolanaAddress: typeof __fixtureSolana.pubKeyToSolanaAddress;
  var pubKeyToStellarAddress: typeof __fixtureStellar.pubKeyToStellarAddress;
  var bytesToHex: typeof __fixtureStellar.bytesToHex;
  var hexToBytes: typeof __fixtureStellar.hexToBytes;
  var STEALTH_SIGNING_MESSAGE: typeof __fixtureEvm.STEALTH_SIGNING_MESSAGE;
  var SCHEME_ID: typeof __fixtureEvm.SCHEME_ID;
  var META_ADDRESS_PREFIX: typeof __fixtureEvm.META_ADDRESS_PREFIX;

  function createWalletClient(...args: any[]): any;
  function custom(...args: any[]): any;
  function privateKeyToAccount(...args: any[]): any;
}
`;

async function main() {
  await verifyFailureFixture();

  const files = await findMdxFiles(repoRoot);
  const snippets = await collectSnippets(files);
  const typeChecked = snippets.filter(isTypedDocumentationSnippet);
  const failures: string[] = [];
  for (const snippet of snippets) {
    const rendered = renderSnippet(snippet);
    if (/^\s*\/\/\s*@ts-nocheck\b/m.test(rendered)) {
      failures.push(`${snippet.file}:${snippet.line}: rendered snippets must not disable TypeScript checking`);
    }

    const result = ts.transpileModule(rendered, {
      fileName: `snippet-${snippet.index}.${snippet.lang === "tsx" ? "tsx" : "ts"}`,
      compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    for (const diagnostic of result.diagnostics ?? []) {
      if (diagnostic.category === ts.DiagnosticCategory.Error) {
        failures.push(
          `${snippet.file}:${snippet.line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
        );
      }
    }
  }

  const tmp = await mkdtemp(path.join(repoRoot, ".wraith-doc-snippets-"));

  try {
    await writeFile(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }), "utf8");

    const snippetFiles: string[] = [];
    for (const snippet of typeChecked) {
      const snippetFile = path.join(
        tmp,
        `snippet-${snippet.index}.${snippet.lang === "tsx" ? "tsx" : "ts"}`,
      );

      await writeFile(snippetFile, renderSnippet(snippet), "utf8");
      snippetFiles.push(snippetFile);
    }

    const compilerConfig = path.join(tmp, "tsconfig.json");
    const ambientTypes = path.join(tmp, "ambient-types.d.ts");
    await writeFile(ambientTypes, "declare module \"*\";\n", "utf8");
    await writeFile(
      compilerConfig,
      JSON.stringify(createTsConfig([...snippetFiles, ambientTypes]), null, 2),
      "utf8",
    );

    const result = await runTsc(compilerConfig);
    if (result.exitCode !== 0) {
      failures.push(appendSourceMap(result.output.trim(), typeChecked));
    }
  } finally {
    await rm(tmp, { force: true, recursive: true });
  }

  const summary = [
    `MDX files scanned: ${files.length}`,
    `Code fences found: ${snippets.length}`,
    `Syntax-checked snippets: ${snippets.length}`,
    `Type-checked documentation snippets: ${typeChecked.length}`,
    `Prose fragments excluded from type checking: ${snippets.length - typeChecked.length}`,
  ].join("\n");

  if (failures.length > 0) {
    console.error(`${summary}\n\nSnippet check failed:\n\n${failures.join("\n\n")}`);
    process.exit(1);
  }

  console.log(`${summary}\nSnippet check passed.`);
}

async function verifyFailureFixture() {
  console.log("Verifying failure fixture (invalid SDK call)...");
  const tmp = await mkdtemp(path.join(repoRoot, ".wraith-failure-fixture-"));
  try {
    await writeFile(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }), "utf8");

    const invalidSnippetCode = `
import { Wraith } from "@wraith-protocol/sdk";
// Invalid SDK call: non-existent method / invalid config option
const w = new Wraith({ invalidConfigOption: true });
w.nonExistentMethod();
`;
    const snippetFile = path.join(tmp, "failure-fixture.ts");
    await writeFile(snippetFile, `${typedPrelude}\n${invalidSnippetCode}\nexport {};\n`, "utf8");

    const compilerConfig = path.join(tmp, "tsconfig.json");
    await writeFile(
      compilerConfig,
      JSON.stringify(createTsConfig([snippetFile]), null, 2),
      "utf8",
    );

    const result = await runTsc(compilerConfig);
    if (result.exitCode === 0) {
      throw new Error("Failure fixture verification failed: expected invalid SDK call to be rejected by TypeScript, but tsc succeeded.");
    }
    if (!result.output.includes("invalidConfigOption") || !result.output.includes("nonExistentMethod")) {
      throw new Error(`Failure fixture verification failed: TypeScript did not report both invalid SDK calls.\n${result.output}`);
    }
    console.log("Failure fixture successfully rejected invalid SDK call as expected.");
  } finally {
    await rm(tmp, { force: true, recursive: true });
  }
}

async function findMdxFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return ignoredDirs.has(entry.name) ? [] : findMdxFiles(fullPath);
      }
      return entry.isFile() && entry.name.endsWith(".mdx") ? [fullPath] : [];
    }),
  );

  return files.flat().sort();
}

async function collectSnippets(files: string[]): Promise<Snippet[]> {
  const snippets: Snippet[] = [];
  let index = 0;

  for (const file of files) {
    const markdown = await readFile(file, "utf8");
    const fencePattern = /^```([A-Za-z0-9_-]+)([^\n]*)\n([\s\S]*?)^```/gm;
    let match: RegExpExecArray | null;

    while ((match = fencePattern.exec(markdown)) !== null) {
      const lang = match[1].toLowerCase();
      if (!checkableLanguages.has(lang)) {
        continue;
      }

      snippets.push({
        attrs: match[2] ?? "",
        code: match[3],
        file: path.relative(repoRoot, file),
        index,
        lang,
        line: lineNumberAt(markdown, match.index),
      });
      index += 1;
    }
  }

  return snippets;
}

function renderSnippet(snippet: Snippet) {
  const code = normalizeSnippet(snippet.code);
  const header = [
    `// Source: ${snippet.file}:${snippet.line}`,
    typedPrelude,
  ].join("\n");

  if (snippet.lang === "js" || snippet.lang === "javascript") {
    return `${header}\n${code}\nexport {};\n`;
  }

  return `${header}\n${code}\nexport {};\n`;
}

function isTypedDocumentationSnippet(snippet: Snippet) {
  return !/(?:^|\s)no-check(?:\s|$)/i.test(snippet.attrs);
}

function runTsc(compilerConfig: string) {
  const tscEntrypoint = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  return run(process.execPath, [tscEntrypoint, "--noEmit", "--project", compilerConfig]);
}

function normalizeSnippet(code: string) {
  return code
    .replace(/^\s*\/\/\s*\.\.\.\s*$/gm, "")
    .replace(/^\s*\.\.\.\s*$/gm, "");
}

function createTsConfig(snippetFiles: string[]) {
  return {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022", "DOM"],
      jsx: "preserve",
      types: ["node"],
      typeRoots: [path.join(repoRoot, "node_modules/@types")],
      strict: false,
      noImplicitAny: false,
      skipLibCheck: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
      noEmit: true,
      baseUrl: repoRoot,
      paths: {
        "@wraith-protocol/sdk": ["node_modules/@wraith-protocol/sdk/dist/index.d.ts"],
        "@wraith-protocol/sdk/chains/evm": ["node_modules/@wraith-protocol/sdk/dist/chains/evm/index.d.ts"],
        "@wraith-protocol/sdk/chains/stellar": ["node_modules/@wraith-protocol/sdk/dist/chains/stellar/index.d.ts"],
        "@wraith-protocol/sdk/chains/solana": ["node_modules/@wraith-protocol/sdk/dist/chains/solana/index.d.ts"],
        "@wraith-protocol/sdk/chains/ckb": ["node_modules/@wraith-protocol/sdk/dist/chains/ckb/index.d.ts"],
        "@solana/web3.js": ["node_modules/@solana/web3.js"],
        "@stellar/stellar-sdk": ["node_modules/@stellar/stellar-sdk"]
      }
    },
    include: snippetFiles,
  };
}

function run(command: string, args: string[]) {
  return new Promise<{ exitCode: number; output: string }>((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      shell: false,
    });
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, output });
    });
  });
}

function appendSourceMap(output: string, snippets: Snippet[]) {
  const failedIndexes = Array.from(output.matchAll(/snippet-(\d+)\.(?:ts|tsx)/g))
    .map((match) => Number(match[1]))
    .filter((value, index, values) => Number.isInteger(value) && values.indexOf(value) === index)
    .sort((a, b) => a - b);

  if (failedIndexes.length === 0) {
    return output;
  }

  const snippetByIndex = new Map(snippets.map((snippet) => [snippet.index, snippet]));
  const sourceMap = failedIndexes
    .map((index) => {
      const snippet = snippetByIndex.get(index);
      return snippet
        ? `snippet-${index}: ${snippet.file}:${snippet.line} (${snippet.lang})`
        : `snippet-${index}: source not found`;
    })
    .join("\n");

  return `${output}\n\nSource map:\n${sourceMap}`;
}

function lineNumberAt(text: string, index: number) {
  return text.slice(0, index).split("\n").length;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
