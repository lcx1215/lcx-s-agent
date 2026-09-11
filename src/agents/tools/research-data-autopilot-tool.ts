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
  type FinanceMarketCollectionKind,
} from "../finance-market-collection-registry.js";
import {
  createFinanceRealtimeSourceRegistry,
  inspectFinanceRealtimeSourceRegistry,
  resolveFinanceRealtimeSourceRegistryOptionsFromEnv,
  runFinanceRealtimeRefresh,
  type FinanceRealtimeSourceRequest,
} from "../finance-realtime-source-registry.js";
import { inspectFinanceSourceHealth } from "../finance-source-health.js";
import {
  createGeospatialSourceRegistry,
  inspectGeospatialSourceRegistry,
  runGeospatialRefresh,
  type GeospatialSourceKind,
} from "../geospatial-source-registry.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

export const RESEARCH_DATA_AUTOPILOT_INTENTS = [
  "source_health",
  "quote",
  "crypto_quote",
  ...FINANCE_MARKET_COLLECTION_KINDS,
  "geocode",
  "weather",
  "earthquake",
] as const;
type ResearchDataAutopilotIntent = (typeof RESEARCH_DATA_AUTOPILOT_INTENTS)[number];

const ResearchDataAutopilotSchema = Type.Object({
  intent: Type.Union(RESEARCH_DATA_AUTOPILOT_INTENTS.map((intent) => Type.Literal(intent))),
  target: Type.String(),
  assetClass: Type.Optional(Type.String()),
  seriesId: Type.Optional(
    Type.String({
      description:
        "Macro series identifier; for news title sampling, an optional literal company or topic keyword such as Apple.",
    }),
  ),
  fromDate: Type.Optional(Type.String()),
  toDate: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 250 })),
  asOf: Type.Optional(Type.String()),
  liveFetch: Type.Optional(Type.Boolean()),
  timeoutMs: Type.Optional(Type.Number()),
  maxSources: Type.Optional(Type.Number()),
  writeReceipt: Type.Optional(Type.Boolean()),
});

const AUTOPILOT_SCHEMA_VERSION = "lcx_research_data_autopilot_v1" as const;

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ToolInputError(`${label} required`);
  }
  return normalized;
}

function safeReceiptStem(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/-+/gu, "-")
      .replace(/^-|-$/gu, "") || "research-data"
  );
}

async function writeAutopilotReceipt(
  workspaceDir: string,
  intent: string,
  target: string,
  payload: unknown,
): Promise<string> {
  const now = new Date().toISOString();
  const relativePath = path.join(
    "memory",
    "research-data-autopilot",
    `${now.slice(0, 10)}-${safeReceiptStem(intent)}-${safeReceiptStem(target)}-${now.replace(/[:.]/gu, "-")}.json`,
  );
  const absolutePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return relativePath;
}

function isGeospatialIntent(intent: ResearchDataAutopilotIntent): intent is GeospatialSourceKind {
  return intent === "geocode" || intent === "weather" || intent === "earthquake";
}

function isCollectionIntent(
  intent: ResearchDataAutopilotIntent,
): intent is Exclude<FinanceMarketCollectionKind, "macro_series"> | "macro_series" {
  return (FINANCE_MARKET_COLLECTION_KINDS as readonly string[]).includes(intent);
}

/**
 * One agent-facing read-only router for all canonical public/registered data
 * registries. It intentionally hides sourceIds: provider selection, fallback,
 * cross-checking, and failure visibility belong to the registries, not to a
 * human or a model guessing an endpoint.
 */
