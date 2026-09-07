import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { loadWebMedia } from "../../web/media.js";
import {
  analyzeFinanceChartBars,
  normalizeFinanceChartBars,
  type FinanceChartRecord,
} from "../finance-chart-analysis.js";
import type { FetchImpl } from "../finance-live-market-source.js";
import {
  createFinanceMarketCollectionRegistry,
  inspectFinanceMarketCollectionRegistry,
  resolveFinanceMarketCollectionRegistryOptionsFromEnv,
  runFinanceMarketCollectionRefresh,
  type FinanceMarketCollectionRequest,
} from "../finance-market-collection-registry.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";
import { decodeDataUrl } from "./image-tool.helpers.js";
import { resolveMediaToolLocalRoots } from "./media-tool-shared.js";

const FinanceChartAnalysisSchema = Type.Object({
  instrument: Type.Optional(Type.String()),
  assetClass: Type.Optional(Type.String()),
  bars: Type.Optional(
    Type.Array(
      Type.Object({
        timestamp: Type.Optional(Type.Union([Type.String(), Type.Number()])),
        date: Type.Optional(Type.String()),
        open: Type.Number(),
        high: Type.Number(),
        low: Type.Number(),
        close: Type.Number(),
        volume: Type.Optional(Type.Number()),
      }),
    ),
  ),
  fromDate: Type.Optional(Type.String()),
  toDate: Type.Optional(Type.String()),
  asOf: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 2, maximum: 250 })),
  liveFetch: Type.Optional(Type.Boolean()),
  timeoutMs: Type.Optional(Type.Number()),
  maxSources: Type.Optional(Type.Number()),
  image: Type.Optional(
    Type.String({ description: "Optional chart image path, URL, or data URL for visual review." }),
  ),
  includeImage: Type.Optional(Type.Boolean()),
  includeBars: Type.Optional(Type.Boolean()),
  writeReceipt: Type.Optional(Type.Boolean()),
});

const FINANCE_CHART_TOOL_SCHEMA_VERSION = "lcx_finance_chart_analysis_tool_v1" as const;

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
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
      .replace(/^-|-$/gu, "") || "chart"
  );
}

async function writeChartReceipt(
  workspaceDir: string,
  instrument: string,
  payload: unknown,
): Promise<string> {
  const now = new Date().toISOString();
  const relativePath = path.join(
    "memory",
    "finance-chart-analysis",
    `${now.slice(0, 10)}-${safeReceiptStem(instrument)}-${now.replace(/[:.]/gu, "-")}.json`,
  );
  const absolutePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return relativePath;
}

function collectionSourceSummary(receipt: {
  status: string;
  selectedSourceIds: readonly string[];
  records: readonly {
    providerName: string;
    sourceTimestamp: string;
    delayStatus: string;
    sourceUrlOrArtifact: string;
  }[];
  sourceAttempts: readonly unknown[];
  missingEvidence: readonly string[];
  requiredNextSteps: readonly string[];
}) {
  return {
    status: receipt.status,
    selectedSourceIds: receipt.selectedSourceIds,
    sourceAttempts: receipt.sourceAttempts,
    recordCount: receipt.records.length,
    providers: [...new Set(receipt.records.map((record) => record.providerName))],
    sourceUrls: [...new Set(receipt.records.map((record) => record.sourceUrlOrArtifact))],
    sourceTimestampRange: {
      first: receipt.records[0]?.sourceTimestamp,
      last: receipt.records.at(-1)?.sourceTimestamp,
    },
    delayStatuses: [...new Set(receipt.records.map((record) => record.delayStatus))],
    missingEvidence: receipt.missingEvidence,
    requiredNextSteps: receipt.requiredNextSteps,
  };
}

function toolContentText(result: unknown): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return "";
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(block) &&
        typeof block === "object" &&
        !Array.isArray(block) &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

