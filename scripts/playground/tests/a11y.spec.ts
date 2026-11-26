import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Accessibility and keyboard coverage for the Wraith Stealth Playground.
//
// The playground is embedded in docs pages, so it has to work for keyboard and
// assistive-technology users at desktop, 200% zoom, and mobile widths without a
// pointer. These tests complement playground.spec.ts (which covers the smoke
// flow and the zero-external-request gate) and enforce the issue #220
// acceptance criteria.
//
// Rule exceptions: none. The palette and markup are fixed rather than excluding
// axe rules, so any serious/critical violation is a failure.

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

async function analyze(page: Page, context: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  const summary = blocking
    .map((v) =>
      `${v.id} (${v.impact}) ${v.help}\n` +
      v.nodes.map((n) => `  ${n.target.join(" ")}: ${n.failureSummary}`).join("\n"),
    )
    .join("\n\n");
  expect(blocking, `${context}\n${summary}`).toEqual([]);
}

// Press Tab until the given element owns focus. This is deliberately keyboard
// only: no locator.click(), no programmatic focus(), no pointer events.
async function tabTo(page: Page, selector: string, maxTabs = 80) {
  const target = page.locator(selector).first();
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`Tab did not reach ${selector} within ${maxTabs} presses`);
}

async function assertNoHorizontalOverflow(page: Page, context: string) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    metrics.scrollWidth,
    `${context} must reflow without horizontal scrolling (${metrics.scrollWidth}px > ${metrics.clientWidth}px)`,
  ).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

// The whole guided flow, activated only with Tab and Enter/Space aside from
// typing the amount.
async function completeFlowWithKeyboard(page: Page) {
  await page.goto("/index.html");

  await tabTo(page, "#deriveBtn");
  await page.keyboard.press("Enter");
  await expect(page.locator("#deriveResults .card-accent")).toContainText("st:xlm:");

  await tabTo(page, "#stepper-send");
  await page.keyboard.press("Enter");
  // Activating a step moves focus to its heading.
  await expect(page.locator("#panel-send-title")).toBeFocused();
  await tabTo(page, "#sendAmount");
  await page.keyboard.type("10");
  await tabTo(page, "#constructBtn");
  await page.keyboard.press("Enter");
  await expect(page.locator("#sendResults")).toContainText("added to the scan batch");

  await tabTo(page, "#stepper-scan");
  await page.keyboard.press("Enter");
  await tabTo(page, "#loadFixture");
  await page.keyboard.press("Enter");
  await tabTo(page, "#scanBtn");
  await page.keyboard.press("Enter");
  await expect(page.locator("#scanResults [role='status']")).toContainText("matches found");

  await tabTo(page, "#stepper-withdraw");
  await page.keyboard.press("Enter");
  await expect(page.locator("#withdrawResults")).toContainText("withdrawable stealth balance");
  await tabTo(page, ".withdraw-btn");
  await page.keyboard.press("Enter");
  await expect(page.locator("#withdrawResults .code-block").first()).toContainText(
    "stealth private scalar",
  );
}

test("no serious or critical axe violations across the guided flow", async ({ page }) => {
  await page.goto("/index.html?step=derive");
  await analyze(page, "derive step");

  await page.locator("#deriveBtn").click();
  await expect(page.locator("#deriveResults .card-accent")).toBeVisible();
  await analyze(page, "derive results");

  await page.locator("#stepper-send").click();
  await page.locator("#sendAmount").fill("10");
  await page.locator("#constructBtn").click();
  await expect(page.locator("#sendResults .card-accent")).toBeVisible();
  // Expand the event JSON so the scrollable code region is exposed.
  await page.locator("#sendResults details summary").click();
  await analyze(page, "send results");

  await page.locator("#stepper-scan").click();
  await page.locator("#loadFixture").click();
  await page.locator("#scanBtn").click();
  await expect(page.locator("#scanResults .match-card")).toHaveCount(3);
  // Expand the announcement table so its caption and headers are scanned.
  await page.locator("#panel-scan details.fixture-section summary").click();
  await analyze(page, "scan results");

  await page.locator("#stepper-withdraw").click();
  await expect(page.locator("#withdrawResults .withdraw-btn")).toHaveCount(3);
  await page.locator("#withdrawResults .withdraw-btn").first().click();
  await analyze(page, "withdraw results");
});

test("no serious or critical axe violations at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/index.html?step=derive");
  await page.locator("#deriveBtn").click();
  await expect(page.locator("#deriveResults .card-accent")).toBeVisible();
  await analyze(page, "derive results at 360px");

  await page.locator("#stepper-scan").click();
  await page.locator("#loadFixture").click();
  await page.locator("#scanBtn").click();
  // The fixture batch alone matches twice; the Send step adds the third.
  await expect(page.locator("#scanResults .match-card")).toHaveCount(2);
  await analyze(page, "scan results at 360px");
});

test("every cryptographic input and select has an accessible name", async ({ page }) => {
  await page.goto("/index.html?step=derive");
  await expect(page.getByLabel(/Wallet signature/)).toBeVisible();

  await page.locator("#stepper-send").click();
  await expect(page.getByLabel(/Recipient meta-address/)).toBeVisible();
  await expect(page.getByLabel("Asset")).toHaveValue("XLM");
  await expect(page.getByLabel("Amount")).toBeVisible();

  await page.locator("#stepper-scan").click();
  await expect(page.getByLabel(/Stealth meta-address/)).toBeVisible();
  await expect(page.getByLabel(/Viewing key/)).toBeVisible();
  await expect(page.getByLabel(/Spending scalar/)).toBeVisible();

  await page.locator("#stepper-withdraw").click();
  await expect(page.getByLabel(/Destination wallet/)).toBeVisible();

  // Errors are associated with the input they describe, not just global text.
  await page.locator("#stepper-derive").click();
  await expect(page.locator("#sigInput")).toHaveAttribute("aria-describedby", "sigError");
  await expect(page.locator("#sendMeta")).toHaveAttribute("aria-describedby", "sendMetaError");
  await expect(page.locator("#scanVk")).toHaveAttribute("aria-describedby", "scanVkError");
});

