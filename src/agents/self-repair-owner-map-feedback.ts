import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFileWithinRoot } from "../infra/fs-safe.js";
import {
  LCX_ONTOLOGY_EVIDENCE_KINDS,
  LCX_ONTOLOGY_EVIDENCE_STATUSES,
} from "../shared/lcx-ontology.js";
import {
  buildLcxRunReceipt,
  createLcxRunSnapshot,
  LCX_RUN_PHASES,
  LCX_RUN_STATUSES,
  LCX_RUN_RECEIPT_CONTRACT_VERSION,
  type LcxRunReceipt,
  type LcxRunSnapshot,
} from "../shared/lcx-run-receipt.js";

type FileRef = { path: string; sha256: string };
type FeedbackStatus = "owner_visible" | "codex_can_act_when_safe" | "blocked_now" | "never_auto";
export type SelfRepairOwnerMapFeedback = {
  requested: true;
  status: "read" | "blocked";
  blockers: string[];
  map?: FileRef;
  governance?: FileRef;
  sourceRunId?: string;
  sourceCheckedAt?: string;
  snapshot?: LcxRunSnapshot;
  itemId?: string;
  itemStatus?: FeedbackStatus;
  diagnostic?: string;
  fieldRefs?: Array<FileRef & { pointer: string }>;
  semanticTruth: "not_proven";
  actionAuthority: false;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function reference(value: unknown): FileRef {
  const row = record(value);
  if (
    !row ||
    typeof row.path !== "string" ||
    !row.path.trim() ||
    typeof row.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.sha256)
  ) {
    throw new Error("owner_map_feedback_reference_invalid");
  }
  return { path: row.path, sha256: row.sha256 };
}

async function readPinned(workspaceDir: string, ref: FileRef, kind: string) {
  let bytes: Buffer;
  try {
    ({ buffer: bytes } = await readFileWithinRoot({
      rootDir: workspaceDir,
      relativePath: ref.path,
      maxBytes: 512 * 1024,
    }));
  } catch {
    throw new Error(`owner_map_feedback_${kind}_unreadable`);
  }
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== ref.sha256) {
    throw new Error(`owner_map_feedback_${kind}_hash_conflict`);
  }
  let value: Record<string, unknown> | undefined;
  try {
    value = record(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new Error(`owner_map_feedback_${kind}_invalid`);
  }
  if (!value) {
    throw new Error(`owner_map_feedback_${kind}_invalid`);
  }
  return value;
}

function sourceReceipt(value: unknown): LcxRunReceipt {
  const row = record(value);
  if (
    !row ||
    row.contractVersion !== LCX_RUN_RECEIPT_CONTRACT_VERSION ||
    !record(row.snapshot) ||
    !record(row.boundary) ||
    !LCX_RUN_STATUSES.some((status) => status === row.status) ||
    !LCX_RUN_PHASES.some((phase) => phase === row.phase) ||
    !Array.isArray(row.evidence) ||
    !Array.isArray(row.ontologyEdges) ||
    row.evidence.some((item) => {
      const evidence = record(item);
      return (
        !evidence ||
        !LCX_ONTOLOGY_EVIDENCE_KINDS.some((kind) => kind === evidence.kind) ||
        !LCX_ONTOLOGY_EVIDENCE_STATUSES.some((status) => status === evidence.status)
      );
    })
  ) {
    throw new Error("owner_map_feedback_run_receipt_invalid");
  }
  // Use the original receipt constructor for identity, boundary and ontology validation.
  const edges = row.ontologyEdges as LcxRunReceipt["ontologyEdges"];
  const generated = edges.filter(
    (edge) =>
      edge.relation === "produces" &&
      edge.subject.type === "module" &&
      edge.subject.id === row.owner &&
      edge.object.type === "receipt" &&
      edge.object.id === row.runId,
  );
  if (generated.length !== 1) {
    throw new Error("owner_map_feedback_receipt_producer_missing");
  }
  return buildLcxRunReceipt({
    ...(row as unknown as LcxRunReceipt),
    ontologyEdges: edges.filter((edge) => edge !== generated[0]),
  });
}

