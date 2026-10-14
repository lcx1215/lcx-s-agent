import type { LcxRunReceipt, LcxRunSnapshot } from "../../shared/lcx-run-receipt.js";

/** Original shadow reader observation, bounded separately from its full run packet. */
export type CentralShadowObservation = Readonly<{
  status: "fresh" | "stale" | "blocked" | "missing";
  checkedAt: string;
  latestStatePath: string;
  experimentId?: string;
  completedAt?: string;
  trialDecision?: "pass" | "downrank" | "unverified" | "discard";
  trialDecisionReason?: string;
  reason: string;
}>;

/** The governance owner's completed batch, before its decision child runs. */
export function buildCentralGovernanceInput(
  completedOwners: readonly Readonly<{
    id: string;
    ok: boolean | undefined;
    compact: Readonly<Record<string, unknown>>;
    runReceipt: LcxRunReceipt;
  }>[],
  params: Readonly<{
    parentRunId: string;
    snapshot: LcxRunSnapshot;
    checkedAt?: string;
    multiAgentPatternShadow?: CentralShadowObservation;
  }>,
) {
  return {
    schemaVersion: "lcx_central_governance_input_v1",
    boundary: "same_cycle_completed_owners_only",
    phase: "before_central_decision",
    checkedAt: params.checkedAt ?? new Date().toISOString(),
    parentRunId: params.parentRunId,
    snapshot: params.snapshot,
    ...(params.multiAgentPatternShadow
      ? {
          multiAgentPatternShadow: {
            status: params.multiAgentPatternShadow.status,
            checkedAt: params.multiAgentPatternShadow.checkedAt,
            latestStatePath: params.multiAgentPatternShadow.latestStatePath,
            experimentId: params.multiAgentPatternShadow.experimentId,
            completedAt: params.multiAgentPatternShadow.completedAt,
            trialDecision: params.multiAgentPatternShadow.trialDecision,
            trialDecisionReason: params.multiAgentPatternShadow.trialDecisionReason,
            reason: params.multiAgentPatternShadow.reason,
          },
        }
      : {}),
    byOwner: Object.fromEntries(
      completedOwners
        .filter((owner) => owner.id !== "centralAgent")
        .map((owner) => [
          owner.id,
          { id: owner.id, ok: owner.ok, compact: owner.compact, runReceipt: owner.runReceipt },
        ]),
    ),
  };
}

export type CentralFlowHandoffDigest = Readonly<{
  status: "observed" | "not_provided" | "unavailable";
  proofLevel: "receipt_handoff_only";
  semanticAdoption: "not_proven";
  reason?: string;
  scenarios?: number;
  counts?: Readonly<{ verified: number; normalBlock: number; gaps: number; notObserved: number }>;
  origins?: Readonly<{ offlineFixture: number; naturalReceipt: number }>;
  gapDetails?: readonly Readonly<{
    scenarioId: string;
    status: string;
    owner: string;
    reason: string;
  }>[];
  gapDetailsOmitted?: number;
}>;

function flowRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function flowString(value: unknown, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}
function unavailableFlow(reason: string): CentralFlowHandoffDigest {
  return {
    status: "unavailable",
    proofLevel: "receipt_handoff_only",
    semanticAdoption: "not_proven",
    reason,
  };
}

