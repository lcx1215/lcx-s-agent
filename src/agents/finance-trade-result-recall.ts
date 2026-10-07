import type { OpenClawConfig } from "../config/config.js";
import type { FinanceTradeReviewFinancialCapability } from "./finance-trade-review-evidence.js";
import { createArtifactMemoryRecallTool } from "./tools/artifact-memory-recall-tool.js";

const OWNER = "finance_intraday_execution";
const SEARCH_LIMIT = 4;
const hash = /^[a-f\d]{64}$/u;
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function excerpt(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  let end = Math.min(bytes.length, maxBytes);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
    end--;
  }
  return bytes.subarray(0, end).toString("utf8");
}
const unavailable = (gap: string) => ({ ok: false, status: "unavailable", gap });

/** Reuse the original reader; the model cannot choose a DB, owner, ID, field or cutoff. */
export function createFinanceTradeResultRecallCapability(options: {
  config?: OpenClawConfig;
  agentId?: string;
  workspaceDir: string;
}): FinanceTradeReviewFinancialCapability {
  const tool = createArtifactMemoryRecallTool(options);
  return {
    toolName: "finance_trade_result_recall",
    moduleIds: ["portfolio_risk_gates", "technical_timing", "finance_learning_memory"],
    description:
      "Read a prior execution result for this account, Paper venue and instrument, preferring the same direction before review cutoff. At most four verified originals searched; no current account facts, strategy edge, self-recall or new research.",
    execute: async ({ candidate, asOf, accountId, venue }, signal) => {
      signal.throwIfAborted();
      const cutoff = typeof asOf === "string" ? Date.parse(asOf) : NaN;
      if (!Number.isFinite(cutoff) || !accountId || venue !== "alpaca:paper") {
        return unavailable("finance_recall_host_scope_missing");
      }
      const search = async (query: string) =>
        record(
          (
            await tool.execute(
              "trade-review-result-search",
              {
                action: "search",
                owner: OWNER,
                query,
                asOf,
                limit: SEARCH_LIMIT,
              },
              signal,
            )
          ).details,
        );
      // Bare symbols also match other trades' portfolio context. Prefer the
      // producer's instrument/direction phrase; retain older summary formats.
      let found = await search(`${candidate.instrument} ${candidate.side}`);
      if (
        found?.available === true &&
        Array.isArray(found.artifacts) &&
        found.artifacts.length === 0
      ) {
        found = await search(candidate.instrument);
      }
      signal.throwIfAborted();
      if (found?.available !== true || !Array.isArray(found.artifacts)) {
        return unavailable(
          typeof found?.gap === "string" ? found.gap : "finance_recall_search_unavailable",
        );
      }
      let readGap: string | undefined;
      // The native ledger schemas depend on review evidence; load at use, not factory setup.
      const { FinanceIntradayDecisionInput } = await import("./finance-intraday-control-ledger.js");
      for (const item of found.artifacts.slice(0, SEARCH_LIMIT)) {
        const metadata = record(item);
        if (metadata?.owner !== OWNER || typeof metadata.id !== "string") {
          continue;
        }
        const read = record(
          (
            await tool.execute(
              "trade-review-result-read",
              { action: "read", id: metadata.id, field: "/value/details", asOf },
              signal,
            )
          ).details,
        );
        signal.throwIfAborted();
        if (read?.available !== true) {
          readGap =
            typeof read?.gap === "string" ? read.gap : "finance_recall_original_unavailable";
          continue;
        }
        const artifact = record(read.artifact);
        const details = record(read.selectedValue);
        const decision = record(details?.decision);
        const outcome = record(details?.outcome);
        const input = FinanceIntradayDecisionInput.safeParse(decision?.input);
        if (
          artifact?.owner !== OWNER ||
          artifact.id !== metadata.id ||
          details?.accountId !== accountId ||
          details.venue !== venue ||
          !input.success ||
          input.data.instrument !== candidate.instrument ||
          input.data.signalId === candidate.candidateId ||
          outcome?.signalId !== input.data.signalId ||
          !["placed", "refused", "uncertain"].includes(String(outcome.status)) ||
          !Array.isArray(outcome.reasons) ||
          outcome.reasons.some((reason) => typeof reason !== "string") ||
          typeof decision?.ref !== "string" ||
          !hash.test(decision.ref) ||
          typeof read.sourceSha256 !== "string" ||
          !hash.test(read.sourceSha256) ||
          typeof read.sourceObservedAt !== "string"
        ) {
          continue;
        }
        const review = record(outcome.tradeDecisionReview);
        const times = [
          read.sourceObservedAt,
          read.sourceCutoff,
          decision.recordedAt,
          input.data.referencePriceAt,
          record(review?.request)?.asOf,
        ].filter((time) => time !== undefined);
        if (
          times.some(
            (time) =>
              typeof time !== "string" ||
              !Number.isFinite(Date.parse(time)) ||
              Date.parse(time) > cutoff,
          )
        ) {
          readGap = "finance_recall_source_after_cutoff_or_invalid_time";
          continue;
        }
        const reasons = (outcome.reasons as string[])
          .slice(0, 2)
          .map((reason) => excerpt(reason, 70));
        const priorDecision = record(review?.decision);
        const truncatedFields = (outcome.reasons as string[])
          .slice(0, 2)
          .flatMap((reason, index) => (reason !== reasons[index] ? [`reasons.${index}`] : []));
        if (
          typeof priorDecision?.rationale === "string" &&
          Buffer.byteLength(priorDecision.rationale) > 80
        ) {
          truncatedFields.push("reviewRationale");
        }
        return {
          ok: true,
          sourceArtifactId: metadata.id,
          sourceSha256: read.sourceSha256,
          sourceObservedAt: read.sourceObservedAt,
          ...(read.sourceCutoff === undefined ? {} : { sourceCutoff: read.sourceCutoff }),
          recordedResult: {
            signalId: input.data.signalId,
            outcome: outcome.status,
            reasons,
            omittedReasonCount: outcome.reasons.length - reasons.length,
            ...(truncatedFields.length ? { truncatedFields } : {}),
            ...(typeof priorDecision?.rationale === "string"
              ? { reviewRationale: excerpt(priorDecision.rationale, 80) }
              : {}),
          },
        };
      }
      return unavailable(
        readGap ??
          (found.hasMore === true
            ? "finance_recall_no_scoped_result_in_bounded_page"
            : "finance_recall_no_prior_scoped_result"),
      );
    },
  };
}
