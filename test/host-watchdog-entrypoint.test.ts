import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runPython(args: string[]) {
  return spawnSync("python3", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });
}

function writeState(name: string, payload: unknown) {
  const filePath = path.join(repoRoot, "branches/_system", name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function cleanupState(...names: string[]) {
  for (const name of names) {
    fs.rmSync(path.join(repoRoot, "branches/_system", name), { force: true });
  }
}

describe("host watchdog clean-root entrypoint", () => {
  it("emits a no-alert dry-run snapshot", () => {
    writeState("scheduler_cycle_report.json", {
      status: "cycle_completed",
      generatedAt: new Date().toISOString(),
      cycleResult: {
        checkCount: 5,
        checks: [
          { name: "finance-pipeline-all", ok: true },
          { name: "finance-multi-candidate", ok: true },
          { name: "finance-event-review", ok: true },
          { name: "lark-brain-language-loop", ok: true },
          { name: "lark-routing-and-distillation-tests", ok: true },
        ],
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
        remoteFetchOccurred: false,
        executionAuthorityGranted: false,
      },
    });
    cleanupState("scheduler_cycle_failure.json");
    const result = runPython([
      "scripts/lobster_host_watchdog.py",
      "--dry-run",
      "--skip-launchd",
      "--json",
    ]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.mode).toBe("dry_run_no_alert");
    expect(payload.boundary.noFeishuLarkSend).toBe(true);
    expect(payload.boundary.noCodexEscalation).toBe(true);
    expect(payload.boundary.noRemoteFetch).toBe(true);
    expect(payload.boundary.noTradingExecution).toBe(true);
    expect(payload.scheduler_cycle.status).toBe("fresh");
    cleanupState("scheduler_cycle_report.json");
  });

  it("writes host watchdog receipt only when explicitly requested", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-host-watchdog-test-"));
    const receiptPath = path.join(repoRoot, "branches/_system/host_watchdog_state.json");
    fs.rmSync(receiptPath, { force: true });
    writeState("scheduler_cycle_report.json", {
      status: "cycle_completed",
      generatedAt: new Date().toISOString(),
      cycleResult: {
        checkCount: 5,
        checks: [
          { name: "finance-pipeline-all", ok: true },
          { name: "finance-multi-candidate", ok: true },
          { name: "finance-event-review", ok: true },
          { name: "lark-brain-language-loop", ok: true },
          { name: "lark-routing-and-distillation-tests", ok: true },
        ],
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
        remoteFetchOccurred: false,
        executionAuthorityGranted: false,
      },
    });
    const result = spawnSync(
      "python3",
      [
        "scripts/lobster_host_watchdog.py",
        "--dry-run",
        "--skip-launchd",
        "--write-receipt",
        "--json",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, HOME: tmpHome },
      },
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    expect(receipt.boundary.noFeishuLarkSend).toBe(true);
    expect(receipt.scheduler_cycle.status).toBe("fresh");
    fs.rmSync(receiptPath, { force: true });
    cleanupState("scheduler_cycle_report.json");
    try {
      fs.rmdirSync(path.dirname(receiptPath));
      fs.rmdirSync(path.dirname(path.dirname(receiptPath)));
    } catch {
      // Local scheduler state may coexist with this test receipt directory.
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("flags scheduler cycle boundary violations", () => {
    writeState("scheduler_cycle_report.json", {
      status: "cycle_completed",
      generatedAt: new Date().toISOString(),
      cycleResult: {
        checkCount: 5,
        checks: [{ name: "finance-pipeline-all", ok: true }],
        liveTouched: true,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
        remoteFetchOccurred: false,
        executionAuthorityGranted: false,
      },
    });
    cleanupState("scheduler_cycle_failure.json");

    const result = runPython([
      "scripts/lobster_host_watchdog.py",
      "--dry-run",
      "--skip-launchd",
      "--json",
    ]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.scheduler_cycle.status).toBe("boundary_violation");
    expect(payload.issues).toContain("scheduler_cycle");
    cleanupState("scheduler_cycle_report.json");
  });
});
