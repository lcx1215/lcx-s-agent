import { createHash } from "node:crypto";
import {
  reviewUniverseCleanup,
  type CleanupReviewResult,
} from "../../../scripts/operator/lcx-change-impact-plan.js";
import type { OpenClawConfig } from "../../config/config.js";
import { readFileWithinRoot } from "../../infra/fs-safe.js";
import type { LcxRunReceipt, LcxRunSnapshot } from "../../shared/lcx-run-receipt.js";
import {
  recordAgentArtifact,
  type ArtifactRecordingReceipt,
} from "../artifact-result-recording.js";
import { buildCentralGovernanceInput } from "./governance-input.js";

type CompletedCleanupOwner = Readonly<{
  id: string;
  ok: boolean | undefined;
  compact: Readonly<Record<string, unknown>>;
  runReceipt: LcxRunReceipt;
}>;
type CleanupHandoffHost = Readonly<{
  config: OpenClawConfig | null;
  rootDir: string;
  repoRoot: string;
  parentRunId: string;
  snapshot: LcxRunSnapshot;
}>;
type CleanupArchiveRef = { path: string; sha256: string };
export type CleanupReviewHandoff = Readonly<{
  review: CleanupReviewResult;
  predecisionArtifact: ArtifactRecordingReceipt;
  selectedCandidates: number;
  omittedCandidates: number;
}>;
const CANDIDATE_FIELDS = [
  "untrackedRepoFiles",
  "unmatchedChangedFiles",
  "staleRuntimeFiles",
  "largeRuntimeFiles",
  "staleSnapshots",
] as const;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("cleanup_review_source_shape_invalid");
  }
  return value as Record<string, unknown>;
}

/** Join already completed owners at the original predecision seam; this never dispatches an owner. */
export async function reviewCleanupBeforeDecision(
  completedOwners: readonly CompletedCleanupOwner[],
  host: CleanupHandoffHost,
): Promise<CleanupReviewHandoff> {
  let predecisionArtifact: ArtifactRecordingReceipt = {
    status: "unavailable",
    reason: "cleanup_review_artifact_not_recorded",
  };
  let selectedCandidates = 0;
  let omittedCandidates = 0;
  try {
    if (!host.config) {
      predecisionArtifact = {
        status: "unavailable",
        reason: "cleanup_review_artifact_config_unavailable",
      };
      throw new Error("cleanup_review_artifact_config_unavailable");
    }
    const input = buildCentralGovernanceInput(completedOwners, {
      parentRunId: host.parentRunId,
      snapshot: host.snapshot,
    });
    predecisionArtifact = await recordAgentArtifact({
      config: host.config,
      agentId: "main",
      workspaceDir: host.rootDir,
      owner: "lcx-governance-autopilot",
      runId: host.parentRunId,
      observedAt: input.checkedAt,
      value: input,
    });
    if (
      !predecisionArtifact.relativePath ||
      !predecisionArtifact.sha256 ||
      !["registered", "unchanged"].includes(predecisionArtifact.status)
    ) {
      throw new Error(`cleanup_review_artifact_unavailable:${predecisionArtifact.reason}`);
    }
    const sources = Object.fromEntries<CleanupArchiveRef>(
      ["universeIndex", "mindModel", "flowGraph", "contextRecovery"].map(
        (id): [string, CleanupArchiveRef] => {
          const rows = completedOwners.filter((owner) => owner.id === id);
          if (rows.length !== 1) {
            throw new Error(`cleanup_review_owner_receipt_missing:${id}`);
          }
          const evidence = rows[0].compact.artifactEvidence;
          if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
            throw new Error(`cleanup_review_source_ref_missing:${id}`);
          }
          const recording = evidence as Record<string, unknown>;
          if (
            ["registered", "unchanged"].includes(String(recording.status)) &&
            typeof recording.sha256 === "string" &&
            typeof recording.relativePath === "string" &&
            /^[a-f0-9]{64}$/u.test(recording.sha256) &&
            recording.relativePath === `state/artifacts/${recording.sha256}.json`
          ) {
            return [id, { path: recording.relativePath, sha256: recording.sha256 }];
          }
          throw new Error(`cleanup_review_source_ref_missing:${id}`);
        },
      ),
    );
    const universe = sources.universeIndex;
    const opened = await readFileWithinRoot({
      rootDir: host.rootDir,
      relativePath: universe.path,
      maxBytes: 16 * 1024 * 1024,
    });
    if (createHash("sha256").update(opened.buffer).digest("hex") !== universe.sha256) {
      throw new Error("cleanup_review_hash_conflict");
    }
    const candidates = record(
      record(JSON.parse(opened.buffer.toString("utf8"))).value,
    ).garbageCandidates;
    const inventory = record(candidates);
    const pointers: string[] = [];
    for (const key of CANDIDATE_FIELDS) {
      const values = inventory[key];
      if (!Array.isArray(values)) {
        throw new Error(`cleanup_review_field_missing:/value/garbageCandidates/${key}`);
      }
      for (let index = 0; index < values.length; index += 1) {
        if (pointers.length < 256) {
          pointers.push(`/value/garbageCandidates/${key}/${index}`);
        } else {
          omittedCandidates += 1;
        }
      }
    }
    selectedCandidates = pointers.length;
    const review = await reviewUniverseCleanup(
      {
        schemaVersion: 2,
        governance: { path: predecisionArtifact.relativePath, sha256: predecisionArtifact.sha256 },
        sources,
        candidates: pointers,
      },
      host,
    );
    return { review, predecisionArtifact, selectedCandidates, omittedCandidates };
  } catch (error) {
    const review = await reviewUniverseCleanup(undefined, host);
    review.reason = error instanceof Error ? error.message : "cleanup_review_handoff_failed";
    return { review, predecisionArtifact, selectedCandidates, omittedCandidates };
  }
}

