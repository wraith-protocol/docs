#!/usr/bin/env node
/**
 * serve-preview.mjs
 *
 * Static server for the deterministic docs preview. It resolves extensionless
 * documentation URLs to the generated .html files and serves the generated 404
 * page with a real 404 status, so the smoke tests exercise the same direct-load
 * and not-found paths a reader hits.
 *
 *   node scripts/preview/serve-preview.mjs
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const root = path.resolve(
  repoRoot,
  process.env.PREVIEW_DIR || "node_modules/.cache/docs-preview",
);
const port = Number(process.env.PREVIEW_PORT || 4174);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

async function fileExists(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

async function resolveRequest(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = path.normalize(decoded).replace(/^([/\\])+/, "");
  if (relative.startsWith("..")) return { status: 403 };
  const base = path.join(root, relative);

  const candidates = [];
  if (decoded.endsWith("/") || decoded === "/") {
    candidates.push(path.join(base, "index.html"));
  } else if (path.extname(base)) {
    candidates.push(base);
  } else {
    candidates.push(`${base}.html`, path.join(base, "index.html"));
  }

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return { status: 200, file: candidate };
  }
  return { status: 404, file: path.join(root, "404.html") };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const resolved = await resolveRequest(url.pathname);

  if (resolved.status === 403) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("Forbidden");
    return;
  }

  if (!(await fileExists(resolved.file))) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Preview is not built");
    return;
  }

  res.writeHead(resolved.status, {
    "Content-Type": MIME[path.extname(resolved.file)] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(resolved.file).pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Docs preview listening on http://127.0.0.1:${port} (root: ${path.relative(repoRoot, root)})`);
});