/** Preserve actual handoff verdicts separately from the owner's structural green checks. */
export function compactFlowGraphOwner(payload: Readonly<Record<string, unknown>>) {
  const audit = payload.handoffAudit;
  let flowHandoff: CentralFlowHandoffDigest;
  if (audit === undefined) {
    flowHandoff = {
      status: "not_provided",
      proofLevel: "receipt_handoff_only",
      semanticAdoption: "not_proven",
      reason: "handoff_observations_not_provided",
    };
  } else if (!Array.isArray(audit) || audit.length === 0 || audit.length > 128) {
    flowHandoff = unavailableFlow("handoff_observations_invalid");
  } else {
    const rows = audit.map(flowRecord);
    const states = new Set(["handoffs_verified", "normal_block", "handoff_gap", "not_observed"]);
    const expected = flowRecord(payload.summary)?.scenarios;
    const ids = rows.map((row) => row?.scenarioId);
    if (
      rows.some(
        (row) =>
          !row ||
          typeof row.scenarioId !== "string" ||
          !row.scenarioId ||
          !states.has(String(row.status)),
      ) ||
      new Set(ids).size !== rows.length ||
      (expected !== undefined && expected !== rows.length) ||
      rows.some(
        (row) =>
          row?.status !== "not_observed" &&
          !["offline_fixture", "natural_receipt"].includes(String(row?.evidenceOrigin)),
      )
    ) {
      flowHandoff = unavailableFlow("handoff_observations_invalid_or_origin_unknown");
    } else {
      const count = (status: string) => rows.filter((row) => row?.status === status).length;
      const actionable = rows
        .filter((row) => row?.status !== "handoffs_verified")
        .toSorted(
          (a, b) => Number(b?.status === "handoff_gap") - Number(a?.status === "handoff_gap"),
        );
      flowHandoff = {
        status: "observed",
        proofLevel: "receipt_handoff_only",
        semanticAdoption: "not_proven",
        scenarios: rows.length,
        counts: {
          verified: count("handoffs_verified"),
          normalBlock: count("normal_block"),
          gaps: count("handoff_gap"),
          notObserved: count("not_observed"),
        },
        origins: {
          offlineFixture: rows.filter((row) => row?.evidenceOrigin === "offline_fixture").length,
          naturalReceipt: rows.filter((row) => row?.evidenceOrigin === "natural_receipt").length,
        },
        gapDetails: actionable.slice(0, 1).map((row) => ({
          scenarioId: flowString(row?.scenarioId, 100),
          status: flowString(row?.status, 32),
          owner: flowString(
            (Array.isArray(row?.gaps) ? flowRecord(row.gaps[0])?.owner : undefined) ?? row?.owner,
            120,
          ),
          reason:
            flowString(
              Array.isArray(row?.gaps) ? flowRecord(row.gaps[0])?.reason : undefined,
              140,
            ) ||
            (row?.status === "normal_block"
              ? "original_gate_blocked; do not bypass"
              : "original_handoff_not_observed"),
        })),
        gapDetailsOmitted: Math.max(0, actionable.length - 1),
      };
    }
  }
  return {
    summary: payload.summary,
    actionableFailures: payload.actionableFailures,
    diagnosticEntries: flowRecord(payload.summary)?.diagnosticEntries,
    flowHandoff,
  };
}

/** Check a persisted projection before placing it in the bounded next decision input. */
export function projectFlowHandoff(value: unknown): CentralFlowHandoffDigest {
  const owner = flowRecord(value);
  if (owner?.handoffAudit !== undefined) {
    return compactFlowGraphOwner(owner).flowHandoff;
  }
  const digest = flowRecord(owner?.flowHandoff);
  if (!digest) {
    return {
      status: "not_provided",
      proofLevel: "receipt_handoff_only",
      semanticAdoption: "not_proven",
      reason: "handoff_observations_not_provided",
    };
  }
  if (digest.status !== "observed") {
    return digest.status === "not_provided"
      ? {
          status: "not_provided",
          proofLevel: "receipt_handoff_only",
          semanticAdoption: "not_proven",
          reason: "handoff_observations_not_provided",
        }
      : unavailableFlow(flowString(digest.reason, 140) || "handoff_projection_invalid");
  }
  const counts = flowRecord(digest.counts);
  const origins = flowRecord(digest.origins);
  const integer = (v: unknown): v is number =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 128;
  if (
    !integer(digest.scenarios) ||
    digest.scenarios === 0 ||
    !counts ||
    !origins ||
    ![
      counts.verified,
      counts.normalBlock,
      counts.gaps,
      counts.notObserved,
      origins.offlineFixture,
      origins.naturalReceipt,
    ].every(integer) ||
    Number(counts.verified) +
      Number(counts.normalBlock) +
      Number(counts.gaps) +
      Number(counts.notObserved) !==
      digest.scenarios ||
    Number(origins.offlineFixture) + Number(origins.naturalReceipt) !==
      digest.scenarios - Number(counts.notObserved) ||
    !Array.isArray(digest.gapDetails) ||
    digest.gapDetails.length > 1 ||
    digest.gapDetails.some((value) => {
      const row = flowRecord(value);
      return (
        !row ||
        typeof row.scenarioId !== "string" ||
        !row.scenarioId ||
        !["normal_block", "handoff_gap", "not_observed"].includes(String(row.status))
      );
    }) ||
    digest.gapDetails.length + Number(digest.gapDetailsOmitted) !==
      Number(counts.normalBlock) + Number(counts.gaps) + Number(counts.notObserved) ||
    !integer(digest.gapDetailsOmitted)
  ) {
    return unavailableFlow("handoff_projection_invalid");
  }
  return {
    status: "observed",
    proofLevel: "receipt_handoff_only",
    semanticAdoption: "not_proven",
    scenarios: digest.scenarios,
    counts: {
      verified: Number(counts.verified),
      normalBlock: Number(counts.normalBlock),
      gaps: Number(counts.gaps),
      notObserved: Number(counts.notObserved),
    },
    origins: {
      offlineFixture: Number(origins.offlineFixture),
      naturalReceipt: Number(origins.naturalReceipt),
    },
    gapDetails: digest.gapDetails.map((value) => {
      const row = flowRecord(value);
      return {
        scenarioId: flowString(row?.scenarioId, 100),
        status: flowString(row?.status, 32),
        owner: flowString(row?.owner, 120),
        reason: flowString(row?.reason, 140),
      };
    }),
    gapDetailsOmitted: digest.gapDetailsOmitted,
  };
}
