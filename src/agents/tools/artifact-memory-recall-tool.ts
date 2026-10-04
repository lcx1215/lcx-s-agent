import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { ArtifactStore, ArtifactStoreError } from "../../memory/artifact-store.js";
import { resolveAgentWorkspaceDir } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const ArtifactRecallSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("search"), Type.Literal("read")]),
    query: Type.Optional(
      Type.String({
        description:
          "Search text; omit or use an empty query to browse this workspace's registered results.",
      }),
    ),
    cursor: Type.Optional(
      Type.String({
        description:
          "Copy nextCursor from the previous page; keep query, owner and asOf unchanged.",
      }),
    ),
    id: Type.Optional(Type.String()),
    field: Type.Optional(
      Type.String({
        description:
          "Optional RFC6901 JSON Pointer on a verified, complete bounded JSON text result, such as /value/beta.",
      }),
    ),
    owner: Type.Optional(Type.String()),
    asOf: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

function preview(text: string): { preview: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, 160);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
    end--;
  }
  return { preview: bytes.subarray(0, end).toString("utf8"), truncated: bytes.length > end };
}
function selectJsonField(text: string | undefined, truncated: boolean, field: string): unknown {
  if (truncated || text === undefined) {
    throw new ArtifactStoreError("artifact_field_text_unavailable");
  }
  if (field.length > 1024 || (field !== "" && !field.startsWith("/"))) {
    throw new ArtifactStoreError("artifact_field_invalid");
  }
  const parts = field === "" ? [] : field.slice(1).split("/");
  if (parts.length > 16 || parts.some((part) => /~(?![01])/u.test(part))) {
    throw new ArtifactStoreError("artifact_field_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ArtifactStoreError("artifact_field_json_unavailable");
  }
  for (const part of parts) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) {
      throw new ArtifactStoreError("artifact_field_missing");
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Host-selected existing DB and workspace; a model can only search or read registered IDs. */
export function createArtifactMemoryRecallTool(options: {
  config?: OpenClawConfig;
  agentId?: string;
  workspaceDir?: string;
}): AnyAgentTool {
  return {
    label: "Artifact Memory Recall",
    name: "artifact_memory_recall",
    description:
      "Search registered owner results and conclusions, or read an original by its registered ID with source-time and SHA verification. Local read only. Binary results return a verified original reference, not inferred contents.",
    parameters: ArtifactRecallSchema,
    execute: async (_toolCallId, input, signal) => {
      const args = (input ?? {}) as Record<string, unknown>;
      if (signal?.aborted) {
        return jsonResult({
          available: false,
          authority: "local_read",
          gap: "artifact_recall_cancelled",
        });
      }
      const cfg = options.config;
      if (!cfg) {
        return jsonResult({
          available: false,
          gap: "artifact_memory_config_missing",
          authority: "local_read",
        });
      }
      const agentId = options.agentId ?? "main";
      const memoryConfig = resolveMemorySearchConfig(cfg, agentId);
      if (!memoryConfig?.enabled) {
        return jsonResult({
          available: false,
          gap: "artifact_memory_disabled",
          authority: "local_read",
        });
      }
      let store: ArtifactStore | undefined;
      try {
        const action = readStringParam(args, "action", { required: true });
        if (action !== "search" && action !== "read") {
          throw new ArtifactStoreError("artifact_action_invalid");
        }
        if (signal?.aborted) {
          throw new ArtifactStoreError("artifact_recall_cancelled");
        }
        store = ArtifactStore.open({
          dbPath: memoryConfig.store.path,
          workspaceDir: options.workspaceDir ?? resolveAgentWorkspaceDir(cfg, agentId),
          readOnly: true,
        });
        if (action === "search" && args.query !== undefined && typeof args.query !== "string") {
          throw new ArtifactStoreError("artifact_query_invalid");
        }
        if (action === "search" && args.cursor !== undefined && typeof args.cursor !== "string") {
          throw new ArtifactStoreError("artifact_cursor_invalid");
        }
        const result =
          action === "search"
            ? store.search({
                query: readStringParam(args, "query", { allowEmpty: true }),
                cursor: readStringParam(args, "cursor", { allowEmpty: true, trim: false }),
                owner: readStringParam(args, "owner"),
                asOf: readStringParam(args, "asOf"),
                limit: readNumberParam(args, "limit"),
              })
            : await store.read(readStringParam(args, "id", { required: true }));
        if (signal?.aborted) {
          throw new ArtifactStoreError("artifact_recall_cancelled");
        }
        if ("artifacts" in result) {
          const { hasMore, nextCursor, ...searchResult } = result;
          return jsonResult({
            available: true,
            authority: "local_read",
            action,
            hasMore,
            nextCursor,
            latestArtifactId: result.artifacts[0]?.id ?? null,
            count: result.artifacts.length,
            ...searchResult,
          });
        }
        const asOf = readStringParam(args, "asOf");
        if (asOf !== undefined) {
          const cutoff = Date.parse(asOf);
          if (!Number.isFinite(cutoff)) {
            throw new ArtifactStoreError("artifact_timestamp_invalid");
          }
          if (
            Date.parse(result.artifact.observedAt) > cutoff ||
            (result.artifact.cutoff !== undefined && Date.parse(result.artifact.cutoff) > cutoff)
          ) {
            throw new ArtifactStoreError("artifact_after_cutoff");
          }
        }
        const field = readStringParam(args, "field", { allowEmpty: true, trim: false });
        const source = {
          sourceSha256: result.artifact.sha256,
          sourceObservedAt: result.artifact.observedAt,
          ...(result.artifact.cutoff ? { sourceCutoff: result.artifact.cutoff } : {}),
        };
        if (field !== undefined) {
          const selectedValue = selectJsonField(result.text, result.truncated, field);
          const selected = preview(JSON.stringify(selectedValue));
          return jsonResult({
            available: true,
            authority: "local_read",
            action,
            selectedValue,
            ...source,
            selectedPreview: selected.preview,
            selectedPreviewTruncated: selected.truncated,
            field,
            ...result,
          });
        }
        const text = preview(result.text ?? "");
        return jsonResult({
          available: true,
          authority: "local_read",
          action,
          ...source,
          textPreview: text.preview,
          previewTruncated: text.truncated || result.truncated,
          ...result,
        });
      } catch (error) {
        return jsonResult({
          available: false,
          authority: "local_read",
          gap: error instanceof ArtifactStoreError ? error.code : "artifact_recall_failed",
        });
      } finally {
        try {
          store?.close();
        } catch {
          /* Preserve the original result or named gap on cleanup failure. */
        }
      }
    },
  };
}
