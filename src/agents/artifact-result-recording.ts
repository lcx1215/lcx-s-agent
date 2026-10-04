import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveBoundaryPath } from "../infra/boundary-path.js";
import { readFileWithinRoot, writeFileWithinRoot } from "../infra/fs-safe.js";
import { assertNoPathAliasEscape } from "../infra/path-alias-guards.js";
import { isPathInside } from "../infra/path-guards.js";
import { logWarn } from "../logger.js";
import { ArtifactStore, ArtifactStoreError } from "../memory/artifact-store.js";
import { resolveMemorySearchConfig } from "./memory-search.js";
import type { AnyAgentTool } from "./tools/common.js";

export const AGENT_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
export type ArtifactRecordingReceipt = Readonly<{
  status: "registered" | "unchanged" | "unavailable";
  reason: string;
  id?: string;
  sha256?: string;
  relativePath?: string;
}>;
export type ArtifactRecordingHost = Readonly<{
  config: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
}>;
type RecordingInput = ArtifactRecordingHost &
  Readonly<{
    owner: string;
    runId: string;
    observedAt?: string;
    value: unknown;
    sourceReceiptRefs?: readonly string[];
    signal?: AbortSignal;
  }>;

type UndefinedOmissions = { fields: string[]; count: number };
function validateJson(
  value: unknown,
  omissions: UndefinedOmissions,
  seen = new Set<object>(),
  depth = 0,
  field = "$",
): void {
  if (depth > 100) {
    throw new Error("artifact_value_unserializable");
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > AGENT_ARTIFACT_MAX_BYTES) {
      throw new Error("artifact_budget_exceeded");
    }
    return;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw new Error("artifact_value_unserializable");
  }
  if (seen.has(value)) {
    throw new Error("artifact_value_cyclic");
  }
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error("artifact_value_unserializable");
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      !descriptor.enumerable
    ) {
      throw new Error("artifact_value_unserializable");
    }
    const childField = `${field}/${encodeURIComponent(key)}`;
    if (!Array.isArray(value) && descriptor.value === undefined) {
      omissions.count++;
      if (omissions.fields.length < 16) {
        omissions.fields.push(excerpt(childField, 160));
      }
      continue;
    }
    validateJson(descriptor.value, omissions, seen, depth + 1, childField);
  }
  if (Array.isArray(value) && Object.keys(value).length !== value.length) {
    throw new Error("artifact_value_unserializable");
  }
  seen.delete(value);
}

function excerpt(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  let end = Math.min(bytes.length, maxBytes);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
    end--;
  }
  return bytes.subarray(0, end).toString("utf8");
}
export function summarizeAgentArtifact(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return excerpt(value, 256);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const content = (value as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      const text = content.find(
        (block) =>
          block &&
          typeof block === "object" &&
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim(),
      );
      if (text) {
        return excerpt(String(text.text), 256);
      }
      return excerpt(
        `JSON tool result: ${content.map((block) => (typeof block?.type === "string" ? block.type : "unknown")).join(", ")}`,
        256,
      );
    }
  }
  return "JSON result; inspect the original artifact for its contents.";
}

async function artifactPath(workspace: string, relativePath: string): Promise<string> {
  const resolved = await resolveBoundaryPath({
    rootPath: workspace,
    rootCanonicalPath: workspace,
    absolutePath: path.join(workspace, relativePath),
    boundaryLabel: "agent artifact",
  });
  if (!isPathInside(path.join(workspace, "state", "artifacts"), resolved.canonicalPath)) {
    throw new Error("artifact_path_blocked");
  }
  await assertNoPathAliasEscape({
    absolutePath: resolved.canonicalPath,
    rootPath: workspace,
    boundaryLabel: "agent artifact",
  });
  return resolved.canonicalPath;
}

