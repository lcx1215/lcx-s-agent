import {
  validateGlobalEvidenceProjection,
  type GlobalEvidenceProjection,
} from "./global-evidence-projection.ts";

export const GLOBAL_EVIDENCE_PROJECTION_MAX_AGE_MS = 5 * 60 * 1000;
export type GlobalEvidenceProjectionReadStatus = "current" | "stale" | "missing" | "invalid";

export type GlobalEvidenceProjectionRead = {
  sourceOwner: string;
  readStatus: GlobalEvidenceProjectionReadStatus;
  blocked: boolean;
  generatedAt: string | null;
  maxAgeSeconds: number;
  reason: string;
  projection: GlobalEvidenceProjection | null;
};

export type GlobalEvidenceProjectionView = {
  sourceOwner: string;
  readStatus: GlobalEvidenceProjectionReadStatus;
  blocked: boolean;
  generatedAt: string | null;
  maxAgeSeconds: number;
  reason: string;
  capabilityCount: number;
  evidenceCount: number;
  actionCount: number;
  deliveryState: GlobalEvidenceProjection["delivery"]["state"] | null;
  adapterId: string | null;
};

/**
 * Reduce a projection read to a safe, read-only display shape.
 *
 * Blocked reads intentionally hide projection payload details so stale or
 * invalid evidence cannot be mistaken for actionable current state.
 */
export function summarizeGlobalEvidenceProjectionRead(
  read: GlobalEvidenceProjectionRead,
): GlobalEvidenceProjectionView {
  const projection = read.blocked ? null : read.projection;
  return {
    sourceOwner: read.sourceOwner,
    readStatus: read.readStatus,
    blocked: read.blocked,
    generatedAt: read.generatedAt,
    maxAgeSeconds: read.maxAgeSeconds,
    reason: read.reason,
    capabilityCount: projection?.capabilities.length ?? 0,
    evidenceCount: projection?.evidence.length ?? 0,
    actionCount: projection?.actions.length ?? 0,
    deliveryState: projection?.delivery.state ?? null,
    adapterId: projection?.delivery.adapterId ?? null,
  };
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

type ProjectionReadEnvelope = {
  readStatus?: unknown;
  blocked?: unknown;
  reason?: unknown;
  projection?: unknown;
};

const READ_STATUSES: ReadonlySet<GlobalEvidenceProjectionReadStatus> = new Set([
  "current",
  "stale",
  "missing",
  "invalid",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asReadEnvelope(value: unknown): ProjectionReadEnvelope | undefined {
  const record = asRecord(value);
  if (!record || !("readStatus" in record || "blocked" in record)) {
    return undefined;
  }
  return record;
}

function asReadStatus(value: unknown): GlobalEvidenceProjectionReadStatus | undefined {
  return typeof value === "string" && READ_STATUSES.has(value as GlobalEvidenceProjectionReadStatus)
    ? (value as GlobalEvidenceProjectionReadStatus)
    : undefined;
}

function readProjectionPayload(
  candidate: unknown,
  checkedAt: string,
  base: { sourceOwner: string; maxAgeSeconds: number },
  maxAgeMs: number,
): GlobalEvidenceProjectionRead {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return {
      ...base,
      readStatus: "missing",
      blocked: true,
      generatedAt: null,
      reason: "projection_missing",
      projection: null,
    };
  }

  const projection = candidate as GlobalEvidenceProjection;
  let errors: string[] = [];
  try {
    errors = validateGlobalEvidenceProjection(projection);
  } catch {
    errors = ["projection_shape_invalid"];
  }
  if (errors.length > 0) {
    return {
      ...base,
      readStatus: "invalid",
      blocked: true,
      generatedAt: isTimestamp(projection.generatedAt) ? projection.generatedAt : null,
      reason: "projection_invalid",
      projection: null,
    };
  }

  if (!isTimestamp(checkedAt)) {
    return {
      ...base,
      readStatus: "stale",
      blocked: true,
      generatedAt: projection.generatedAt,
      reason: "consumer_check_time_invalid",
      projection,
    };
  }
  const ageMs = Date.parse(checkedAt) - Date.parse(projection.generatedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeMs) {
    return {
      ...base,
      readStatus: "stale",
      blocked: true,
      generatedAt: projection.generatedAt,
      reason: ageMs < 0 ? "projection_time_ahead" : "projection_stale",
      projection,
    };
  }
  return {
    ...base,
    readStatus: "current",
    blocked: false,
    generatedAt: projection.generatedAt,
    reason: "projection_current",
    projection,
  };
}

export function readGlobalEvidenceProjection(
  candidate: unknown,
  checkedAt: string,
  options: { sourceOwner?: string; maxAgeMs?: number } = {},
): GlobalEvidenceProjectionRead {
  const sourceOwner = options.sourceOwner?.trim() || "unknown-owner";
  const maxAgeMs = options.maxAgeMs ?? GLOBAL_EVIDENCE_PROJECTION_MAX_AGE_MS;
  const base = { sourceOwner, maxAgeSeconds: maxAgeMs / 1000 };
  const envelope = asReadEnvelope(candidate);
  const read = readProjectionPayload(
    envelope ? envelope.projection : candidate,
    checkedAt,
    base,
    maxAgeMs,
  );
  if (!envelope) {
    return read;
  }

  const envelopeStatus = asReadStatus(envelope.readStatus);
  if (!envelopeStatus || typeof envelope.blocked !== "boolean") {
    return {
      ...read,
      readStatus: "invalid",
      blocked: true,
      reason: "projection_read_envelope_invalid",
      projection: null,
    };
  }
  const statusIsCurrent = envelopeStatus === "current";
  if (statusIsCurrent === envelope.blocked) {
    return {
      ...read,
      readStatus: "invalid",
      blocked: true,
      reason: "projection_read_envelope_inconsistent",
      projection: null,
    };
  }
  if (!statusIsCurrent) {
    const upstreamReason =
      typeof envelope.reason === "string" && envelope.reason.trim().length > 0
        ? envelope.reason.trim()
        : "projection_not_current";
    return {
      ...read,
      readStatus: envelopeStatus,
      blocked: true,
      reason: `upstream_${upstreamReason}`,
    };
  }
  return read;
}