test("tab order follows the visual order of the stepper and derive panel", async ({ page }) => {
  await page.goto("/index.html?step=derive");
  await page.locator("#stepper-derive").focus();

  for (const id of [
    "stepper-send",
    "stepper-scan",
    "stepper-withdraw",
    "sigInput",
    "deriveBtn",
    "reset-derive",
    "permalink-derive",
  ]) {
    await page.keyboard.press("Tab");
    await expect(page.locator(`#${id}`)).toBeFocused();
  }
});

test("stepper exposes the current step and moves focus to its heading", async ({ page }) => {
  await page.goto("/index.html?step=derive");
  await expect(page.locator("#stepper-derive")).toHaveAttribute("aria-current", "step");
  await expect(page.locator("#stepper-send")).not.toHaveAttribute("aria-current", "step");

  await page.locator("#stepper-scan").click();
  await expect(page.locator("#stepper-scan")).toHaveAttribute("aria-current", "step");
  await expect(page.locator("#stepper-derive")).not.toHaveAttribute("aria-current", "step");
  await expect(page.locator("#panel-scan-title")).toBeFocused();
});

test("invalid signature moves focus, announces the error, and keeps the input", async ({
  page,
}) => {
  await page.goto("/index.html?step=derive");
  await page.locator("#sigInput").fill("abc123");
  await page.locator("#deriveBtn").click();

  await expect(page.locator("#sigInput")).toBeFocused();
  await expect(page.locator("#sigInput")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#sigInput")).toHaveValue("abc123");
  await expect(page.locator("#sigError")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("128 hex characters");
  await expect(page.locator("#deriveResults")).toHaveText("");
});

test("scan errors focus the first invalid field and preserve all input", async ({ page }) => {
  await page.goto("/index.html?step=scan");
  await expect(page.locator("#scanVk")).toHaveValue(/^[0-9a-f]{64}$/);

  await page.locator("#scanMeta").fill("not-a-meta-address");
  await page.locator("#scanVk").fill("zz");
  await page.locator("#scanScalar").fill("not-a-number");
  await page.locator("#scanBtn").click();

  await expect(page.locator("#scanMeta")).toBeFocused();
  await expect(page.locator("#scanMeta")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#scanVk")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#scanScalar")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#scanVk")).toHaveValue("zz");
  await expect(page.locator("#scanScalar")).toHaveValue("not-a-number");
  await expect(page.locator("#scanMetaError")).toContainText(
    "Meta-address must start with st:xlm:",
  );
  await expect(page.locator("#scanResults")).toHaveText("");
});

test("result statuses and copy actions announce through live regions", async ({ page }) => {
  await page.goto("/index.html?step=derive");
  await page.locator("#deriveBtn").click();
  await expect(page.locator("#deriveResults [role='status']")).toContainText("Keys derived");

  await page.locator("#copyMetaBtn").click();
  await expect(page.locator("#copyMetaBtn")).toContainText("Copied ✓");
  await expect(page.locator("#liveRegion")).toHaveText(
    "Stealth meta-address copied to clipboard.",
  );

  await page.locator("#permalink-derive").click();
  await expect(page.locator("#liveRegion")).toHaveText("Permalink copied to clipboard.");
  await expect(page.locator("#permalink-derive")).toContainText("Copied ✓");

  await page.locator("#stepper-scan").click();
  await page.locator("#loadFixture").click();
  await page.locator("#scanBtn").click();
  const scanStatus = page.locator("#scanResults [role='status']");
  await expect(scanStatus).toContainText("matches found");
  await expect(scanStatus).toHaveAttribute("aria-atomic", "true");
});

test("reduced motion disables the scanning pulse", async ({ page }) => {
  await page.goto("/index.html?step=derive");

  const normal = await page.evaluate(() => {
    const dot = document.createElement("span");
    dot.className = "dot dot-scanning";
    document.body.appendChild(dot);
    const name = getComputedStyle(dot).animationName;
    dot.remove();
    return name;
  });
  expect(normal).toBe("pulse");

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await page.evaluate(() => {
    const dot = document.createElement("span");
    dot.className = "dot dot-scanning";
    document.body.appendChild(dot);
    const style = getComputedStyle(dot);
    const result = { name: style.animationName, duration: style.animationDuration };
    dot.remove();
    return result;
  });
  expect(reduced.name).toBe("none");
  expect(parseFloat(reduced.duration)).toBeLessThanOrEqual(0.01);
});

test("critical flow works with the keyboard at 200% zoom and mobile width", async ({ page }) => {
  for (const viewport of [
    { width: 640, height: 512, label: "200% zoom (640x512 CSS px)" },
    { width: 360, height: 740, label: "mobile width (360x740 CSS px)" },
  ]) {
    await page.setViewportSize(viewport);
    await completeFlowWithKeyboard(page);
    await assertNoHorizontalOverflow(page, viewport.label);
  }
});