/** Host-scoped result capture. Failures stay named evidence gaps, never business failures. */
export async function recordAgentArtifact(
  input: RecordingInput,
): Promise<ArtifactRecordingReceipt> {
  let store: ArtifactStore | undefined;
  let artifact: Pick<ArtifactRecordingReceipt, "id" | "sha256" | "relativePath"> = {};
  try {
    if (input.signal?.aborted) {
      return { status: "unavailable", reason: "artifact_recording_cancelled" };
    }
    const memory = resolveMemorySearchConfig(input.config, input.agentId);
    if (!memory) {
      return { status: "unavailable", reason: "artifact_recording_disabled" };
    }
    if (
      !input.owner ||
      input.owner.length > 128 ||
      !input.runId ||
      input.runId.length > 240 ||
      (input.observedAt !== undefined && !Number.isFinite(Date.parse(input.observedAt)))
    ) {
      throw new Error("artifact_metadata_invalid");
    }
    const envelope = {
      schemaVersion: "lcx_agent_artifact_v1",
      owner: input.owner,
      runId: input.runId,
      value: input.value,
      ...(input.sourceReceiptRefs ? { sourceReceiptRefs: [...input.sourceReceiptRefs] } : {}),
    };
    if (input.value === undefined) {
      throw new Error("artifact_value_unserializable");
    }
    const omissions: UndefinedOmissions = { fields: [], count: 0 };
    validateJson(envelope, omissions);
    const serialized =
      omissions.count > 0
        ? {
            ...envelope,
            omittedUndefinedFields: omissions.fields,
            omittedUndefinedCount: omissions.count,
          }
        : envelope;
    const bytes = Buffer.from(`${JSON.stringify(serialized)}\n`);
    if (bytes.length > AGENT_ARTIFACT_MAX_BYTES) {
      throw new Error("artifact_budget_exceeded");
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const workspace = await fs.realpath(input.workspaceDir);
    const id = `artifact-${createHash("sha256")
      .update(JSON.stringify([workspace, sha256]))
      .digest("hex")}`;
    const relativePath = `state/artifacts/${sha256}.json`;
    artifact = { id, sha256, relativePath };
    const destination = await artifactPath(workspace, relativePath);
    if (input.signal?.aborted) {
      throw new Error("artifact_recording_cancelled");
    }
    const temporary = `state/artifacts/.pending-${randomUUID()}.json`;
    const temporaryPath = await artifactPath(workspace, temporary);
    try {
      await writeFileWithinRoot({ rootDir: workspace, relativePath: temporary, data: bytes });
      await fs.chmod(temporaryPath, 0o600);
      await artifactPath(workspace, relativePath);
      if (input.signal?.aborted) {
        throw new Error("artifact_recording_cancelled");
      }
      try {
        await fs.link(temporaryPath, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
    } finally {
      await fs.unlink(temporaryPath).catch(() => {});
    }
    const original = await readFileWithinRoot({
      rootDir: workspace,
      relativePath,
      maxBytes: AGENT_ARTIFACT_MAX_BYTES,
    });
    if (!original.buffer.equals(bytes)) {
      throw new Error("artifact_identity_conflict");
    }
    if (input.signal?.aborted) {
      throw new Error("artifact_recording_cancelled");
    }
    store = ArtifactStore.open({ dbPath: memory.store.path, workspaceDir: workspace });
    const registered = await store.register({
      id,
      owner: input.owner,
      runId: input.runId,
      observedAt: input.observedAt ?? original.stat.mtime.toISOString(),
      relativePath,
      mimeType: "application/json",
      summary: summarizeAgentArtifact(input.value),
      ...(input.sourceReceiptRefs ? { sourceReceiptRefs: input.sourceReceiptRefs } : {}),
    });
    return { status: registered.status, reason: "ok", ...artifact };
  } catch (error) {
    const reason =
      error instanceof ArtifactStoreError
        ? error.code
        : error instanceof Error && /^artifact_[a-z_]+$/u.test(error.message)
          ? error.message
          : "artifact_recording_unavailable";
    return { status: "unavailable", reason, ...artifact };
  } finally {
    try {
      store?.close();
    } catch {
      /* A close failure cannot change the original business result. */
    }
  }
}

/** Preserve business result fields; expose only a small appended recording receipt to the model. */
export function withArtifactResultRecording(
  tool: AnyAgentTool,
  host: ArtifactRecordingHost,
): AnyAgentTool {
  if (
    [
      "artifact_search",
      "artifact_get",
      "artifact_read",
      "artifact_recall",
      "artifact_memory_recall",
    ].includes(tool.name)
  ) {
    return tool;
  }
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const result = await tool.execute(toolCallId, params, signal, onUpdate);
      const artifactEvidence = await recordAgentArtifact({
        ...host,
        owner: tool.name,
        runId: toolCallId,
        value: result,
        signal,
      });
      if (Object.hasOwn(result, "artifactEvidence")) {
        logWarn("artifact result recording: business artifactEvidence field preserved");
      }
      return {
        ...result,
        ...(!Object.hasOwn(result, "artifactEvidence") ? { artifactEvidence } : {}),
        content: [...result.content, { type: "text", text: JSON.stringify({ artifactEvidence }) }],
      };
    },
  };
}
