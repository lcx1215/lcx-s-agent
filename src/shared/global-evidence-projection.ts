/**
 * A read-only, medium-neutral projection of owner evidence.
 *
 * This module deliberately does not own any workflow. Callers provide the
 * already-checked owner verdicts, and this module gives Codex, LCX, local
 * automation, and delivery adapters one small shape for reading them.
 */

import {
  LCX_ONTOLOGY_CAPABILITY_ROLES,
  LCX_ONTOLOGY_VERSION,
  LCX_ONTOLOGY_SURFACE_IDS,
  isLcxOntologyValue,
} from "./lcx-ontology.js";
import type {
  LcxOntologyActionKind,
  LcxOntologyActionStatus,
  LcxOntologyAdaptability,
  LcxOntologyBoundaryStatus,
  LcxOntologyCapabilityCoverage,
  LcxOntologyCapabilityMaturity,
  LcxOntologyCapabilityRole,
  LcxOntologyDeliveryProofVisibility,
  LcxOntologyDeliveryState,
  LcxOntologyEvidenceKind,
  LcxOntologyEvidenceStatus,
  LcxOntologySurfaceId,
} from "./lcx-ontology.js";

export const GLOBAL_EVIDENCE_PROJECTION_VERSION = "global_evidence_projection_v1" as const;
export const GLOBAL_EVIDENCE_PROJECTION_MODE = "read_only_shadow" as const;
export type GlobalProjectionSurface = LcxOntologySurfaceId;
export type GlobalProjectionEvidenceKind = LcxOntologyEvidenceKind;
export type GlobalProjectionEvidenceStatus = LcxOntologyEvidenceStatus;
export type GlobalProjectionCoverage = LcxOntologyCapabilityCoverage;
export type GlobalProjectionMaturity = LcxOntologyCapabilityMaturity;
export type GlobalProjectionAdaptability = LcxOntologyAdaptability;
export type GlobalProjectionCapabilityRole = LcxOntologyCapabilityRole;
export type GlobalProjectionActionKind = LcxOntologyActionKind;
export type GlobalProjectionActionStatus = LcxOntologyActionStatus;
export type GlobalProjectionDeliveryState = LcxOntologyDeliveryState;
export type GlobalProjectionBoundaryStatus = LcxOntologyBoundaryStatus;
export type GlobalProjectionMissingItem = {
  surface: GlobalProjectionSurface;
  term: string;
};
export type GlobalProjectionLaneInput = {
  id: string;
  masterLane: string;
  /** Optional implementation lanes are observed, not mind-model authority. */
  role?: GlobalProjectionCapabilityRole;
  objective: string;
  ok: boolean;
  missing: readonly GlobalProjectionMissingItem[];
  evidence: readonly string[];
  nextAction: string;
};
export type GlobalProjectionInvariantInput = {
  id: string;
  category: string;
  objective: string;
  ok: boolean;
  missing: readonly GlobalProjectionMissingItem[];
  nextAction: string;
};
export type GlobalProjectionSourceRef = {
  owner: string;
  locator: string;
  checkedAt: string;
};
export type GlobalProjectionDeliveryProof = {
  owner: string;
  receiptId: string;
  checkedAt: string;
  visibility: LcxOntologyDeliveryProofVisibility;
};
export type GlobalProjectionDelivery = {
  /** Opaque adapter identity; null means no delivery proof is attached. */
  adapterId: string | null;
  state: GlobalProjectionDeliveryState;
  evidenceRefs: string[];
  proof?: GlobalProjectionDeliveryProof;
};
export type GlobalProjectionDeliveryInput =
  | {
      adapterId?: null;
      state?: "unknown";
      evidenceRefs?: readonly string[];
    }
  | {
      adapterId: string;
      state: "bound" | "observed";
      evidenceRefs: readonly string[];
      proof: GlobalProjectionDeliveryProof;
    };
