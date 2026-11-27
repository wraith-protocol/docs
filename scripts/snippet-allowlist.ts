import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export type BypassCategory =
  | "output"
  | "pseudocode"
  | "framework-example"
  | "snippet-stub";

export interface AllowlistEntry {
  file: string;
  line: number;
  category: BypassCategory;
  reason: string;
  owner: string;
  expires: string;
}

export interface InventoryBypass {
  file: string;
  line: number;
  rawFence: string;
}

export interface ValidationFailure {
  type: "missing" | "expired" | "duplicated" | "stale" | "invalid-format";
  message: string;
  entry?: AllowlistEntry | InventoryBypass;
}

export const VALID_CATEGORIES = new Set<BypassCategory>([
  "output",
  "pseudocode",
  "framework-example",
  "snippet-stub",
]);

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates the bypass allowlist against the actual inventory of bypassed fences.
 *
 * Rules:
 * - Missing: Every fence marked with an inline bypass marker (e.g. `no-check`) must have an allowlist entry.
 * - Stale: Every allowlist entry must correspond to an actual bypassed code fence in MDX.
 * - Expired: Entry expires date must not be on or before referenceDate (YYYY-MM-DD).
 * - Duplicated: No duplicate entries for the same file and line.
 * - Schema: Valid category, non-empty reason, non-empty owner, valid ISO YYYY-MM-DD date.
 */
export function validateSnippetAllowlist(
  allowlist: AllowlistEntry[],
  actualBypasses: InventoryBypass[],
  referenceDate: string = new Date().toISOString().slice(0, 10),
): ValidationFailure[] {
  const failures: ValidationFailure[] = [];

  const allowlistKeys = new Map<string, AllowlistEntry>();
  const duplicateKeys = new Set<string>();

  for (const entry of allowlist) {
    // Check format
    if (!entry.file || typeof entry.file !== "string") {
      failures.push({
        type: "invalid-format",
        message: `Allowlist entry missing or invalid 'file': ${JSON.stringify(entry)}`,
        entry,
      });
      continue;
    }
    if (!Number.isInteger(entry.line) || entry.line <= 0) {
      failures.push({
        type: "invalid-format",
        message: `${entry.file}: invalid 'line' number: ${entry.line}`,
        entry,
      });
      continue;
    }
    if (!VALID_CATEGORIES.has(entry.category)) {
      failures.push({
        type: "invalid-format",
        message: `${entry.file}:${entry.line}: invalid category '${entry.category}'. Allowed categories: ${[...VALID_CATEGORIES].join(", ")}`,
        entry,
      });
    }
    if (!entry.reason || typeof entry.reason !== "string" || !entry.reason.trim()) {
      failures.push({
        type: "invalid-format",
        message: `${entry.file}:${entry.line}: missing or empty 'reason'`,
        entry,
      });
    }
    if (!entry.owner || typeof entry.owner !== "string" || !entry.owner.trim()) {
      failures.push({
        type: "invalid-format",
        message: `${entry.file}:${entry.line}: missing or empty 'owner'`,
        entry,
      });
    }
    if (!entry.expires || !DATE_REGEX.test(entry.expires) || Number.isNaN(Date.parse(entry.expires))) {
      failures.push({
        type: "invalid-format",
        message: `${entry.file}:${entry.line}: invalid 'expires' date format '${entry.expires}', expected YYYY-MM-DD`,
        entry,
      });
    } else if (entry.expires <= referenceDate) {
      failures.push({
        type: "expired",
        message: `${entry.file}:${entry.line}: bypass expired on ${entry.expires} (reference date: ${referenceDate})`,
        entry,
      });
    }

    const key = `${entry.file}:${entry.line}`;
    if (allowlistKeys.has(key)) {
      duplicateKeys.add(key);
      failures.push({
        type: "duplicated",
        message: `${entry.file}:${entry.line}: duplicate allowlist entry`,
        entry,
      });
    } else {
      allowlistKeys.set(key, entry);
    }
  }

  const actualKeys = new Map<string, InventoryBypass>();
  for (const bypass of actualBypasses) {
    const key = `${bypass.file}:${bypass.line}`;
    actualKeys.set(key, bypass);
  }

  // Missing: In actual bypasses but not in allowlist
  for (const [key, bypass] of actualKeys.entries()) {
    if (!allowlistKeys.has(key)) {
      failures.push({
        type: "missing",
        message: `${bypass.file}:${bypass.line}: code fence has bypass marker ('${bypass.rawFence.trim()}') but is not in the allowlist`,
        entry: bypass,
      });
    }
  }

  // Stale: In allowlist but not in actual bypasses
  for (const [key, entry] of allowlistKeys.entries()) {
    if (!actualKeys.has(key)) {
      failures.push({
        type: "stale",
        message: `${entry.file}:${entry.line}: stale allowlist entry (does not match any bypassed code fence)`,
        entry,
      });
    }
  }

  return failures;
}

export async function loadAllowlist(allowlistPath: string): Promise<AllowlistEntry[]> {
  const content = await readFile(allowlistPath, "utf8");
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected allowlist at ${allowlistPath} to be an array`);
  }
  return parsed as AllowlistEntry[];
}