async function loadChartImage(
  imageInput: string,
  workspaceDir: string,
): Promise<{ data: string; mimeType: string; resolvedImage: string }> {
  const resolvedImage = imageInput.replace(/^@/u, "").trim();
  if (!resolvedImage) {
    throw new Error("image must not be empty");
  }
  if (resolvedImage.startsWith("data:")) {
    const decoded = decodeDataUrl(resolvedImage);
    return {
      data: decoded.buffer.toString("base64"),
      mimeType: decoded.mimeType,
      resolvedImage: "data-url",
    };
  }
  const media = await loadWebMedia(resolvedImage, {
    maxBytes: 10 * 1024 * 1024,
    localRoots: resolveMediaToolLocalRoots(workspaceDir),
  });
  if (media.kind !== "image") {
    throw new Error(`chart image is not an image: ${media.kind}`);
  }
  return {
    data: media.buffer.toString("base64"),
    mimeType: media.contentType ?? "image/png",
    resolvedImage,
  };
}

/**
 * A two-lane chart capability: deterministic OHLCV analysis first, with an
 * optional image content block for a native or configured vision model. The
 * numeric lane never pretends to recover information from chart pixels.
 */
export function createFinanceChartAnalysisTool(options?: {
  workspaceDir?: string;
  fetchImpl?: FetchImpl;
  modelHasVision?: boolean;
  visionTool?: AnyAgentTool | null;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Chart Analysis",
    name: "finance_chart_analysis",
    description:
      "Analyze a stock or other market chart through two explicit lanes: fetch and calculate deterministic OHLCV features from canonical history, and optionally attach a chart image for native vision review. This is research-only and never issues trades, orders, sizing, or wallet actions.",
    parameters: FinanceChartAnalysisSchema,
    execute: async (_toolCallId, args) => {
      const params = args as {
        instrument?: string;
        assetClass?: string;
        bars?: FinanceChartRecord[];
        fromDate?: string;
        toDate?: string;
        asOf?: string;
        limit?: number;
        liveFetch?: boolean;
        timeoutMs?: number;
        maxSources?: number;
        image?: string;
        includeImage?: boolean;
        includeBars?: boolean;
        writeReceipt?: boolean;
      };
      try {
        const instrument = optionalText(params.instrument);
        const imageInput = optionalText(params.image);
        if (!instrument && !imageInput && !(params.bars && params.bars.length > 0)) {
          throw new ToolInputError("instrument, bars, or image required");
        }
        const asOf = params.asOf ?? new Date().toISOString();
        let sourceReceipt: Record<string, unknown>;
        let sourceRecords: FinanceChartRecord[] = params.bars ?? [];
        let collectionStatus: string = params.bars ? "provided_input" : "not_requested";
        let liveFetched = false;

        if (sourceRecords.length === 0 && instrument) {
          const request: FinanceMarketCollectionRequest = {
            instrument,
            assetClass: params.assetClass ?? "us_equity",
            collection: "eod_history",
            fromDate: params.fromDate,
            toDate: params.toDate,
            asOf,
            limit: params.limit ?? 250,
          };
          const registry = createFinanceMarketCollectionRegistry({
            ...resolveFinanceMarketCollectionRegistryOptionsFromEnv(),
            fetchImpl: options?.fetchImpl,
          });
          if (params.liveFetch === false) {
            const inspection = inspectFinanceMarketCollectionRegistry(request, registry);
            sourceReceipt = inspection as unknown as Record<string, unknown>;
            collectionStatus = "inspection";
          } else {
            const receipt = await runFinanceMarketCollectionRefresh({
              request,
              adapters: registry,
              maxSources: params.maxSources,
              timeoutMs: params.timeoutMs,
            });
            sourceRecords = receipt.records as unknown as FinanceChartRecord[];
            collectionStatus = receipt.status;
            liveFetched = true;
            sourceReceipt = collectionSourceSummary(receipt);
          }
        } else {
          sourceReceipt = {
            status: collectionStatus,
            recordCount: sourceRecords.length,
            selectedSourceIds: [],
            sourceAttempts: [],
            sourceUrls: [],
            sourceTimestampRange: { first: undefined, last: undefined },
            delayStatuses: [],
            missingEvidence: [],
            requiredNextSteps: [],
          };
        }

        const normalization = normalizeFinanceChartBars(sourceRecords);
        const analysis =
          normalization.bars.length >= 2
            ? analyzeFinanceChartBars(instrument ?? "provided_bars", normalization.bars, {
                droppedCount: normalization.droppedCount,
              })
            : undefined;
        const includeImage = params.includeImage ?? true;
        let imagePayload: { data: string; mimeType: string; resolvedImage: string } | undefined;
        let imageError: string | undefined;
        let visionAnalysis:
          | { status: "completed"; text: string; details?: unknown }
          | { status: "failed"; error: string }
          | undefined;
        if (imageInput && includeImage) {
          try {
            imagePayload = await loadChartImage(imageInput, workspaceDir);
          } catch (error) {
            imageError = error instanceof Error ? error.message : String(error);
          }
        }
        if (imagePayload && !options?.modelHasVision && options?.visionTool) {
          try {
            const visionResult = await options.visionTool.execute("finance-chart-vision", {
              image: imageInput,
              prompt:
                "Analyze this financial market chart as research context. Return concise labeled observations for visible text/axes, series, directional visual trend (rising, falling, sideways, or uncertain), levels, formations, timeframe, and uncertainty. Keep trend as a direction word, never a price value. Use only pixels; if text is unreadable, say so. Do not repeat phrases and do not issue buy/sell, order, sizing, or execution instructions.",
            });
            visionAnalysis = {
              status: "completed",
              text: toolContentText(visionResult) || "vision tool returned no textual analysis",
              details: (visionResult as { details?: unknown }).details,
            };
          } catch (error) {
            visionAnalysis = {
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
        const includeBars = params.includeBars === true;

        const status = analysis
          ? collectionStatus === "needs_review"
            ? "needs_review"
            : "ready"
          : imagePayload
            ? "visual_only"
            : collectionStatus === "inspection"
              ? "inspection"
              : "blocked";
        const payload = {
          schemaVersion: FINANCE_CHART_TOOL_SCHEMA_VERSION,
          boundary: "finance_chart_analysis_read_only",
          status,
          instrument: instrument ?? "provided_bars",
          liveFetch: liveFetched,
          sourceReceipt,
          normalizedBarCount: normalization.bars.length,
          droppedBarCount: normalization.droppedCount,
          ...(includeBars ? { bars: normalization.bars } : {}),
          analysis: analysis ?? null,
          visual: {
            imageProvided: Boolean(imageInput),
            imageLoaded: Boolean(imagePayload),
            imageAttached: Boolean(imagePayload && options?.modelHasVision),
            imagePath: imagePayload?.resolvedImage,
            modelHasVision: options?.modelHasVision ?? false,
            visionAnalysis,
            handoff:
              visionAnalysis?.status === "completed"
                ? "configured_vision_tool_completed"
                : imagePayload && options?.modelHasVision
                  ? "native_vision_can_review_the_attached_image"
                  : imagePayload
                    ? "use_the_configured_image_tool_or_a_vision_model_to_review_the_attached_image"
                    : "no_image_attached",
            imageError,
          },
          notTouched: [
            "provider_config",
            "external_channel_sender",
            "protected_memory",
            "trading_execution",
            "broker_or_wallet_authority",
          ],
        };
        const receiptPayload = { ...payload, bars: normalization.bars };
        const receiptPath = params.writeReceipt
          ? await writeChartReceipt(workspaceDir, instrument ?? "provided_bars", receiptPayload)
          : undefined;
        const result = jsonResult({ ...payload, receiptPath });
        if (imagePayload && options?.modelHasVision) {
          result.content.push({
            type: "image",
            data: imagePayload.data,
            mimeType: imagePayload.mimeType,
          });
        }
        return result;
      } catch (error) {
        if (error instanceof ToolInputError) {
          throw error;
        }
        throw new ToolInputError(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
