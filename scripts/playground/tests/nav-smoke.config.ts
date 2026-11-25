import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const PREVIEW_PORT = 4175;

// The nav smoke suite always runs against a disposable, locally built preview
// so CI never depends on a deployed Mintlify preview URL (issue #223). The
// webServer entry builds preview-dist from docs.json and the shipped .mdx
// pages, then serves it on 127.0.0.1.
export default defineConfig({
  testDir: ".",
  testMatch: "nav-smoke.spec.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: path.join(repoRoot, "test-results", "nav-smoke"),
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { browserName: "chromium", viewport: { width: 390, height: 844 } } },
  ],
  use: {
    baseURL: `http://127.0.0.1:${PREVIEW_PORT}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/preview/build.mjs && node scripts/preview/serve.mjs",
    url: `http://127.0.0.1:${PREVIEW_PORT}/introduction`,
    cwd: repoRoot,
    env: { ...process.env, PORT: String(PREVIEW_PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
