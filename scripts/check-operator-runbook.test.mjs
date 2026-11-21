import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const script = path.join(repoRoot, "scripts", "check-operator-runbook.mjs");

test("operator runbook check exits 0", () => {
  const r = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    cwd: repoRoot,
    env: { ...process.env, OPERATOR_RUNBOOK_PORT: "18799" },
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test("operator runbook check prints skipped destructive steps with safety reasons", () => {
  const r = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    cwd: repoRoot,
    env: { ...process.env, OPERATOR_RUNBOOK_PORT: "18800" },
  });
  assert.match(r.stdout, /SKIP:/);
  assert.match(r.stdout, /safety:/);
});
