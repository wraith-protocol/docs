#!/usr/bin/env node
/**
 * check-operator-runbook.mjs
 *
 * Executes safe subsets of the commands documented in the operator runbooks
 * (guides/ops/self-hosted-deployment.mdx and guides/ops/monitoring-and-on-call.mdx)
 * against disposable local fixtures. Destructive or privileged commands are
 * NOT executed; they are reported as skipped with the exact safety reason.
 *
 * Acceptance (issue #221):
 *  - CI runs commands in documented order.
 *  - Same environment variable names and paths readers see.
 *  - Missing tools/files/flags/stale endpoints fail with source page + line.
 *  - No live network secret or production mutation.
 *
 * Required tools are hard requirements: a missing tool is a failure, never a
 * skip, because the runbook tells readers to run that command.
 *
 * Run: node scripts/check-operator-runbook.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const repoRoot = process.cwd();
const PORT = Number(process.env.OPERATOR_RUNBOOK_PORT || 18765);
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE_DIR = path.join(repoRoot, "scripts", "fixtures", "operator-runbook");

const MONITORING_PAGE = "guides/ops/monitoring-and-on-call.mdx";
const DEPLOYMENT_PAGE = "guides/ops/self-hosted-deployment.mdx";

let failures = [];
let skipped = [];
const log = (msg) => console.log(msg);

function fail(msg) { failures.push(msg); console.error("  FAIL: " + msg); }
function ok(msg) { console.log("  ok: " + msg); }
function skip(reason) { skipped.push(reason); console.log("  SKIP: " + reason); }

/**
 * Resolve the source page and 1-based line for a command or path so every
 * failure points at what a reader would be following (issue #221).
 */
function locate(page, needle) {
  try {
    const lines = readFileSync(path.join(repoRoot, page), "utf8").split(/\r?\n/);
    const index = lines.findIndex((line) => line.includes(needle));
    if (index !== -1) return `${page}:${index + 1}`;
  } catch {
    // Fall back to the page name; the missing file is reported separately.
  }
  return page;
}

function failAt(page, needle, message) {
  fail(`${locate(page, needle)}: ${message}`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd: repoRoot, ...opts });
  return r;
}

function commandExists(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0;
}

