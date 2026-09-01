import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_EXPERIMENT_ID,
  DEFAULT_ISOLATED_EXECUTOR_EXPERIMENT_ID,
  DEFAULT_REPLAY_EXPERIMENT_ID,
  EXECUTOR_SCHEMA_VERSION,
  METRICS_SCHEMA_VERSION,
  RECEIPT_SCHEMA_VERSION,
  REPLAY_FIXTURES,
  SHADOW_EXECUTION_PHASES,
  SHADOW_PATTERNS,
  auditShadowPermissions,
  buildIsolatedExecutorExperiment,
  buildLiveExperiment,
  canonicalShadowExecutionPhase,
  buildReplayExperiment,
  buildShadowDeliveryKey,
  buildShadowIdempotencyKey,
  classifyShadowLatestReceipt,
  getDefaultShadowExperimentId,
  getShadowTopology,
  normalizeExecutorResponse,
  normalizeShadowModeInput,
  scoreShadowAnswer,
  type ShadowExecutorRequest,
} from "../scripts/operator/lcx-multi-agent-pattern-shadow.js";
import { buildFixtureResponse } from "./fixtures/lcx-multi-agent-pattern-shadow-executor.ts";

describe("LCX multi-agent pattern shadow", () => {
  it("classifies latest receipts without allowing governance to trigger a shadow run", () => {
    const source = buildReplayExperiment({ experimentId: "shadow-latest-status" });
    const receipt = {
      ...source,
      createdAt: "2026-09-01T00:00:00.000Z",
      completedAt: "2026-09-01T00:00:00.000Z",
    };
    const snapshot = classifyShadowLatestReceipt(receipt, "2026-09-02T00:00:00.000Z");

    expect(snapshot).toMatchObject({
      status: "fresh",
      trialDecision: "unverified",
      latestStatePath: expect.stringContaining("lcx-multi-agent-pattern-shadow-latest.json"),
    });
    expect(snapshot.reason).toContain("freshness window");

    const stale = classifyShadowLatestReceipt(receipt, "2026-09-10T00:00:00.000Z");
    expect(stale.status).toBe("stale");
  });

  it("keeps the protocol versioned, forward-compatible, and evidence-bounded", () => {
    const normalized = normalizeExecutorResponse({
      schemaVersion: EXECUTOR_SCHEMA_VERSION,
      status: "completed",
      answer: "normalized answer",
      futureOptionalField: { ignored: true },
      capabilities: {
        eventReceipt: "supported",
        toolEventReceipt: "supported",
        sideEffectReceipt: "supported",
        faultInjection: "supported",
        resume: "supported",
      },
      events: [],
      toolEvents: [],
      sideEffects: [],
    });

    expect(normalized).toMatchObject({ ok: true });
    if (normalized.ok) {
      expect(normalized.response.schemaVersion).toBe(EXECUTOR_SCHEMA_VERSION);
      expect(normalized.response.capabilities.eventReceipt).toBe("supported");
      expect("futureOptionalField" in normalized.response).toBe(false);
    }

    const missingEvidence = normalizeExecutorResponse({
      schemaVersion: EXECUTOR_SCHEMA_VERSION,
      status: "completed",
      capabilities: {
        eventReceipt: "supported",
        toolEventReceipt: "supported",
        sideEffectReceipt: "supported",
        faultInjection: "supported",
        resume: "supported",
      },
    });
    expect(missingEvidence).toMatchObject({ ok: true });
    if (missingEvidence.ok) {
      expect(missingEvidence.response.events).toBeUndefined();
      expect(missingEvidence.response.usage).toBeUndefined();
      expect(missingEvidence.response.capabilities.eventReceipt).toBe("unknown");
      expect(missingEvidence.response.capabilities.toolEventReceipt).toBe("unknown");
      expect(missingEvidence.response.capabilities.sideEffectReceipt).toBe("unknown");
    }

    const malformedEvidence = normalizeExecutorResponse({
      schemaVersion: EXECUTOR_SCHEMA_VERSION,
      status: "completed",
      capabilities: {
        eventReceipt: "supported",
        toolEventReceipt: "supported",
        sideEffectReceipt: "supported",
      },
      events: [{ futureEventOnly: true }],
      toolEvents: [{ futureToolOnly: true }],
      sideEffects: [{ futureEffectOnly: true }],
    });
    expect(malformedEvidence).toMatchObject({ ok: true });
    if (malformedEvidence.ok) {
      expect(malformedEvidence.response.capabilities).toMatchObject({
        eventReceipt: "unknown",
        toolEventReceipt: "unknown",
        sideEffectReceipt: "unknown",
      });
    }

    const unknownEnumEvidence = normalizeExecutorResponse({
      schemaVersion: EXECUTOR_SCHEMA_VERSION,
      status: "completed",
      capabilities: {
        eventReceipt: "supported",
        toolEventReceipt: "supported",
        sideEffectReceipt: "supported",
        faultInjection: "supported",
        resume: "supported",
      },
      events: [
        {
          eventId: "event-1",
          taskId: "task-1",
          role: "future_role",
          state: "completed",
          kind: "task_completed",
          communicationKind: "report",
          atMs: 1,
        },
      ],
      toolEvents: [{ toolName: "future.tool", status: "future_status" }],
      sideEffects: [{ kind: "future_effect", status: "future_status" }],
    });
    expect(unknownEnumEvidence).toMatchObject({ ok: true });
    if (unknownEnumEvidence.ok) {
      expect(unknownEnumEvidence.response.capabilities).toMatchObject({
        eventReceipt: "unknown",
        toolEventReceipt: "unknown",
        sideEffectReceipt: "unknown",
      });
      expect(unknownEnumEvidence.response.events).toEqual([]);
      expect(unknownEnumEvidence.response.toolEvents).toEqual([]);
      expect(unknownEnumEvidence.response.sideEffects).toEqual([]);
    }

    expect(
      normalizeExecutorResponse({
        schemaVersion: "future_executor_v2",
        status: "completed",
      }),
    ).toMatchObject({ ok: false, code: "executor_schema_incompatible" });
    expect(EXECUTOR_SCHEMA_VERSION).toBe("lcx_multi_agent_shadow_executor_v1");
    expect(RECEIPT_SCHEMA_VERSION).toBe("lcx_multi_agent_pattern_shadow_v1");
    expect(METRICS_SCHEMA_VERSION).toBe("lcx_multi_agent_shadow_metrics_v1");
  });

  it("runs one stable replay comparison for all three topologies", () => {
    const first = buildReplayExperiment({
      experimentId: "shadow-test-stable",
      patterns: SHADOW_PATTERNS,
    });
    const second = buildReplayExperiment({
      experimentId: "shadow-test-stable",
      patterns: SHADOW_PATTERNS,
    });
    const stableProjection = (payload: typeof first) => ({
      summary: payload.summary,
      runs: payload.runs,
    });

    expect(stableProjection(first)).toEqual(stableProjection(second));
    expect(first.replayFixtures).toEqual(REPLAY_FIXTURES);
    expect(first.executionPhase).toBe("replay");
    expect(first.runs.every((run) => run.executionPhase === "replay")).toBe(true);
    expect(first.summary.normalRuns).toBe(3);
    expect(first.summary.normalPasses).toBe(3);
    expect(first.summary.usageBasis).toBe("missing");
    expect(first.summary.recoveryPassByPattern).toEqual({
      manager: true,
      handoff: true,
      parallel_worker: true,
    });
    expect(first.summary.patternComparisons).toMatchObject({
      manager: { normalRuns: 1, normalPasses: 1, medianEvidenceCoverage: 1 },
      handoff: { normalRuns: 1, normalPasses: 1, medianCriticalPathLatencyMs: 40 },
      parallel_worker: { normalRuns: 1, normalPasses: 1, medianCriticalPathLatencyMs: 28 },
    });
    expect(new Set(first.runs.map((run) => run.deliveryKey)).size).toBe(first.runs.length);
  });

  it("keeps a single-pattern experiment scoped and blocks the isolated executor without an executor", async () => {
    const replay = buildReplayExperiment({
      experimentId: "shadow-test-single-pattern",
      patterns: ["handoff"],
    });
    expect(replay.summary).toMatchObject({
      patternCount: 1,
      requestedRootRuns: 1,
      rootRuns: 1,
      passByPattern: { manager: 0, handoff: 1, parallel_worker: 0 },
    });
    expect(replay.summary.patternComparisons).toMatchObject({
      manager: null,
      handoff: { normalRuns: 1 },
      parallel_worker: null,
    });

    const isolated = await buildIsolatedExecutorExperiment({
      experimentId: "shadow-test-live-blocked",
      patterns: ["manager"],
      repetitions: 5,
    });
    expect(isolated.runs).toHaveLength(5);
    expect(isolated.runs.every((run) => run.status === "blocked")).toBe(true);
    expect(isolated.runs.every((run) => run.metrics.childCallCount === 0)).toBe(true);
    expect(isolated.runs.every((run) => run.permissionAudit.evidence === "unverified")).toBe(true);
    expect(isolated.executionPhase).toBe("isolated_executor");
    expect(isolated.runs.every((run) => run.executionPhase === "isolated_executor")).toBe(true);
    expect(buildLiveExperiment).toBe(buildIsolatedExecutorExperiment);
  });

  it("preserves topology ownership, call counts, and critical-path differences", () => {
    expect(getShadowTopology("manager")).toMatchObject({
      delegationMode: "manager_as_tool",
      finalOwner: "root_final_owner",
      expectedChildCalls: 3,
      expectedMaxConcurrency: 1,
    });
    expect(getShadowTopology("handoff")).toMatchObject({
      delegationMode: "handoff",
      finalOwner: "specialist_final_owner",
      expectedChildCalls: 1,
    });
    expect(getShadowTopology("parallel_worker")).toMatchObject({
      delegationMode: "parallel_fanout",
      finalOwner: "root_final_owner",
      expectedChildCalls: 3,
      expectedMaxConcurrency: 3,
    });

    const payload = buildReplayExperiment({ experimentId: "shadow-test-topology" });
    const normal = new Map(
      payload.runs
        .filter((run) => run.fixture === "normal_quality")
        .map((run) => [run.pattern, run]),
    );
    expect(normal.get("manager")).toMatchObject({
      topology: { finalOwner: "root_final_owner" },
      metrics: { childCallCount: 3, maxConcurrency: 1, criticalPathLatencyMs: 66 },
    });
    expect(normal.get("handoff")).toMatchObject({
      topology: { finalOwner: "specialist_final_owner" },
      metrics: { childCallCount: 1, maxConcurrency: 1, criticalPathLatencyMs: 40 },
    });
    expect(normal.get("parallel_worker")).toMatchObject({
      topology: { finalOwner: "root_final_owner" },
      metrics: { childCallCount: 3, maxConcurrency: 3, criticalPathLatencyMs: 28 },
    });
  });

  it("fails the safe-but-empty and direct-trade fixtures while accepting the bounded answer", () => {
    const payload = buildReplayExperiment({ experimentId: "shadow-test-quality" });
    for (const pattern of SHADOW_PATTERNS) {
      const normal = payload.runs.find(
        (run) => run.pattern === pattern && run.fixture === "normal_quality",
      );
      const empty = payload.runs.find(
        (run) => run.pattern === pattern && run.fixture === "safe_but_empty_thesis_list",
      );
      const direct = payload.runs.find(
        (run) => run.pattern === pattern && run.fixture === "direct_trade_advice",
      );
      expect(normal?.quality?.pass, pattern).toBe(true);
      expect(normal?.quality?.evidenceCoverage).toMatchObject({ denominator: 8, ratio: 1 });
      expect(empty?.quality?.pass, pattern).toBe(false);
      expect(direct?.quality?.pass, pattern).toBe(false);
    }
    expect(scoreShadowAnswer(undefined)).toBeUndefined();
  });

  it("distinguishes blocked permissions, escaped side effects, duplicates, and unknown cost", () => {
    const payload = buildReplayExperiment({ experimentId: "shadow-test-failure-fixtures" });
    const blocked = payload.runs.find((run) => run.fixture === "permission_boundary_blocked");
    const escaped = payload.runs.find((run) => run.fixture === "external_side_effect_escape");
    const duplicate = payload.runs.find((run) => run.fixture === "duplicate_task_and_artifact");
    const timeout = payload.runs.find((run) => run.fixture === "timeout");

    expect(blocked?.metrics).toMatchObject({
      blockedPermissionViolationAttempts: 1,
      escapedPermissionViolations: 0,
      externalSideEffects: 0,
    });
    expect(escaped?.metrics).toMatchObject({
      escapedPermissionViolations: 2,
      externalSideEffects: 1,
    });
    expect(duplicate?.metrics.duplicateTaskCount).toBeGreaterThan(0);
    expect(duplicate?.metrics.duplicateArtifactCount).toBeGreaterThan(0);
    expect(timeout?.status).toBe("timed_out");
    expect(timeout?.metrics.usageBasis).toBe("missing");
    expect(
      auditShadowPermissions(
        [{ toolName: "lark.send", status: "blocked", allowed: false }],
        [{ kind: "external_channel_send", status: "blocked" }],
      ),
    ).toMatchObject({ outcome: "verified", blockedViolationAttempts: 1, escapedViolations: 0 });
  });

  it("records interruption recovery without lost work or duplicate final output", () => {
    const payload = buildReplayExperiment({ experimentId: "shadow-test-recovery" });
    const recoveryRuns = payload.runs.filter((run) => run.fixture === "interruption");
    expect(recoveryRuns).toHaveLength(3);
    for (const run of recoveryRuns) {
      expect(run.status).toBe("resumed");
      expect(run.recovery).toMatchObject({
        state: "resumed",
        supported: true,
        passed: true,
        lostWork: 0,
        duplicateFinalOutputs: 0,
        resumeTokenPresent: true,
      });
    }
  });

  it("uses a stable idempotency key and rejects path traversal experiment IDs", () => {
    expect(getDefaultShadowExperimentId("replay")).toBe(DEFAULT_REPLAY_EXPERIMENT_ID);
    expect(getDefaultShadowExperimentId("live")).toBe(DEFAULT_LIVE_EXPERIMENT_ID);
    expect(DEFAULT_ISOLATED_EXECUTOR_EXPERIMENT_ID).toBe(DEFAULT_LIVE_EXPERIMENT_ID);
    expect(SHADOW_EXECUTION_PHASES).toEqual(["replay", "isolated_executor"]);
    expect(canonicalShadowExecutionPhase("replay")).toBe("replay");
    expect(canonicalShadowExecutionPhase("live")).toBe("isolated_executor");
    expect(normalizeShadowModeInput("isolated-executor")).toBe("live");
    expect(() => normalizeShadowModeInput("unknown")).toThrow("--mode must be replay");
    expect(
      buildShadowIdempotencyKey({
        experimentId: "exp",
        pattern: "manager",
        repetition: 1,
        executorFingerprint: "fingerprint",
      }),
    ).toBe("exp|manager|1|fingerprint");
    expect(
      buildShadowDeliveryKey({
        experimentId: "exp",
        pattern: "manager",
        repetition: 1,
        executorFingerprint: "fingerprint",
      }),
    ).toBe("exp|manager|1|fingerprint|final");
    expect(() => buildReplayExperiment({ experimentId: "../outside" })).toThrow(
      "experimentId must contain only",
    );
    expect(() => buildReplayExperiment({ patterns: ["manager", "manager"] })).toThrow(
      "patterns must not contain duplicates",
    );
  });

  it("provides a no-network fixture for isolated topology and recovery probes", () => {
    const requestFor = (
      pattern: ShadowExecutorRequest["pattern"],
      role: ShadowExecutorRequest["role"],
      ownershipMode: ShadowExecutorRequest["ownershipMode"],
    ): ShadowExecutorRequest => ({
      schemaVersion: EXECUTOR_SCHEMA_VERSION,
      runId: `fixture-test:${pattern}`,
      caseId: "single_stock_loss_recovery_risk_triage",
      pattern,
      role,
      taskPath: ["root", role],
      parentTaskId: `fixture-test:${pattern}:root`,
      contextScope: "inherited",
      workspaceScope: "disjoint_write_set",
      ownershipMode,
      allowedTools: ["read_case", "write_workspace_artifact"],
      workspaceDir: "/tmp/lcx-multi-agent-pattern-shadow-fixture-test",
    });

    const requests: ShadowExecutorRequest[] = [
      requestFor("manager", "risk_gate", "verifier_only"),
      requestFor("handoff", "specialist", "specialist_final_owner"),
      requestFor("parallel_worker", "risk_gate", "verifier_only"),
    ];
    for (const request of requests) {
      const response = buildFixtureResponse({ ...request, futureOptionalField: "ignored" });
      expect(response).toMatchObject({
        schemaVersion: EXECUTOR_SCHEMA_VERSION,
        status: "completed",
        capabilities: {
          eventReceipt: "supported",
          toolEventReceipt: "supported",
          sideEffectReceipt: "supported",
          faultInjection: "supported",
          resume: "supported",
        },
        sideEffects: [],
      });
      expect(response.usage).toBeUndefined();
      expect(scoreShadowAnswer(response.answer)?.pass).toBe(true);
      expect(normalizeExecutorResponse(response)).toMatchObject({ ok: true });
    }

    const interruptedRequest = requestFor("handoff", "specialist", "specialist_final_owner");
    const interrupted = buildFixtureResponse({
      ...interruptedRequest,
      faultInjection: { kind: "interrupt_after_checkpoint" },
    });
    expect(interrupted.status).toBe("interrupted");
    const checkpointEventId = interrupted.events?.find(
      (event) => event.kind === "checkpoint",
    )?.eventId;
    expect(checkpointEventId).toBeTruthy();
    const resumed = buildFixtureResponse({
      ...interruptedRequest,
      faultInjection: { kind: "interrupt_after_checkpoint" },
      resumeFromEventId: checkpointEventId,
    });
    expect(resumed).toMatchObject({ status: "resumed", answer: expect.any(String) });
    expect(normalizeExecutorResponse(resumed)).toMatchObject({ ok: true });
  });
});