function clipUtf8(value: string, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) {
      break;
    }
    output += character;
    bytes += size;
  }
  return output;
}

function emptyCompact(reason: string) {
  return {
    status: "blocked" as "blocked" | "reviewed",
    reason,
    count: 0,
    preserve: 0,
    unknown: 0,
    selectedCandidates: 0,
    omittedCandidates: 0,
    coverage: "selected_candidates_only" as const,
    missingChecks: [] as string[],
    missingChecksOmitted: 0,
    semanticTruth: "not_proven" as const,
    cleanupAuthorized: false as const,
    detailPointers: {
      sourceReads: "/value/cleanupReview/sourceReads",
      dispositions: "/value/cleanupReview/dispositions",
    },
  };
}

/** Re-project persisted summaries through a whitelist; source bodies never enter decision input. */
export function projectCleanupReview(value: unknown) {
  try {
    const source = record(value);
    const count = (key: string) => {
      const number = source[key];
      if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
        throw new Error("cleanup_review_projection_invalid");
      }
      return number;
    };
    const counts = {
      count: count("count"),
      preserve: count("preserve"),
      unknown: count("unknown"),
      selectedCandidates: count("selectedCandidates"),
      omittedCandidates: count("omittedCandidates"),
    };
    if (
      !["reviewed", "blocked"].includes(String(source.status)) ||
      typeof source.reason !== "string" ||
      source.cleanupAuthorized !== false ||
      source.semanticTruth !== "not_proven" ||
      source.coverage !== "selected_candidates_only" ||
      counts.selectedCandidates > 256 ||
      counts.preserve + counts.unknown !== counts.count ||
      (source.status === "reviewed"
        ? counts.count !== counts.selectedCandidates
        : counts.count !== 0) ||
      !Array.isArray(source.missingChecks) ||
      source.missingChecks.slice(0, 4).some((check) => typeof check !== "string")
    ) {
      throw new Error("cleanup_review_projection_invalid");
    }
    const summary = {
      ...emptyCompact(""),
      ...counts,
      status: source.status as "reviewed" | "blocked",
      reason: clipUtf8(source.reason, 180),
      missingChecks: source.missingChecks.slice(0, 4).map((check) => clipUtf8(check as string, 48)),
      missingChecksOmitted:
        count("missingChecksOmitted") + Math.max(0, source.missingChecks.length - 4),
    };
    if (!Number.isSafeInteger(summary.missingChecksOmitted)) {
      throw new Error("cleanup_review_projection_invalid");
    }
    return boundCompact(summary);
  } catch {
    return emptyCompact(
      value === undefined ? "cleanup_review_not_provided" : "cleanup_review_projection_invalid",
    );
  }
}

function boundCompact(summary: ReturnType<typeof emptyCompact>) {
  while (Buffer.byteLength(JSON.stringify(summary)) > 1200 && summary.missingChecks.length > 0) {
    summary.missingChecks.pop();
    summary.missingChecksOmitted += 1;
  }
  return summary;
}

/** Build the same bounded whitelist from a full original consumer result. */
export function compactCleanupReview(reviewValue: unknown, coverageValue: unknown) {
  try {
    const review = record(reviewValue);
    const coverage = record(coverageValue);
    if (!Array.isArray(review.dispositions) || review.dispositions.length > 256) {
      throw new Error("cleanup_review_projection_invalid");
    }
    const rows = review.dispositions.map(record);
    if (
      rows.some(
        (row) =>
          !["preserve", "unknown"].includes(String(row.disposition)) ||
          !Array.isArray(row.missingChecks) ||
          row.missingChecks.length > 128 ||
          row.missingChecks.some((check) => typeof check !== "string"),
      )
    ) {
      throw new Error("cleanup_review_projection_invalid");
    }
    const checks = [...new Set(rows.flatMap((row) => row.missingChecks as string[]))];
    return projectCleanupReview({
      status: review.status,
      reason: review.reason,
      count: rows.length,
      preserve: rows.filter((row) => row.disposition === "preserve").length,
      unknown: rows.filter((row) => row.disposition === "unknown").length,
      selectedCandidates: coverage.selectedCandidates,
      omittedCandidates: coverage.omittedCandidates,
      coverage: review.coverage,
      missingChecks: checks,
      missingChecksOmitted: 0,
      semanticTruth: review.semanticTruth,
      cleanupAuthorized: review.cleanupAuthorized,
    });
  } catch {
    return emptyCompact("cleanup_review_projection_invalid");
  }
}
