import crypto from "node:crypto";
import type {
  LcxOntologyBoundaryStatus,
  LcxOntologyEvidenceKind,
  LcxOntologyEvidenceStatus,
} from "./lcx-ontology.js";

/**
 * The shared execution receipt used to join operator runs without making the
 * receipt an authority over routing, training, providers, or delivery.
 *
 * Existing owners may keep their legacy top-level fields. The receipt is the
 * stable cross-owner join surface for automation, handoffs, and human views.
 */
export const LCX_RUN_RECEIPT_CONTRACT_VERSION = "lcx_run_receipt_v1" as const;

export const LCX_RUN_PHASES = ["observe", "repair", "verify", "handoff"] as const;
export type LcxRunPhase = (typeof LCX_RUN_PHASES)[number];

export const LCX_RUN_STATUSES = ["passed", "blocked", "failed"] as const;
export type LcxRunStatus = (typeof LCX_RUN_STATUSES)[number];

export type LcxRunBoundary = {
  scope: string;
  externalSender: LcxOntologyBoundaryStatus;
  training: LcxOntologyBoundaryStatus;
  providerConfig: LcxOntologyBoundaryStatus;
  protectedMemory: LcxOntologyBoundaryStatus;
};

export type LcxRunEvidence = {
  id: string;
  kind: LcxOntologyEvidenceKind;
  status: LcxOntologyEvidenceStatus;
  owner: string;
  locator: string;
  detail?: string;
};

export type LcxRunReceipt = {
  contractVersion: typeof LCX_RUN_RECEIPT_CONTRACT_VERSION;
  runId: string;
  parentRunId?: string;
  owner: string;
  phase: LcxRunPhase;
  status: LcxRunStatus;
  checkedAt: string;
  boundary: LcxRunBoundary;
  evidence: LcxRunEvidence[];
  nextAction: string;
};

export type BuildLcxRunReceiptParams = Omit<LcxRunReceipt, "contractVersion" | "evidence"> & {
  evidence?: readonly LcxRunEvidence[];
};

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must not be empty`);
  }
  return normalized;
}

function isTimestamp(value: string): boolean {
  return value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function normalizeBoundary(boundary: LcxRunBoundary): LcxRunBoundary {
  const statuses = [
    boundary.externalSender,
    boundary.training,
    boundary.providerConfig,
    boundary.protectedMemory,
  ];
  if (
    statuses.some((status) => !["unknown", "not_touched_by_projection", "touched"].includes(status))
  ) {
    throw new Error("run receipt boundary contains an unknown status");
  }
  return {
    scope: nonEmpty(boundary.scope, "boundary.scope"),
    externalSender: boundary.externalSender,
    training: boundary.training,
    providerConfig: boundary.providerConfig,
    protectedMemory: boundary.protectedMemory,
  };
}

export function buildLcxRunReceipt(params: BuildLcxRunReceiptParams): LcxRunReceipt {
  if (!LCX_RUN_PHASES.includes(params.phase)) {
    throw new Error(`unknown run phase: ${String(params.phase)}`);
  }
  if (!LCX_RUN_STATUSES.includes(params.status)) {
    throw new Error(`unknown run status: ${String(params.status)}`);
  }
  if (!isTimestamp(params.checkedAt)) {
    throw new Error("run receipt checkedAt must be a valid timestamp");
  }
  const evidence = (params.evidence ?? []).map((item) => ({
    id: nonEmpty(item.id, "evidence.id"),
    kind: item.kind,
    status: item.status,
    owner: nonEmpty(item.owner, "evidence.owner"),
    locator: nonEmpty(item.locator, "evidence.locator"),
    ...(item.detail?.trim() ? { detail: item.detail.trim() } : {}),
  }));
  if (new Set(evidence.map((item) => item.id)).size !== evidence.length) {
    throw new Error("run receipt evidence ids must be unique");
  }
  return {
    contractVersion: LCX_RUN_RECEIPT_CONTRACT_VERSION,
    runId: nonEmpty(params.runId, "runId"),
    ...(params.parentRunId?.trim() ? { parentRunId: params.parentRunId.trim() } : {}),
    owner: nonEmpty(params.owner, "owner"),
    phase: params.phase,
    status: params.status,
    checkedAt: params.checkedAt.trim(),
    boundary: normalizeBoundary(params.boundary),
    evidence,
    nextAction: nonEmpty(params.nextAction, "nextAction"),
  };
}

export function createLcxRunId(params: { checkedAt: string; owner: string; key?: string }): string {
  const timePart = params.checkedAt.replace(/[^0-9TZ]+/gu, "-").replace(/[:-]/gu, "-");
  const hash = crypto
    .createHash("sha256")
    .update(`${params.owner}|${params.key ?? params.checkedAt}`)
    .digest("hex")
    .slice(0, 8);
  const ownerPart = params.owner
    .replace(/[^a-zA-Z0-9_]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase();
  return `${timePart}-${ownerPart}-${hash}`;
}

export function boundaryFromFlags(params: {
  scope: string;
  externalSenderTouched?: boolean;
  trainingTouched?: boolean;
  providerConfigTouched?: boolean;
  protectedMemoryTouched?: boolean;
}): LcxRunBoundary {
  return {
    scope: params.scope,
    externalSender: params.externalSenderTouched ? "touched" : "not_touched_by_projection",
    training: params.trainingTouched ? "touched" : "not_touched_by_projection",
    providerConfig: params.providerConfigTouched ? "touched" : "not_touched_by_projection",
    protectedMemory: params.protectedMemoryTouched ? "touched" : "not_touched_by_projection",
  };
}