async function main() {
  console.log("Operator runbook command check");
  console.log("Port:", PORT);

  // ---- 1. Tool availability (missing tools must fail, not skip) ----
  const requiredTools = [
    { tool: "curl", page: MONITORING_PAGE, needle: "curl https://horizon-futurenet.stellar.org/" },
    { tool: "grep", page: MONITORING_PAGE, needle: 'grep "RPC timeout"' },
    { tool: "cat", page: MONITORING_PAGE, needle: "cat stellar/deployments/futurenet.json" },
    { tool: "jq", page: MONITORING_PAGE, needle: "jq '.contracts'" },
    { tool: "promtool", page: MONITORING_PAGE, needle: "promtool check rules" },
  ];
  const availableTools = new Set();
  for (const { tool, page, needle } of requiredTools) {
    if (commandExists(tool)) {
      availableTools.add(tool);
      ok(`tool present: ${tool}`);
    } else {
      failAt(page, needle, `missing required tool '${tool}' — the documented command cannot run`);
    }
  }

  // ---- 2. File existence (paths readers see) ----
  const requiredFiles = [
    "guides/ops/alerts/wraith-alerts.yml",
    "guides/ops/dashboards/rpc-health.json",
    "guides/ops/self-hosted-deployment.mdx",
    "guides/ops/monitoring-and-on-call.mdx",
  ];
  for (const f of requiredFiles) {
    const full = path.join(repoRoot, f);
    if (!existsSync(full)) {
      const needle = path.basename(f);
      const page = f.startsWith("guides/ops/self-hosted") ? MONITORING_PAGE : DEPLOYMENT_PAGE;
      failAt(page, needle, `referenced path '${f}' does not exist on disk`);
    } else {
      ok(`path exists: ${f}`);
    }
  }
  // fixture manifest path readers see (deployment manifest)
  const manifestPath = path.join(FIXTURE_DIR, "futurenet.json");
  if (!existsSync(manifestPath)) {
    failAt(DEPLOYMENT_PAGE, "stellar/deployments/futurenet.json", `fixture manifest missing: ${manifestPath}`);
  } else {
    ok("fixture manifest present");
  }

  // ---- 3. Start disposable health endpoint ----
  const serverProc = spawn(process.execPath, [path.join(FIXTURE_DIR, "health-server.mjs")], {
    env: { ...process.env, OPERATOR_RUNBOOK_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  // wait for readiness
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const r = run("curl", ["-sS", `${BASE}/health`]);
    if (r.status === 0 && r.stdout.includes("ok")) { ready = true; break; }
    await sleep(200);
  }
  if (!ready) failAt(MONITORING_PAGE, "curl https://horizon-futurenet.stellar.org/", `disposable health endpoint not reachable at ${BASE}/health`);
  else ok(`health endpoint ready at ${BASE}/health`);

  // ---- 4. Execute safe commands in documented order ----

  // Playbook 1: RPC Outage diagnosis — health check (safe)
  {
    const r = run("curl", ["-sS", `${BASE}/health`]);
    if (r.status !== 0 || !r.stdout.includes("ok")) {
      failAt(MONITORING_PAGE, "curl https://horizon-futurenet.stellar.org/", "Playbook 1 health check failed");
    } else ok("Playbook 1: curl health endpoint succeeded");
  }

  // Playbook 2: Horizon Backpressure — headers (safe, localhost)
  {
    const r = run("curl", ["-sSI", `${BASE}/health`]);
    if (r.status !== 0) {
      failAt(MONITORING_PAGE, "curl -I https://horizon-futurenet.stellar.org/", "Playbook 2 header check failed");
    } else ok("Playbook 2: curl -I health endpoint succeeded");
  }

  // Metrics endpoint (dashboard import uses localhost:3000; we use disposable port)
  {
    const r = run("curl", ["-sS", `${BASE}/metrics`]);
    if (r.status !== 0 || !r.stdout.includes("wraith_rpc_latency_seconds")) {
      failAt(MONITORING_PAGE, "wraith_rpc_latency_seconds", "metrics endpoint missing expected metric");
    } else ok("metrics endpoint exposes wraith_rpc_latency_seconds");
  }

  // Prometheus rules validation (documented command)
  if (availableTools.has("promtool")) {
    const r = run("promtool", ["check", "rules", "guides/ops/alerts/wraith-alerts.yml"]);
    if (r.status !== 0) {
      failAt(
        MONITORING_PAGE,
        "promtool check rules",
        `promtool check rules failed: ${String(r.stderr || r.stdout || r.error || "").slice(0, 200)}`,
      );
    } else ok("promtool check rules guides/ops/alerts/wraith-alerts.yml -> SUCCESS");
  }

  // Dashboard import command uses guides/ops/dashboards/rpc-health.json (verify exists)
  {
    const r = run("cat", ["guides/ops/dashboards/rpc-health.json"]);
    if (r.status !== 0) {
      failAt(MONITORING_PAGE, "guides/ops/dashboards/rpc-health.json", "dashboard file unreadable");
    } else ok("dashboard file readable: guides/ops/dashboards/rpc-health.json");
  }

  // Contract manifest verification (safe read)
  {
    const rel = path.relative(repoRoot, manifestPath);
    const r = run("cat", [rel]);
    if (r.status !== 0 || !r.stdout.includes("futurenet")) {
      failAt(DEPLOYMENT_PAGE, "stellar/deployments/futurenet.json", "deployment manifest read failed");
    } else ok("deployment manifest readable with network=futurenet");
  }

  // Log grep (safe)
  {
    const logRel = path.relative(repoRoot, path.join(FIXTURE_DIR, "wraith-app.log"));
    const r = run("grep", ["RPC timeout", logRel]);
    if (r.status !== 0) {
      failAt(MONITORING_PAGE, 'grep "RPC timeout"', "grep RPC timeout in log failed");
    } else ok("grep 'RPC timeout' in fixture log succeeded");
  }

  // jq parse manifest (required tool; absence already failed above)
  if (availableTools.has("jq")) {
    const rel = path.relative(repoRoot, manifestPath);
    const r = run("jq", [".contracts", rel]);
    if (r.status !== 0) {
      failAt(MONITORING_PAGE, "jq '.contracts'", "jq parse of manifest failed");
    } else ok("jq parsed deployment manifest contracts");
  }

  // ---- 5. Skipped destructive/privileged steps with exact reasons ----
  skip("stellar account fund / contract deploy / contract invoke — destructive, requires funded keypair and network mutation; simulated only (safety: production mutation)");
  skip("./deploy.sh futurenet ... — destructive deployment; dry-run variant validated by shell-command checker only (safety: spends funds)");
  skip("systemctl restart wraith-indexer/wraith-watcher — privileged host operation; not runnable in disposable fixture (safety: host mutation)");
  skip("stellar contract invoke set_admin/pause — privileged; requires admin key (safety: authorization)");
  skip("traceroute / iostat — may require privileges and network; skipped (safety: host/network)");

  // ---- 6. Teardown ----
  try { serverProc.kill("SIGTERM"); } catch {}
  await sleep(200);

  // ---- 7. Result ----
  console.log("");
  console.log(`Skipped destructive steps: ${skipped.length}`);
  for (const s of skipped) console.log("  - " + s);
  console.log(`Failures: ${failures.length}`);

  if (failures.length > 0) {
    console.error("\nOperator runbook check FAILED:");
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }
  console.log("\nOperator runbook check passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