export type GlobalProjectionBoundaries = {
  scope: "projection_only";
  externalSender: GlobalProjectionBoundaryStatus;
  training: GlobalProjectionBoundaryStatus;
  providerConfig: GlobalProjectionBoundaryStatus;
  protectedMemory: GlobalProjectionBoundaryStatus;
};
export type GlobalProjectionCapability = {
  id: string;
  domain: string;
  /** Optional for backward-compatible reads of older v1 receipts. */
  role?: GlobalProjectionCapabilityRole;
  objective: string;
  coverage: GlobalProjectionCoverage;
  maturity: GlobalProjectionMaturity;
  adaptability: GlobalProjectionAdaptability;
  evidenceRefs: string[];
};
export type GlobalProjectionEvidence = {
  id: string;
  kind: GlobalProjectionEvidenceKind;
  capabilityId?: string;
  status: GlobalProjectionEvidenceStatus;
  sourceRefs: GlobalProjectionSourceRef[];
  detail?: string;
};
export type GlobalProjectionAction = {
  id: string;
  kind: GlobalProjectionActionKind;
  status: GlobalProjectionActionStatus;
  capabilityId?: string;
  reason: string;
  evidenceRefs: string[];
};
export type GlobalEvidenceProjection = {
  contractVersion: typeof GLOBAL_EVIDENCE_PROJECTION_VERSION;
  /** Semantic vocabulary used by this projection; optional for older v1 receipts. */
  ontologyVersion?: typeof LCX_ONTOLOGY_VERSION;
  mode: typeof GLOBAL_EVIDENCE_PROJECTION_MODE;
  generatedAt: string;
  sourceOwners: string[];
  capabilities: GlobalProjectionCapability[];
  evidence: GlobalProjectionEvidence[];
  actions: GlobalProjectionAction[];
  delivery: GlobalProjectionDelivery;
  boundaries: GlobalProjectionBoundaries;
};
export type BuildGlobalEvidenceProjectionParams = {
  lanes: readonly GlobalProjectionLaneInput[];
  invariants: readonly GlobalProjectionInvariantInput[];
  generatedAt?: string;
  sourceOwners: readonly string[];
  delivery?: GlobalProjectionDeliveryInput;
  boundaries?: Partial<GlobalProjectionBoundaries>;
};
const SURFACES: readonly GlobalProjectionSurface[] = LCX_ONTOLOGY_SURFACE_IDS;
const CAPABILITY_ROLES: readonly GlobalProjectionCapabilityRole[] = LCX_ONTOLOGY_CAPABILITY_ROLES;
const LEGACY_ID_ALIASES: Record<string, string> = {
  local_live_status_words_stay_separate: "delivery_status_separation",
  skillopt_preflight_is_not_absorption_or_live_proof:
    "preflight_is_not_absorption_or_delivery_proof",
};

