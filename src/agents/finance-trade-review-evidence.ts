import { createHash } from "node:crypto";
import { z } from "zod";
import type { OpenClawConfig } from "../config/config.js";
import { FINANCE_FRAMEWORK_CORE_DOMAINS } from "../hooks/bundled/lobster-brain-registry.js";
import {
  financeBrainModuleCatalog,
  type FinanceBrainModuleId,
} from "./finance-brain-orchestration.js";
import { createCalculationLedger } from "./finance-calculation-ledger.js";
import type { FinanceTradeDecisionReviewRequest } from "./finance-trade-decision-review.js";
import { createFinanceTradeResultRecallCapability } from "./finance-trade-result-recall.js";
import type { PairSpreadDiagnostics } from "./quant-math-pair-spread.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createFinanceBarLedgerTool } from "./tools/finance-bar-ledger-tool.js";
import { createFinanceFrameworkCoreInspectTool } from "./tools/finance-framework-core-inspect-tool.js";
import { createFinanceLearningCapabilityApplyTool } from "./tools/finance-learning-capability-apply-tool.js";
import { createFinanceLearningCapabilityInspectTool } from "./tools/finance-learning-capability-inspect-tool.js";
import { createQuantLabTool } from "./tools/quant-lab-tool.js";
import { createQuantMathTool } from "./tools/quant-math-tool.js";

const Text = z.string().min(1).max(120);
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
export const FinanceTradeReviewEvidenceRequestSchema = z.union([
  MathEvidenceRequestSchema,
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
    })
    .strict(),
]);
export type FinanceTradeReviewEvidenceRequest = z.infer<
  typeof FinanceTradeReviewEvidenceRequestSchema
>;
export const FinanceTradeReviewModelCallEvidenceSchema = z
  .object({
    attempt: z.union([z.literal(1), z.literal(2)]),
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
}>;
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

function knowledgeProjection(output: Record<string, unknown>, priority: Record<string, unknown>) {
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
  for (const [prefix, record] of records) {
    for (const key of [
      "capabilityName",
      "whatChangesMyMind",
      "doNotUseFor",
      "riskGateNotes",
      "riskChecks",
      "requiredInputs",
      "evidenceSummary",
      "baseCase",
      "bearCase",
      "keyCausalChain",
      "applicationBoundary",
      "sourceArticlePath",
    ]) {
      if (record[key] === undefined) {
        continue;
      }
      const qualified = `${prefix}.${key}`;
      if (
        Buffer.byteLength(
          JSON.stringify({ ...priority, knowledge: { ...selected, [qualified]: record[key] } }),
          "utf8",
        ) <= 1000
      ) {
        selected[qualified] = record[key];
      } else {
        omitted.push(qualified);
      }
    }
  }
  return {
    ...priority,
    ...(Object.keys(selected).length ? { knowledge: selected } : {}),
    ...(omitted.length ? { omittedKnowledgeFieldCount: omitted.length } : {}),
  };
}

/** One review-local calculation ledger; all data and identity come from the trusted host. */
export function createFinanceTradeReviewEvidenceExecutor(scope: FinanceTradeReviewEvidenceScope) {
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
    }
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
        if (request.action === "financial_capability") {
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
            priority = knowledgeProjection(record, priority);
          } catch (error) {
            signal.throwIfAborted();
            status = "unavailable";
            const reason =
              error instanceof Error &&
              [
                "nonfinite mathematical result",
                "stored knowledge result missing",
                "stored knowledge timestamp invalid or after review cutoff",
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
            evidence.summary = summarizeEvidence(output, priority);
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
        const read = async (instrument: string) => {
          signal.throwIfAborted();
          const result = await barTool.execute("trade-review-bars", {
            action: "read",
            directory: scope.directory,
            instrument,
            asOf: packet.asOf,
            limit: 120,
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
          const bars = z
            .array(Bar)
            .max(120)
            .parse(details.bars)
            .filter((bar) => bar.date < packet.asOf.slice(0, 10));
          if (
            new Set(bars.map((bar) => bar.date)).size !== bars.length ||
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
          refs.push(`${details.headRef}:${digest(bars)}`);
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
          };
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
