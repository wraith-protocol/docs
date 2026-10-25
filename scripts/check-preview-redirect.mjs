#!/usr/bin/env node
/**
 * check-preview-redirect.mjs
 *
 * Verifies that the Mintlify PR-preview environment redirects the legacy
 * /README path to /introduction, exercising the single redirect entry in
 * docs.json.
 *
 * Usage (CLI):
 *   MINTLIFY_PREVIEW_URL=https://… node scripts/check-preview-redirect.mjs
 *
 * The core validation is exported as `validatePreviewRedirect` so that
 * scripts/check-preview-redirect.test.mjs can exercise it against a local
 * mock server without requiring a live Mintlify deployment.
 */

/**
 * Validates a single redirect response.
 *
 * @param {string}   requestUrl   - The URL that was fetched (for error messages).
 * @param {number}   status       - HTTP status code returned by the server.
 * @param {string|null} location  - Value of the Location response header.
 * @param {string}   expectedPath - The pathname the redirect must point at.
 * @returns {{ ok: boolean; message: string }}
 */
export function validatePreviewRedirect(requestUrl, status, location, expectedPath) {
  if (status < 300 || status >= 400) {
    return {
      ok: false,
      message: `Expected ${requestUrl} to return a 3xx redirect; received ${status}.`,
    };
  }

  if (!location) {
    return {
      ok: false,
      message: `Expected ${requestUrl} to include a Location header; received none.`,
    };
  }

  const destination = new URL(location, requestUrl);
  if (destination.pathname !== expectedPath) {
    return {
      ok: false,
      message: `Expected ${requestUrl} to resolve to ${expectedPath}; Location was ${location}.`,
    };
  }

  return {
    ok: true,
    message: `Verified ${requestUrl} returns ${status} redirect to ${destination.pathname}.`,
  };
}

// ---------------------------------------------------------------------------
// CLI entry-point – only runs when the script is executed directly.
// ---------------------------------------------------------------------------
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (await import("node:url")).fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const previewUrl = process.env.MINTLIFY_PREVIEW_URL;

  if (!previewUrl) {
    // No preview URL supplied: there is nothing to verify, so this is a skip
    // rather than a failure. CI only requires the live check when a preview
    // URL is actually provided (see .github/workflows/snippets.yml).
    console.log(
      "MINTLIFY_PREVIEW_URL is not set — skipping the live preview redirect check.",
    );
    process.exit(0);
  }

  let baseUrl;
  try {
    baseUrl = new URL(previewUrl);
  } catch {
    console.error(`MINTLIFY_PREVIEW_URL is not a valid URL: ${previewUrl}`);
    process.exit(1);
  }

  if (!/^https?:$/.test(baseUrl.protocol)) {
    console.error("MINTLIFY_PREVIEW_URL must use HTTP or HTTPS.");
    process.exit(1);
  }

  const requestUrl = new URL("/README", baseUrl).toString();
  const response = await fetch(requestUrl, { redirect: "manual" });
  const location = response.headers.get("location");

  const result = validatePreviewRedirect(requestUrl, response.status, location, "/introduction");

  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }

  console.log(result.message);
}