const ID_TOKEN_ALIASES: Record<string, string> = {
  channel: "adapter",
  dev: "core",
  live: "external",
};
function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
function neutralizeIdentifier(value: string): string {
  const trimmed = value.trim();
  const directAlias = LEGACY_ID_ALIASES[trimmed.toLowerCase()];
  if (directAlias) {
    return directAlias;
  }
  const normalized = trimmed
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((token) => ID_TOKEN_ALIASES[token.toLowerCase()] ?? token.toLowerCase())
    .join("_");
  return normalized || "unknown";
}
function neutralizeText(value: string): string {
  return value
    .replace(/\b(?:External\s*\/\s*External|External\s*\/\s*External)\b/giu, "message adapter")
    .replace(/(?<![A-Za-z0-9])(?:External|External)(?=[A-Z_-]|\b)/giu, "message_adapter")
    .replace(/\bdev[/-]live\b/giu, "core/adapter")
    .replace(/\blive-visible-fixed\b/giu, "observed")
    .replace(/\bdev-only\b/giu, "core-scoped")
    .replace(/(?<![A-Za-z0-9])dev(?=[A-Z_-]|\b)/giu, "core")
    .replace(/(?<![A-Za-z0-9])live(?=[A-Z_-]|\b)/giu, "external")
    .replace(/\bexternal[- ]channel\b/giu, "external adapter")
    .replace(/\bchannels?\b/giu, "adapter")
    .replace(/\s+/gu, " ")
    .trim();
}
function coverageFor(lane: GlobalProjectionLaneInput): GlobalProjectionCoverage {
  if (lane.missing.length === 0) {
    return "complete";
  }
  const missingSurfaces = new Set(lane.missing.map((item) => item.surface));
  return missingSurfaces.size >= SURFACES.length ? "missing" : "partial";
}
function assertOwnerInputConsistency(params: {
  lanes: readonly GlobalProjectionLaneInput[];
  invariants: readonly GlobalProjectionInvariantInput[];
}): void {
  for (const lane of params.lanes) {
    if (lane.role !== undefined && !CAPABILITY_ROLES.includes(lane.role)) {
      throw new Error(`lane ${lane.id} has an invalid capability role`);
    }
    if (lane.ok !== (lane.missing.length === 0)) {
      throw new Error(`lane ${lane.id} has inconsistent ok and missing evidence`);
    }
    for (const surface of SURFACES) {
      const detail = lane.evidence.find((item) =>
        item.toLowerCase().startsWith(`${surface.toLowerCase()}=`),
      );
      if (!detail || !detail.slice(detail.indexOf("=") + 1).trim()) {
        throw new Error(`lane ${lane.id} is missing ${surface} owner evidence`);
      }
    }
  }
  for (const invariant of params.invariants) {
    if (invariant.ok !== (invariant.missing.length === 0)) {
      throw new Error(`invariant ${invariant.id} has inconsistent ok and missing evidence`);
    }
  }
}
function sourceRefsFor(params: {
  sourceOwners: readonly string[];
  locator: string;
  checkedAt: string;
}): GlobalProjectionSourceRef[] {
  return params.sourceOwners.map((owner) => ({
    owner,
    locator: params.locator,
    checkedAt: params.checkedAt,
  }));
}
function isTimestamp(value: string): boolean {
  return value.trim().length > 0 && Number.isFinite(Date.parse(value));
}
function normalizeDelivery(input?: GlobalProjectionDeliveryInput): GlobalProjectionDelivery {
  const state = input?.state ?? "unknown";
  const adapterId = typeof input?.adapterId === "string" ? input.adapterId.trim() || null : null;
  const evidenceRefs = uniqueStrings(input?.evidenceRefs ?? []);
  const proof = input && "proof" in input ? input.proof : undefined;
  if (!isLcxOntologyValue("deliveryState", state)) {
    throw new Error(`unknown delivery state: ${String(state)}`);
  }
  if (state === "unknown" && (adapterId !== null || evidenceRefs.length > 0 || proof)) {
    throw new Error("unknown delivery state must not carry adapter or evidence proof");
  }
  if (state !== "unknown") {
    if (adapterId === null || evidenceRefs.length === 0) {
      throw new Error(`${state} delivery state requires adapterId and evidenceRefs`);
    }
    if (!proof) {
      throw new Error(`${state} delivery state requires an independent delivery proof`);
    }
    if (
      !proof.owner.trim() ||
      !proof.receiptId.trim() ||
      !isTimestamp(proof.checkedAt) ||
      !evidenceRefs.includes(proof.receiptId.trim()) ||
      (state === "bound" && proof.visibility !== "binding") ||
      (state === "observed" && proof.visibility !== "user_visible")
    ) {
      throw new Error(`${state} delivery state has invalid independent delivery proof`);
    }
  }

  return {
    adapterId,
    state,
    evidenceRefs,
    ...(proof
      ? {
          proof: {
            ...proof,
            owner: proof.owner.trim(),
            receiptId: proof.receiptId.trim(),
            checkedAt: proof.checkedAt.trim(),
          },
        }
      : {}),
  };
}
export function validateGlobalEvidenceProjection(projection: GlobalEvidenceProjection): string[] {
  const errors: string[] = [];
  if (projection.contractVersion !== GLOBAL_EVIDENCE_PROJECTION_VERSION) {
    errors.push("contractVersion must match GLOBAL_EVIDENCE_PROJECTION_VERSION");
  }
  if (
    projection.ontologyVersion !== undefined &&
    projection.ontologyVersion !== LCX_ONTOLOGY_VERSION
  ) {
    errors.push("ontologyVersion must match LCX_ONTOLOGY_VERSION");
  }
  if (projection.mode !== GLOBAL_EVIDENCE_PROJECTION_MODE) {
    errors.push("mode must be read_only_shadow");
  }
  if (!isTimestamp(projection.generatedAt)) {
    errors.push("generatedAt must be a valid timestamp");
  }
  if (projection.sourceOwners.length === 0) {
    errors.push("sourceOwners must contain at least one owner");
  }
  if (projection.boundaries.scope !== "projection_only") {
    errors.push("boundaries.scope must be projection_only");
  }
  if (
    [
      projection.boundaries.externalSender,
      projection.boundaries.training,
      projection.boundaries.providerConfig,
      projection.boundaries.protectedMemory,
    ].some((status) => !["unknown", "not_touched_by_projection", "touched"].includes(status))
  ) {
    errors.push("boundaries statuses must be known values");
  }
  if (!isLcxOntologyValue("deliveryState", projection.delivery.state)) {
    errors.push("delivery.state must be unknown, bound, or observed");
  } else if (projection.delivery.state === "unknown") {
    if (
      projection.delivery.adapterId !== null ||
      projection.delivery.evidenceRefs.length > 0 ||
      projection.delivery.proof
    ) {
      errors.push("unknown delivery state must not carry adapter or evidence proof");
    }
  } else if (
    projection.delivery.adapterId === null ||
    projection.delivery.evidenceRefs.length === 0 ||
    !projection.delivery.proof
  ) {
    errors.push("bound or observed delivery state requires adapterId, evidenceRefs, and proof");
  } else if (
    !projection.delivery.proof.owner.trim() ||
    !projection.delivery.proof.receiptId.trim() ||
    !isTimestamp(projection.delivery.proof.checkedAt) ||
    !projection.delivery.evidenceRefs.includes(projection.delivery.proof.receiptId.trim()) ||
    (projection.delivery.state === "bound" && projection.delivery.proof.visibility !== "binding") ||
    (projection.delivery.state === "observed" &&
      projection.delivery.proof.visibility !== "user_visible")
  ) {
    errors.push("delivery proof must include owner, receiptId, checkedAt, and matching visibility");
  }
  const capabilityIds = new Set(projection.capabilities.map((capability) => capability.id));
  const evidenceIds = new Set(projection.evidence.map((item) => item.id));
  const actionIds = new Set(projection.actions.map((action) => action.id));
  if (capabilityIds.size !== projection.capabilities.length) {
    errors.push("capabilities must have unique ids");
  }
  if (evidenceIds.size !== projection.evidence.length) {
    errors.push("evidence must have unique ids");
  }
  if (actionIds.size !== projection.actions.length) {
    errors.push("actions must have unique ids");
  }
  for (const capability of projection.capabilities) {
    if (capability.role !== undefined && !CAPABILITY_ROLES.includes(capability.role)) {
      errors.push(`capability ${capability.id} has an invalid role`);
    }
    if (capability.maturity !== "structural") {
      errors.push(`capability ${capability.id} cannot leave structural maturity in v1 shadow mode`);
    }
    if (capability.adaptability !== "adapter_neutral") {
      errors.push(
        `capability ${capability.id} cannot leave adapter-neutral mode in v1 shadow mode`,
      );
    }
    for (const evidenceRef of capability.evidenceRefs) {
      if (!evidenceIds.has(evidenceRef)) {
        errors.push(`capability ${capability.id} references unknown evidence ${evidenceRef}`);
      }
    }
  }
  for (const evidence of projection.evidence) {
    if (!isLcxOntologyValue("evidenceKind", evidence.kind)) {
      errors.push(`evidence ${evidence.id} has an invalid kind`);
    }
    if (!isLcxOntologyValue("evidenceStatus", evidence.status)) {
      errors.push(`evidence ${evidence.id} has an invalid status`);
    }
    if (evidence.sourceRefs.length === 0) {
      errors.push(`evidence ${evidence.id} must include sourceRefs`);
    }
    for (const sourceRef of evidence.sourceRefs) {
      if (
        !sourceRef.owner.trim() ||
        !sourceRef.locator.trim() ||
        !isTimestamp(sourceRef.checkedAt)
      ) {
        errors.push(`evidence ${evidence.id} has an invalid sourceRef`);
      }
    }
    if (evidence.capabilityId && !capabilityIds.has(evidence.capabilityId)) {
      errors.push(`evidence ${evidence.id} references unknown capability ${evidence.capabilityId}`);
    }
  }
  for (const action of projection.actions) {
    if (!isLcxOntologyValue("actionKind", action.kind)) {
      errors.push(`action ${action.id} has an invalid kind`);
    }
    if (!isLcxOntologyValue("actionStatus", action.status)) {
      errors.push(`action ${action.id} has an invalid status`);
    }
    for (const evidenceRef of action.evidenceRefs) {
      if (!evidenceIds.has(evidenceRef)) {
        errors.push(`action ${action.id} references unknown evidence ${evidenceRef}`);
      }
    }
    if (action.capabilityId && !capabilityIds.has(action.capabilityId)) {
      errors.push(`action ${action.id} references unknown capability ${action.capabilityId}`);
    }
  }
  return errors;
}
export function buildGlobalEvidenceProjection(
  params: BuildGlobalEvidenceProjectionParams,
): GlobalEvidenceProjection {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  if (!isTimestamp(generatedAt)) {
    throw new Error("generatedAt must be a valid timestamp");
  }
  assertOwnerInputConsistency(params);
  const sourceOwners = uniqueStrings(params.sourceOwners.map(neutralizeText));
  const evidence: GlobalProjectionEvidence[] = [];
  const capabilities = params.lanes.map((lane) => {
    const id = neutralizeIdentifier(lane.id);
    const evidenceRefs = SURFACES.map((surface) => `${id}:${surface}`);
    for (const surface of SURFACES) {
      const missing = lane.missing.filter((item) => item.surface === surface);
      const details = lane.evidence.filter((item) =>
        item.toLowerCase().startsWith(`${surface.toLowerCase()}=`),
      );
      evidence.push({
        id: `${id}:${surface}`,
        kind: surface,
        capabilityId: id,
        status: missing.length === 0 ? "present" : "missing",
        sourceRefs: sourceRefsFor({
          sourceOwners,
          locator: `capability:${id}:surface:${surface}`,
          checkedAt: generatedAt,
        }),
        ...(missing.length === 0
          ? details.length > 0
            ? { detail: neutralizeText(details.join(" | ")) }
            : {}
          : { detail: neutralizeText(missing.map((item) => item.term).join(", ")) }),
      });
    }
    return {
      id,
      domain: neutralizeIdentifier(lane.masterLane),
      role: lane.role ?? "core_architecture",
      objective: neutralizeText(lane.objective),
      coverage: coverageFor(lane),
      maturity: "structural",
      adaptability: "adapter_neutral",
      evidenceRefs,
    } satisfies GlobalProjectionCapability;
  });
  for (const invariant of params.invariants) {
    const id = neutralizeIdentifier(invariant.id);
    evidence.push({
      id: `invariant:${id}`,
      kind: "invariant",
      status: invariant.ok ? "present" : "missing",
      sourceRefs: sourceRefsFor({
        sourceOwners,
        locator: `invariant:${id}`,
        checkedAt: generatedAt,
      }),
      detail: neutralizeText(
        invariant.ok
          ? invariant.objective
          : invariant.missing.map((item) => `${item.surface}:${item.term}`).join(", "),
      ),
    });
  }
  const actions: GlobalProjectionAction[] = [];
  for (const lane of params.lanes.filter((candidate) => !candidate.ok)) {
    const capabilityId = neutralizeIdentifier(lane.id);
    actions.push({
      id: `repair:${capabilityId}`,
      kind: "repair",
      status: "blocked",
      capabilityId,
      reason: neutralizeText(lane.nextAction),
      evidenceRefs: lane.missing.map((item) => `${capabilityId}:${item.surface}`),
    });
  }
  for (const invariant of params.invariants.filter((candidate) => !candidate.ok)) {
    const id = neutralizeIdentifier(invariant.id);
    actions.push({
      id: `repair:invariant:${id}`,
      kind: "repair",
      status: "blocked",
      reason: neutralizeText(invariant.nextAction),
      evidenceRefs: [`invariant:${id}`],
    });
  }
  if (actions.length === 0) {
    actions.push({
      id: "observe:global-evidence-projection",
      kind: "observe",
      status: "recommended",
      reason: "Keep owner receipts authoritative; this projection remains read-only.",
      evidenceRefs: [],
    });
  }

  const projection: GlobalEvidenceProjection = {
    contractVersion: GLOBAL_EVIDENCE_PROJECTION_VERSION,
    ontologyVersion: LCX_ONTOLOGY_VERSION,
    mode: GLOBAL_EVIDENCE_PROJECTION_MODE,
    generatedAt,
    sourceOwners,
    capabilities,
    evidence,
    actions,
    delivery: normalizeDelivery(params.delivery),
    boundaries: {
      scope: "projection_only",
      externalSender: params.boundaries?.externalSender ?? "not_touched_by_projection",
      training: params.boundaries?.training ?? "not_touched_by_projection",
      providerConfig: params.boundaries?.providerConfig ?? "not_touched_by_projection",
      protectedMemory: params.boundaries?.protectedMemory ?? "not_touched_by_projection",
    },
  };
  const errors = validateGlobalEvidenceProjection(projection);
  if (errors.length > 0) {
    throw new Error(`invalid Global Evidence Projection: ${errors.join("; ")}`);
  }
  return projection;
}
