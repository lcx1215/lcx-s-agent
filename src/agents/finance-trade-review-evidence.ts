import { createHash } from "node:crypto";
import { z } from "zod";
import type { OpenClawConfig } from "../config/config.js";
import { FINANCE_FRAMEWORK_CORE_DOMAINS } from "../hooks/bundled/lobster-brain-registry.js";
import {
  financeBrainModuleCatalog,
  type FinanceBrainModuleId,
} from "./finance-brain-orchestration.js";
import { createCalculationLedger } from "./finance-calculation-ledger.js";
import type { FinanceMarketCollectionReceipt } from "./finance-market-collection-registry.js";
import type { FinanceTradeDecisionReviewRequest } from "./finance-trade-decision-review.js";
import { createFinanceTradeResultRecallCapability } from "./finance-trade-result-recall.js";
import type { PairSpreadDiagnostics } from "./quant-math-pair-spread.js";
import { createArtifactMemoryRecallTool } from "./tools/artifact-memory-recall-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createFinanceBarLedgerTool } from "./tools/finance-bar-ledger-tool.js";
import { createFinanceFrameworkCoreInspectTool } from "./tools/finance-framework-core-inspect-tool.js";
import { createFinanceLearningCapabilityApplyTool } from "./tools/finance-learning-capability-apply-tool.js";
import { createFinanceLearningCapabilityInspectTool } from "./tools/finance-learning-capability-inspect-tool.js";
import { createFinanceMarketCollectionRefreshTool } from "./tools/finance-market-collection-refresh-tool.js";
import { createQuantLabTool } from "./tools/quant-lab-tool.js";
import { createQuantMathTool } from "./tools/quant-math-tool.js";

// One candidate budget covers evidence follow-ups and any quote re-review.
export const FINANCE_TRADE_REVIEW_MAX_MODEL_CALLS = 4;
export const FINANCE_TRADE_REVIEW_INITIAL_MODEL_CALLS = 3;
export const FINANCE_TRADE_REVIEW_MAX_TOOL_REQUESTS = 4;
// The reviewer and durable execution receipts share this failure contract.
export const FinanceTradeReviewFailureCodeSchema = z.enum([
  "output_contract",
  "reviewer_unavailable",
  "prompt_input_invalid",
  "prompt_budget_exceeded",
  "output_invalid",
  "output_truncated",
  "provider_auth",
  "provider_payment_required",
  "provider_rate_limit",
  "process_error",
  "output_limit",
  "runtime_timeout",
  "call_budget_exhausted",
]);
export type FinanceTradeReviewFailureCode = z.infer<typeof FinanceTradeReviewFailureCodeSchema>;
// Bounded parser branch only; never stores model text, candidate values or credentials.
export const FinanceTradeReviewContractStageSchema = z.enum([
  "output_object",
  "output_envelope",
  "candidate_count",
  "candidate_fields",
  "expectation_gap",
  "strategy_feedback_scope",
  "strategy_feedback_response",
  "broker_exit_response_schema",
  "broker_exit_feedback_scope",
  "broker_exit_response_facts",
  "unexpected_broker_exit_response",
  "candidate_coverage",
]);
export type FinanceTradeReviewContractStage = z.infer<typeof FinanceTradeReviewContractStageSchema>;

const KNOWLEDGE_FIELDS = [
  "capabilityName",
  "applicationBoundary",
  "whatChangesMyMind",
  "causalCheck",
  "riskGateNotes",
  "riskChecks",
  "doNotUseFor",
  "requiredInputs",
  "implementationCheck",
  "useFor",
  "requiredEvidenceCategories",
  "evidenceSummary",
  "baseCase",
  "bearCase",
  "keyCausalChain",
  "sourceArticlePath",
] as const;
const MAX_RETAINED_KNOWLEDGE_RESULT_BYTES = 64 * 1024;
const Text = z.string().min(1).max(120);
const HistorySourceSchema = z
  .object({
    origin: z.string().trim().min(1).max(120),
    sourceUrlOrArtifact: z.string().trim().min(1).max(512),
  })
  .strict()
  .refine((source) => Buffer.byteLength(JSON.stringify(source), "utf8") <= 512);
const MathEvidenceRequestSchema = z
  .object({
    candidateId: Text,
    action: z.enum([
      "daily_closes",
      "max_drawdown",
      "z_score",
      "returns_from_levels",
      "pair_spread_diagnostics",
    ]),
    source: HistorySourceSchema.optional(),
    instrumentB: Text.optional(),
    construction: z.enum(["fixed_spread", "price_ratio"]).optional(),
    hedgeRatio: z.number().finite().positive().max(100).optional(),
    lookbackWindow: z.number().int().min(20).max(100).optional(),
    relationshipRationale: z.string().min(1).max(240).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const pair = request.action === "pair_spread_diagnostics";
    if (
      pair &&
      ((request.construction === "fixed_spread" && request.hedgeRatio === undefined) ||
        (request.construction === "price_ratio" && request.hedgeRatio !== undefined))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fixed spread requires hedge ratio; price ratio forbids it",
      });
    }
    if (pair && request.source !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pair history source selection is not registered",
      });
    }
    if (
      pair
        ? !request.instrumentB || !request.construction || !request.relationshipRationale
        : [
            request.instrumentB,
            request.construction,
            request.hedgeRatio,
            request.lookbackWindow,
            request.relationshipRationale,
          ].some((value) => value !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pair parameters must match the requested action",
      });
    }
  });
const moduleCatalog = financeBrainModuleCatalog();
const moduleIds = moduleCatalog.map(({ id }) => id) as [
  FinanceBrainModuleId,
  ...FinanceBrainModuleId[],
];
const financialBoundary =
  "recorded_financial_knowledge_research_only_not_market_or_account_facts" as const;
const brokerFeedbackBoundary =
  "recorded_broker_fill_feedback_not_strategy_edge_or_expected_return" as const;
const marketCollectionBoundary =
  "public_news_research_only_not_verified_event_or_execution_quote" as const;
