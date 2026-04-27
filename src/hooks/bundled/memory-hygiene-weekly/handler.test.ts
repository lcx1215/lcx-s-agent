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
  buildLearningCouncilMemoryNoteFilename,
  buildKnowledgeValidationNoteFilename,
  buildMemoryHygieneArtifactRelativePath,
  buildWatchtowerArtifactDir,
  renderCodexEscalationArtifact,
  renderCorrectionNoteArtifact,
  renderLearningCouncilMemoryNote,
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
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-hygiene-"));
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

async function runReset(tempDir: string, isoTime = "2026-03-27T15:00:00.000Z") {
  const sessionsDir = path.join(tempDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionFile = await writeWorkspaceFile({
    dir: sessionsDir,
    name: "memory-hygiene-session.jsonl",
    content: "",
  });
  const event = createHookEvent("command", "reset", "agent:main:main", {
    cfg: makeConfig(tempDir),
    previousSessionEntry: {
      sessionId: "memory-hygiene-123",
      sessionFile,
    },
  });
  event.timestamp = new Date(isoTime);
  await handler(event);
}

describe("memory-hygiene-weekly hook", () => {
  it("writes provisional, rejected, anti-pattern, and trash ledgers and prunes expired workface noise", async () => {
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
      content: renderCorrectionNoteArtifact({
        dateStr: "2026-03-24",
        timeStr: "12:00:00",
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        issueKey: "abcd1234",
        memoryTier: "provisional",
        priorClaimOrBehavior: "old control-room answer",
        foundationTemplate: "outcome-review",
        whatWasWrong: "freshness discipline was too weak in control room",
        evidenceOrUserObservedFailure: "source: operator correction",
        replacementRule: "use fresher evidence",
        confidenceDowngrade: "old_rule_confidence: downgraded",
        repeatedIssueSignal: "no",
        sessionTraceLines: ["assistant: old control-room answer", "user: feedback"],
      }),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: buildCorrectionNoteFilename({
        dateStr: "2026-03-25",
        issueKey: "efgh5678",
        timeSlug: "120000-000Z",
      }),
      content: renderCorrectionNoteArtifact({
        dateStr: "2026-03-25",
        timeStr: "12:00:00",
        sessionKey: "agent:main:main",
        sessionId: "sess-2",
        issueKey: "efgh5678",
        memoryTier: "provisional",
        priorClaimOrBehavior: "second old control-room answer",
        foundationTemplate: "outcome-review",
        whatWasWrong: "freshness discipline was too weak in control room",
        evidenceOrUserObservedFailure: "source: operator correction",
        replacementRule: "use fresher evidence",
        confidenceDowngrade: "old_rule_confidence: downgraded",
        repeatedIssueSignal: "yes",
        sessionTraceLines: ["assistant: second old answer", "user: repeated feedback"],
      }),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: buildLearningCouncilMemoryNoteFilename({
        dateStr: "2026-03-25",
        noteSlug: "msg-1",
      }),
      content: renderLearningCouncilMemoryNote({
        stem: "msg-1",
        generatedAt: "2026-03-25T12:00:00.000Z",
        status: "full_with_mutable_fact_warnings",
        userMessage: "学一下利率和成长股脆弱性的关系",
        mutableFactWarnings: 1,
        failedRolesSummary: "none",
        finalReplySnapshot: "先把成长股脆弱性和利率敏感度拆开看。",
      }),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: buildKnowledgeValidationNoteFilename({
        dateStr: "2026-03-26",
        noteSlug: "position-management",
      }),
      content: [
        "# Knowledge Validation Note",
        "",
        "- domain: position management",
        "- hallucination_risk: high",
        "- verdict: fail",
        "",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-01-lobster-workface.md",
      content: "# old workface",
    });

    const anomaliesDir = path.join(tempDir, buildWatchtowerArtifactDir("anomalies"));
    await fs.mkdir(anomaliesDir, { recursive: true });
    await writeWorkspaceFile({
      dir: anomaliesDir,
      name: "hallucination-1.json",
      content: JSON.stringify(
        {
          lastSeenAt: "2026-03-26T15:00:00.000Z",
          category: "hallucination_risk",
          problem: "freshness anchor was stale",
        },
        null,
        2,
      ),
    });
    const codexDir = path.join(tempDir, buildWatchtowerArtifactDir("codexEscalations"));
    await fs.mkdir(codexDir, { recursive: true });
    await writeWorkspaceFile({
      dir: codexDir,
      name: "write_edit_failure-savefail.md",
      content: renderCodexEscalationArtifact({
        titleValue: "write_edit_failure",
        category: "write_edit_failure",
        issueKey: "savefail",
        source: "correction-loop",
        severity: "medium",
        foundationTemplate: "execution-hygiene",
        occurrences: 2,
        lastSeen: "2026-03-26T16:00:00.000Z",
        repairTicketPath: "bank/watchtower/repair-tickets/savefail.md",
        anomalyRecordPath: "bank/watchtower/anomalies/hallucination-1.json",
        problem: "file save still did not land cleanly",
        evidenceLines: ["attempt=2", "surface=control_room"],
        impactLine: "repair loop is blocked",
        suggestedScopeLine: "smallest-safe-patch only",
        generatedAt: "2026-03-26T16:00:00.000Z",
      }),
    });

    await runReset(tempDir);

    const weekly = await fs.readFile(
      path.join(
        tempDir,
        buildMemoryHygieneArtifactRelativePath("2026-W13", "memory-hygiene-weekly"),
      ),
      "utf-8",
    );
    const provisional = await fs.readFile(
      path.join(tempDir, buildMemoryHygieneArtifactRelativePath("2026-W13", "provisional-ledger")),
      "utf-8",
    );
    const rejected = await fs.readFile(
      path.join(tempDir, buildMemoryHygieneArtifactRelativePath("2026-W13", "rejected-ledger")),
      "utf-8",
    );
    const antiPatterns = await fs.readFile(
      path.join(tempDir, buildMemoryHygieneArtifactRelativePath("2026-W13", "anti-patterns")),
      "utf-8",
    );
    const trashManifest = JSON.parse(
      await fs.readFile(
        path.join(tempDir, buildMemoryHygieneArtifactRelativePath("2026-W13", "trash-candidates")),
        "utf-8",
      ),
    ) as {
      trashCandidates: Array<{ relativePath: string; reason: string }>;
      prunedPaths: string[];
    };

    expect(weekly).toContain("# Memory Hygiene Weekly: 2026-W13");
    expect(weekly).toContain("## Provisional Queue");
    expect(weekly).toContain(
      `memory/${buildLearningCouncilMemoryNoteFilename({
        dateStr: "2026-03-25",
        noteSlug: "msg-1",
      })}`,
    );
    expect(weekly).toContain("## Rejected / Quarantine Queue");
    expect(weekly).toContain("memory/2026-03-26-knowledge-validation-position-management.md");
    expect(weekly).toContain("## Anti-Patterns To Keep");
    expect(weekly).toContain("stale-anchor overreach");
    expect(weekly).toContain("## Codex Escalation Queue");
    expect(weekly).toContain("write_edit_failure");
    expect(weekly).toContain("file save still did not land cleanly");
    expect(weekly).toContain("## Prune Actions");
    expect(weekly).toContain("pruned memory/2026-03-01-lobster-workface.md");

    expect(provisional).toContain("source: correction");
    expect(provisional).toContain("reason: provisional_replacement");
    expect(provisional).toContain("source: learning");
    expect(provisional).toContain("reason: bounded_learning_note");

    expect(rejected).toContain("reason: failed_validation");
    expect(rejected).toContain(
      "revive_condition: only after a fresh validation pass changes the verdict",
    );

    expect(antiPatterns).toContain("# Anti-Patterns: 2026-W13");
    expect(antiPatterns).toContain("## stale-anchor overreach");

    expect(trashManifest.trashCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "memory/2026-03-01-lobster-workface.md",
          reason: "expired_operating_artifact",
        }),
      ]),
    );
    expect(trashManifest.prunedPaths).toContain("memory/2026-03-01-lobster-workface.md");

    await expect(
      fs.access(path.join(memoryDir, "2026-03-01-lobster-workface.md")),
    ).rejects.toThrow();
  });

  it("does nothing when no hygiene signals exist", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    await runReset(tempDir);

    await expect(
      fs.access(
        path.join(
          tempDir,
          buildMemoryHygieneArtifactRelativePath("2026-W13", "memory-hygiene-weekly"),
        ),
      ),
    ).rejects.toThrow();
  });
});
