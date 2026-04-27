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

describe("host watchdog clean-root entrypoint", () => {
  it("emits a no-alert dry-run snapshot", () => {
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
  });

  it("writes host watchdog receipt only when explicitly requested", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-host-watchdog-test-"));
    const receiptPath = path.join(repoRoot, "branches/_system/host_watchdog_state.json");
    fs.rmSync(receiptPath, { force: true });
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
    fs.rmSync(receiptPath, { force: true });
    try {
      fs.rmdirSync(path.dirname(receiptPath));
      fs.rmdirSync(path.dirname(path.dirname(receiptPath)));
    } catch {
      // Local scheduler state may coexist with this test receipt directory.
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });
});
