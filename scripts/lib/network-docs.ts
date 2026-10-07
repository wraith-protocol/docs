/**
 * Network-documentation validation helpers.
 *
 * Extracts environment-variable blocks and network connection tables from the
 * MDX guides, then validates them against a canonical network registry and runs
 * placeholder-normalised shell syntax checks — never executing a command, so no
 * real transaction can ever be sent from CI.
 */

/** Canonical passphrases, endpoints and contract placeholders per network. */
export const NETWORK_REGISTRY = {
  testnet: {
    passphrase: "Test SDF Network ; September 2015",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    friendbotUrl: "https://friendbot.stellar.org?addr=<G_ADDRESS>",
    contractsLive: true,
  },
  futurenet: {
    passphrase: "Test SDF Future Network ; October 2022",
    horizonUrl: null,
    rpcUrl: "https://rpc-futurenet.stellar.org",
    friendbotUrl: "https://friendbot-futurenet.stellar.org?addr=<G_ADDRESS>",
    contractsLive: false,
  },
  mainnet: {
    passphrase: "Public Global Stellar Network ; September 2015",
    horizonUrl: "https://horizon.stellar.org",
    rpcUrl: null,
    friendbotUrl: null,
    contractsLive: false,
  },
} as const;

export type NetworkName = keyof typeof NETWORK_REGISTRY;

/** Documented environment variables the network guides are allowed to define. */
export const KNOWN_ENV_VARS = [
  "STELLAR_NETWORK",
  "STELLAR_NETWORK_PASSPHRASE",
  "STELLAR_HORIZON_URL",
  "STELLAR_RPC_URL",
  "STELLAR_ANNOUNCER_CONTRACT_ID",
  "STELLAR_NAMES_CONTRACT_ID",
  "STELLAR_REGISTRY_CONTRACT_ID",
  "STELLAR_SENDER_CONTRACT_ID",
] as const;

/** Environment variable -> the registry field it must agree with. */
const ENV_TO_REGISTRY_FIELD: Record<string, keyof (typeof NETWORK_REGISTRY)["testnet"]> = {
  STELLAR_NETWORK_PASSPHRASE: "passphrase",
  STELLAR_HORIZON_URL: "horizonUrl",
  STELLAR_RPC_URL: "rpcUrl",
};

const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;
const PLACEHOLDER_RE = /^C?PLACEHOLDER[_-]?[A-Z0-9_]*$/i;

export type Severity = "error" | "warning" | "info";

export type Finding = {
  severity: Severity;
  code: string;
  file: string;
  line: number;
  message: string;
};

export type EnvAssignment = {
  name: string;
  value: string;
  file: string;
  line: number;
  blockIndex: number;
};

export type CommandLine = {
  command: string;
  file: string;
  line: number;
};

export type DocSection = {
  file: string;
  env: EnvAssignment[];
  commands: CommandLine[];
  /** Passphrase/URL values read from `| Property | Value |` connection tables. */
  tableValues: Array<{ property: string; value: string; line: number }>;
};

