import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHostWatchdogDryRunReport } from "../scripts/dev/live-sidecar-host-watchdog-dry-run.ts";

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

function writeHostWatchdogPlist(params: {
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
    <string>${params.root}/scripts/lobster_host_watchdog.py</string>
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

describe("live sidecar host watchdog dry-run", () => {
  it("reports target dependency gaps without touching live state", () => {
    const legacyRoot = makeTmpRoot("watchdog-legacy");
    const targetRoot = makeTmpRoot("watchdog-target");
    const plistDir = makeTmpRoot("watchdog-plist");
    const plistPath = path.join(plistDir, "ai.openclaw.lobster.host_watchdog.plist");

    writeFile(legacyRoot, "scripts/lobster_host_watchdog.py");
    writeFile(legacyRoot, "scripts/branch_freshness.py");
    writeFile(legacyRoot, "scripts/lobster_paths.py");
    writeHostWatchdogPlist({ root: legacyRoot, plistPath });

    const report = buildHostWatchdogDryRunReport({
      legacyRoot,
      targetRoot,
      plistPath,
      checkedAt: "2026-04-27T00:00:00.000Z",
    });

    expect(report.launchAgent.pointsAtLegacyRoot).toBe(true);
    expect(report.migrationReady).toBe(false);
    expect(report.blockedReasons).toContain(
      "target clean repo still lacks host watchdog dependency: scripts/lobster_host_watchdog.py, scripts/branch_freshness.py, scripts/lobster_paths.py",
    );
  });

  it("blocks migration when target watchdog files exist but are not tracked", () => {
    const legacyRoot = makeTmpRoot("watchdog-legacy-untracked");
    const targetRoot = makeTmpRoot("watchdog-target-untracked");
    const plistDir = makeTmpRoot("watchdog-plist-untracked");
    const plistPath = path.join(plistDir, "ai.openclaw.lobster.host_watchdog.plist");

    for (const relativePath of [
      "scripts/lobster_host_watchdog.py",
      "scripts/branch_freshness.py",
      "scripts/lobster_paths.py",
    ]) {
      writeFile(legacyRoot, relativePath);
      writeFile(targetRoot, relativePath);
    }
    writeHostWatchdogPlist({ root: legacyRoot, plistPath });

    const report = buildHostWatchdogDryRunReport({
      legacyRoot,
      targetRoot,
      plistPath,
      checkedAt: "2026-04-27T00:00:00.000Z",
    });

    expect(report.migrationReady).toBe(false);
    expect(report.blockedReasons).toContain(
      "target host watchdog dependency exists but is not tracked by Git: scripts/lobster_host_watchdog.py, scripts/branch_freshness.py, scripts/lobster_paths.py",
    );
  });
});
