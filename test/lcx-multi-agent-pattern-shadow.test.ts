import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { killProcessTree } from "../src/process/kill-tree.js";

vi.mock("node:child_process", { spy: true });
vi.mock("../src/process/kill-tree.js", () => ({ killProcessTree: vi.fn() }));
import {
  DEFAULT_LIVE_EXPERIMENT_ID,
  DEFAULT_ISOLATED_EXECUTOR_EXPERIMENT_ID,
  DEFAULT_REPLAY_EXPERIMENT_ID,
  EXECUTOR_SCHEMA_VERSION,
  METRICS_SCHEMA_VERSION,
  PROOF_COVERAGE_SCHEMA_VERSION,
  RECEIPT_SCHEMA_VERSION,
  REPLAY_FIXTURES,
  SHADOW_EXECUTION_PHASES,
  SHADOW_PATTERNS,
  auditShadowPermissions,
  executorFingerprint,
  invokeExecutor,
  isolatedExecutorPattern,
  isShadowProcessGroupGone,
  mergeResponseParts,
  preserveShadowRetryHistory,
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
  validateShadowLatestReceipt,
  validateShadowProofCoverage,
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

  it("blocks a latest projection when its runs, proof coverage, phase, or summary drift", () => {
    const source = buildReplayExperiment({ experimentId: "shadow-latest-integrity" });

    expect(validateShadowLatestReceipt(source)).toEqual([]);

    const missingRuns = { ...source, runs: [] };
    expect(classifyShadowLatestReceipt(missingRuns, "2026-09-02T00:00:00.000Z")).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining("runs must be a non-empty array"),
    });

    const missingCoverage = {
      ...source,
      runs: source.runs.map((run) => ({ ...run, proofCoverage: undefined })),
    };
    expect(classifyShadowLatestReceipt(missingCoverage, "2026-09-02T00:00:00.000Z")).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining("proof coverage must be an object"),
    });

    const phaseDrift = { ...source, executionPhase: "isolated_executor" as const };
    expect(classifyShadowLatestReceipt(phaseDrift, "2026-09-02T00:00:00.000Z")).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining("executionPhase disagrees with mode"),
    });

    const summaryDrift = {
      ...source,
      summary: { ...source.summary, normalPasses: source.summary.normalRuns + 1 },
    };
    expect(classifyShadowLatestReceipt(summaryDrift, "2026-09-02T00:00:00.000Z")).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining("normalPasses exceeds normalRuns"),
    });

    const projectionDrift = {
      ...source,
      summary: { ...source.summary, normalPasses: 0, normalPassRate: 0 },
    };
    expect(classifyShadowLatestReceipt(projectionDrift, "2026-09-02T00:00:00.000Z")).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining("summary normalPasses disagrees with runs"),
    });
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
    const normalRuns = first.runs.filter((run) => run.fixture === "normal_quality");
    expect(
      normalRuns.every((run) => run.proofCoverage?.schemaVersion === PROOF_COVERAGE_SCHEMA_VERSION),
    ).toBe(true);
    expect(normalRuns.every((run) => run.proofCoverage?.complete === true)).toBe(true);
    expect(normalRuns.every((run) => run.proofCoverage?.missing.length === 0)).toBe(true);
    expect(normalRuns.every((run) => run.proofCoverage?.unknown.length === 0)).toBe(true);
    expect(
      normalRuns.every(
        (run) => run.proofCoverage?.present.length === run.proofCoverage?.required.length,
      ),
    ).toBe(true);
    expect(
      normalRuns.every((run) =>
        run.proofCoverage?.entries.every((entry) => entry.evidence.length > 0),
      ),
    ).toBe(true);
    const normalCoverage = normalRuns[0]?.proofCoverage;
    const normalTopology = normalRuns[0]?.topology;
    expect(validateShadowProofCoverage(normalCoverage, normalTopology)).toEqual([]);
    expect(
      validateShadowProofCoverage(
        { ...normalCoverage, complete: true, missing: ["replay"] },
        normalTopology,
      ),
    ).toEqual(
      expect.arrayContaining([
        "proof coverage status partitions overlap",
        "proof coverage complete disagrees with missing or unknown",
      ]),
    );
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
    expect(isolated.runs.every((run) => run.proofCoverage?.complete === false)).toBe(true);
    expect(isolated.runs.every((run) => (run.proofCoverage?.unknown.length ?? 0) > 0)).toBe(true);
    expect(isolated.summary.trialDecision).toBe("downrank");
    expect(isolated.summary.trialDecisionReason).toContain("proof coverage");
    expect(isolated.summary.trialDecisionReason).toContain("replay");
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
      requiredProofKinds: expect.arrayContaining([
        "trace",
        "tool_attribution",
        "permission_audit",
        "evaluator_result",
        "replay",
      ]),
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

