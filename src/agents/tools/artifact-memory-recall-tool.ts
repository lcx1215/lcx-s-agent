import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import {
  ARTIFACT_JSON_SOURCE_MAX_BYTES,
  ARTIFACT_TEXT_PREVIEW_MAX_BYTES,
  ArtifactStore,
  ArtifactStoreError,
} from "../../memory/artifact-store.js";
import { resolveAgentWorkspaceDir } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const TEXT_PAGE_MAX_BYTES = 2048;

/** Exact child pointers, never an inferred summary of the stored evidence. */
export function buildArtifactSelectionHints(field: string, value: unknown) {
  const hints: { field: string; bytes: number }[] = [];
  const addChildren = (parent: string, object: unknown, limit = 8) => {
    if (!object || typeof object !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(object)
      .toSorted(
        (a, b) => Buffer.byteLength(JSON.stringify(b[1])) - Buffer.byteLength(JSON.stringify(a[1])),
      )
      .slice(0, limit)) {
      const pointer = `${parent}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      const hint = { field: pointer, bytes: Buffer.byteLength(JSON.stringify(child)) };
      if (Buffer.byteLength(JSON.stringify([...hints, hint])) > 1024) {
        return;
      }
      hints.push(hint);
    }
  };
  addChildren(field, value);
  if (Array.isArray(value)) {
    for (const [index, child] of value.slice(0, 4).entries()) {
      addChildren(`${field}/${index}`, child, 2);
    }
  }
  return hints;
}

function artifactSelectionScope(text: string, field: string) {
  const scope: Record<string, string | readonly string[]> = {};
  let current: unknown = JSON.parse(text);
  const collect = () => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return;
    }
    const record = current as Record<string, unknown>;
    if (
      Array.isArray(record.instruments) &&
      record.instruments.length <= 16 &&
      record.instruments.every((item) => typeof item === "string" && item.length <= 128)
    ) {
      scope.instruments = record.instruments;
    }
    for (const key of ["accountId", "venue", "instrument", "ruleId"]) {
      if (typeof record[key] === "string" && record[key].length <= 128) {
        scope[key] = record[key];
      }
    }
  };
  collect();
  for (const token of field.slice(1).split("/")) {
    if (!current || typeof current !== "object") {
      break;
    }
    current = (current as Record<string, unknown>)[
      token.replaceAll("~1", "/").replaceAll("~0", "~")
    ];
    collect();
  }
  return scope;
}

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
          "Optional RFC6901 JSON Pointer on a verified JSON source up to the existing artifact size limit; return a selected field within 64 KiB, such as /value/beta. Large selected fields require a narrower pointer.",
      }),
    ),
    textOffset: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: ARTIFACT_JSON_SOURCE_MAX_BYTES,
        description:
          "Read a bounded UTF8 text page instead of a JSON field. Start at 0, then copy nextTextOffset; offsets refer to the returned text projection. Cannot combine with field.",
      }),
    ),
    textLimit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: TEXT_PAGE_MAX_BYTES,
        description:
          "Maximum UTF8 bytes per text page (default 2048); encoded text is also bounded.",
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

/** A missing key is still missing; expose real sibling pointers so the next read need not guess. */
function missingFieldHints(text: string, field: string) {
  let value: unknown = JSON.parse(text);
  let parent = "";
  for (const token of field.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) {
      return buildArtifactSelectionHints(parent, value);
    }
    parent += `/${token}`;
    value = (value as Record<string, unknown>)[key];
  }
  return [];
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
      "Search registered owner results and conclusions, or read an original by its registered ID with source-time and SHA verification. action is required: use action=read with id and optional field for an exact read, or action=search for discovery. Local read only. field must be an exact RFC6901 JSON Pointer, such as /value/status; dot/bracket paths are invalid. sourceAvailable=true retains a verified original or usable fragment even when the requested field is unavailable. For non-JSON or incomplete text, read textOffset=0 then nextTextOffset with the same ID and asOf; use textLimit for narrower pages. Truncated text remains partial evidence. Binary results provide original references, not inferred media meaning.",
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
        const action = typeof args.action === "string" ? args.action.trim() : args.action;
        if (action === undefined || action === null || action === "") {
          throw new ArtifactStoreError("artifact_action_required");
        }
        if (action !== "search" && action !== "read") {
          throw new ArtifactStoreError("artifact_action_invalid");
        }
        const textPageRequested = args.textOffset !== undefined || args.textLimit !== undefined;
        const textOffset = args.textOffset === undefined ? 0 : args.textOffset;
        const textLimit = args.textLimit === undefined ? TEXT_PAGE_MAX_BYTES : args.textLimit;
        if (
          textPageRequested &&
          (action !== "read" ||
            args.field !== undefined ||
            typeof textOffset !== "number" ||
            !Number.isSafeInteger(textOffset) ||
            textOffset < 0 ||
            textOffset > ARTIFACT_JSON_SOURCE_MAX_BYTES ||
            typeof textLimit !== "number" ||
            !Number.isSafeInteger(textLimit) ||
            textLimit < 1 ||
            textLimit > TEXT_PAGE_MAX_BYTES)
        ) {
          throw new ArtifactStoreError("artifact_text_page_invalid");
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
        const field =
          action === "read"
            ? readStringParam(args, "field", { allowEmpty: true, trim: false })
            : undefined;
        const result =
          action === "search"
            ? store.search({
                query: readStringParam(args, "query", { allowEmpty: true }),
                cursor: readStringParam(args, "cursor", { allowEmpty: true, trim: false }),
                owner: readStringParam(args, "owner"),
                asOf: readStringParam(args, "asOf"),
                limit: readNumberParam(args, "limit"),
              })
            : await store.read(readStringParam(args, "id", { required: true }), {
                completeJsonText: field !== undefined || textPageRequested,
              });
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
        const source = {
          sourceSha256: result.artifact.sha256,
          sourceObservedAt: result.artifact.observedAt,
          ...(result.artifact.cutoff ? { sourceCutoff: result.artifact.cutoff } : {}),
        };
        if (textPageRequested) {
          // Validation above fixes numeric bounds; all bytes still come through
          // the original store's full SHA, cutoff and mixed-media projection.
          const offset = textOffset as number;
          const limit = textLimit as number;
          const bytes = result.text === undefined ? undefined : Buffer.from(result.text);
          const pageSource = {
            authority: "local_read",
            action,
            artifactId: result.artifact.id,
            format: result.format,
            ...source,
            textOffset: offset,
            sourceTextTruncated: result.truncated,
            textProjection: result.textProjection ?? "original_utf8_text",
          };
          if (!bytes || (result.truncated && offset >= bytes.length)) {
            return jsonResult({
              available: false,
              ...pageSource,
              sourceAvailable: true,
              gap: bytes ? "artifact_text_source_limit_reached" : "artifact_text_unavailable",
            });
          }
          if (offset > bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)) {
            throw new ArtifactStoreError("artifact_text_offset_invalid");
          }
          let end = Math.min(bytes.length, offset + limit);
          let textPage: string;
          while (true) {
            while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
              end--;
            }
            if (end === offset && offset < bytes.length) {
              throw new ArtifactStoreError("artifact_text_page_too_small");
            }
            textPage = bytes.subarray(offset, end).toString("utf8");
            const encodedBytes = Buffer.byteLength(JSON.stringify(textPage));
            if (encodedBytes <= TEXT_PAGE_MAX_BYTES) {
              break;
            }
            // Bound escape-heavy text too; continuation starts at the actual
            // retained byte boundary, so shrinking a page never skips content.
            end = offset + Math.floor(((end - offset) * TEXT_PAGE_MAX_BYTES) / encodedBytes);
          }
          return jsonResult({
            available: true,
            ...pageSource,
            sourceBytes: result.artifact.bytes,
            availableTextBytes: bytes.length,
            textPage,
            textPageBytes: end - offset,
            hasMore: end < bytes.length,
            nextTextOffset: end < bytes.length ? end : null,
            ...(result.truncated && end === bytes.length
              ? { gap: "artifact_text_source_limit_reached" }
              : {}),
          });
        }
        if (field !== undefined) {
          const unavailableField = (
            gap: string,
            selectedText?: string,
            selectionHints?: ReturnType<typeof buildArtifactSelectionHints>,
          ) => {
            const fragment = preview(selectedText ?? result.text ?? "");
            return jsonResult({
              available: false,
              authority: "local_read",
              action,
              field,
              gap,
              sourceAvailable: true,
              selectionComplete: false,
              ...(selectionHints?.length ? { selectionHints } : {}),
              artifactId: result.artifact.id,
              format: result.artifact.format,
              ...source,
              ...(selectedText !== undefined
                ? {
                    selectedPreview: fragment.preview,
                    selectedPreviewTruncated: fragment.truncated,
                  }
                : result.text === undefined
                  ? {}
                  : {
                      textPreview: fragment.preview,
                      previewTruncated: fragment.truncated || result.truncated,
                    }),
            });
          };
          let selectedValue: unknown;
          try {
            selectedValue = selectJsonField(result.text, result.truncated, field);
          } catch (error) {
            if (
              !(error instanceof ArtifactStoreError) ||
              ![
                "artifact_field_json_unavailable",
                "artifact_field_text_unavailable",
                "artifact_field_missing",
              ].includes(error.code)
            ) {
              throw error;
            }
            // The verified original remains useful even when this field cannot
            // be extracted. Retain a bounded fragment without inventing a value.
            return unavailableField(
              error.code,
              undefined,
              error.code === "artifact_field_missing" && result.text !== undefined
                ? missingFieldHints(result.text, field)
                : undefined,
            );
          }
          const encoded = JSON.stringify(selectedValue);
          if (Buffer.byteLength(encoded) > ARTIFACT_TEXT_PREVIEW_MAX_BYTES) {
            return unavailableField(
              "artifact_field_budget_exceeded",
              encoded,
              buildArtifactSelectionHints(field, selectedValue),
            );
          }
          const selected = preview(encoded);
          const fieldResult = { ...result };
          const sourceTextOmitted = result.text !== undefined;
          if (sourceTextOmitted) {
            delete fieldResult.text;
          }
          return jsonResult({
            available: true,
            authority: "local_read",
            action,
            selectedValue,
            selectionHints: buildArtifactSelectionHints(field, selectedValue),
            selectionScope: artifactSelectionScope(result.text!, field),
            ...source,
            selectedPreview: selected.preview,
            selectedPreviewTruncated: selected.truncated,
            field,
            ...fieldResult,
            ...(sourceTextOmitted ? { sourceTextOmittedForField: true } : {}),
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
          ...(error instanceof ArtifactStoreError && error.code === "artifact_action_required"
            ? {
                requiredArgs: ["action"],
                allowedActions: ["read", "search"],
                guidance:
                  "For a specific registered id/field, explicitly supply action=read; for discovery use action=search. No read was performed.",
              }
            : {}),
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
