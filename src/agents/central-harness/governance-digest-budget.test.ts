import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectGovernanceDigest } from "../../../scripts/operator/lcx-central-agent.js";
import { projectCleanupReview } from "./cleanup-review-handoff.js";
import { fitGovernanceDigest } from "./governance-digest-budget.js";
import { compactFlowGraphOwner } from "./governance-input.js";
import { boundPerception } from "./harness-loop.js";

function crowdedDigest() {
  const long = "原始来源缺失需要回到负责读取的模块核查".repeat(100);
  return projectGovernanceDigest({
    ok: false,
    checkedAt: "2026-10-11T06:00:00Z",
    runReceipt: { status: "blocked", nextAction: long },
    summary: {
      releaseBlocked: true,
      structuralOwnerFailures: ["changeImpact", "flowGraph"],
      failedGates: ["source_hash_conflict"],
      blockedGates: ["broker_unconfirmed"],
    },
    multiAgentPatternShadow: {
      status: "blocked",
      experimentId: long,
      trialDecision: "unverified",
      trialDecisionReason: long,
      reason: long,
    },
    owners: {
      flowGraph: compactFlowGraphOwner({
        summary: { scenarios: 2 },
        handoffAudit: [
          {
            scenarioId: "cleanup_candidate_review",
            status: "handoff_gap",
            evidenceOrigin: "offline_fixture",
            gaps: [{ owner: "changeImpact", reason: long }],
          },
          { scenarioId: "not_seen", status: "not_observed" },
        ],
      }),
      changeImpact: {
        cleanupReview: projectCleanupReview({
          status: "reviewed",
          reason: long,
          count: 256,
          preserve: 0,
          unknown: 256,
          selectedCandidates: 256,
          omittedCandidates: 44,
          coverage: "selected_candidates_only",
          missingChecks: [
            "source_hash_binding",
            "retention_rule",
            "reference_check",
            "replacement_relation",
          ],
          missingChecksOmitted: 9,
          semanticTruth: "not_proven",
          cleanupAuthorized: false,
        }),
      },
    },
  });
}

function bound(digest: Readonly<Record<string, unknown>>) {
  return boundPerception({
    observedAt: "2026-10-11T06:00:00Z",
    ownerTotals: {},
    backlog: [],
    boundaries: [],
    controlRoom: { governanceDigest: digest },
  });
}

