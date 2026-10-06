import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  AGENT_ARTIFACT_MAX_BYTES,
  summarizeAgentArtifact,
} from "../agents/artifact-result-recording.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { readFileWithinRoot } from "../infra/fs-safe.js";
import { ArtifactStore, ArtifactStoreError } from "./artifact-store.js";

const ROOTS = [
  { root: "state/lcx-central-agent-runs", owner: "central_harness" },
  { root: "state/learning-workflow/runs", owner: "learning_distill" },
  { root: "memory/module-learning-pipeline-plan-receipts", owner: "module_learning_pipeline_plan" },
  { root: "memory/module-learning-pipeline-reviews", owner: "module_learning_pipeline_review" },
  { root: "state/artifacts", owner: "agent-artifact" },
] as const;

type Coverage = {
  root: string;
  owner: string;
  status: "complete" | "absent" | "partial";
  scanned: number;
  registered: number;
  unchanged: number;
  excluded: number;
};
export type OwnerArtifactBackfillReceipt = {
  status: "complete" | "partial" | "unavailable";
  scanned: number;
  registered: number;
  unchanged: number;
  gaps: { relativePath: string; reason: string }[];
  gapCount: number;
  truncated: boolean;
  coverage: Coverage[];
  excluded: { relativePath: string; reason: string }[];
};
function validTime(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function rejectAliases(workspace: string, relativePath: string): Promise<void> {
  let current = workspace;
  for (const part of relativePath.split("/")) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) {
      throw new ArtifactStoreError("artifact_backfill_alias_blocked");
    }
  }
}

