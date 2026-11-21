import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// Playwright config for the deterministic docs preview. The preview is built
// from docs.json and the shipped .mdx pages, then served over HTTP so direct
// loads, client navigation, anchors, tabs, and the not-found path behave the
// same way they do on the deployed site.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");

export default defineConfig({
  testDir: ".",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(repoRoot, "playwright-report/preview"), open: "never" }],
  ],
  outputDir: path.join(repoRoot, "test-results/preview"),
  use: {
    baseURL: process.env.PREVIEW_BASE_URL || "http://127.0.0.1:4174",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/preview/build-preview.mjs && node scripts/preview/serve-preview.mjs",
    url: "http://127.0.0.1:4174/introduction",
    cwd: repoRoot,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      name: "mobile-chromium",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
