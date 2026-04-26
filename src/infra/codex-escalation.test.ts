import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWatchtowerArtifactDir,
  parseCodexEscalationArtifact,
} from "../hooks/bundled/lobster-brain-registry.js";
import {
  shouldEscalateOperationalIssueToCodex,
  writeAndMaybeDispatchCodexEscalation,
} from "./codex-escalation.js";

const tempDirs: string[] = [];

async function makeWorkspaceDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-escalation-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("codex escalation", () => {
  it("keeps the category gate bounded to real repair categories", () => {
    expect(shouldEscalateOperationalIssueToCodex("write_edit_failure")).toBe(true);
    expect(shouldEscalateOperationalIssueToCodex("artifact_integrity")).toBe(true);
    expect(shouldEscalateOperationalIssueToCodex("provider_degradation")).toBe(false);
  });

  it("writes a packet even when no wake command is configured", async () => {
    const workspaceDir = await makeWorkspaceDir();

    const result = await writeAndMaybeDispatchCodexEscalation({
      workspaceDir,
      category: "write_edit_failure",
      issueKey: "abc123",
      source: "correction-loop",
      severity: "medium",
      foundationTemplate: "execution-hygiene",
      occurrences: 2,
      lastSeen: "2026-04-02T10:00:00.000Z",
      repairTicketPath: "bank/watchtower/repair-tickets/abc123.md",
      anomalyRecordPath: "bank/watchtower/anomalies/write_edit_failure-abc123.json",
      problem: "file save kept failing",
      evidenceLines: ["attempt=2", "surface=control_room"],
      impactLine: "write path is blocked",
      suggestedScopeLine: "smallest-safe-patch only",
      generatedAt: "2026-04-02T10:00:00.000Z",
      env: {},
    });

    expect(result.commandStatus).toBe("disabled");

    const content = await fs.readFile(path.join(workspaceDir, result.packetPath), "utf-8");
    const parsed = parseCodexEscalationArtifact(content);
    expect(parsed).toBeTruthy();
    expect(parsed?.category).toBe("write_edit_failure");
    expect(parsed?.issueKey).toBe("abc123");
    expect(parsed?.repairTicketPath).toBe("bank/watchtower/repair-tickets/abc123.md");
    expect(parsed?.anomalyRecordPath).toBe(
      "bank/watchtower/anomalies/write_edit_failure-abc123.json",
    );
  });

  it("dispatches the operator-configured wake command with packet metadata", async () => {
    const workspaceDir = await makeWorkspaceDir();
    const unref = vi.fn();
    const spawnImpl = vi.fn(() => ({ unref }) as never);

    const result = await writeAndMaybeDispatchCodexEscalation({
      workspaceDir,
      category: "artifact_integrity",
      issueKey: "def456",
      source: "fundamental.snapshot",
      severity: "medium",
      foundationTemplate: "general",
      occurrences: 3,
      lastSeen: "2026-04-02T11:00:00.000Z",
      repairTicketPath: "bank/watchtower/repair-tickets/artifact_integrity-def456.md",
      problem: "snapshot json stayed malformed",
      evidenceLines: ["manifest=foo", "stage=snapshot"],
      impactLine: "fundamental flow is blocked",
      suggestedScopeLine: "smallest-safe-patch only",
      generatedAt: "2026-04-02T11:00:00.000Z",
      env: {
        OPENCLAW_CODEX_ESCALATION_COMMAND: "echo wake-codex",
      },
      spawnImpl,
    });

    expect(result.commandStatus).toBe("dispatched");
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [command, argv, options] = spawnImpl.mock.calls[0] ?? [];
    if (process.platform === "win32") {
      expect(command).toBe("cmd.exe");
      expect(argv).toEqual(["/d", "/s", "/c", "echo wake-codex"]);
    } else {
      expect(command).toBe("/bin/sh");
      expect(argv).toEqual(["-lc", "echo wake-codex"]);
    }
    expect(options.cwd).toBe(workspaceDir);
    expect(options.env.OPENCLAW_CODEX_ESCALATION_CATEGORY).toBe("artifact_integrity");
    expect(options.env.OPENCLAW_CODEX_ESCALATION_ISSUE_KEY).toBe("def456");
    expect(options.env.OPENCLAW_CODEX_ESCALATION_PACKET_PATH).toContain(
      buildWatchtowerArtifactDir("codexEscalations"),
    );
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
