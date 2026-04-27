import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runPython(args: string[], options: { env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync("python3", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

describe("scheduler clean-root entrypoints", () => {
  it("exposes orchestrator status without Feishu/Lark or remote side effects", () => {
    const result = runPython(["lobster_orchestrator.py", "status", "--json"]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("scheduler_entrypoint_ready");
    expect(payload.boundary.noFeishuLarkSend).toBe(true);
    expect(payload.boundary.noRemoteFetch).toBe(true);
    expect(payload.boundary.noTradingExecution).toBe(true);
  });

  it("dry-runs the daily runner without requiring live cycle enablement", () => {
    const result = runPython(["daily_learning_runner.py", "--dry-run"]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("cycle_blocked_fail_closed");
    expect(payload.cycleMode).toBe("dry_run");
  });

  it("fails closed when a live cycle is requested without explicit enablement", () => {
    const result = runPython(["daily_learning_runner.py"], {
      env: { OPENCLAW_SCHEDULER_ENABLE_CYCLE: "" },
    });
    expect(result.status).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("cycle_blocked_fail_closed");
    expect(payload.reason).toContain("OPENCLAW_SCHEDULER_ENABLE_CYCLE=1");
  });

  it("runs an enabled cycle command and writes a bounded report receipt", () => {
    const reportPath = path.join(repoRoot, "branches/_system/scheduler_cycle_report.json");
    const failurePath = path.join(repoRoot, "branches/_system/scheduler_cycle_failure.json");
    fs.rmSync(reportPath, { force: true });
    fs.rmSync(failurePath, { force: true });
    const command = [
      "python3",
      "-c",
      JSON.stringify(
        "import json; print(json.dumps({'ok': True, 'scope': 'test_cycle', 'checks': [{'name': 'stub', 'ok': True, 'durationMs': 1}], 'liveTouched': False, 'providerConfigTouched': False, 'protectedMemoryTouched': False, 'remoteFetchOccurred': False, 'executionAuthorityGranted': False, 'summary': 'stub cycle passed'}))",
      ),
    ].join(" ");
    const result = runPython(["daily_learning_runner.py", "--write-receipt"], {
      env: {
        OPENCLAW_SCHEDULER_ENABLE_CYCLE: "1",
        OPENCLAW_SCHEDULER_CYCLE_COMMAND: command,
      },
    });
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("cycle_completed");
    expect(payload.cycleResult.scope).toBe("test_cycle");
    expect(payload.boundary.liveFeishuLarkSend).toBe(false);
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.existsSync(failurePath)).toBe(false);
    fs.rmSync(reportPath, { force: true });
  });

  it("writes receipts only when explicitly requested", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-scheduler-test-"));
    const heartbeatPath = path.join(repoRoot, "branches/_system/scheduler_heartbeat.json");
    const smokePath = path.join(repoRoot, "branches/_system/scheduler_cycle_smoke.json");
    fs.rmSync(heartbeatPath, { force: true });
    fs.rmSync(smokePath, { force: true });
    const result = runPython(["daily_learning_runner.py", "--dry-run", "--write-receipt"], {
      env: { HOME: tmpHome },
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(heartbeatPath)).toBe(true);
    expect(fs.existsSync(smokePath)).toBe(true);
    const heartbeat = JSON.parse(fs.readFileSync(heartbeatPath, "utf8"));
    const smoke = JSON.parse(fs.readFileSync(smokePath, "utf8"));
    expect(heartbeat.status).toBe("success");
    expect(smoke.status).toBe("cycle_blocked_fail_closed");
    fs.rmSync(heartbeatPath, { force: true });
    fs.rmSync(smokePath, { force: true });
    try {
      fs.rmdirSync(path.dirname(heartbeatPath));
      fs.rmdirSync(path.dirname(path.dirname(heartbeatPath)));
    } catch {
      // The scheduler state directory may contain unrelated local state.
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });
});
