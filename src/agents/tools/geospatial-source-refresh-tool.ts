import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { FetchImpl } from "../finance-live-market-source.js";
import {
  createGeospatialSourceRegistry,
  GEOSPATIAL_SOURCE_KINDS,
  inspectGeospatialSourceRegistry,
  runGeospatialRefresh,
  type GeospatialSourceKind,
} from "../geospatial-source-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

const GeospatialSourceRefreshSchema = Type.Object({
  kind: stringEnum(GEOSPATIAL_SOURCE_KINDS),
  query: Type.String(),
  asOf: Type.Optional(Type.String()),
  freshnessMaxMinutes: Type.Optional(Type.Number()),
  liveFetch: Type.Optional(Type.Boolean()),
  timeoutMs: Type.Optional(Type.Number()),
  maxSources: Type.Optional(Type.Number()),
  writeReceipt: Type.Optional(Type.Boolean()),
});

function safeReceiptStem(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/-+/gu, "-")
      .replace(/^-|-$/gu, "") || "geospatial"
  );
}

async function writeReceipt(workspaceDir: string, kind: string, query: string, payload: unknown) {
  const now = new Date().toISOString();
  const relPath = path.join(
    "memory",
    "geospatial-data",
    `${now.slice(0, 10)}-${safeReceiptStem(kind)}-${safeReceiptStem(query)}-${now.replace(/[:.]/gu, "-")}.json`,
  );
  const absolutePath = path.join(workspaceDir, relPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return relPath;
}

export function createGeospatialSourceRefreshTool(options?: {
  workspaceDir?: string;
  fetchImpl?: FetchImpl;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Geospatial Source Refresh",
    name: "geospatial_source_refresh",
    description:
      "Inspect or explicitly fetch public geocoding, weather, and earthquake sources. Live requests are opt-in; source disagreement and stale fields remain visible for review.",
    parameters: GeospatialSourceRefreshSchema,
    execute: async (_toolCallId, args, callerSignal) => {
      callerSignal?.throwIfAborted();
      const params = args as {
        kind: GeospatialSourceKind;
        query: string;
        asOf?: string;
        freshnessMaxMinutes?: number;
        liveFetch?: boolean;
        timeoutMs?: number;
        maxSources?: number;
        writeReceipt?: boolean;
      };
      try {
        const request = {
          kind: params.kind,
          query: params.query,
          asOf: params.asOf ?? new Date().toISOString(),
          freshnessMaxMinutes: params.freshnessMaxMinutes,
        };
        const registry = createGeospatialSourceRegistry({ fetchImpl: options?.fetchImpl });
        if (params.liveFetch !== true) {
          return jsonResult({
            ...inspectGeospatialSourceRegistry(request, registry),
            liveFetch: false,
            nextAction:
              "set liveFetch=true only when a current public geospatial snapshot is required",
            boundary: "no network call; inspection only; no current value is claimed",
          });
        }
        const receipt = await runGeospatialRefresh({
          request,
          adapters: registry,
          maxSources: params.maxSources,
          timeoutMs: params.timeoutMs,
          signal: callerSignal,
        });
        callerSignal?.throwIfAborted();
        const receiptPath = params.writeReceipt
          ? await writeReceipt(workspaceDir, params.kind, params.query, receipt)
          : undefined;
        return jsonResult({ ...receipt, receiptPath });
      } catch (error) {
        throw new ToolInputError((error as Error).message);
      }
    },
  };
}