/** Explicit diagnostic read only; a legal reference cannot authorize repair or prove its truth. */
export async function readSelfRepairOwnerMapFeedback(
  workspaceDir: string,
  request: unknown,
  host: unknown,
): Promise<SelfRepairOwnerMapFeedback> {
  const result: SelfRepairOwnerMapFeedback = {
    requested: true,
    status: "blocked",
    blockers: [],
    semanticTruth: "not_proven",
    actionAuthority: false,
  };
  try {
    const selection = record(request);
    const expected = record(host);
    if (selection?.readError === "owner_map_feedback_manifest_unreadable") {
      throw new Error("owner_map_feedback_manifest_unreadable");
    }
    if (expected?.readError === "owner_map_feedback_host_unreadable") {
      throw new Error("owner_map_feedback_host_unreadable");
    }
    if (!selection || selection.schemaVersion !== 1 || typeof selection.itemId !== "string") {
      throw new Error("owner_map_feedback_manifest_invalid");
    }
    if (!expected || expected.schemaVersion !== 1 || typeof expected.sourceRunId !== "string") {
      throw new Error("owner_map_feedback_host_missing");
    }
    const snapshot = record(expected.snapshot);
    if (
      !snapshot ||
      ["snapshotId", "observedAt", "sourceCommit", "sourceBranch", "authorityOwner"].some(
        (field) => typeof snapshot[field] !== "string" || !snapshot[field].trim(),
      )
    ) {
      throw new Error("owner_map_feedback_host_snapshot_missing");
    }
    const hostSnapshot = createLcxRunSnapshot(snapshot as LcxRunSnapshot);
    result.map = reference(selection.map);
    result.governance = reference(selection.governance);
    result.itemId = selection.itemId;
    const map = await readPinned(workspaceDir, result.map, "map");
    const governance = await readPinned(workspaceDir, result.governance, "governance");
    if (
      map.kind !== "lcx-owner-control-map" ||
      map.boundary !== "local_owner_control_map_only" ||
      !Array.isArray(map.items) ||
      governance.boundary !== "local_governance_autopilot_only"
    ) {
      throw new Error("owner_map_feedback_source_kind_invalid");
    }
    const parent = sourceReceipt(governance.runReceipt);
    if (
      parent.owner !== "lcx-governance-autopilot" ||
      parent.runId !== expected.sourceRunId ||
      governance.runId !== parent.runId ||
      governance.checkedAt !== parent.checkedAt ||
      map.checkedAt !== parent.checkedAt ||
      !isDeepStrictEqual(parent.snapshot, hostSnapshot) ||
      !isDeepStrictEqual(governance.snapshot, hostSnapshot) ||
      !isDeepStrictEqual(map.snapshot, hostSnapshot) ||
      !isDeepStrictEqual(map.runReceipt, governance.runReceipt)
    ) {
      throw new Error("owner_map_feedback_source_scope_conflict");
    }
    const nowMs = expected.nowMs === undefined ? Date.now() : expected.nowMs;
    const age = typeof nowMs === "number" ? nowMs - Date.parse(parent.checkedAt) : NaN;
    if (!Number.isFinite(age) || age < 0) {
      throw new Error("owner_map_feedback_source_time_invalid");
    }
    if (
      expected.maxAgeMs !== undefined &&
      (typeof expected.maxAgeMs !== "number" ||
        !Number.isFinite(expected.maxAgeMs) ||
        expected.maxAgeMs < 0 ||
        age > expected.maxAgeMs)
    ) {
      throw new Error("owner_map_feedback_source_expired");
    }
    const matches = map.items.flatMap((value, index) => {
      const item = record(value);
      return item && item.id === selection.itemId ? [{ item, index }] : [];
    });
    if (matches.length !== 1) {
      throw new Error("owner_map_feedback_item_missing_or_duplicate");
    }
    const { item, index } = matches[0];
    const status = item.status;
    if (
      typeof status !== "string" ||
      !["owner_visible", "codex_can_act_when_safe", "blocked_now", "never_auto"].includes(status) ||
      typeof item.reason !== "string" ||
      !item.reason.trim() ||
      typeof item.nextControl !== "string" ||
      !item.nextControl.trim()
    ) {
      throw new Error("owner_map_feedback_item_invalid");
    }
    const bounded = (value: string) =>
      value.length <= 2048 ? value : `${value.slice(0, 2048)} [omitted; read referenced field]`;
    result.status = "read";
    result.sourceRunId = parent.runId;
    result.sourceCheckedAt = parent.checkedAt;
    result.snapshot = hostSnapshot;
    result.itemStatus = status as FeedbackStatus;
    result.diagnostic = [
      `Owner-map diagnostic only: sourceRunId=${parent.runId}; checkedAt=${parent.checkedAt}; item=${selection.itemId}; status=${status}.`,
      `Observed source reason: ${bounded(item.reason)}`,
      `Proposed diagnostic next step (not action authority): ${bounded(item.nextControl)}`,
    ].join("\n");
    result.fieldRefs = ["reason", "nextControl"].map((field) => ({
      ...result.map!,
      pointer: `/items/${index}/${field}`,
    }));
  } catch (error) {
    result.blockers = [error instanceof Error ? error.message : "owner_map_feedback_read_failed"];
  }
  return result;
}
