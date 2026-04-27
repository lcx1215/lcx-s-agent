import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import { createHookEvent } from "../../hooks.js";
import type { HookHandler } from "../../hooks.js";
import {
  buildCorrectionNoteFilename,
  buildOperatingWeeklyArtifactFilename,
  buildWatchtowerArtifactDir,
  parsePortfolioAnswerScorecardArtifact,
  renderCodexEscalationArtifact,
} from "../lobster-brain-registry.js";

let handler: HookHandler;
let suiteWorkspaceRoot = "";
let workspaceCaseCounter = 0;

async function createCaseWorkspace(prefix = "case"): Promise<string> {
  const dir = path.join(suiteWorkspaceRoot, `${prefix}-${workspaceCaseCounter}`);
  workspaceCaseCounter += 1;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-operating-weekly-"));
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  suiteWorkspaceRoot = "";
  workspaceCaseCounter = 0;
});

function makeConfig(tempDir: string): OpenClawConfig {
  return {
    agents: { defaults: { workspace: tempDir } },
  } satisfies OpenClawConfig;
}

async function runReset(tempDir: string, isoTime = "2026-03-26T15:00:00.000Z") {
  const sessionsDir = path.join(tempDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionFile = await writeWorkspaceFile({
    dir: sessionsDir,
    name: "weekly-session.jsonl",
    content: "",
  });
  const event = createHookEvent("command", "reset", "agent:main:main", {
    cfg: makeConfig(tempDir),
    previousSessionEntry: {
      sessionId: "weekly-123",
      sessionFile,
    },
  });
  event.timestamp = new Date(isoTime);
  await handler(event);
}

describe("operating-weekly-review hook", () => {
  it("writes one weekly review from correction notes, repair tickets, and companion weekly notes", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const memoryDir = path.join(tempDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: buildCorrectionNoteFilename({
        dateStr: "2026-03-24",
        issueKey: "abcd1234",
        timeSlug: "120000-000Z",
      }),
      content: [
        "# Correction Note: 2026-03-24 12:00:00 UTC",
        "",
        "- **Issue Key**: abcd1234",
        "",
        "## Foundation Template",
        "- outcome-review",
        "",
        "## What Was Wrong",
        "- freshness discipline was too weak in control room",
        "",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-W13-learning-weekly-review.md",
      content: "# Weekly Learning Review",
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-W13-frontier-methods-weekly-review.md",
      content: "# Weekly Frontier Review",
    });

    const ticketsDir = path.join(tempDir, buildWatchtowerArtifactDir("repairTickets"));
    await fs.mkdir(ticketsDir, { recursive: true });
    await writeWorkspaceFile({
      dir: ticketsDir,
      name: "abcd1234.md",
      content: [
        "# Repair Ticket Candidate: abcd1234",
        "",
        "- **Category**: provider_or_freshness",
        "- **Issue Key**: abcd1234",
        "- **Foundation Template**: outcome-review",
        "- **Occurrences**: 2",
        "- **Last Seen**: 2026-03-25 15:00:00 UTC",
        "- **Session Key**: agent:main:main",
        "",
        "## Problem",
        "- freshness discipline still slips during broad overview requests",
        "",
        "## Evidence",
        "- repeated operator correction detected (2 occurrences)",
        "",
        "## Impact",
        "- user-facing trust or operating reliability is at risk if this issue keeps recurring",
        "",
        "## Suggested Scope",
        "- smallest-safe-patch only; do not broaden providers, memory architecture, or doctrine without explicit approval",
        "",
      ].join("\n"),
    });
    const anomaliesDir = path.join(tempDir, buildWatchtowerArtifactDir("anomalies"));
    await fs.mkdir(anomaliesDir, { recursive: true });
    await writeWorkspaceFile({
      dir: anomaliesDir,
      name: "provider_degradation-1234abcd.json",
      content: JSON.stringify(
        {
          version: 1,
          generatedAt: "2026-03-25T15:00:00.000Z",
          firstSeenAt: "2026-03-24T15:00:00.000Z",
          lastSeenAt: "2026-03-25T15:00:00.000Z",
          occurrenceCount: 2,
          severity: "medium",
          category: "provider_degradation",
          source: "feishu.monitor.startup",
          foundationTemplate: "risk-transmission",
          problem: "startup bot-info probe timed out",
          impact: "startup health was degraded",
          suggestedScope: "smallest-safe-patch only",
          evidence: ["account=alpha"],
          fingerprint: "1234abcd",
        },
        null,
        2,
      ),
    });
    const codexDir = path.join(tempDir, buildWatchtowerArtifactDir("codexEscalations"));
    await fs.mkdir(codexDir, { recursive: true });
    await writeWorkspaceFile({
      dir: codexDir,
      name: "write_edit_failure-abcd1234.md",
      content: renderCodexEscalationArtifact({
        titleValue: "write_edit_failure",
        category: "write_edit_failure",
        issueKey: "abcd1234",
        source: "correction-loop",
        severity: "medium",
        foundationTemplate: "execution-hygiene",
        occurrences: 2,
        lastSeen: "2026-03-25T15:30:00.000Z",
        repairTicketPath: "bank/watchtower/repair-tickets/abcd1234.md",
        anomalyRecordPath: "bank/watchtower/anomalies/provider_degradation-1234abcd.json",
        problem: "file-save failure kept recurring",
        evidenceLines: ["attempt=2", "surface=control_room"],
        impactLine: "repair loop still cannot land the file write cleanly",
        suggestedScopeLine: "smallest-safe-patch only",
        generatedAt: "2026-03-25T15:30:00.000Z",
      }),
    });

    await runReset(tempDir);

    const files = await fs.readdir(memoryDir);
    const expectedWeeklyFile = buildOperatingWeeklyArtifactFilename(
      "2026-W13",
      "lobster-weekly-review",
    );
    const expectedScorecardFile = buildOperatingWeeklyArtifactFilename(
      "2026-W13",
      "portfolio-answer-scorecard",
    );
    const weeklyFile = files.find((name) => name === expectedWeeklyFile);
    const scorecardFile = files.find((name) => name === expectedScorecardFile);
    expect(weeklyFile).toBe(expectedWeeklyFile);
    expect(scorecardFile).toBe(expectedScorecardFile);

    const content = await fs.readFile(path.join(memoryDir, weeklyFile!), "utf-8");
    const scorecardContent = await fs.readFile(path.join(memoryDir, scorecardFile!), "utf-8");
    const parsedScorecard = parsePortfolioAnswerScorecardArtifact(scorecardContent);
    expect(content).toContain("# Lobster Weekly Review: 2026-W13");
    expect(content).toContain("**Active Codex Escalations**: 1");
    expect(content).toContain(
      "correction abcd1234: freshness discipline was too weak in control room",
    );
    expect(content).toContain("## Drift Areas By Foundation");
    expect(content).toContain("outcome-review: 1 correction note");
    expect(content).toContain("provider_or_freshness / abcd1234");
    expect(content).toContain(
      "provider_degradation / feishu.monitor.startup: startup bot-info probe timed out (foundation risk-transmission, occurrences 2)",
    );
    expect(content).toContain("## Active Codex Escalations");
    expect(content).toContain(
      "medium / write_edit_failure / correction-loop: file-save failure kept recurring (foundation execution-hygiene, occurrences 2)",
    );
    expect(content).toContain("## Watchtower Foundation Impact");
    expect(content).toContain("outcome-review: 1 active watchtower signal");
    expect(content).toContain("risk-transmission: 1 active watchtower signal");
    expect(content).toContain("2026-W13-learning-weekly-review.md");
    expect(content).toContain("2026-W13-frontier-methods-weekly-review.md");
    expect(content).toContain("## Active Brain Spine");
    expect(content).toContain(
      "Read memory/current-research-line.md first, then MEMORY.md, then memory/unified-risk-view.md when present",
    );
    expect(content).toContain(
      "the distillation chain serves both Lobster's general meta-capability and the full finance research pipeline",
    );
    expect(content).toContain("This artifact is for supervision and long-horizon improvement.");
    expect(scorecardContent).toContain("# Portfolio Answer Scorecard: 2026-W13");
    expect(scorecardContent).toContain("## Dimension Scores");
    expect(scorecardContent).toContain("Stance Clarity");
    expect(scorecardContent).toContain("Confidence Calibration");
    expect(scorecardContent).toContain("## Main Failure Modes");
    expect(scorecardContent).toContain("## Next Upgrade Focus");
    expect(scorecardContent).toContain(
      "use this scorecard to judge whether Lobster is answering like a portfolio assistant or hiding behind market commentary.",
    );
    expect(parsedScorecard).toMatchObject({
      weekKey: "2026-W13",
      averageScore: expect.stringContaining("/ 5.0"),
      improveTarget: expect.any(String),
    });
    expect(parsedScorecard?.nextUpgradeFocus).toContain("do-now: improve");
  });

  it("does nothing when there are no weekly signals to summarize", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    await runReset(tempDir);
    await expect(
      fs.access(
        path.join(
          tempDir,
          "memory",
          buildOperatingWeeklyArtifactFilename("2026-W13", "lobster-weekly-review"),
        ),
      ),
    ).rejects.toThrow();
  });
});