export const FinanceTradeReviewEvidenceRequestSchema = z.union([
  MathEvidenceRequestSchema,
  z
    .object({
      candidateId: Text,
      action: z.literal("market_collection"),
      keyword: Text.optional(),
    })
    .strict(),
  z
    .object({
      candidateId: Text,
      action: z.literal("artifact_search"),
      owner: Text.refine((owner) =>
        /^(?:finance_[a-z_]+|quant_math|quant_lab|workflow_delivery)$/u.test(owner),
      ),
      query: z
        .string()
        .trim()
        .min(1)
        .refine((value) => Buffer.byteLength(value, "utf8") <= 240),
    })
    .strict(),
  z
    .object({
      candidateId: Text,
      action: z.literal("artifact_read"),
      artifactId: z.string().min(1).max(240),
      field: z
        .string()
        .max(512)
        .refine((field) => field.startsWith("/"))
        .optional(),
      textOffset: z
        .number()
        .int()
        .min(0)
        .max(16 * 1024 * 1024)
        .optional(),
    })
    .strict()
    .refine((request) => (request.field === undefined) !== (request.textOffset === undefined)),
  z.object({ candidateId: Text, action: z.literal("broker_fill_feedback") }).strict(),
  z
    .object({
      candidateId: Text,
      action: z.literal("financial_capability"),
      toolName: Text,
      moduleId: z.enum(moduleIds),
      question: z
        .string()
        .trim()
        .min(1)
        .refine((value) => Buffer.byteLength(value, "utf8") <= 240),
      field: z
        .string()
        .regex(
          new RegExp(
            `^/(?:entry|appliedCapabilities/[01])/(?:${KNOWLEDGE_FIELDS.join("|")})$`,
            "u",
          ),
        )
        .optional(),
      sourceResultSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .optional(),
    })
    .strict()
    .refine(
      (request) => (request.field === undefined) === (request.sourceResultSha256 === undefined),
    ),
]);
export type FinanceTradeReviewEvidenceRequest = z.infer<
  typeof FinanceTradeReviewEvidenceRequestSchema
>;
export const FinanceTradeReviewModelCallEvidenceSchema = z
  .object({
    attempt: z.number().int().min(1).max(FINANCE_TRADE_REVIEW_MAX_MODEL_CALLS),
    callId: z.string().min(1).max(240),
    payloadSha256: z.string().regex(/^[a-f\d]{64}$/u),
    outputSha256: z
      .string()
      .regex(/^[a-f\d]{64}$/u)
      .optional(),
    resultKind: z.enum(["evidence_request", "decision", "output_truncated", "invalid", "failed"]),
    attestation: z.union([
      z
        .object({
          status: z.literal("attested"),
          kind: z.enum(["provider_call", "model_inference"]),
          transportRequestIdSha256: z.string().regex(/^[a-f\d]{64}$/u),
        })
        .strict(),
      z.object({ status: z.literal("unattested") }).strict(),
    ]),
    toolEvidenceSha256: z
      .string()
      .regex(/^[a-f\d]{64}$/u)
      .optional(),
    evidenceRequests: FinanceTradeReviewEvidenceRequestSchema.array().min(1).max(2).optional(),
    hypothesis: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 240)
      .optional(),
  })
  .strict();
export type FinanceTradeReviewModelCallEvidence = z.infer<
  typeof FinanceTradeReviewModelCallEvidenceSchema
>;
export const FinanceTradeReviewToolEvidenceSchema = z
  .object({
    action: Text,
    candidateId: Text,
    accountId: z.string().min(1).max(240),
    asOf: z.string().datetime(),
    status: z.enum(["completed", "unavailable"]),
    sourceRef: z.string().max(240),
    requestSha256: z.string().regex(/^[a-f\d]{64}$/u),
    resultSha256: z.string().regex(/^[a-f\d]{64}$/u),
    summary: z.string().max(1600),
    boundary: z.enum([
      "recorded_daily_history_research_only_no_execution_or_fresh_quote",
      financialBoundary,
      brokerFeedbackBoundary,
      marketCollectionBoundary,
    ]),
  })
  .strict()
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 2048,
    "tool evidence exceeds byte budget",
  );
export type FinanceTradeReviewToolEvidence = z.infer<typeof FinanceTradeReviewToolEvidenceSchema>;
export type FinanceTradeReviewEvidenceScope = Readonly<{
  directory: string;
  accountId: string;
  instruments: readonly string[];
  financialCapabilities?: readonly FinanceTradeReviewFinancialCapability[];
  marketCollectionTool?: AnyAgentTool;
  artifactRecallOptions?: Readonly<{
    config: OpenClawConfig;
    workspaceDir?: string;
    agentId?: string;
  }>;
}>;

/** Reuse the registered collection tool; this seam adds no provider or execution owner. */
export function createFinanceTradeReviewMarketCollectionTool(workspaceDir: string): AnyAgentTool {
  return createFinanceMarketCollectionRefreshTool({ workspaceDir });
}
export type FinanceTradeReviewFinancialCapability = Readonly<{
  toolName: string;
  moduleIds: readonly FinanceBrainModuleId[];
  description: string;
  execute: (
    input: Readonly<{
      moduleId: FinanceBrainModuleId;
      candidate: FinanceTradeDecisionReviewRequest["candidates"][number];
      question: string;
      asOf?: string;
      accountId?: string;
      venue?: FinanceTradeDecisionReviewRequest["venue"];
    }>,
    signal: AbortSignal,
  ) => Promise<unknown>;
}>;

function financialCapabilities(scope: FinanceTradeReviewEvidenceScope) {
  const capabilities = scope.financialCapabilities ?? [];
  const names = new Set<string>();
  for (const capability of capabilities) {
    if (
      !Text.safeParse(capability.toolName).success ||
      names.has(capability.toolName) ||
      !capability.description.trim() ||
      Buffer.byteLength(capability.description, "utf8") > 600 ||
      typeof capability.execute !== "function" ||
      capability.moduleIds.length === 0 ||
      new Set(capability.moduleIds).size !== capability.moduleIds.length ||
      capability.moduleIds.some((id) => !moduleIds.includes(id))
    ) {
      throw new Error("invalid host financial capability registration");
    }
    names.add(capability.toolName);
  }
  return capabilities;
}

export function describeFinanceTradeReviewFinancialCapabilities(
  scope: FinanceTradeReviewEvidenceScope,
) {
  return financialCapabilities(scope).map(({ toolName, moduleIds, description }) => ({
    toolName,
    moduleIds: [...moduleIds],
    description,
    boundary: financialBoundary,
  }));
}

