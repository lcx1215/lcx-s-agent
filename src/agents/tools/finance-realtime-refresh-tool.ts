import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { FetchImpl } from "../finance-live-market-source.js";
import {
  createFinanceRealtimeSourceRegistry,
  inspectFinanceRealtimeSourceRegistry,
  runFinanceRealtimeRefresh,
  type FinanceRealtimeSourceRequest,
} from "../finance-realtime-source-registry.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

const FinanceRealtimeRefreshSchema = Type.Object({
  instrument: Type.String(),
  assetClass: Type.String(),
  useCase: Type.String(),
  asOf: Type.Optional(Type.String()),
  freshnessMaxMinutes: Type.Optional(Type.Number()),
  requireOfficialReference: Type.Optional(Type.Boolean()),
  sourceIds: Type.Optional(Type.Array(Type.String())),
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
      .replace(/^-|-$/gu, "") || "finance-realtime"
  );
}

async function writeReceipt(workspaceDir: string, instrument: string, payload: unknown) {
  const now = new Date().toISOString();
  const relPath = path.join(
    "memory",
    "finance-data-gateway",
    "realtime",
    `${now.slice(0, 10)}-${safeReceiptStem(instrument)}-${now.replace(/[:.]/gu, "-")}.json`,
  );
  const absolutePath = path.join(workspaceDir, relPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return relPath;
}

export function createFinanceRealtimeRefreshTool(options?: {
  workspaceDir?: string;
  fetchImpl?: FetchImpl;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Realtime Source Refresh",
    name: "finance_realtime_source_refresh",
    description:
      "Inspect or explicitly fetch an authorized public finance source through the preferred/fallback registry, then pass the result into the canonical finance data gateway. Live fetching is opt-in, delayed data is labeled, and missing cross-check evidence remains blocked.",
    parameters: FinanceRealtimeRefreshSchema,
    execute: async (_toolCallId, args) => {
      const params = args as {
        instrument: string;
        assetClass: string;
        useCase: string;
        asOf?: string;
        freshnessMaxMinutes?: number;
        requireOfficialReference?: boolean;
        sourceIds?: string[];
        liveFetch?: boolean;
        timeoutMs?: number;
        maxSources?: number;
        writeReceipt?: boolean;
      };
      try {
        const request: FinanceRealtimeSourceRequest = {
          instrument: params.instrument,
          assetClass: params.assetClass,
          useCase: params.useCase,
          asOf: params.asOf ?? new Date().toISOString(),
          freshnessMaxMinutes: params.freshnessMaxMinutes,
          requireOfficialReference: params.requireOfficialReference,
        };
        const registry = createFinanceRealtimeSourceRegistry({ fetchImpl: options?.fetchImpl });
        const selectedSourceIds = params.sourceIds?.map((sourceId) => sourceId.trim());
        const adapters = selectedSourceIds
          ? registry.filter((adapter) => selectedSourceIds.includes(adapter.id))
          : registry;
        const unknownSourceIds =
          selectedSourceIds?.filter(
            (sourceId) => !registry.some((adapter) => adapter.id === sourceId),
          ) ?? [];
        if (unknownSourceIds.length > 0) {
          throw new ToolInputError(
            `unknown finance source adapter: ${unknownSourceIds.join(", ")}`,
          );
        }

        if (params.liveFetch !== true) {
          return jsonResult({
            ...inspectFinanceRealtimeSourceRegistry(request, adapters),
            liveFetch: false,
            nextAction:
              "set liveFetch=true only when a current delayed public snapshot is required",
            boundary: "no network call; inspection only; no current number is claimed",
          });
        }

        const receipt = await runFinanceRealtimeRefresh({
          request,
          adapters,
          maxSources: params.maxSources,
          timeoutMs: params.timeoutMs,
        });
        const receiptPath = params.writeReceipt
          ? await writeReceipt(workspaceDir, request.instrument, receipt)
          : undefined;
        return jsonResult({
          ...receipt,
          receiptPath,
          nextTool:
            receipt.status === "ready"
              ? "finance_framework_core_inspect"
              : "data_provenance_quality_review_input",
        });
      } catch (error) {
        if (error instanceof ToolInputError) {
          throw error;
        }
        throw new ToolInputError((error as Error).message);
      }
    },
  };
}
