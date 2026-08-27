import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// Playwright config for the Wraith Stealth Playground smoke tests.
// The playground is served over HTTP (not file://) because module script
// loading and CSP behave differently on file://.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    headless: true,
  },
  webServer: {
    command: "node scripts/playground/tests/serve.mjs",
    url: "http://127.0.0.1:4173/index.html",
    cwd: repoRoot,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
