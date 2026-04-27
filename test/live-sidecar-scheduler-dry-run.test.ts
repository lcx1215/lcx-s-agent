import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSchedulerDryRunReport } from "../scripts/dev/live-sidecar-scheduler-dry-run.ts";

const tmpRoots: string[] = [];

function makeTmpRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-${label}-`));
  tmpRoots.push(root);
  return root;
}

function writeFile(root: string, relativePath: string, content = "") {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeSchedulerPlist(params: {
  root: string;
  plistPath: string;
  workingDirectory?: string;
}) {
  writeFile(
    path.dirname(params.plistPath),
    path.basename(params.plistPath),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>${params.root}/daily_learning_runner.py</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${params.workingDirectory ?? params.root}</string>
</dict>
</plist>
`,
  );
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("live sidecar scheduler dry-run", () => {
  it("reports target dependency gaps without touching live state", () => {
    const legacyRoot = makeTmpRoot("legacy");
    const targetRoot = makeTmpRoot("target");
    const plistDir = makeTmpRoot("plist");
    const plistPath = path.join(plistDir, "ai.openclaw.lobster.scheduler.plist");

    writeFile(legacyRoot, "daily_learning_runner.py");
    writeFile(legacyRoot, "scripts/lobster_paths.py");
    writeFile(legacyRoot, "lobster_orchestrator.py");
    writeFile(
      legacyRoot,
      "branches/_system/scheduler_heartbeat.json",
      JSON.stringify({ status: "success", last_exit_code: 0 }),
    );
    writeSchedulerPlist({ root: legacyRoot, plistPath });

    const report = buildSchedulerDryRunReport({
      legacyRoot,
      targetRoot,
      plistPath,
      checkedAt: "2026-04-27T00:00:00.000Z",
    });

    expect(report.mode).toBe("dry_run_no_launchagent_change_no_lark_send");
    expect(report.launchAgent.pointsAtLegacyRoot).toBe(true);
    expect(report.migrationReady).toBe(false);
    expect(report.blockedReasons).toContain(
      "target clean repo still lacks scheduler dependency: daily_learning_runner.py, scripts/lobster_paths.py, lobster_orchestrator.py",
    );
    expect(report.stateFiles[0]?.summary).toEqual({ status: "success", last_exit_code: 0 });
  });

  it("blocks migration when target files exist but are not tracked", () => {
    const legacyRoot = makeTmpRoot("legacy-ready");
    const targetRoot = makeTmpRoot("target-ready");
    const plistDir = makeTmpRoot("plist-ready");
    const plistPath = path.join(plistDir, "ai.openclaw.lobster.scheduler.plist");

    for (const relativePath of [
      "daily_learning_runner.py",
      "scripts/lobster_paths.py",
      "lobster_orchestrator.py",
    ]) {
      writeFile(legacyRoot, relativePath);
      writeFile(targetRoot, relativePath);
    }
    spawnSync("git", ["init"], { cwd: targetRoot, stdio: "ignore" });
    writeSchedulerPlist({ root: legacyRoot, plistPath });

    const report = buildSchedulerDryRunReport({
      legacyRoot,
      targetRoot,
      plistPath,
      checkedAt: "2026-04-27T00:00:00.000Z",
    });

    expect(report.migrationReady).toBe(false);
    expect(report.blockedReasons).toContain(
      "target scheduler dependency exists but is not tracked by Git: daily_learning_runner.py, scripts/lobster_paths.py, lobster_orchestrator.py",
    );
  });

  it("accepts a non-git runtime bundle target when files exist", () => {
    const legacyRoot = makeTmpRoot("legacy-runtime");
    const targetRoot = makeTmpRoot("target-runtime");
    const plistDir = makeTmpRoot("plist-runtime");
    const plistPath = path.join(plistDir, "ai.openclaw.lobster.scheduler.plist");

    for (const relativePath of [
      "daily_learning_runner.py",
      "scripts/lobster_paths.py",
      "lobster_orchestrator.py",
    ]) {
      writeFile(legacyRoot, relativePath);
      writeFile(targetRoot, relativePath);
    }
    writeSchedulerPlist({ root: legacyRoot, plistPath });

    const report = buildSchedulerDryRunReport({
      legacyRoot,
      targetRoot,
      plistPath,
      checkedAt: "2026-04-27T00:00:00.000Z",
    });

    expect(report.migrationReady).toBe(true);
    expect(report.targetRequiredFiles.every((file) => file.trackedByGit === null)).toBe(true);
  });
});
