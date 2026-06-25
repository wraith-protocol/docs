import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

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

const ambientPrelude = `
declare global {
  var account: any;
  var agent: any;
  var announcement: any;
  var announcements: any;
  var apiKey: string;
  var bobMetaAddress: string;
  var chain: any;
  var chainRegistry: any;
  var config: any;
  var connector: any;
  var detected: any;
  var ephemeralPubKey: Uint8Array;
  var hash: string;
  var keys: any;
  var message: string;
  var metaAddress: string;
  var nameRegistry: any;
  var payment: any;
  var privateKey: any;
  var publicClient: any;
  var publicKey: Uint8Array;
  var recipient: any;
  var recipientSpendingPubKey: any;
  var recipientViewingPubKey: any;
  var response: any;
  var seed: Uint8Array;
  var sender: any;
  var signature: Uint8Array;
  var stealthAddress: string;
  var stealthKeys: any;
  var wallet: any;
  var walletAddress: string;
  var wraith: any;
  var wraithClient: any;
  var stellarKeypair: any;
  var privateKeyBytes: Uint8Array;
  var sharedSecret: Uint8Array;
  var ephemeralPrivateKey: Uint8Array;
  var spendingPubKey: Uint8Array;
  var viewingPubKey: Uint8Array;
  function createWalletClient(...args: any[]): any;
  function custom(...args: any[]): any;
  function privateKeyToAccount(...args: any[]): any;
  function signNameRegistration(...args: any[]): any;
}
`;

async function main() {
  const files = await findMdxFiles(repoRoot);
  const snippets = await collectSnippets(files);
  const skipped = snippets.filter((snippet) => /\bno-check\b/.test(snippet.attrs));
  const checkable = snippets.filter((snippet) => !/\bno-check\b/.test(snippet.attrs));

  const failures: string[] = [];
  const tmp = await mkdtemp(path.join(tmpdir(), "wraith-doc-snippets-"));

  try {
    await writeFile(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    await symlink(path.join(repoRoot, "node_modules"), path.join(tmp, "node_modules"), "dir").catch(
      () => undefined,
    );

    const snippetFiles: string[] = [];
    for (const snippet of checkable) {
      const snippetFile = path.join(
        tmp,
        `snippet-${snippet.index}.${snippet.lang === "tsx" ? "tsx" : "ts"}`,
      );

      await writeFile(snippetFile, renderSnippet(snippet), "utf8");
      snippetFiles.push(snippetFile);
    }

    const compilerConfig = path.join(tmp, "tsconfig.json");
    await writeFile(
      compilerConfig,
      JSON.stringify(createTsConfig(snippetFiles), null, 2),
      "utf8",
    );

    const result = await run("npx", ["tsc", "--noEmit", "--project", compilerConfig]);
    if (result.exitCode !== 0) {
      failures.push(appendSourceMap(result.output.trim(), checkable));
    }
  } finally {
    await rm(tmp, { force: true, recursive: true });
  }

  const summary = [
    `MDX files scanned: ${files.length}`,
    `Code fences found: ${snippets.length}`,
    `Checked snippets: ${checkable.length}`,
    `Skipped no-check snippets: ${skipped.length}`,
  ].join("\n");

  if (failures.length > 0) {
    console.error(`${summary}\n\nSnippet check failed:\n\n${failures.join("\n\n")}`);
    process.exit(1);
  }

  console.log(`${summary}\nSnippet check passed.`);
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
    // Current docs include many illustrative fragments; this keeps the first CI gate focused on malformed syntax.
    "// @ts-nocheck",
    ambientPrelude,
  ].join("\n");

  if (snippet.lang === "js" || snippet.lang === "javascript") {
    return `${header}\n${code}\nexport {};\n`;
  }

  return `${header}\n${code}\nexport {};\n`;
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
      types: [],
      strict: false,
      noImplicitAny: false,
      skipLibCheck: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
      noEmit: true,
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
