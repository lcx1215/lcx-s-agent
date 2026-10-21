import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { auditWorkflowHandoffs } from "../scripts/operator/lcx-flow-graph.js";
import {
  canReuseCompletedIsolatedShadowReceipt,
  linkShadowRecoveryReplayProof,
} from "../scripts/operator/lcx-multi-agent-pattern-shadow.js";
import { probeOriginalShadow } from "./fixtures/lcx-waterflow-shadow-probe.js";

it("uses native recovery in comparison, refuses incompatible cached completion, and retains cost/timeout gates", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-shadow-native-handoff-"));
  try {
    const result = await probeOriginalShadow(directory);
    expect(result.receipt.replayPreflight).toMatchObject({ passed: true, normalPasses: 1 });
    expect(
      (await auditWorkflowHandoffs([result.handoffEvidence])).find(
        (row) => row.scenarioId === "multi_agent_pattern_shadow_evaluation_waterflow",
      ),
    ).toMatchObject({ status: "handoffs_verified", gaps: [], semanticAdoption: "not_proven" });
    const normal = result.receipt.runs.find((run) => run.fixture === undefined)!;
    const recovery = result.receipt.runs.find((run) => run.fixture === "interruption")!;
    expect(normal.status).toBe("completed");
    expect(normal.proofCoverage).toMatchObject({ complete: true, missing: [], unknown: [] });
    expect(normal.recoveryReplaySource).toEqual({
      runId: recovery.runId,
      idempotencyKey: recovery.idempotencyKey,
      deliveryKey: recovery.deliveryKey,
    });
    expect(recovery.recovery).toMatchObject({ state: "resumed", passed: true });
    const expected = {
      experimentId: result.receipt.experimentId,
      pattern: "manager" as const,
      repetition: 1,
      executorFingerprint: result.receipt.executorFingerprint,
    };
    expect(canReuseCompletedIsolatedShadowReceipt(normal, expected)).toBe(true);
    const incompatiblePatches: Record<string, unknown>[] = [
      { caseId: "another_case" },
      { executionPhase: "replay" },
      { mode: "replay" },
      { runId: "another_task" },
      { deliveryKey: "another_delivery" },
      { idempotencyKey: "another_executor" },
      { proofCoverage: undefined },
      { liveTouched: true },
      { liveTouched: undefined },
      { providerConfigTouched: undefined },
      { protectedMemoryTouched: undefined },
      { protectedMemoryTouched: true },
      { topology: { ...normal.topology, pattern: "handoff" } },
    ];
    for (const patch of incompatiblePatches) {
      expect(canReuseCompletedIsolatedShadowReceipt({ ...normal, ...patch }, expected)).toBe(false);
    }
    for (const patch of incompatiblePatches) {
      const candidate = { ...recovery, ...patch };
      expect(linkShadowRecoveryReplayProof(normal, [candidate])).toBe(normal);
    }
    expect(result.receipt.summary).toMatchObject({
      usageBasis: "missing",
      trialDecision: "unverified",
    });
    expect(result.receipt.summary.trialDecisionReason).toContain("cost basis");
    expect(result.snapshot).toMatchObject({ status: "fresh", trialDecision: "unverified" });
    expect(result.reused.runs.every((run) => run.reused)).toBe(true);
    expect(result.reuseInvocations).toBe(0);
    expect(result.retainedLedgerUnchanged).toBe(true);
    expect(result.incompatibleInvocations).toBe(0);
    expect(result.incompatible.runs.every((run) => run.status === "blocked" && !run.reused)).toBe(
      true,
    );
    expect(result.incompatible.runs.some((run) => run.error?.code === "retry_required")).toBe(true);
    expect(result.missingRecoveryErrors.join(" ")).toContain("matching original recovery source");
    expect(result.conflictingRecoveryErrors.join(" ")).toContain(
      "matching original recovery source",
    );
    expect(result.forgedPassErrors.join(" ")).toContain("original wide-trial gate");
    expect(result.comparisonConflictErrors.join(" ")).toContain(
      "patternComparisons manager disagrees with original runs",
    );
    expect(result.missingSource.snapshot).toMatchObject({
      status: "missing",
      reason: "latest shadow receipt is missing",
    });
    expect(result.missingSource.actionableClusters).toContain("multi_agent_pattern_shadow_cluster");
    expect(result.missingSource.ownerNextAction).toContain("local replay owner");
    if (process.platform === "win32") {
      // The Windows process owner cannot establish descendant cleanup from a
      // parent exit. Its explicit refusal is required, never a successful timeout.
      expect(
        result.timeout.runs.some(
          (run) => run.status === "blocked" && run.error?.code === "executor_cleanup_unconfirmed",
        ),
      ).toBe(true);
    } else {
      expect(result.timeout.runs.some((run) => run.status === "timed_out")).toBe(true);
    }
    expect(result.timeout.summary.trialDecision).not.toBe("pass");
    expect(result.retainedLatestUnchanged).toBe(true);
    expect(result.timeoutExecutorReleased).toBe(true);
    expect(result.centralJudgments).toHaveLength(2);
    expect(result.centralJudgments[0].note).toContain(
      "fresh/unverified; explicit cost basis is missing",
    );
    expect(result.centralJudgments[1].note).toContain("fresh/downrank; required proof coverage");
    for (const judgment of result.centralJudgments) {
      expect(judgment.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(judgment.approvedActions).toBe(0);
      expect(judgment.prompt).toContain('"trialDecisionReason"');
      const stored = JSON.parse(await fs.readFile(judgment.receiptPath, "utf8"));
      expect(stored.brainCall.note).toBe(judgment.note);
      expect(stored.steps).toEqual([]);
      expect(stored.boundaries).toContain("no_execution_authority");
    }
    expect(result.receipt.liveTouched).toBe(false);
    expect(result.receipt.providerConfigTouched).toBe(false);
    expect(result.receipt.protectedMemoryTouched).toBe(false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 60_000);
