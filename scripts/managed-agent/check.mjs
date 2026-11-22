import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { client } from './client.mjs';
import { cookbook } from './cookbook.mjs';

const consumer = process.argv[2];
const pages = [
  ['sdk/agent-client.mdx', 'client', fences => client(fences, false)],
  ['guides/single-chain-agent.mdx', 'single-chain', fences => client(fences, true)],
  ['guides/spectre-stellar-cookbook.mdx', 'cookbook', cookbook],
];

for (const [page, entry, generate] of pages) {
  const mdx = readFileSync(page, 'utf8');
  const fences = Array.from(mdx.matchAll(/^```(?:typescript|tsx|ts|javascript|js)\b[^\n]*\n([\s\S]*?)^```\s*$/gm),
    match => ({ code: match[1].trimEnd(), line: mdx.slice(0, match.index).split('\n').length }));
  if (!fences.length) throw new Error(`No examples found in ${page}`);
  const files = generate(fences);
  for (const [name, contents] of files) {
    writeFileSync(path.join(consumer, name), contents);
  }
  const tsc = path.join(consumer, 'node_modules/typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'ESNext', '--moduleResolution', 'Bundler', '--types', 'node',
    '--outDir', 'dist', ...files.keys()], { cwd: consumer, stdio: 'inherit' });
  execFileSync(process.execPath, [`dist/${entry}.js`], { cwd: consumer, stdio: 'inherit' });
  console.log(`Verified ${page} (${fences.length} examples)`);
}