describe("governance digest combined original budget (offline)", () => {
  it("reproduces the original entire-key drop for valid bounded handoff summaries", async () => {
    const digest = crowdedDigest();
    const result = bound(digest);
    if (digest.budgetProjection !== undefined) {
      // The original caller may already have integrated the local fit repair.
      expect(result.perception.controlRoom.governanceDigest).toEqual(digest);
      return;
    }
    expect(Buffer.byteLength(JSON.stringify(digest))).toBeGreaterThan(2048);
    expect(result.perception.controlRoom.governanceDigest).toBeUndefined();
    if (process.env.LCX_WATERFLOW_PROOF_DIR) {
      await fs.writeFile(
        path.join(process.env.LCX_WATERFLOW_PROOF_DIR, "before.json"),
        JSON.stringify(
          {
            boundary: "offline_actual_projection_and_bound_functions_no_owner_provider",
            digestBytes: Buffer.byteLength(JSON.stringify(digest)),
            digest,
            result,
          },
          null,
          2,
        ) + "\n",
      );
    }
  });

  it("retains the concrete original failures and both handoff summaries after fitting", async () => {
    const digest = crowdedDigest();
    const fitted = fitGovernanceDigest(digest);
    const result = bound(fitted);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(2048);
    expect(result.report.injectedBytes).toBeLessThanOrEqual(12000);
    expect(result.perception.controlRoom.governanceDigest).toEqual(fitted);
    expect(fitted).toMatchObject({
      ok: false,
      releaseBlocked: true,
      cycleStatus: "blocked",
      ownerFailures: ["changeImpact", "flowGraph"],
      failedGates: ["source_hash_conflict"],
      blockedGates: ["broker_unconfirmed"],
      flowHandoff: {
        counts: { verified: 0, normalBlock: 0, gaps: 1, notObserved: 1 },
        semanticAdoption: "not_proven",
        gapDetails: [{ owner: "changeImpact" }],
        gapDetailsOmitted: 1,
      },
      cleanupReview: {
        status: "reviewed",
        count: 256,
        preserve: 0,
        unknown: 256,
        omittedCandidates: 44,
        missingChecks: ["source_hash_binding"],
        missingChecksOmitted: 12,
        cleanupAuthorized: false,
        semanticTruth: "not_proven",
      },
      shadow: { status: "blocked", trialDecision: "unverified" },
    });
    expect(fitted.budgetProjection).toMatchObject({ shortenedStrings: expect.any(Number) });
    if (process.env.LCX_WATERFLOW_PROOF_DIR) {
      await fs.writeFile(
        path.join(process.env.LCX_WATERFLOW_PROOF_DIR, "after.json"),
        JSON.stringify(
          {
            boundary: "offline_original_budget_after_local_pure_fit_no_natural_adoption",
            digestBytes: Buffer.byteLength(JSON.stringify(fitted)),
            fitted,
            result,
          },
          null,
          2,
        ) + "\n",
      );
    }
  });

  it("leaves small original digests unchanged and never mutates a source", () => {
    const small = Object.freeze({ status: "pre_decision", complete: false, releaseBlocked: false });
    expect(fitGovernanceDigest(small)).toBe(small);
    const large = crowdedDigest();
    const before = JSON.stringify(large);
    fitGovernanceDigest(large);
    expect(JSON.stringify(large)).toBe(before);
  });

  it("does not invent absent flags or turn missing counts into zero, and retains identity whole", () => {
    const parentRunId = "original-parent".repeat(10);
    const sourceSha256 = "b".repeat(64);
    const fitted = fitGovernanceDigest({
      status: "pre_decision",
      complete: false,
      parentRunId,
      sourceSha256,
      nextAction: "核查来源".repeat(500),
      flowHandoff: {
        status: "not_provided",
        proofLevel: "receipt_handoff_only",
        semanticAdoption: "not_proven",
        gapDetails: [],
      },
      cleanupReview: {
        status: "blocked",
        reason: "source_missing",
        missingChecks: ["source_read"],
      },
    });
    expect(fitted.ok).toBeUndefined();
    expect(fitted.releaseBlocked).toBeUndefined();
    expect(fitted).toMatchObject({
      parentRunId,
      sourceSha256,
      flowHandoff: { status: "not_provided", gapDetailsOmittedStatus: "missing" },
      cleanupReview: { status: "blocked", missingChecksOmittedStatus: "missing" },
    });
    expect((fitted.flowHandoff as Record<string, unknown>).counts).toBeUndefined();
  });

  it("uses exact UTF8 bytes under crowded failures, escaping and optional pointers", () => {
    const long = '账户来源未确认😀\\"\n'.repeat(300);
    const initial = crowdedDigest();
    const ownerResults = Array.from({ length: 4 }, (_, i) => ({
      ownerId: `original_owner_${i}`,
      status: "registered",
      artifactId: `artifact-${"a".repeat(64)}`,
      sourceSha256: "a".repeat(64),
    }));
    const raw = {
      ...initial,
      ownerFailures: Array(6).fill(long),
      failedGates: Array(6).fill(long),
      blockedGates: Array(6).fill(long),
      ownerResults,
      ownerResultsOmitted: 3,
      privateBody: "private should not be copied".repeat(300),
      flowHandoff: {
        ...(initial.flowHandoff as Record<string, unknown>),
        gapDetails: [{ scenarioId: long, status: "handoff_gap", owner: long, reason: long }],
      },
      cleanupReview: {
        ...(initial.cleanupReview as Record<string, unknown>),
        reason: long,
        missingChecks: [long, long],
        missingChecksOmitted: 9,
      },
    };
    const fitted = fitGovernanceDigest(raw);
    expect(Buffer.byteLength(JSON.stringify(fitted), "utf8")).toBeLessThanOrEqual(2048);
    expect(fitted.status).toBe("present");
    expect(fitted.releaseBlocked).toBe(true);
    expect(fitted.ownerFailuresCount).toBe(6);
    expect(fitted.failedGatesCount).toBe(6);
    expect(fitted.blockedGatesCount).toBe(6);
    expect(JSON.stringify(fitted)).not.toContain("\uFFFD");
    expect(fitted.privateBody).toBeUndefined();
    expect(fitted.flowHandoff).toMatchObject({
      counts: { gaps: 1, notObserved: 1 },
      gapDetails: [{ owner: expect.stringContaining("账户") }],
    });
    expect(fitted.cleanupReview).toMatchObject({
      status: "reviewed",
      unknown: 256,
      missingChecks: [expect.stringContaining("账户")],
      missingChecksOmitted: 10,
    });
    expect(bound(fitted).perception.controlRoom.governanceDigest).toEqual(fitted);
  });

  it("keeps unknown and blocked reviews distinct, including empty candidates and omitted counts", () => {
    const initial = crowdedDigest();
    const fitted = fitGovernanceDigest({
      ...initial,
      phase: "before_central_decision",
      status: "pre_decision",
      complete: false,
      cleanupReview: projectCleanupReview({
        status: "blocked",
        reason: "cleanup_source_hash_conflict",
        count: 0,
        preserve: 0,
        unknown: 0,
        selectedCandidates: 0,
        omittedCandidates: 44,
        coverage: "selected_candidates_only",
        semanticTruth: "not_proven",
        cleanupAuthorized: false,
        missingChecks: ["source_read_confirmation"],
        missingChecksOmitted: 3,
      }),
      flowHandoff: {
        status: "unavailable",
        proofLevel: "receipt_handoff_only",
        semanticAdoption: "not_proven",
        reason: "original_owner_not_observed",
      },
    });
    expect(fitted).toMatchObject({
      status: "pre_decision",
      complete: false,
      cleanupReview: {
        status: "blocked",
        reason: "cleanup_source_hash_conflict",
        omittedCandidates: 44,
        count: 0,
        missingChecks: ["source_read_confirmation"],
        cleanupAuthorized: false,
      },
      flowHandoff: { status: "unavailable", reason: "original_owner_not_observed" },
    });
  });

  it("reserves the fitted blockers while the original total budget drops lower priority sections", () => {
    const fitted = fitGovernanceDigest(crowdedDigest());
    const result = boundPerception({
      observedAt: "2026-10-11T06:00:00Z",
      ownerTotals: {},
      backlog: [],
      boundaries: [],
      controlRoom: {
        governanceDigest: fitted,
        ...Object.fromEntries(
          Array.from({ length: 8 }, (_, index) => [`optional_${index}`, "x".repeat(1800)]),
        ),
      },
    });
    expect(result.perception.controlRoom.governanceDigest).toEqual(fitted);
    expect(result.report.injectedBytes).toBeLessThanOrEqual(12000);
    expect(result.report.overBudget).toBe(false);
    expect(result.report.droppedSections?.[0].droppedKeys.length).toBeGreaterThan(0);
  });
});

