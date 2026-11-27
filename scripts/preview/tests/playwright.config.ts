import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for the docs preview render and navigation tests.
 *
 * The preview is built from docs.json and the shipped .mdx pages and served
 * from 127.0.0.1, so the suite never contacts a live deployment or any other
 * external service. Both projects run the same specs at desktop and mobile
 * widths; failures are annotated with their route and navigation group.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], [path.join(__dirname, "reporter.ts")]],
  use: {
    baseURL: "http://127.0.0.1:4174",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    command: "node scripts/preview/build.mjs && node scripts/preview/serve.mjs",
    url: "http://127.0.0.1:4174/introduction",
    cwd: repoRoot,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