/** Existing read-only tools; no producer, provider call or usage-receipt writer is exposed. */
export function createFinanceTradeReviewFinancialCapabilities(options: {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
}): readonly FinanceTradeReviewFinancialCapability[] {
  const framework = createFinanceFrameworkCoreInspectTool(options);
  const domains = new Map<FinanceBrainModuleId, (typeof FINANCE_FRAMEWORK_CORE_DOMAINS)[number]>(
    moduleCatalog.flatMap(({ id, requiredTools }) => {
      const domain = FINANCE_FRAMEWORK_CORE_DOMAINS.find((domain) =>
        requiredTools.some((toolName) => toolName === `finance_framework_${domain}_producer`),
      );
      return domain ? [[id, domain] as const] : [];
    }),
  );
  const inspect = createFinanceLearningCapabilityInspectTool(options);
  const execute = async (
    tool: AnyAgentTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const result = await tool.execute("trade-review-financial-knowledge", args, signal);
    signal.throwIfAborted();
    return result.details;
  };
  return [
    {
      toolName: framework.name,
      moduleIds: [...domains.keys()],
      description:
        "Read an existing module's stored framework domain. This queries recorded cognition, not its producer, current market data or account facts.",
      execute: ({ moduleId }, signal) =>
        execute(framework, { domain: domains.get(moduleId) }, signal),
    },
    {
      toolName: "finance_learning_capability_apply",
      moduleIds,
      description:
        "Query retained finance capability reuse guidance for a module/question. At most two stored cards; no receipt write, new research, current data or account facts.",
      execute: async ({ moduleId, candidate, question }, signal) => {
        let sourceUpdatedAt: unknown;
        const inspectTool: AnyAgentTool = {
          ...inspect,
          execute: async (callId, args) => {
            signal.throwIfAborted();
            const result = await inspect.execute(callId, args, signal);
            signal.throwIfAborted();
            sourceUpdatedAt = (result.details as { updatedAt?: unknown }).updatedAt;
            return result;
          },
        };
        const apply = createFinanceLearningCapabilityApplyTool({ ...options, inspectTool });
        const result = await execute(
          apply,
          {
            queryText: `${moduleId} ${candidate.instrument} ${question}`,
            maxCandidates: 2,
            writeUsageReceipt: false,
          },
          signal,
        );
        return { ...(result as Record<string, unknown>), sourceUpdatedAt };
      },
    },
    createFinanceTradeResultRecallCapability(options),
  ];
}
const Bar = z
  .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), close: z.number().positive().finite() })
  .passthrough();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function requireFiniteResult(value: unknown): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("nonfinite mathematical result");
  }
  if (Array.isArray(value)) {
    value.forEach(requireFiniteResult);
  } else if (value && typeof value === "object") {
    Object.values(value).forEach(requireFiniteResult);
  }
}

function knowledgeTimes(value: unknown, cutoff: number): number {
  if (!value || typeof value !== "object") {
    return 0;
  }
  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    if (
      [
        "updatedAt",
        "sourceUpdatedAt",
        "observedAt",
        "evidenceAsOf",
        "sourceTimestamp",
        "sourceObservedAt",
        "sourceCutoff",
      ].includes(key)
    ) {
      if (child !== undefined && child !== null) {
        if (
          typeof child !== "string" ||
          !Number.isFinite(Date.parse(child)) ||
          Date.parse(child) > cutoff
        ) {
          throw new Error("stored knowledge timestamp invalid or after review cutoff");
        }
        count++;
      }
    } else {
      count += knowledgeTimes(child, cutoff);
    }
  }
  return count;
}

function summarizeEvidence(
  output: unknown,
  priority: Record<string, unknown>,
  excludedKeys: readonly string[] = [],
) {
  const outputRecord =
    output && typeof output === "object" ? (output as Record<string, unknown>) : { value: output };
  const summary: Record<string, unknown> = { ...priority };
  if (Buffer.byteLength(JSON.stringify(summary), "utf8") > 1200) {
    throw new Error("required evidence summary exceeds budget");
  }
  const omittedKeys: string[] = [];
  for (const [key, value] of Object.entries(outputRecord)) {
    if (excludedKeys.includes(key)) {
      omittedKeys.push(key);
      continue;
    }
    if (Object.hasOwn(priority, key)) {
      continue;
    }
    if (Buffer.byteLength(JSON.stringify({ ...summary, [key]: value }), "utf8") <= 1200) {
      summary[key] = value;
    } else {
      omittedKeys.push(key);
    }
  }
  const summaryText = JSON.stringify({
    result: summary,
    omittedKeys,
    ...(omittedKeys.includes("returns") && Array.isArray(outputRecord.returns)
      ? { omittedReturnCount: outputRecord.returns.length }
      : {}),
  });
  if (Buffer.byteLength(summaryText, "utf8") > 1600) {
    throw new Error("evidence summary exceeds budget");
  }
  return summaryText;
}

function knowledgeProjection(
  output: Record<string, unknown>,
  priority: Record<string, unknown>,
  field?: string,
) {
  const omitted: string[] = [];
  const records: [string, Record<string, unknown>][] = [];
  if (output.entry && typeof output.entry === "object") {
    records.push(["entry", output.entry as Record<string, unknown>]);
  }
  if (Array.isArray(output.appliedCapabilities)) {
    output.appliedCapabilities.slice(0, 2).forEach((item, index) => {
      if (item && typeof item === "object") {
        records.push([`appliedCapabilities.${index}`, item as Record<string, unknown>]);
      }
    });
  }
  const selected: Record<string, unknown> = {};
  const selectedKey = field?.slice(1).replaceAll("/", ".");
  let matchedField = false;
  for (const [prefix, record] of records) {
    // Retained methods need their application checks, not only names and risk labels.
    for (const key of KNOWLEDGE_FIELDS) {
      if (record[key] === undefined) {
        continue;
      }
      const qualified = `${prefix}.${key}`;
      if (selectedKey !== undefined && selectedKey !== qualified) {
        continue;
      }
      matchedField = true;
      if (
        Buffer.byteLength(
          JSON.stringify({ ...priority, knowledge: { ...selected, [qualified]: record[key] } }),
          "utf8",
        ) <= 1000
      ) {
        selected[qualified] = record[key];
      } else {
        // Preserve only a bounded prefix of this selected field; its tail remains unknown.
        omitted.push(qualified);
        const json = JSON.stringify(record[key]);
        const bytes = Buffer.from(json, "utf8");
        for (let limit = 160; limit >= 16; limit -= 16) {
          let end = Math.min(bytes.length, limit);
          while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
            end--;
          }
          const fragment = {
            fragmentFormat: "json_prefix_not_complete_value",
            jsonPrefix: bytes.subarray(0, end).toString("utf8"),
            originalJsonBytes: bytes.length,
          };
          if (
            Buffer.byteLength(
              JSON.stringify({ ...priority, knowledge: { ...selected, [qualified]: fragment } }),
              "utf8",
            ) <= 1000
          ) {
            selected[qualified] = fragment;
            break;
          }
        }
      }
    }
  }
  if (field !== undefined && !matchedField) {
    throw new Error("stored_knowledge_field_missing");
  }
  return {
    ...priority,
    ...(Object.keys(selected).length ? { knowledge: selected } : {}),
    ...(omitted.length ? { omittedKnowledgeFieldCount: omitted.length } : {}),
  };
}

