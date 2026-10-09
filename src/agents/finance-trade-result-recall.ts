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
      "Read a prior execution result for this account, Paper venue and instrument, preferring the same direction before review cutoff. Choose the newest native decision among at most four verified originals; capture time is not operation time. Partial reasons retain gaps; model review status is separate from execution. No current account facts, strategy edge, self-recall or new research.",
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
      let selected: { recordedAt: number; result: Record<string, unknown> } | undefined;
      // The native ledger schemas depend on review evidence; load at use, not factory setup.
      const { FinanceIntradayDecisionInput } = await import("./finance-intraday-control-ledger.js");
      for (const item of found.artifacts.slice(0, SEARCH_LIMIT)) {
        const metadata = record(item);
        if (metadata?.owner !== OWNER || typeof metadata.id !== "string") {
          continue;
        }
        let read = record(
          (
            await tool.execute(
              "trade-review-result-read",
              { action: "read", id: metadata.id, field: "/value/details", asOf },
              signal,
            )
          ).details,
        );
        signal.throwIfAborted();
        let reasonFragment: string | undefined;
        if (
          read?.available === false &&
          read.gap === "artifact_field_budget_exceeded" &&
          read.sourceAvailable === true &&
          typeof read.sourceSha256 === "string" &&
          hash.test(read.sourceSha256)
        ) {
          const original = read;
          // Reuse exact fields through the original guarded reader. Never raise its
          // budget, parse a whole-record preview or combine different source versions.
          const field = async (pointer: string, optional = false, partial = false) => {
            signal.throwIfAborted();
            const selected = record(
              (
                await tool.execute(
                  "trade-review-result-field",
                  { action: "read", id: metadata.id, field: pointer, asOf },
                  signal,
                )
              ).details,
            );
            signal.throwIfAborted();
            if (!selected || (selected.available !== true && selected.sourceAvailable !== true)) {
              throw new Error(
                typeof selected?.gap === "string"
                  ? selected.gap
                  : "finance_recall_original_unavailable",
              );
            }
            const identity = record(selected.artifact);
            if (
              (selected.available === true
                ? identity?.id !== metadata.id || identity?.owner !== OWNER
                : selected.artifactId !== metadata.id) ||
              selected.sourceSha256 !== original.sourceSha256 ||
              selected.sourceObservedAt !== original.sourceObservedAt ||
              selected.sourceCutoff !== original.sourceCutoff
            ) {
              throw new Error("finance_recall_source_changed_during_selection");
            }
            if (
              selected.available !== true &&
              !(optional && selected.gap === "artifact_field_missing") &&
              !(partial && selected.gap === "artifact_field_budget_exceeded")
            ) {
              throw new Error(
                typeof selected.gap === "string"
                  ? selected.gap
                  : "finance_recall_original_unavailable",
              );
            }
            return selected;
          };
          try {
            const account = await field("/value/details/accountId");
            const priorVenue = await field("/value/details/venue");
            if (account.selectedValue !== accountId || priorVenue.selectedValue !== venue) {
              continue;
            }
            const prior = await field("/value/details/decision");
            const priorInput = FinanceIntradayDecisionInput.safeParse(
              record(prior.selectedValue)?.input,
            );
            if (
              !priorInput.success ||
              priorInput.data.instrument !== candidate.instrument ||
              priorInput.data.signalId === candidate.candidateId
            ) {
              continue;
            }
            const signalId = await field("/value/details/outcome/signalId");
            const status = await field("/value/details/outcome/status");
            const reasons = await field("/value/details/outcome/reasons", false, true);
            if (reasons.available !== true) {
              reasonFragment =
                typeof reasons.selectedPreview === "string"
                  ? excerpt(reasons.selectedPreview, 70)
                  : "";
            }
            const priorReview = await field(
              "/value/details/outcome/tradeDecisionReview/decision",
              true,
            );
            const priorReviewTime = await field(
              "/value/details/outcome/tradeDecisionReview/request/asOf",
              true,
            );
            const priorReviewStatus = await field(
              "/value/details/outcome/tradeDecisionReview/status",
              true,
            );
            const priorReviewFailure = await field(
              "/value/details/outcome/tradeDecisionReview/failureCode",
              true,
            );
            read = {
              ...account,
              selectedValue: {
                accountId: account.selectedValue,
                venue: priorVenue.selectedValue,
                decision: prior.selectedValue,
                outcome: {
                  signalId: signalId.selectedValue,
                  status: status.selectedValue,
                  reasons: reasons.available === true ? reasons.selectedValue : [],
                  tradeDecisionReview: {
                    decision: priorReview.selectedValue,
                    request: { asOf: priorReviewTime.selectedValue },
                    status: priorReviewStatus.selectedValue,
                    failureCode: priorReviewFailure.selectedValue,
                  },
                },
              },
            };
          } catch (error) {
            signal.throwIfAborted();
            readGap =
              error instanceof Error ? error.message : "finance_recall_original_unavailable";
            continue;
          }
        }
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
        const recordedAt =
          typeof decision.recordedAt === "string" ? Date.parse(decision.recordedAt) : -Infinity;
        if (selected && selected.recordedAt >= recordedAt) {
          continue;
        }
        const reasons = (outcome.reasons as string[])
          .slice(0, 2)
          .map((reason) => excerpt(reason, 70));
        const priorDecision = record(review?.decision);
        const reviewStatus =
          review?.status === "completed" || review?.status === "failed" ? review.status : undefined;
        const truncatedFields = (outcome.reasons as string[])
          .slice(0, 2)
          .flatMap((reason, index) => (reason !== reasons[index] ? [`reasons.${index}`] : []));
        if (
          reviewStatus === "failed" &&
          typeof review?.failureCode === "string" &&
          Buffer.byteLength(review.failureCode) > 80
        ) {
          truncatedFields.push("reviewFailureCode");
        }
        if (
          typeof priorDecision?.rationale === "string" &&
          Buffer.byteLength(priorDecision.rationale) > 80
        ) {
          truncatedFields.push("reviewRationale");
        }
        const result = {
          ok: true,
          sourceArtifactId: metadata.id,
          sourceSha256: read.sourceSha256,
          sourceObservedAt: read.sourceObservedAt,
          ...(read.sourceCutoff === undefined ? {} : { sourceCutoff: read.sourceCutoff }),
          recordedResult: {
            signalId: input.data.signalId,
            decisionRecordedAt: decision.recordedAt ?? null,
            outcome: outcome.status,
            ...(reviewStatus ? { reviewStatus } : {}),
            ...(reviewStatus === "failed" && typeof review?.failureCode === "string"
              ? { reviewFailureCode: excerpt(review.failureCode, 80) }
              : {}),
            ...(reviewStatus === "completed" &&
            (priorDecision?.decision === "approve" || priorDecision?.decision === "veto")
              ? { reviewDecision: priorDecision.decision }
              : {}),
            reasons,
            omittedReasonCount:
              reasonFragment === undefined ? outcome.reasons.length - reasons.length : null,
            ...(reasonFragment === undefined
              ? {}
              : {
                  reasonSelectionGap: "artifact_field_budget_exceeded",
                  reasonFragmentFormat: "json_prefix_not_complete_reasons",
                  reasonFragmentJson: reasonFragment,
                }),
            ...(truncatedFields.length ? { truncatedFields } : {}),
            ...(typeof priorDecision?.rationale === "string"
              ? { reviewRationale: excerpt(priorDecision.rationale, 80) }
              : {}),
          },
        };
        selected = { recordedAt, result };
      }
      if (selected) {
        return selected.result;
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
