// serve.mjs
// Minimal static file server for the playground tests. The playground must
// be served over HTTP (not file://) because module-style script loading and
// the CSP behave differently on file:// — see the maintainer's note on #134.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.normalize(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

// We serve the playground only, and always resolve to index.html for
// directory requests, mirroring how a docs host serves the static files.
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let filePath = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    if (filePath.endsWith("/") || path.extname(filePath) === "") {
      filePath = path.join(filePath, "index.html");
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Playground test server listening on http://127.0.0.1:${PORT}`);
});
