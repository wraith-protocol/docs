#!/usr/bin/env node
/**
 * serve.mjs
 *
 * Static server for the docs preview used by the Playwright render tests.
 * It mirrors the production host's routing closely enough to be meaningful:
 * extensionless routes map to <route>.html and unknown routes return the
 * built 404 page with a 404 status.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const ROOT = path.resolve(process.env.PREVIEW_DIST || path.join(repoRoot, "preview-dist"));
const PORT = Number(process.env.PORT || 4174);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const relative = decoded.replace(/^\/+/, "");
  const candidate = path.normalize(path.join(ROOT, relative));

  if (!candidate.startsWith(ROOT)) return null;
  if (relative === "") return path.join(ROOT, "introduction.html");

  if (await isFile(candidate)) return candidate;
  if (await isFile(`${candidate}.html`)) return `${candidate}.html`;
  if (await isFile(path.join(candidate, "index.html"))) return path.join(candidate, "index.html");
  return null;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const redirect = url.pathname === "/README" ? "/introduction" : null;
    if (redirect) {
      res.writeHead(302, { Location: redirect }).end();
      return;
    }

    const filePath = await resolveFile(url.pathname);
    if (!filePath) {
      const body = await readFile(path.join(ROOT, "404.html"));
      res.writeHead(404, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Preview server error");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Docs preview listening on http://127.0.0.1:${PORT} (root: ${ROOT})`);
});