/** Index only declared immutable owner outputs. This never rewrites or scans broad workspace state. */
export async function backfillOwnerArtifacts(input: {
  config: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  limit?: number;
  /** Cooperative run budget; finish the current bounded operation, then stop. */
  deadlineMs?: number;
}): Promise<OwnerArtifactBackfillReceipt> {
  const receipt: OwnerArtifactBackfillReceipt = {
    status: "complete",
    scanned: 0,
    registered: 0,
    unchanged: 0,
    gaps: [],
    gapCount: 0,
    truncated: false,
    coverage: [],
    excluded: [
      {
        relativePath: "logs/lcx-central-agent-log-latest.jsonl",
        reason: "mutable_jsonl_excluded_immutable_run_snapshots_indexed",
      },
    ],
  };
  const gap = (relativePath: string, reason: string) => {
    receipt.gapCount++;
    if (receipt.gaps.length < 200) {
      receipt.gaps.push({ relativePath, reason });
    }
    receipt.status = "partial";
  };
  let deadlineReached = false;
  const stopForDeadline = (coverage?: Coverage): boolean => {
    if (input.deadlineMs === undefined || Date.now() < input.deadlineMs) {
      return false;
    }
    if (!deadlineReached) {
      gap("", "artifact_backfill_deadline_reached");
    }
    deadlineReached = true;
    receipt.truncated = true;
    if (coverage) {
      coverage.status = "partial";
    }
    return true;
  };
  if (input.deadlineMs !== undefined && !Number.isFinite(input.deadlineMs)) {
    gap("", "artifact_backfill_deadline_invalid");
    return receipt;
  }
  if (stopForDeadline()) {
    return receipt;
  }
  const memory = resolveMemorySearchConfig(input.config, input.agentId);
  if (!memory?.enabled) {
    gap("", "artifact_backfill_memory_disabled");
    receipt.status = "unavailable";
    return receipt;
  }
  const limit = Math.min(
    10000,
    Math.max(1, Number.isFinite(input.limit) ? Math.trunc(input.limit!) : 10000),
  );
  let store: ArtifactStore | undefined;
  try {
    const workspace = await fs.realpath(input.workspaceDir);
    if (stopForDeadline()) {
      return receipt;
    }
    store = ArtifactStore.open({ dbPath: memory.store.path, workspaceDir: workspace });
    for (const owner of ROOTS) {
      if (stopForDeadline()) {
        break;
      }
      const coverage: Coverage = {
        ...owner,
        status: "complete",
        scanned: 0,
        registered: 0,
        unchanged: 0,
        excluded: 0,
      };
      receipt.coverage.push(coverage);
      const visit = async (relativeDir: string, depth: number): Promise<void> => {
        if (stopForDeadline(coverage)) {
          return;
        }
        if (receipt.scanned >= limit) {
          receipt.truncated = true;
          coverage.status = "partial";
          return;
        }
        let entries;
        try {
          await rejectAliases(workspace, relativeDir);
          if (stopForDeadline(coverage)) {
            return;
          }
          entries = await fs.readdir(path.join(workspace, relativeDir), { withFileTypes: true });
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT" && depth === 0) {
            coverage.status = "absent";
            return;
          }
          gap(
            relativeDir,
            error instanceof ArtifactStoreError
              ? error.code
              : "artifact_backfill_directory_unavailable",
          );
          coverage.status = "partial";
          return;
        }
        for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
          if (stopForDeadline(coverage)) {
            return;
          }
          if (entry.name.startsWith(".") || entry.name.includes(".pending-")) {
            coverage.excluded++;
            continue;
          }
          const relativePath = path.posix.join(relativeDir, entry.name);
          if (entry.isSymbolicLink()) {
            gap(relativePath, "artifact_backfill_alias_blocked");
            coverage.status = "partial";
            continue;
          }
          if (entry.isDirectory()) {
            if (depth >= 3) {
              gap(relativePath, "artifact_backfill_depth_limit");
              receipt.truncated = true;
              coverage.status = "partial";
            } else {
              await visit(relativePath, depth + 1);
            }
            continue;
          }
          if (!entry.isFile() || !entry.name.endsWith(".json")) {
            coverage.excluded++;
            continue;
          }
          if (receipt.scanned >= limit) {
            receipt.truncated = true;
            coverage.status = "partial";
            return;
          }
          receipt.scanned++;
          coverage.scanned++;
          try {
            await rejectAliases(workspace, relativePath);
            if (stopForDeadline(coverage)) {
              return;
            }
            const original = await readFileWithinRoot({
              rootDir: workspace,
              relativePath,
              maxBytes: AGENT_ARTIFACT_MAX_BYTES,
            });
            if (stopForDeadline(coverage)) {
              return;
            }
            if (original.realPath !== path.join(workspace, relativePath)) {
              throw new ArtifactStoreError("artifact_backfill_alias_blocked");
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(original.buffer),
              );
            } catch {
              throw new ArtifactStoreError("artifact_backfill_json_invalid");
            }
            const record = object(parsed);
            if (!record) {
              throw new ArtifactStoreError("artifact_backfill_json_object_required");
            }
            const envelope = owner.root === "state/artifacts";
            const sha256 = createHash("sha256").update(original.buffer).digest("hex");
            if (
              envelope &&
              (record.schemaVersion !== "lcx_agent_artifact_v1" ||
                typeof record.owner !== "string" ||
                typeof record.runId !== "string" ||
                !Object.hasOwn(record, "value") ||
                entry.name !== `${sha256}.json`)
            ) {
              throw new ArtifactStoreError("artifact_backfill_envelope_invalid");
            }
            const id = envelope
              ? `artifact-${createHash("sha256")
                  .update(JSON.stringify([workspace, sha256]))
                  .digest("hex")}`
              : `owner-artifact-${createHash("sha256")
                  .update(JSON.stringify([workspace, relativePath]))
                  .digest("hex")}`;
            const observed =
              validTime(record.observedAt) ??
              validTime(record.updatedAt) ??
              validTime(record.generatedAt);
            let observedAt = envelope
              ? original.stat.mtime.toISOString()
              : (observed ?? original.stat.mtime.toISOString());
            if (envelope) {
              try {
                // A production caller may have provided a source observation time instead of mtime.
                // Preserve it only after verifying that the registered original still matches its SHA.
                observedAt = (await store!.read(id)).artifact.observedAt;
              } catch (error) {
                if (
                  !(error instanceof ArtifactStoreError && error.code === "artifact_not_registered")
                ) {
                  throw error;
                }
              }
            }
            const run = object(record.run);
            const runId = envelope
              ? String(record.runId)
              : typeof record.runId === "string"
                ? record.runId
                : typeof run?.id === "string"
                  ? run.id
                  : entry.name.slice(0, -5);
            const cutoff = validTime(record.cutoff) ?? validTime(record.asOf);
            const sourceRefs = record.sourceReceiptRefs;
            if (
              envelope &&
              sourceRefs !== undefined &&
              (!Array.isArray(sourceRefs) || sourceRefs.some((ref) => typeof ref !== "string"))
            ) {
              throw new ArtifactStoreError("artifact_backfill_source_refs_invalid");
            }
            if (stopForDeadline(coverage)) {
              return;
            }
            const registered = await store!.register({
              id,
              owner: envelope ? String(record.owner) : owner.owner,
              runId,
              observedAt,
              relativePath,
              mimeType: "application/json",
              summary: envelope
                ? summarizeAgentArtifact(record.value)
                : `${owner.owner} run ${runId}; observation time source: ${observed ? "receipt" : "file_mtime"}`,
              ...(cutoff && !envelope ? { cutoff } : {}),
              ...(envelope && sourceRefs !== undefined
                ? { sourceReceiptRefs: sourceRefs as string[] }
                : {}),
            });
            receipt[registered.status]++;
            coverage[registered.status]++;
          } catch (error) {
            gap(
              relativePath,
              error instanceof ArtifactStoreError
                ? error.code
                : "artifact_backfill_original_unavailable",
            );
            coverage.status = "partial";
          }
        }
      };
      await visit(owner.root, 0);
    }
    if (receipt.truncated && !deadlineReached) {
      gap("", "artifact_backfill_limit_or_depth_reached");
    }
  } catch (error) {
    gap("", error instanceof ArtifactStoreError ? error.code : "artifact_backfill_unavailable");
    receipt.status = "unavailable";
  } finally {
    store?.close();
  }
  return receipt;
}