describe("shadow recovery and evidence boundaries", () => {
  it("binds the actual binary, script and declared configuration bytes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shadow-identity-"));
    try {
      const script = path.join(dir, "executor.js");
      const config = path.join(dir, "model.json");
      await fs.writeFile(script, "version one");
      await fs.writeFile(config, "config one");
      const command = `"${process.execPath}" "${script}"`;
      const first = executorFingerprint(command, "live", [config]);
      expect(executorFingerprint(command, "live", [config])).toBe(first);
      await fs.writeFile(script, "version two");
      const second = executorFingerprint(command, "live", [config]);
      expect(second).not.toBe(first);
      await fs.writeFile(config, "config two");
      expect(executorFingerprint(command, "live", [config])).not.toBe(second);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("counts undeclared completed tools and explicit permission denials", () => {
    const audit = auditShadowPermissions(
      [
        { toolName: "network.fetch", status: "completed", allowed: true },
        { toolName: "read_case", status: "completed", allowed: false },
        { toolName: "unknown.tool", status: "blocked", allowed: false },
        { toolName: "read_case", status: "completed", allowed: true },
      ],
      [],
    );
    expect(audit.escapedViolations).toBe(2);
    expect(audit.blockedViolationAttempts).toBe(1);
  });

  it("does not turn missing child usage into an exact aggregate", () => {
    const base = {
      schemaVersion: EXECUTOR_SCHEMA_VERSION,
      status: "completed" as const,
      capabilities: {
        eventReceipt: "unknown" as const,
        toolEventReceipt: "unknown" as const,
        sideEffectReceipt: "unknown" as const,
        faultInjection: "unknown" as const,
        resume: "unknown" as const,
      },
    };
    expect(
      mergeResponseParts([{ ...base, usage: { totalTokens: 8 } }, base], [1, 1], "manager").usage,
    ).toBeUndefined();
    expect(
      mergeResponseParts(
        [
          { ...base, usage: { totalTokens: 8 } },
          { ...base, usage: { totalTokens: 3 } },
        ],
        [1, 1],
        "manager",
      ).usage?.totalTokens,
    ).toBe(11);
  });

  it("preserves complete token fields while omitting partial fields and mixed-currency fees", () => {
    const normalized = normalizeExecutorResponse({
      schemaVersion: EXECUTOR_SCHEMA_VERSION,
      status: "completed",
    });
    if (!normalized.ok) {
      throw new Error("fixture normalization failed");
    }
    const base = normalized.response;
    const partial = mergeResponseParts(
      [
        { ...base, usage: { totalTokens: 8 } },
        { ...base, usage: { promptTokens: 3 } },
      ],
      [1, 1],
      "manager",
    );
    expect(partial.usage?.totalTokens).toBeUndefined();
    expect(partial.usage?.promptTokens).toBeUndefined();
    expect(partial.usage?.billedAmount).toBeUndefined();
    const tokens = mergeResponseParts(
      [
        { ...base, usage: { totalTokens: 8, billedAmount: 1, currency: "USD" } },
        { ...base, usage: { totalTokens: 3, promptTokens: 3, billedAmount: 2, currency: "CNY" } },
      ],
      [1, 1],
      "manager",
    );
    expect(tokens.usage).toMatchObject({ totalTokens: 11, estimated: false });
    expect(tokens.usage?.promptTokens).toBeUndefined();
    expect(tokens.usage?.billedAmount).toBeUndefined();
    expect(tokens.usage?.currency).toBeUndefined();
    const fees = mergeResponseParts(
      [
        { ...base, usage: { billedAmount: 1, currency: "USD" } },
        { ...base, usage: { billedAmount: 2, currency: "USD" } },
      ],
      [1, 1],
      "manager",
    );
    expect(fees.usage).toMatchObject({ billedAmount: 3, currency: "USD" });
    expect(fees.usage?.totalTokens).toBeUndefined();
    const cleanup = mergeResponseParts(
      [
        { ...base, status: "timed_out", error: { code: "executor_timeout", message: "timeout" } },
        {
          ...base,
          status: "blocked",
          error: { code: "executor_cleanup_unconfirmed", message: "unconfirmed" },
        },
      ],
      [1, 1],
      "parallel_worker",
    );
    expect(cleanup.status).toBe("blocked");
    expect(cleanup.error?.code).toBe("executor_cleanup_unconfirmed");
  });

  it.each(["alive", "EPERM", "open-child"])(
    "blocks bounded cleanup when %s prevents confirmation",
    async (scenario) => {
      vi.useFakeTimers();
      const fake = Object.assign(new EventEmitter(), {
        pid: 424242,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      vi.mocked(spawn).mockReturnValueOnce(fake as unknown as ChildProcessWithoutNullStreams);
      const probe = vi.spyOn(process, "kill").mockImplementation(() => {
        if (scenario === "alive") {
          return true;
        }
        throw Object.assign(new Error("fixture"), {
          code: scenario === "EPERM" ? "EPERM" : "ESRCH",
        });
      });
      try {
        const pending = invokeExecutor('"node" fixture.js', {} as ShadowExecutorRequest, 10);
        let finished = false;
        void pending.then(() => {
          finished = true;
        });
        await vi.advanceTimersByTimeAsync(10);
        if (scenario !== "open-child") {
          fake.emit("close", null);
        }
        await vi.advanceTimersByTimeAsync(1499);
        expect(finished).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect((await pending).error?.code).toBe("executor_cleanup_unconfirmed");
      } finally {
        probe.mockRestore();
        vi.useRealTimers();
        vi.mocked(spawn).mockRestore();
      }
    },
  );

  it("does not resume an interrupted parallel worker after a sibling cleanup is unconfirmed", async () => {
    vi.useFakeTimers();
    const requests: ShadowExecutorRequest[] = [];
    let spawned = 0;
    const mkdir = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    const probe = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.mocked(spawn).mockImplementation(() => {
      const index = spawned++;
      const fake = Object.assign(new EventEmitter(), {
        pid: 424242 + index,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      let input = "";
      fake.stdin.on("data", (chunk: Buffer) => {
        input += String(chunk);
      });
      fake.stdin.on("finish", () => {
        const request = JSON.parse(input) as ShadowExecutorRequest;
        requests.push(request);
        if (index === 1) {
          setTimeout(() => fake.emit("close", null), 20);
          return;
        }
        fake.stdout.emit("data", JSON.stringify(buildFixtureResponse(request)));
        fake.emit("close", 0);
      });
      return fake as unknown as ChildProcessWithoutNullStreams;
    });
    try {
      const pending = isolatedExecutorPattern(
        {
          experimentId: "parallel-cleanup-fixture",
          runId: "parallel-cleanup-fixture:recovery",
          pattern: "parallel_worker",
          repetition: 1,
          mode: "live",
          workspaceDir: "/unused-mocked-workspace",
          executorCommand: "node fixture.js",
          childTimeoutMs: 10,
          rootTimeoutMs: 10000,
          recoveryProbe: true,
        },
        "fixture-identity",
      );
      await vi.advanceTimersByTimeAsync(1600);
      const result = await pending;
      expect(result.status).toBe("blocked");
      expect(result.error?.code).toBe("executor_cleanup_unconfirmed");
      expect(result.childStatuses).toContain("interrupted");
      expect(requests).toHaveLength(3);
      expect(requests.some((request) => request.resumeFromEventId)).toBe(false);
      expect(result.recovery.passed).toBe(false);
    } finally {
      mkdir.mockRestore();
      probe.mockRestore();
      vi.mocked(spawn).mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not mistake a Windows parent exit for confirmed descendant cleanup", () => {
    const probe = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("not a group proof");
    });
    try {
      expect(isShadowProcessGroupGone(424242, "win32")).toBe(false);
      expect(probe).not.toHaveBeenCalled();
    } finally {
      probe.mockRestore();
    }
  });

  it("retains a failed retry across a later retry-required receipt", () => {
    const prior = buildReplayExperiment().runs[0];
    const retried = {
      ...prior,
      retry: { reason: "fixture", attempt: 1, retryOfRunId: prior.runId },
    };
    const blocked = { ...prior, status: "blocked" as const, retry: undefined };
    expect(preserveShadowRetryHistory(blocked, retried).retry).toEqual(retried.retry);
  });

  it.skipIf(process.platform === "win32")(
    "waits for child close and canonical tree escalation without inheriting secrets",
    async () => {
      vi.useFakeTimers();
      const fake = Object.assign(new EventEmitter(), {
        pid: 424242,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      vi.mocked(spawn).mockReturnValueOnce(fake as unknown as ChildProcessWithoutNullStreams);
      vi.stubEnv("OPENAI_API_KEY", "private-fixture");
      const probe = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      });
      try {
        const pending = invokeExecutor('"node" fixture.js', {} as ShadowExecutorRequest, 10);
        let finished = false;
        void pending.then(() => {
          finished = true;
        });
        await vi.advanceTimersByTimeAsync(10);
        expect(killProcessTree).toHaveBeenCalledWith(424242, { graceMs: 750 });
        expect(finished).toBe(false);
        const options = vi.mocked(spawn).mock.calls.at(-1)?.[2];
        expect(options?.env?.OPENAI_API_KEY).toBeUndefined();
        expect(options?.env?.LCX_MULTI_AGENT_SHADOW).toBe("1");
        fake.emit("close", null);
        await vi.advanceTimersByTimeAsync(749);
        expect(finished).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect((await pending).error?.code).toBe("executor_timeout");
      } finally {
        probe.mockRestore();
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.mocked(spawn).mockRestore();
      }
    },
  );
});