export function createResearchDataAutopilotTool(options?: {
  workspaceDir?: string;
  fetchImpl?: FetchImpl;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Research Data Autopilot",
    name: "research_data_autopilot",
    description:
      "Use source_health to inspect configured routes, recent call evidence, shared provider quotas, next eligible times, cooldowns, process-local response reuse and unknown ceilings without network access. Cached reads are not new source-health verification. Autonomously route a read-only research request across all canonical finance, crypto, public macro, SEC, news, geospatial, weather, and seismic adapters. The agent does not choose provider URLs: registries select every supporting source, retain failures, cross-check results, and never touch trading, broker, wallet, or order authority.",
    parameters: ResearchDataAutopilotSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = args as {
        intent: ResearchDataAutopilotIntent;
        target: string;
        assetClass?: string;
        seriesId?: string;
        fromDate?: string;
        toDate?: string;
        limit?: number;
        asOf?: string;
        liveFetch?: boolean;
        timeoutMs?: number;
        maxSources?: number;
        writeReceipt?: boolean;
      };
      try {
        const intent = params.intent;
        const target = requiredText(params.target, "target");
        const asOf = params.asOf ?? new Date().toISOString();
        const liveFetch = intent === "source_health" ? false : (params.liveFetch ?? true);
        let payload: unknown;

        if (intent === "source_health") {
          payload = await inspectFinanceSourceHealth({ workspaceDir, asOf });
        } else if (isGeospatialIntent(intent)) {
          const request = {
            kind: intent,
            query: target,
            asOf,
            freshnessMaxMinutes: undefined,
          } as const;
          const registry = createGeospatialSourceRegistry({ fetchImpl: options?.fetchImpl });
          payload = liveFetch
            ? await runGeospatialRefresh({
                request,
                adapters: registry,
                maxSources: params.maxSources,
                timeoutMs: params.timeoutMs,
                signal,
              })
            : inspectGeospatialSourceRegistry(request, registry);
        } else if (intent === "quote" || intent === "crypto_quote") {
          const request: FinanceRealtimeSourceRequest = {
            instrument: target,
            assetClass: params.assetClass ?? (intent === "crypto_quote" ? "crypto" : "us_equity"),
            useCase: "research_data_autopilot",
            asOf,
          };
          const envOptions = resolveFinanceRealtimeSourceRegistryOptionsFromEnv();
          const registry = createFinanceRealtimeSourceRegistry({
            ...envOptions,
            fetchImpl: options?.fetchImpl,
          });
          payload = liveFetch
            ? await runFinanceRealtimeRefresh({
                request,
                adapters: registry,
                maxSources: params.maxSources,
                timeoutMs: params.timeoutMs,
                signal,
              })
            : inspectFinanceRealtimeSourceRegistry(request, registry);
        } else {
          if (!isCollectionIntent(intent)) {
            throw new ToolInputError(`unsupported research data intent: ${String(intent)}`);
          }
          const collection = intent;
          const request = {
            instrument: target,
            assetClass:
              params.assetClass ?? (collection === "macro_series" ? "macro_series" : "us_equity"),
            collection,
            seriesId: params.seriesId ?? (collection === "macro_series" ? target : undefined),
            fromDate: params.fromDate,
            toDate: params.toDate,
            limit: params.limit,
            asOf,
          } as const;
          const envOptions = resolveFinanceMarketCollectionRegistryOptionsFromEnv();
          const registry = createFinanceMarketCollectionRegistry({
            ...envOptions,
            fetchImpl: options?.fetchImpl,
          });
          payload = liveFetch
            ? await runFinanceMarketCollectionRefresh({
                request,
                adapters: registry,
                maxSources: params.maxSources,
                timeoutMs: params.timeoutMs,
                signal,
              })
            : inspectFinanceMarketCollectionRegistry(request, registry);
        }

        const result = {
          schemaVersion: AUTOPILOT_SCHEMA_VERSION,
          boundary: "research_data_autopilot_read_only" as const,
          autoSelectedSources: true,
          liveFetch,
          intent,
          target,
          result: payload,
          notTouched: [
            "provider_config",
            "external_channel_sender",
            "protected_memory",
            "trading_execution",
            "wallet_or_order_authority",
          ],
        };
        const receiptPath =
          (params.writeReceipt ?? (liveFetch && !isGeospatialIntent(intent)))
            ? await writeAutopilotReceipt(workspaceDir, intent, target, result)
            : undefined;
        return jsonResult({ ...result, receiptPath });
      } catch (error) {
        if (error instanceof ToolInputError) {
          throw error;
        }
        throw new ToolInputError((error as Error).message);
      }
    },
  };
}