type HistoryReadIdentity = {
  instrument: string;
  headRef: string;
  barsSha256: string;
  returnedBarCount: number;
  completedBarCount?: number;
  duplicateDates?: string[];
  duplicateDatesOmitted?: number;
  divergentDateCount?: number;
  sourceSelection?: {
    requested: z.infer<typeof HistorySourceSchema>;
    allSourcesDivergentDateCount: number;
    matchedRecordCount: number;
    boundary: string;
  };
};

/** Bounded tool batches reuse validated history only within the same host review packet. */
export function createFinanceTradeReviewEvidenceExecutor(scope: FinanceTradeReviewEvidenceScope) {
  let selectedArtifacts = new Map<string, { owner: string; sha256: string }>();
  let knowledgeResults = new Map<string, { json: string; sha256: string }>();
  let observations = new Map<
    string,
    { bars: z.infer<typeof Bar>[]; identity: HistoryReadIdentity; ref: string }
  >();
  let observationPacket: FinanceTradeDecisionReviewRequest | undefined;
  let observationScope: string | undefined;
  return async (
    requests: readonly FinanceTradeReviewEvidenceRequest[],
    packet: FinanceTradeDecisionReviewRequest,
    signal: AbortSignal,
  ): Promise<readonly FinanceTradeReviewToolEvidence[]> => {
    if (requests.length < 1 || requests.length > 2) {
      throw new Error("invalid evidence request count or duplicate");
    }
    const parsedRequests = requests.map((request) =>
      FinanceTradeReviewEvidenceRequestSchema.parse(request),
    );
    if (
      new Set(parsedRequests.map((request) => JSON.stringify(request))).size !==
      parsedRequests.length
    ) {
      throw new Error("invalid evidence request count or duplicate");
    }
    if (
      !scope.directory ||
      !scope.accountId ||
      scope.accountId.length > 240 ||
      !Number.isFinite(Date.parse(packet.asOf))
    ) {
      throw new Error("invalid host evidence scope");
    }
    const capabilities = new Map(
      financialCapabilities(scope).map((capability) => [capability.toolName, capability]),
    );
    for (const request of parsedRequests) {
      const candidate = packet.candidates.find((item) => item.candidateId === request.candidateId);
      if (
        !candidate ||
        !scope.instruments.includes(candidate.instrument) ||
        (request.action === "pair_spread_diagnostics" &&
          request.instrumentB &&
          (request.instrumentB === candidate.instrument ||
            !scope.instruments.includes(request.instrumentB)))
      ) {
        throw new Error("evidence request outside host candidate/instrument scope");
      }
      if (
        request.action === "financial_capability" &&
        !capabilities.get(request.toolName)?.moduleIds.includes(request.moduleId)
      ) {
        throw new Error("financial capability outside host tool/module scope");
      }
      if (request.action === "market_collection" && !scope.marketCollectionTool) {
        throw new Error("market collection outside host tool scope");
      }
    }
    const scopeKey = JSON.stringify([scope.directory, scope.accountId, packet.venue, packet.asOf]);
    if (packet !== observationPacket || scopeKey !== observationScope) {
      observations = new Map();
      selectedArtifacts = new Map();
      knowledgeResults = new Map();
      observationPacket = packet;
      observationScope = scopeKey;
    }
    // Keep a concurrent caller's differently scoped packet from replacing this batch's map.
    const packetObservations = observations;
    const packetArtifacts = selectedArtifacts;
    const packetKnowledgeResults = knowledgeResults;
    const ledger = createCalculationLedger({ maxEntries: 2 });
    const barTool = createFinanceBarLedgerTool();
    const math = createQuantMathTool();
    const lab = createQuantLabTool({ ledger });
    const results: FinanceTradeReviewToolEvidence[] = [];
    try {
      for (const request of parsedRequests) {
        signal.throwIfAborted();
        const candidate = packet.candidates.find(
          (item) => item.candidateId === request.candidateId,
        )!;
        if (request.action === "market_collection") {
          let output: unknown = { reason: "public_news_unavailable" };
          let status: FinanceTradeReviewToolEvidence["status"] = "unavailable";
          let sourceRef = "gdelt_public_news_titles";
          let summary = summarizeEvidence(output, {});
          try {
            const result = await scope.marketCollectionTool!.execute(
              "trade-review-public-news",
              {
                instrument: candidate.instrument,
                assetClass: "us_equity",
                collection: "news",
                seriesId: request.keyword ?? candidate.instrument,
                asOf: packet.asOf,
                sourceIds: ["gdelt_public_news_titles"],
                limit: 2,
                maxSources: 1,
                timeoutMs: 10000,
                liveFetch: true,
                writeReceipt: true,
              },
              signal,
            );
            signal.throwIfAborted();
            const receipt = result.details as FinanceMarketCollectionReceipt & {
              receiptPath?: string;
            };
            output = receipt;
            if (
              receipt.request.instrument !== candidate.instrument ||
              receipt.request.asOf !== packet.asOf ||
              receipt.request.collection !== "news" ||
              receipt.selectedSourceIds.length !== 1 ||
              !receipt.selectedSourceIds.every((id) => id === "gdelt_public_news_titles")
            ) {
              throw new Error("public_news_source_scope_mismatch");
            }
            const item = receipt.records[0];
            if (
              receipt.status === "ready" &&
              item &&
              item.collection === "news" &&
              Number.isFinite(Date.parse(item.sourceTimestamp)) &&
              Date.parse(item.sourceTimestamp) <= Date.parse(packet.asOf) &&
              typeof item.data.title === "string" &&
              typeof item.data.url === "string"
            ) {
              sourceRef = receipt.receiptPath ?? sourceRef;
              summary = summarizeEvidence(
                {},
                {
                  title: item.data.title.slice(0, 240),
                  titleTruncated: item.data.title.length > 240,
                  url: item.data.url.length <= 300 ? item.data.url : undefined,
                  urlOmitted: item.data.url.length > 300,
                  sourceTimestamp: item.sourceTimestamp,
                  delayStatus: item.delayStatus,
                  returnedRecords: receipt.records.length,
                  omittedRecords: receipt.records.length - 1,
                  receiptStatus: receipt.status,
                },
              );
              status = "completed";
            } else {
              summary = summarizeEvidence(
                {},
                { reason: "public_news_missing_or_outside_cutoff", receiptStatus: receipt.status },
              );
            }
          } catch (error) {
            signal.throwIfAborted();
            summary = summarizeEvidence(
              {},
              {
                reason:
                  error instanceof Error && error.message === "public_news_source_scope_mismatch"
                    ? error.message
                    : "public_news_unavailable",
              },
            );
          }
          results.push(
            FinanceTradeReviewToolEvidenceSchema.parse({
              action: request.action,
              candidateId: request.candidateId,
              accountId: scope.accountId,
              asOf: packet.asOf,
              status,
              sourceRef,
              requestSha256: digest(request),
              resultSha256: digest(output),
              summary,
              boundary: marketCollectionBoundary,
            }),
          );
          continue;
        }
        if (request.action === "artifact_search" || request.action === "artifact_read") {
          let output: Record<string, unknown> = {};
          let status: FinanceTradeReviewToolEvidence["status"] = "unavailable";
          try {
            if (!scope.artifactRecallOptions) {
              output = { available: false, gap: "artifact_recall_not_registered" };
            } else if (
              request.action === "artifact_read" &&
              !packetArtifacts.has(JSON.stringify([request.candidateId, request.artifactId]))
            ) {
              output = { available: false, gap: "artifact_not_selected_in_this_review" };
            } else {
              const tool = createArtifactMemoryRecallTool(scope.artifactRecallOptions);
              const result = await tool.execute(
                "trade-review-recorded-artifact",
                request.action === "artifact_search"
                  ? {
                      action: "search",
                      owner: request.owner,
                      query: request.query,
                      limit: 2,
                      asOf: packet.asOf,
                    }
                  : {
                      action: "read",
                      id: request.artifactId,
                      asOf: packet.asOf,
                      ...(request.field !== undefined
                        ? { field: request.field }
                        : { textOffset: request.textOffset, textLimit: 128 }),
                    },
                signal,
              );
              signal.throwIfAborted();
              output = result.details as Record<string, unknown>;
              if (request.action === "artifact_search" && Array.isArray(output.artifacts)) {
                for (const value of output.artifacts) {
                  if (value && typeof value === "object") {
                    const record = value as Record<string, unknown>;
                    if (
                      typeof record.id === "string" &&
                      record.owner === request.owner &&
                      typeof record.sha256 === "string"
                    ) {
                      packetArtifacts.set(JSON.stringify([request.candidateId, record.id]), {
                        owner: request.owner,
                        sha256: record.sha256,
                      });
                    }
                  }
                }
              }
              if (
                request.action === "artifact_read" &&
                output.sourceSha256 !==
                  packetArtifacts.get(JSON.stringify([request.candidateId, request.artifactId]))
                    ?.sha256
              ) {
                output = {
                  available: false,
                  gap:
                    typeof output.gap === "string"
                      ? output.gap
                      : "artifact_selected_source_changed",
                };
              }
              status = output.available === true ? "completed" : "unavailable";
            }
          } catch {
            signal.throwIfAborted();
            output = { available: false, gap: "artifact_recall_failed" };
          }
          const projected: Record<string, unknown> = {};
          for (const key of [
            "available",
            "gap",
            "sourceAvailable",
            "sourceSha256",
            "sourceObservedAt",
            "sourceCutoff",
            "field",
            "selectionComplete",
            "textOffset",
            "nextTextOffset",
            "hasMore",
            "format",
            "textProjection",
            "textPreview",
            "selectedPreview",
            "textPage",
          ]) {
            if (output[key] !== undefined) {
              projected[key] = output[key];
            }
          }
          if (Array.isArray(output.artifacts)) {
            projected.artifacts = output.artifacts.map((value) => {
              const row = value as Record<string, unknown>;
              const bytes = Buffer.from(typeof row.summary === "string" ? row.summary : "");
              let end = Math.min(160, bytes.length);
              while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
                end--;
              }
              return {
                id: row.id,
                owner: row.owner,
                observedAt: row.observedAt,
                summary: bytes.subarray(0, end).toString("utf8"),
                summaryTruncated: end < bytes.length,
              };
            });
          }
          if (Object.hasOwn(output, "selectedValue")) {
            const json = JSON.stringify(output.selectedValue);
            if (
              Buffer.byteLength(
                JSON.stringify({ ...projected, selectedValue: output.selectedValue }),
              ) <= 1000
            ) {
              projected.selectedValue = output.selectedValue;
            } else {
              const bytes = Buffer.from(json);
              let end = Math.min(320, bytes.length);
              while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
                end--;
              }
              projected.selectedFragment = {
                jsonPrefix: bytes.subarray(0, end).toString("utf8"),
                originalJsonBytes: bytes.length,
                complete: false,
              };
              projected.selectionComplete = false;
              status = "unavailable";
              projected.gap = "selected_field_exceeds_review_budget_use_narrower_field";
            }
          }
          const evidence = {
            action: request.action,
            candidateId: request.candidateId,
            accountId: scope.accountId,
            asOf: packet.asOf,
            status,
            sourceRef:
              request.action === "artifact_read"
                ? request.artifactId
                : digest({ owner: request.owner, query: request.query, asOf: packet.asOf }),
            requestSha256: digest(request),
            resultSha256: digest(output),
            summary: "",
            boundary: financialBoundary,
          };
          try {
            evidence.summary = summarizeEvidence({}, projected);
          } catch {
            evidence.status = "unavailable";
            evidence.summary = JSON.stringify({
              result: {
                gap: "artifact_projection_exceeds_review_budget",
                artifactId: request.action === "artifact_read" ? request.artifactId : undefined,
              },
            });
          }
          if (Buffer.byteLength(JSON.stringify(evidence), "utf8") > 2048) {
            evidence.status = "unavailable";
            evidence.summary = JSON.stringify({
              result: {
                gap: "artifact_projection_exceeds_review_budget",
                sourceSha256: output.sourceSha256,
                sourceObservedAt: output.sourceObservedAt,
              },
            });
          }
          results.push(FinanceTradeReviewToolEvidenceSchema.parse(evidence));
          continue;
        }
        if (request.action === "financial_capability") {
          const knowledgeKey = digest({
            candidate,
            accountId: scope.accountId,
            asOf: packet.asOf,
            venue: packet.venue,
            toolName: request.toolName,
            moduleId: request.moduleId,
            question: request.question,
          });
          let output: unknown;
          let resultSha256: string | undefined;
          let provenance: Record<string, unknown> = {};
          let status: FinanceTradeReviewToolEvidence["status"] = "completed";
          let priority: Record<string, unknown> = {
            toolName: request.toolName,
            moduleId: request.moduleId,
            interpretation: "stored_knowledge_not_current_market_account_or_point_in_time_facts",
          };
          try {
            if (request.field !== undefined) {
              const prior = packetKnowledgeResults.get(knowledgeKey);
              if (!prior) {
                throw new Error("financial_capability_source_not_retained");
              }
              if (prior.sha256 !== request.sourceResultSha256) {
                throw new Error("financial_capability_source_hash_mismatch");
              }
              // Select the sealed prior result; do not rerun a producer or mix source versions.
              output = JSON.parse(prior.json);
            } else {
              output = await capabilities.get(request.toolName)!.execute(
                {
                  moduleId: request.moduleId,
                  candidate,
                  question: request.question,
                  asOf: packet.asOf,
                  accountId: scope.accountId,
                  venue: packet.venue,
                },
                signal,
              );
            }
            signal.throwIfAborted();
            requireFiniteResult(output);
            if (!output || typeof output !== "object" || Array.isArray(output)) {
              throw new Error("stored knowledge result missing");
            }
            const record = output as Record<string, unknown>;
            resultSha256 = digest(output);
            provenance = Object.fromEntries(
              [
                "sourceUpdatedAt",
                "updatedAt",
                "artifactPath",
                "contractPath",
                "sourceRef",
                "sourceArtifactId",
                "sourceSha256",
                "sourceObservedAt",
                "sourceCutoff",
              ]
                .filter((key) => record[key] !== undefined)
                .map((key) => [key, record[key]]),
            );
            const timeCount = knowledgeTimes(record, Date.parse(packet.asOf));
            priority.sourceTime = timeCount
              ? "recorded_metadata_at_or_before_cutoff_not_market_freshness"
              : "source_time_unverified";
            for (const key of [
              "sourceUpdatedAt",
              "updatedAt",
              "candidateCount",
              "applicationStatus",
              "sourceArtifactId",
              "sourceSha256",
              "sourceObservedAt",
              "sourceCutoff",
              "recordedResult",
            ]) {
              if (record[key] !== undefined) {
                priority[key] = record[key];
              }
            }
            if (
              record.ok === false ||
              record.available === false ||
              (typeof record.status === "string" &&
                !["completed", "ready", "succeeded", "success", "ok"].includes(record.status))
            ) {
              status = "unavailable";
            }
            if (request.field === undefined && status === "completed") {
              const json = JSON.stringify(record);
              if (
                Buffer.byteLength(json, "utf8") <= MAX_RETAINED_KNOWLEDGE_RESULT_BYTES &&
                createHash("sha256").update(json).digest("hex") === resultSha256 &&
                (packetKnowledgeResults.has(knowledgeKey) ||
                  packetKnowledgeResults.size < FINANCE_TRADE_REVIEW_MAX_TOOL_REQUESTS)
              ) {
                packetKnowledgeResults.set(knowledgeKey, { json, sha256: resultSha256 });
              }
            }
            priority.fieldReadAvailable =
              status === "completed" &&
              packetKnowledgeResults.get(knowledgeKey)?.sha256 === resultSha256;
            if (request.field !== undefined) {
              priority.field = request.field;
              priority.sourceResultSha256 = request.sourceResultSha256;
            }
            priority = knowledgeProjection(record, priority, request.field);
          } catch (error) {
            signal.throwIfAborted();
            status = "unavailable";
            const reason =
              error instanceof Error &&
              [
                "nonfinite mathematical result",
                "stored knowledge result missing",
                "stored knowledge timestamp invalid or after review cutoff",
                "stored_knowledge_field_missing",
                "financial_capability_source_not_retained",
                "financial_capability_source_hash_mismatch",
              ].includes(error.message)
                ? error.message
                : "financial_capability_unavailable";
            output = { reason };
          }
          const evidence = {
            action: request.action,
            candidateId: request.candidateId,
            accountId: scope.accountId,
            asOf: packet.asOf,
            status,
            sourceRef: digest({
              toolName: request.toolName,
              moduleId: request.moduleId,
              candidateId: candidate.candidateId,
              instrument: candidate.instrument,
              accountId: scope.accountId,
              asOf: packet.asOf,
              provenance,
            }),
            requestSha256: digest(request),
            resultSha256: resultSha256 ?? digest(output),
            summary: "",
            boundary: financialBoundary,
          };
          try {
            evidence.summary = summarizeEvidence(
              request.field === undefined || status === "unavailable" ? output : {},
              priority,
            );
            if (Buffer.byteLength(JSON.stringify(evidence), "utf8") > 2048) {
              throw new Error("financial knowledge projection exceeds budget");
            }
          } catch {
            evidence.status = "unavailable";
            evidence.summary = JSON.stringify({
              result: {
                toolName: request.toolName,
                moduleId: request.moduleId,
                interpretation:
                  "stored_knowledge_not_current_market_account_or_point_in_time_facts",
                sourceTime: priority.sourceTime ?? "source_time_unverified",
                reason: "financial_capability_result_omitted_by_budget",
              },
              omittedKeys: ["result"],
            });
          }
          results.push(FinanceTradeReviewToolEvidenceSchema.parse(evidence));
          continue;
        }
        if (request.action === "broker_fill_feedback") {
          let output: unknown;
          let resultSha256: string | undefined;
          let status: FinanceTradeReviewToolEvidence["status"] = "unavailable";
          let priority: Record<string, unknown> = {
            interpretation: "recorded_instrument_fifo_not_strategy_edge_or_expected_return",
          };
          let provenance: Record<string, unknown> = {};
          try {
            // The composite feedback owner imports control-ledger schemas; load only at use.
            const { readFinanceBrokerInstrumentFeedback } =
              await import("./finance-broker-profit-feedback.js");
            signal.throwIfAborted();
            const feedback = await readFinanceBrokerInstrumentFeedback({
              directory: scope.directory,
              accountId: scope.accountId,
              instrument: candidate.instrument,
              asOf: packet.asOf,
            });
            signal.throwIfAborted();
            requireFiniteResult(feedback);
            output = feedback;
            resultSha256 = digest(feedback);
            if (
              feedback.scope.accountId !== scope.accountId ||
              feedback.scope.venue !== packet.venue ||
              feedback.scope.instrument !== candidate.instrument ||
              feedback.asOf !== packet.asOf
            ) {
              throw new Error("broker feedback outside host scope");
            }
            provenance = {
              historyHeadRef: feedback.historyHeadRef,
              ...(feedback.status === "present"
                ? {
                    snapshotRef: feedback.snapshotRef,
                    observedAt: feedback.observedAt,
                    sealedSequence: feedback.sealedSequence,
                  }
                : {}),
            };
            priority = {
              ...priority,
              ...(feedback.status === "present" ? { economics: feedback.economics } : {}),
              ...provenance,
              freshness: feedback.freshness,
              ...(feedback.status === "present"
                ? { observationBoundary: feedback.observationBoundary }
                : { reason: feedback.reason }),
            };
            status = feedback.status === "present" ? "completed" : "unavailable";
          } catch (error) {
            signal.throwIfAborted();
            const reason =
              error instanceof Error && error.message === "nonfinite mathematical result"
                ? "nonfinite_broker_feedback"
                : "broker_fill_feedback_unavailable";
            output = { reason };
            priority = { ...priority, reason };
          }
          const evidence = {
            action: request.action,
            candidateId: request.candidateId,
            accountId: scope.accountId,
            asOf: packet.asOf,
            status,
            sourceRef: digest({
              accountId: scope.accountId,
              instrument: candidate.instrument,
              asOf: packet.asOf,
              provenance,
            }),
            requestSha256: digest(request),
            resultSha256: resultSha256 ?? digest(output),
            summary: "",
            boundary: brokerFeedbackBoundary,
          };
          try {
            evidence.summary = summarizeEvidence(output, priority);
            if (Buffer.byteLength(JSON.stringify(evidence), "utf8") > 2048) {
              throw new Error("broker feedback projection exceeds budget");
            }
          } catch {
            evidence.status = "unavailable";
            evidence.summary = JSON.stringify({
              result: {
                interpretation: priority.interpretation,
                reason: "broker_fill_feedback_result_omitted_by_budget",
              },
              omittedKeys: ["result"],
            });
          }
          results.push(FinanceTradeReviewToolEvidenceSchema.parse(evidence));
          continue;
        }
        const refs: string[] = [];
        let historyRead: HistoryReadIdentity | undefined;
        let historySources: unknown;
        const read = async (instrument: string) => {
          // A failed second leg must not inherit the first leg's diagnostics.
          historyRead = undefined;
          historySources = undefined;
          signal.throwIfAborted();
          const observationKey = JSON.stringify([instrument, request.source ?? null]);
          const observed = packetObservations.get(observationKey);
          if (observed) {
            historyRead = observed.identity;
            refs.push(observed.ref);
            return observed.bars;
          }
          const result = await barTool.execute("trade-review-bars", {
            action: "read",
            directory: scope.directory,
            instrument,
            asOf: packet.asOf,
            limit: 120,
            includeSources: true,
            ...(request.source ? { source: request.source } : {}),
          });
          signal.throwIfAborted();
          const details = result.details as Record<string, unknown>;
          if (
            details.ok !== true ||
            typeof details.headRef !== "string" ||
            !Array.isArray(details.bars)
          ) {
            throw new Error("recorded daily history missing");
          }
          const catalog = details.sourceCatalog as
            | { sources?: unknown[]; omittedRecordCount?: number }
            | undefined;
          if (catalog && Array.isArray(catalog.sources)) {
            const choices: unknown[] = [];
            for (const choice of catalog.sources) {
              if (Buffer.byteLength(JSON.stringify([...choices, choice]), "utf8") <= 650) {
                choices.push(choice);
              }
            }
            historySources = {
              sources: choices,
              omittedCatalogSourceCount: catalog.sources.length - choices.length,
              omittedRecordCount: catalog.omittedRecordCount ?? 0,
              boundary: "retained_provenance_choices_not_source_quality_or_coverage",
            };
          }
          const selection = details.sourceSelection as
            | {
                allSourcesDivergentDates?: unknown[];
                matchedRecordCount?: number;
                boundary?: string;
              }
            | undefined;
          historyRead = {
            ...(request.source
              ? {
                  sourceSelection: {
                    requested: request.source,
                    allSourcesDivergentDateCount: selection?.allSourcesDivergentDates?.length ?? 0,
                    matchedRecordCount: selection?.matchedRecordCount ?? 0,
                    boundary:
                      selection?.boundary ??
                      "exact_retained_provenance_not_verified_coverage_or_adjustment",
                  },
                }
              : {}),
            instrument,
            headRef: details.headRef,
            barsSha256: digest(details.bars),
            returnedBarCount: details.bars.length,
          };
          const bars = z
            .array(Bar)
            .max(120)
            .parse(details.bars)
            .filter((bar) => bar.date < packet.asOf.slice(0, 10));
          const seenDates = new Set<string>();
          const duplicateDates = new Set<string>();
          for (const bar of bars) {
            if (seenDates.has(bar.date)) {
              duplicateDates.add(bar.date);
            }
            seenDates.add(bar.date);
          }
          historyRead = {
            ...historyRead,
            completedBarCount: bars.length,
            duplicateDates: [...duplicateDates].toSorted().slice(0, 4),
            duplicateDatesOmitted: Math.max(0, duplicateDates.size - 4),
            divergentDateCount: Array.isArray(details.divergentDates)
              ? details.divergentDates.length
              : 0,
          };
          if (
            duplicateDates.size > 0 ||
            (Array.isArray(details.divergentDates) && details.divergentDates.length > 0)
          ) {
            throw new Error("ambiguous recorded daily history");
          }
          if (bars.some((bar) => bar.sampleCount !== null)) {
            throw new Error(
              "recorded point observations are not completed daily closes or synchronized pair evidence",
            );
          }
          if (bars.length < 21) {
            throw new Error("insufficient completed daily history");
          }
          const ref = `${details.headRef}:${digest(request.source ? { bars, source: request.source } : bars)}`;
          // Capture this verified observation, not a fresh quote. A new review gets a new
          // executor; direct callers changing packet/cutoff/account also discard it.
          if (packetObservations.size >= FINANCE_TRADE_REVIEW_MAX_TOOL_REQUESTS * 2) {
            packetObservations.delete(packetObservations.keys().next().value!);
          }
          packetObservations.set(observationKey, { bars, identity: historyRead, ref });
          refs.push(ref);
          return bars;
        };
        let sourceRef = "";
        let output: unknown;
        let priority: Record<string, unknown> = {};
        let status: FinanceTradeReviewToolEvidence["status"] = "completed";
        let excludedSummaryKeys: readonly string[] = [];
        try {
          const bars = await read(candidate.instrument);
          priority.historyWindow = {
            firstDate: bars[0].date,
            lastDate: bars.at(-1)!.date,
            count: bars.length,
          };
          if (historyRead?.sourceSelection) {
            priority.sourceSelection = historyRead.sourceSelection;
          }
          priority.interpretation =
            "completed_history_not_current_quote_account_drawdown_or_net_profit";
          if (request.action === "daily_closes") {
            output = {
              count: bars.length,
              firstDate: bars[0].date,
              lastDate: bars.at(-1)!.date,
              latestClose: bars.at(-1)!.close,
              seriesSha256: digest(bars),
            };
          } else if (request.action === "pair_spread_diagnostics") {
            const other = await read(request.instrumentB!);
            const otherByDate = new Map(other.map((bar) => [bar.date, bar.close]));
            const observations = bars
              .filter((bar) => otherByDate.has(bar.date))
              .map((bar) => ({
                timestamp: `${bar.date}T00:00:00.000Z`,
                priceA: bar.close,
                priceB: otherByDate.get(bar.date)!,
              }));
            if (observations.length < Math.max(21, (request.lookbackWindow ?? 20) + 1)) {
              throw new Error("insufficient synchronized daily history");
            }
            priority.historyWindow = {
              firstDate: observations[0].timestamp.slice(0, 10),
              lastDate: observations.at(-1)!.timestamp.slice(0, 10),
              count: observations.length,
            };
            sourceRef = digest({ refs, observations, asOf: packet.asOf });
            const result = await lab.execute("trade-review-pair", {
              action: request.action,
              pairId: `${candidate.instrument}:${request.instrumentB}`,
              instrumentA: candidate.instrument,
              instrumentB: request.instrumentB,
              construction: request.construction,
              hedgeRatio: request.hedgeRatio,
              lookbackWindow: request.lookbackWindow ?? 20,
              relationshipRationale: request.relationshipRationale,
              sourceRef,
              observations,
            });
            output = result.details;
            const diagnostics = output as PairSpreadDiagnostics;
            const stationarity = diagnostics.stationarityTest;
            // Preserve the formula and both legs alongside its diagnostics; the
            // next judgment receives this summary, not the first model's request.
            priority = {
              ...priority,
              instrumentA: diagnostics.instrumentA,
              instrumentB: diagnostics.instrumentB,
              construction: diagnostics.construction,
              latestSpread: diagnostics.latestSpread,
              latestObservationZScore: diagnostics.latestObservationZScore,
              zScoreBaseline: diagnostics.zScoreBaseline,
              stationarityTest:
                stationarity.status === "assessed"
                  ? {
                      status: stationarity.status,
                      result: {
                        observations: stationarity.result.observations,
                        effectiveObservations: stationarity.result.effectiveObservations,
                        regression: stationarity.result.regression,
                        lagsUsed: stationarity.result.lagsUsed,
                        statistic: stationarity.result.statistic,
                        criticalValues: stationarity.result.criticalValues,
                        verdict: stationarity.result.verdict,
                      },
                    }
                  : stationarity,
              researchMode: diagnostics.researchMode,
              signalProduced: diagnostics.signalProduced,
              executionAuthority: diagnostics.executionAuthority,
              statisticalBoundary:
                "in_sample_descriptors_asymptotic_ADF_not_cointegration_future_convergence_or_cost_adjusted_profit",
            };
            excludedSummaryKeys = ["relationshipRationale"];
          } else {
            const result = await math.execute("trade-review-math", {
              action: request.action,
              series: bars.map((bar) => bar.close),
              seriesMode: "levels",
              returnMode: "simple",
            });
            output = result.details;
            if (request.action === "returns_from_levels") {
              const returns = z
                .array(z.number().finite())
                .min(1)
                .parse((output as Record<string, unknown>).returns);
              const cumulativePriceReturn = bars.at(-1)!.close / bars[0].close - 1;
              const mean = returns.reduce((value, item) => value + item, 0) / returns.length;
              if (![cumulativePriceReturn, mean].every(Number.isFinite)) {
                throw new Error("nonfinite return summary");
              }
              priority.returnSummary = {
                count: returns.length,
                latest: returns.at(-1)!,
                min: Math.min(...returns),
                max: Math.max(...returns),
                cumulativePriceReturn,
                mean,
                basis: "recorded_daily_simple_price_returns_not_net_profit",
              };
            }
          }
          requireFiniteResult(output);
          signal.throwIfAborted();
        } catch (error) {
          signal.throwIfAborted();
          status = "unavailable";
          priority = {};
          output = {
            reason: error instanceof Error ? error.message.slice(0, 160) : "evidence unavailable",
            ...(historySources ? { historySources } : {}),
            ...(historyRead ? { historyRead } : {}),
          };
          if (historyRead) {
            // Preserve the rejected read's identity without making its series usable.
            sourceRef = digest({
              refs,
              historyRead,
              asOf: packet.asOf,
              instrument: candidate.instrument,
            });
          }
        }
        sourceRef ||= digest({ refs, asOf: packet.asOf, instrument: candidate.instrument });
        const summaryText = summarizeEvidence(output, priority, excludedSummaryKeys);
        results.push(
          FinanceTradeReviewToolEvidenceSchema.parse({
            action: request.action,
            candidateId: request.candidateId,
            accountId: scope.accountId,
            asOf: packet.asOf,
            status,
            sourceRef,
            requestSha256: digest(request),
            resultSha256: digest(output),
            summary: summaryText,
            boundary: "recorded_daily_history_research_only_no_execution_or_fresh_quote",
          }),
        );
      }
      return results;
    } finally {
      ledger.clear();
    }
  };
}
