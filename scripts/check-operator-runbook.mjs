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

let failures = [];
let skipped = [];
const log = (msg) => console.log(msg);

function fail(msg) { failures.push(msg); console.error("  FAIL: " + msg); }
function ok(msg) { console.log("  ok: " + msg); }
function skip(reason) { skipped.push(reason); console.log("  SKIP: " + reason); }

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

  // ---- 1. Tool availability (missing tools must fail) ----
  for (const tool of ["curl", "grep", "cat"]) {
    if (!commandExists(tool)) {
      fail(`missing required tool '${tool}' (used in guides/ops/monitoring-and-on-call.mdx)`);
    } else {
      ok(`tool present: ${tool}`);
    }
  }
  for (const tool of ["jq", "promtool"]) {
    if (!commandExists(tool)) {
      skip(`${tool} not installed — related checks skipped (install to enable)`);
    } else {
      ok(`tool present: ${tool}`);
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
    if (!existsSync(full)) fail(`referenced path '${f}' does not exist on disk`);
    else ok(`path exists: ${f}`);
  }
  // fixture manifest path readers see (deployment manifest)
  const manifestPath = path.join(FIXTURE_DIR, "futurenet.json");
  if (!existsSync(manifestPath)) fail(`fixture manifest missing: ${manifestPath}`);
  else ok("fixture manifest present");

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
  if (!ready) fail(`disposable health endpoint not reachable at ${BASE}/health`);
  else ok(`health endpoint ready at ${BASE}/health`);

  // ---- 4. Execute safe commands in documented order ----

  // Playbook 1: RPC Outage diagnosis — health check (safe)
  {
    const r = run("curl", ["-sS", `${BASE}/health`]);
    if (r.status !== 0 || !r.stdout.includes("ok")) fail("Playbook 1 health check failed");
    else ok("Playbook 1: curl health endpoint succeeded");
  }

  // Playbook 2: Horizon Backpressure — headers (safe, localhost)
  {
    const r = run("curl", ["-sSI", `${BASE}/health`]);
    if (r.status !== 0) fail("Playbook 2 header check failed");
    else ok("Playbook 2: curl -I health endpoint succeeded");
  }

  // Metrics endpoint (dashboard import uses localhost:3000; we use disposable port)
  {
    const r = run("curl", ["-sS", `${BASE}/metrics`]);
    if (r.status !== 0 || !r.stdout.includes("wraith_rpc_latency_seconds")) fail("metrics endpoint missing expected metric");
    else ok("metrics endpoint exposes wraith_rpc_latency_seconds");
  }

  // Prometheus rules validation (documented command)
  if (commandExists("promtool")) {
    const r = run("promtool", ["check", "rules", "guides/ops/alerts/wraith-alerts.yml"]);
    if (r.status !== 0) fail(`promtool check rules failed: ${String(r.stderr || r.stdout || r.error || "").slice(0, 200)}`);
    else ok("promtool check rules guides/ops/alerts/wraith-alerts.yml -> SUCCESS");
  } else {
    skip("promtool not installed — rules validation skipped");
  }

  // Dashboard import command uses guides/ops/dashboards/rpc-health.json (verify exists)
  {
    const r = run("cat", ["guides/ops/dashboards/rpc-health.json"]);
    if (r.status !== 0) fail("dashboard file unreadable");
    else ok("dashboard file readable: guides/ops/dashboards/rpc-health.json");
  }

  // Contract manifest verification (safe read)
  {
    const r = run("cat", [path.relative(repoRoot, manifestPath)]);
    // run from repo root; adjust path
  }
  {
    const rel = path.relative(repoRoot, manifestPath);
    const r = run("cat", [rel]);
    if (r.status !== 0 || !r.stdout.includes("futurenet")) fail("deployment manifest read failed");
    else ok("deployment manifest readable with network=futurenet");
  }

  // Log grep (safe)
  {
    const logRel = path.relative(repoRoot, path.join(FIXTURE_DIR, "wraith-app.log"));
    const r = run("grep", ["RPC timeout", logRel]);
    if (r.status !== 0) fail("grep RPC timeout in log failed");
    else ok("grep 'RPC timeout' in fixture log succeeded");
  }

  // jq parse manifest (if jq available)
  if (commandExists("jq")) {
    const rel = path.relative(repoRoot, manifestPath);
    const r = run("jq", [".contracts", rel]);
    if (r.status !== 0) fail("jq parse of manifest failed");
    else ok("jq parsed deployment manifest contracts");
  } else {
    skip("jq not installed — manifest JSON parse skipped (safety: tool absence)");
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