export function isPlaceholder(value: string): boolean {
  const trimmed = value.trim().replace(/^["']|["']$/g, "");
  if (trimmed === "") return true;
  if (PLACEHOLDER_RE.test(trimmed)) return true;
  // Angle-bracket/ellipsis tokens such as <YOUR_API_KEY> or MAINNET_****
  if (/[<>]/.test(trimmed)) return true;
  if (/[*]{2,}/.test(trimmed)) return true;
  if (/\.\.\./.test(trimmed)) return true;
  return false;
}

/** Strip the quoting a markdown table or shell block may add around a value. */
function stripQuotes(value: string): string {
  let trimmed = value.trim();
  // Inline code spans inside connection tables, e.g. `Test SDF Network ; ...`
  if (trimmed.startsWith("`") && trimmed.endsWith("`") && trimmed.length >= 2) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * True while a shell fragment has an unterminated single or double quote, i.e.
 * the logical command continues onto the next documented line.
 */
export function hasUnbalancedQuotes(text: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\" && quote !== "'") {
      i += 1;
      continue;
    }
    if (quote === null && (char === '"' || char === "'")) {
      quote = char;
      continue;
    }
    if (quote !== null && char === quote) {
      quote = null;
    }
  }
  return quote !== null;
}

/**
 * Extract fenced ```bash/```sh/```shell blocks, returning every `KEY=value`
 * assignment and every non-assignment, non-comment command line.
 */
export function extractSection(file: string, markdown: string): DocSection {
  const section: DocSection = { file, env: [], commands: [], tableValues: [] };
  const lines = markdown.split("\n");

  let inFence = false;
  let fenceLang = "";
  let blockIndex = -1;
  let pending = "";
  let pendingStart = 0;

  const flushPending = () => {
    const command = pending.trim();
    if (command) {
      section.commands.push({ command, file, line: pendingStart });
    }
    pending = "";
  };

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const fence = raw.match(/^```(\S*)\s*$/);

    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceLang = fence[1] ?? "";
        blockIndex += 1;
      } else {
        flushPending();
        inFence = false;
        fenceLang = "";
      }
      return;
    }

    // Connection tables live outside fenced blocks.
    if (!inFence) {
      const row = raw.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/);
      if (row) {
        const property = row[1].trim();
        const value = stripQuotes(row[2].trim());
        if (/passphrase|url|endpoint/i.test(property) && value && !/^-+$/.test(value)) {
          section.tableValues.push({ property, value, line: lineNo });
        }
      }
      return;
    }

    if (!/^(bash|sh|shell|zsh)$/i.test(fenceLang)) return;

    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const assignment = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (assignment) {
      flushPending();
      section.env.push({
        name: assignment[1],
        value: stripQuotes(assignment[2]),
        file,
        line: lineNo,
        blockIndex,
      });
      return;
    }

    if (!pending) pendingStart = lineNo;
    // A trailing backslash continues the same logical command, and so does an
    // unterminated quote — as in a multi-line `curl -d '{ ... }'` payload.
    pending += raw.endsWith("\\") ? `${raw.slice(0, -1)} ` : `${raw} `;
    if (!raw.endsWith("\\") && !hasUnbalancedQuotes(pending)) flushPending();
  });

  flushPending();
  return section;
}

/** Validate the names of documented environment variables. */
export function validateEnvNames(sections: DocSection[]): Finding[] {
  const findings: Finding[] = [];
  const known = new Set<string>(KNOWN_ENV_VARS);

  for (const section of sections) {
    for (const assignment of section.env) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(assignment.name)) {
        findings.push({
          severity: "error",
          code: "ENV_NAME_FORMAT",
          file: assignment.file,
          line: assignment.line,
          message: `"${assignment.name}" is not a valid upper-snake-case environment variable name.`,
        });
        continue;
      }

      if (assignment.name.startsWith("STELLAR_") && !known.has(assignment.name)) {
        // Unrecognised names are reported but tolerated: guides legitimately
        // document deployment-specific variables (fallback endpoints, secrets).
        findings.push({
          severity: "warning",
          code: "ENV_NAME_UNRECOGNISED",
          file: assignment.file,
          line: assignment.line,
          message: `"${assignment.name}" is not a core registry variable — confirm it is intentional.`,
        });
      }
    }
  }

  return findings;
}

/** Cross-check documented passphrases/URLs against the registry. */
export function validateAgainstRegistry(sections: DocSection[]): Finding[] {
  const findings: Finding[] = [];

  for (const section of sections) {
    for (const assignment of section.env) {
      if (assignment.name === "STELLAR_NETWORK") {
        const value = assignment.value.trim().toLowerCase();
        if (!(value in NETWORK_REGISTRY)) {
          findings.push({
            severity: "error",
            code: "NETWORK_UNKNOWN",
            file: assignment.file,
            line: assignment.line,
            message: `STELLAR_NETWORK="${assignment.value}" is not one of ${Object.keys(NETWORK_REGISTRY).join(", ")}.`,
          });
        }
        continue;
      }

      const field = ENV_TO_REGISTRY_FIELD[assignment.name];
      if (!field) continue;

      const network = resolveBlockNetwork(section, assignment.blockIndex);
      if (!network) {
        findings.push({
          severity: "info",
          code: "NETWORK_UNDECLARED",
          file: assignment.file,
          line: assignment.line,
          message: `Cannot verify ${assignment.name} — the surrounding block does not set STELLAR_NETWORK.`,
        });
        continue;
      }

      if (isPlaceholder(assignment.value)) continue;

      const expected = NETWORK_REGISTRY[network][field];
      if (expected === null) {
        findings.push({
          severity: "info",
          code: "REGISTRY_NO_ENDPOINT",
          file: assignment.file,
          line: assignment.line,
          message: `${assignment.name} is provider-dependent on ${network}; no registry value to compare.`,
        });
        continue;
      }

      if (assignment.value !== expected) {
        findings.push({
          severity: "error",
          code: "REGISTRY_MISMATCH",
          file: assignment.file,
          line: assignment.line,
          message: `${assignment.name} is "${assignment.value}" but the ${network} registry value is "${expected}".`,
        });
      }
    }

    // Connection tables must quote the registry passphrase verbatim.
    for (const entry of section.tableValues) {
      if (!/passphrase/i.test(entry.property)) continue;
      const known: string[] = Object.values(NETWORK_REGISTRY).map((n) => n.passphrase);
      if (!known.includes(entry.value)) {
        findings.push({
          severity: "error",
          code: "REGISTRY_PASSPHRASE_UNKNOWN",
          file: section.file,
          line: entry.line,
          message: `Documented passphrase "${entry.value}" does not match any registered Stellar network.`,
        });
      }
    }
  }

  return findings;
}

/** The network declared by the env block a value belongs to, if any. */
export function resolveBlockNetwork(
  section: DocSection,
  blockIndex: number,
): NetworkName | null {
  const declared = section.env.find(
    (assignment) => assignment.blockIndex === blockIndex && assignment.name === "STELLAR_NETWORK",
  );
  if (!declared) return null;
  const value = declared.value.trim().toLowerCase();
  return value in NETWORK_REGISTRY ? (value as NetworkName) : null;
}

/**
 * Neutralise documented placeholders so a syntax-only `bash -n` check does not
 * mistake `<YOUR_API_KEY>` for a shell redirection.
 */
export function normalisePlaceholders(command: string): string {
  return command
    .replace(/<[^<>\s]*>/g, "PLACEHOLDER")
    .replace(/\.\.\.[A-Za-z0-9_]*/g, "PLACEHOLDER")
    .replace(/\*{2,}/g, "PLACEHOLDER");
}

export type SyntaxChecker = (command: string) => string | null;

/** Run the injected syntax checker over every extracted command. */
export function checkCommandSyntax(
  sections: DocSection[],
  check: SyntaxChecker,
): Finding[] {
  const findings: Finding[] = [];

  for (const section of sections) {
    for (const { command, line } of section.commands) {
      const error = check(normalisePlaceholders(command));
      if (error) {
        findings.push({
          severity: "error",
          code: "COMMAND_SYNTAX",
          file: section.file,
          line,
          message: `Shell syntax error in documented command: ${error}`,
        });
      }
    }
  }

  return findings;
}

/**
 * Report the same variable documented with conflicting, non-placeholder values.
 * Comparing is scoped per network so that documenting `testnet` in one guide and
 * `mainnet` in another is not mistaken for a conflict.
 */
export function findConflicts(sections: DocSection[]): Finding[] {
  const findings: Finding[] = [];
  const seen = new Map<string, EnvAssignment>();

  for (const section of sections) {
    for (const assignment of section.env) {
      if (isPlaceholder(assignment.value)) continue;
      const network = resolveBlockNetwork(section, assignment.blockIndex) ?? "unscoped";
      const key = `${network}::${assignment.name}`;
      const previous = seen.get(key);
      if (!previous) {
        seen.set(key, assignment);
        continue;
      }
      if (previous.value === assignment.value) continue;

      findings.push({
        severity: "warning",
        code: "ENV_VALUE_CONFLICT",
        file: assignment.file,
        line: assignment.line,
        message: `${assignment.name} is "${assignment.value}" here but "${previous.value}" in ${previous.file}:${previous.line} (both scope ${network}).`,
      });
    }
  }

  return findings;
}

const LAST_VERIFIED_RE = /<!--\s*Last verified:\s*(\d{4}-\d{2}-\d{2})\.?/i;

/** Flag `Last verified` stamps older than `maxAgeDays`. */
export function findStaleStamps(
  files: Array<{ file: string; markdown: string }>,
  now: Date,
  maxAgeDays = 120,
): Finding[] {
  const findings: Finding[] = [];

  for (const { file, markdown } of files) {
    const match = markdown.match(LAST_VERIFIED_RE);
    if (!match) continue;

    const verified = new Date(`${match[1]}T00:00:00Z`);
    if (Number.isNaN(verified.getTime())) continue;

    const ageDays = Math.floor((now.getTime() - verified.getTime()) / 86_400_000);
    if (ageDays > maxAgeDays) {
      findings.push({
        severity: "warning",
        code: "STALE_VERIFICATION",
        file,
        line: markdown.slice(0, match.index ?? 0).split("\n").length,
        message: `Last verified ${match[1]} — ${ageDays} days old (limit ${maxAgeDays}). Re-run the generator and re-verify.`,
      });
    }
  }

  return findings;
}

/** True when a document is a Stellar network guide worth validating. */
export function looksLikeNetworkDoc(markdown: string): boolean {
  return /\bSTELLAR_NETWORK\b/.test(markdown) || /Network passphrase/i.test(markdown);
}

export function formatFinding(finding: Finding): string {
  const label = finding.severity.toUpperCase().padEnd(7);
  return `${label} ${finding.file}:${finding.line} [${finding.code}] ${finding.message}`;
}

export function summarise(findings: Finding[]): Record<Severity, number> {
  return {
    error: findings.filter((f) => f.severity === "error").length,
    warning: findings.filter((f) => f.severity === "warning").length,
    info: findings.filter((f) => f.severity === "info").length,
  };
}
