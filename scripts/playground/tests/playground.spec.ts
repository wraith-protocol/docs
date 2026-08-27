import { expect, test } from "@playwright/test";

// Smoke test for the Wraith Stealth Playground. Covers the full guided flow
// (derive → send → scan → withdraw) and enforces the hard acceptance gate:
// zero requests to any non-local origin during any step.

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

function trackRequests(page) {
  const external = [];
  const local = [];
  page.on("request", (req) => {
    const host = new URL(req.url()).hostname;
    if (LOCAL_HOSTS.has(host)) local.push(req.url());
    else external.push(req.url());
  });
  return { external, local };
}

test("guided flow runs end to end with zero external requests", async ({ page }) => {
  const { external, local } = trackRequests(page);
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.goto("/index.html?step=derive");

  // CSP must allow only same-origin scripts/connect and nothing external.
  const csp = await page.evaluate(() => {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    return meta ? meta.getAttribute("content") : null;
  });
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("script-src 'self' 'unsafe-inline'");

  // Fixtures load from the same origin.
  await expect(page.locator("#fixtureTable tbody tr")).toHaveCount(5);
  expect(local.some((u) => u.includes("fixtures.json"))).toBe(true);

  // ── Step 1: Derive ──────────────────────────────────────
  await expect(page.locator("#panel-derive")).toBeVisible();
  await page.getByRole("button", { name: "Derive stealth keys" }).click();
  const metaAddress = await page.locator("#deriveResults .card-accent code").textContent();
  expect(metaAddress).toMatch(/^st:xlm:[0-9a-f]{128}$/);
  await expect(page.locator("#deriveResults")).toContainText(/spending scalar/i);

  // ── Step 2: Send ────────────────────────────────────────
  await page.locator("#stepper-send").click();
  await page.locator("#sendAmount").fill("10");
  await page.getByRole("button", { name: "Construct announcement" }).click();
  await expect(page.locator("#sendResults")).toContainText("added to the scan batch (now 1");
  const stealthAddress = await page.locator("#sendResults .card-accent code").first().textContent();
  expect(stealthAddress).toMatch(/^G[A-Z2-7]{55}$/);
  await expect(page.locator("#sendResults .code-block")).toContainText('"topic"');

  // ── Step 3: Scan ────────────────────────────────────────
  await page.locator("#stepper-scan").click();
  await page.locator("#loadFixture").click();
  await page.getByRole("button", { name: "Scan announcements" }).click();
  await expect(page.locator("#scanResults")).toContainText("3 matches found");
  await expect(page.locator("#scanResults .match-card")).toHaveCount(3);
  // The send-step announcement joins the batch and is also a match.
  await expect(page.locator("#scanResults")).toContainText("6 announcements");

  // ── Step 4: Withdraw ────────────────────────────────────
  await page.locator("#stepper-withdraw").click();
  await expect(page.locator("#withdrawResults")).toContainText("3 withdrawable stealth balance");
  await page.locator("#withdrawResults .withdraw-btn").first().click();
  await expect(page.locator("#withdrawResults .code-block").first()).toContainText("stealth private scalar");

  // ── Permalink ───────────────────────────────────────────
  await page.locator("#stepper-scan").click();
  await page.locator("#permalink-scan").click();
  await expect(page.locator("#permalink-scan")).toContainText("Copied");

  // ── Hard gate: zero external requests, no errors ────────
  expect(external).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter((t) => !t.includes("favicon"))).toEqual([]);
});

test("each step can be opened directly via its URL parameter", async ({ page }) => {
  const { external } = trackRequests(page);

  const cases = [
    { step: "derive", panel: "panel-derive", label: "Derive stealth keys" },
    { step: "send", panel: "panel-send", label: "Send a stealth payment" },
    { step: "scan", panel: "panel-scan", label: "Scan for incoming payments" },
    { step: "withdraw", panel: "panel-withdraw", label: "Withdraw to your wallet" },
  ];

  for (const { step, panel, label } of cases) {
    await page.goto(`/index.html?step=${step}`);
    await expect(page.locator(`#${panel}`)).toBeVisible();
    await expect(page.locator(`#stepper-${step}`)).toHaveClass(/active/);
    await expect(page.locator(`#${panel} h2`)).toContainText(label);
    await expect(page.locator(`#panel-${step}`)).not.toBeHidden();
  }

  expect(external).toEqual([]);
});
