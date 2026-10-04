import { createHash } from "node:crypto";
import { z } from "zod";
import { createCalculationLedger } from "./finance-calculation-ledger.js";
import type { FinanceTradeDecisionReviewRequest } from "./finance-trade-decision-review.js";
import { createFinanceBarLedgerTool } from "./tools/finance-bar-ledger-tool.js";
import { createQuantLabTool } from "./tools/quant-lab-tool.js";
import { createQuantMathTool } from "./tools/quant-math-tool.js";

const Text = z.string().min(1).max(120);
export const FinanceTradeReviewEvidenceRequestSchema = z
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
export type FinanceTradeReviewEvidenceRequest = z.infer<
  typeof FinanceTradeReviewEvidenceRequestSchema
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
    boundary: z.literal("recorded_daily_history_research_only_no_execution_or_fresh_quote"),
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
}>;
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

/** One review-local calculation ledger; all data and identity come from the trusted host. */
export function createFinanceTradeReviewEvidenceExecutor(scope: FinanceTradeReviewEvidenceScope) {
  return async (
    requests: readonly FinanceTradeReviewEvidenceRequest[],
    packet: FinanceTradeDecisionReviewRequest,
    signal: AbortSignal,
  ): Promise<readonly FinanceTradeReviewToolEvidence[]> => {
    if (
      requests.length < 1 ||
      requests.length > 2 ||
      new Set(requests.map((request) => JSON.stringify(request))).size !== requests.length
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
    for (const raw of requests) {
      const request = FinanceTradeReviewEvidenceRequestSchema.parse(raw);
      const candidate = packet.candidates.find((item) => item.candidateId === request.candidateId);
      if (
        !candidate ||
        !scope.instruments.includes(candidate.instrument) ||
        (request.instrumentB &&
          (request.instrumentB === candidate.instrument ||
            !scope.instruments.includes(request.instrumentB)))
      ) {
        throw new Error("evidence request outside host candidate/instrument scope");
      }
    }
    const ledger = createCalculationLedger({ maxEntries: 2 });
    const barTool = createFinanceBarLedgerTool();
    const math = createQuantMathTool();
    const lab = createQuantLabTool({ ledger });
    const results: FinanceTradeReviewToolEvidence[] = [];
    try {
      for (const raw of requests) {
        signal.throwIfAborted();
        const request = FinanceTradeReviewEvidenceRequestSchema.parse(raw);
        const candidate = packet.candidates.find(
          (item) => item.candidateId === request.candidateId,
        );
        if (
          !candidate ||
          !scope.instruments.includes(candidate.instrument) ||
          (request.instrumentB &&
            (request.instrumentB === candidate.instrument ||
              !scope.instruments.includes(request.instrumentB)))
        ) {
          throw new Error("evidence request outside host candidate/instrument scope");
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
        const outputRecord =
          output && typeof output === "object"
            ? (output as Record<string, unknown>)
            : { value: output };
        const summary: Record<string, unknown> = { ...priority };
        if (Buffer.byteLength(JSON.stringify(summary), "utf8") > 1200) {
          throw new Error("required math summary exceeds budget");
        }
        const omittedKeys: string[] = [];
        for (const [key, value] of Object.entries(outputRecord)) {
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