describe("provider cancellation verdict in the original governance budget", () => {
  it.each(["cleanup_unconfirmed", "local_operation_settled"])(
    "retains %s under crowded context without implying remote cleanup",
    (cleanupStatus) => {
      const state = {
        owners: {
          providerCouncilAcceleration: {
            providerRunTimedOut: true,
            providerRunFailureCode: "provider_council_timeout",
            providerRunCleanup: {
              status: cleanupStatus,
              cancellationRequested: true,
              scope: "local_council_operation_only_remote_execution_not_confirmed",
            },
          },
        },
      };
      const provider = projectGovernanceDigest(state).providerCouncilRun;
      const fitted = fitGovernanceDigest({
        ...crowdedDigest(),
        providerCouncilRun: provider,
        optionalDetails: "x".repeat(20000),
      });
      expect(fitted.providerCouncilRun).toEqual(provider);
      expect(bound(fitted).perception.controlRoom.governanceDigest).toEqual(fitted);
      expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(2048);
    },
  );
  it("keeps malformed or foreign cleanup claims unconfirmed", () => {
    const digest = projectGovernanceDigest({
      owners: {
        providerCouncilAcceleration: {
          providerRunCleanup: {
            status: "local_operation_settled",
            cancellationRequested: true,
            scope: "foreign_remote_owner",
          },
        },
      },
    });
    expect(digest.providerCouncilRun).toMatchObject({
      cleanupStatus: "cleanup_unconfirmed",
      remoteCancellation: "not_confirmed",
    });
  });
});

it("does not turn an idle council plan into an observed cancellation result", () => {
  const digest = projectGovernanceDigest({
    owners: { providerCouncilAcceleration: { status: "ready_plan", providerRunTimedOut: false } },
  });
  expect(digest.providerCouncilRun).toBeUndefined();
});
