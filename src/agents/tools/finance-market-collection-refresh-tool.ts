import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { FetchImpl } from "../finance-live-market-source.js";
import {
  createFinanceMarketCollectionRegistry,
  FINANCE_MARKET_COLLECTION_KINDS,
  inspectFinanceMarketCollectionRegistry,
  resolveFinanceMarketCollectionRegistryOptionsFromEnv,
  runFinanceMarketCollectionRefresh,
  type FinanceMarketCollectionRequest,
} from "../finance-market-collection-registry.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

const FinanceMarketCollectionRefreshSchema = Type.Object({
  instrument: Type.String(),
  assetClass: Type.String(),
  collection: Type.Union(FINANCE_MARKET_COLLECTION_KINDS.map((kind) => Type.Literal(kind))),
  seriesId: Type.Optional(Type.String()),
  fromDate: Type.Optional(Type.String()),
  toDate: Type.Optional(Type.String()),
  asOf: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 250 })),
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
      .replace(/^-|-$/gu, "") || "finance-market-collection"
  );
}

async function writeReceipt(
  workspaceDir: string,
  instrument: string,
  collection: string,
  payload: unknown,
) {
  const now = new Date().toISOString();
  const relPath = path.join(
    "memory",
    "finance-data-gateway",
    "collections",
    `${now.slice(0, 10)}-${safeReceiptStem(instrument)}-${safeReceiptStem(collection)}-${now.replace(/[:.]/gu, "-")}.json`,
  );
  const absolutePath = path.join(workspaceDir, relPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return relPath;
}

export function createFinanceMarketCollectionRefreshTool(options?: {
  workspaceDir?: string;
  fetchImpl?: FetchImpl;
  massiveApiKey?: string;
  finnhubApiKey?: string;
  fredApiKey?: string;
  fmpApiKey?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Market Collection Refresh",
    name: "finance_market_collection_refresh",
    description:
      "Inspect or explicitly fetch structured US-market collections such as public news, options chains, dividends, splits, official macro series, SEC filings, company profiles, and free-tier EOD history. Results retain source, timestamp, delay, raw record fields, and failed attempts; this tool has no trading or order authority.",
    parameters: FinanceMarketCollectionRefreshSchema,
    execute: async (_toolCallId, args) => {
      const params = args as {
        instrument: string;
        assetClass: string;
        collection: FinanceMarketCollectionRequest["collection"];
        seriesId?: string;
        fromDate?: string;
        toDate?: string;
        asOf?: string;
        limit?: number;
        sourceIds?: string[];
        liveFetch?: boolean;
        timeoutMs?: number;
        maxSources?: number;
        writeReceipt?: boolean;
      };
      try {
        const request: FinanceMarketCollectionRequest = {
          instrument: params.instrument,
          assetClass: params.assetClass,
          collection: params.collection,
          seriesId: params.seriesId,
          fromDate: params.fromDate,
          toDate: params.toDate,
          asOf: params.asOf ?? new Date().toISOString(),
          limit: params.limit,
        };
        const envRegistryOptions = resolveFinanceMarketCollectionRegistryOptionsFromEnv();
        const registryOptions = {
          ...envRegistryOptions,
          fetchImpl: options?.fetchImpl,
          massiveApiKey: options?.massiveApiKey ?? envRegistryOptions.massiveApiKey,
          finnhubApiKey: options?.finnhubApiKey ?? envRegistryOptions.finnhubApiKey,
          fredApiKey: options?.fredApiKey ?? envRegistryOptions.fredApiKey,
          fmpApiKey: options?.fmpApiKey ?? envRegistryOptions.fmpApiKey,
        };
        const registry = createFinanceMarketCollectionRegistry(registryOptions);
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
            `unknown finance market collection adapter: ${unknownSourceIds.join(", ")}`,
          );
        }
        if (params.liveFetch !== true) {
          return jsonResult({
            ...inspectFinanceMarketCollectionRegistry(request, adapters),
            liveFetch: false,
            nextAction: "set liveFetch=true only when a current structured collection is required",
            boundary: "no network call; inspection only; no current collection is claimed",
          });
        }
        const receipt = await runFinanceMarketCollectionRefresh({
          request,
          adapters,
          maxSources: params.maxSources,
          timeoutMs: params.timeoutMs,
        });
        const receiptPath = params.writeReceipt
          ? await writeReceipt(workspaceDir, request.instrument, request.collection, receipt)
          : undefined;
        return jsonResult({ ...receipt, receiptPath });
      } catch (error) {
        if (error instanceof ToolInputError) {
          throw error;
        }
        throw new ToolInputError((error as Error).message);
      }
    },
  };
}
