import { createHash } from "node:crypto";
import {
  buildPipelineResult,
  planCommercialAnswerRequirements,
  type CommercialAuditCaller,
} from "../../scripts/operator/lcx-commercial-answer-pipeline.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import type { FinanceReplyEvidenceDecision } from "./finance-reply-evidence.js";
import {
  isProviderCouncilGapCode,
  readProviderCouncilReviewFeedback,
} from "./provider-council-evidence.js";
import { applyVisibleAnswerAdoptionGate } from "./visible-answer-adoption-gate.js";

/** Explicit host opt-in, bound to the original inbound message; not a model declaration. */
export type CommercialAnswerAuditRequest = {
  messageId: string;
  askSha256: string;
  /** Missing inputs hold this explicitly selected flow, rather than inventing an approval. */
  input?: NonNullable<Parameters<typeof buildPipelineResult>[2]>;
};

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Project the original ask planner into the existing loop without invoking any review owner. */
export function buildCommercialAnswerPlanningSystemPrompt(params: {
  request?: CommercialAnswerAuditRequest;
  messageId?: string;
  ask: string;
  runId: string;
  signal?: AbortSignal;
  extraSystemPrompt?: string;
}): string | undefined {
  if (
    params.signal?.aborted ||
    !params.runId.trim() ||
    !params.messageId?.trim() ||
    params.request?.messageId !== params.messageId ||
    !params.ask.trim() ||
    params.request.askSha256 !== hash(params.ask)
  ) {
    return params.extraSystemPrompt;
  }
  const planning = planCommercialAnswerRequirements(
    params.ask,
    params.request.input?.financeDecisionMode,
  );
  const needs = planning.needs.filter((need) => need.required).map((need) => need.id);
  const selected = [...needs];
  const prefix =
    "LCX predecision advisory: planning only; this advisory asserts no completed check or authorization. ";
  const policy =
    "Use sufficient supplied evidence to decide. For a concrete missing or conflicting field, narrowly choose existing tools/Skills or state the exact gap. Review needs are conditional checks, not instructions to call council, MiniMax, Qwen or any provider. Do not force a full pipeline or paid rerun. Preserve original source, risk, permission and context budgets.";
  const render = () =>
    prefix +
    (needs.length
      ? `Ask-based needs: ${selected.join(", ")}.${selected.length < needs.length ? ` ${needs.length - selected.length} needs omitted from this advisory.` : ""} `
      : "No extra source/review need inferred; supplied arithmetic can be calculated directly. ") +
    policy;
  while (Buffer.byteLength(render(), "utf8") > 1024 && selected.length > 0) {
    selected.pop();
  }
  const advisory = render();
  return params.extraSystemPrompt ? `${params.extraSystemPrompt}\n\n${advisory}` : advisory;
}

/** Bind the optional host language instruction to the same original ask used by the terminal gate. */
export function buildCommercialAnswerLanguageInstruction(params: {
  request?: CommercialAnswerAuditRequest;
  messageId?: string;
  ask: string;
}): string | undefined {
  const language = params.request?.input?.responseLanguage;
  if (
    (language !== "zh" && language !== "en") ||
    !params.messageId?.trim() ||
    params.request?.messageId !== params.messageId ||
    !params.ask.trim() ||
    params.request.askSha256 !== hash(params.ask)
  ) {
    return undefined;
  }
  return `LCX reply language: ${language}. Respond in ${language === "zh" ? "Chinese" : "English"}. Preserve necessary quoted terms and code. This instruction grants no source, quality or execution authority.`;
}

/** The existing auditor produces the receipt; this outlet consumes its actual terminal decision. */
export function createCommercialAnswerReplyGate(params: {
  request?: CommercialAnswerAuditRequest;
  messageId?: string;
  ask: string;
  signal?: AbortSignal;
  /** Original queued runtime prompt, reused by the current main or followup caller. */
  historicalSystemPrompt?: string;
}) {
  let request = params.request;
  let failed: string[] | undefined;
  let failureText: string | undefined;
  const queuedRefusals = new Set<string>();
  let refusalFeedback: {
    status: "queued" | "already_queued" | "not_observed";
    reason: string;
    contextKey?: string;
    omittedFailedReasons?: number;
  } = {
    status: "not_observed",
    reason: "native_audit_refusal_not_observed",
  };
  let financeRunId: string | undefined;
  let completedLocalAudits = 0;
  let maxLocalAudits: number | undefined;
  const localAuditBudget = () => ({
    scope: "selected_message_local_final_audits_only" as const,
    completedAudits: completedLocalAudits,
    maxAudits: maxLocalAudits,
    modelRounds: "not_observed" as const,
  });
  let selection:
    | { runId: string; receiptSha256?: string; snapshotPointer?: string; auditInputGaps?: string[] }
    | undefined;
  return {
    startFinanceRun(runId: string) {
      if (financeRunId === runId) {
        return;
      }
      financeRunId = runId;
      if (!params.request) {
        request = undefined;
        completedLocalAudits = 0;
        maxLocalAudits = undefined;
        failed = undefined;
        failureText = undefined;
        selection = undefined;
        refusalFeedback = { status: "not_observed", reason: "native_audit_refusal_not_observed" };
      }
    },
    selectFinanceEvidence(decision: FinanceReplyEvidenceDecision, runId: string) {
      if (params.request || financeRunId !== runId || failed) {
        return;
      }
      if (decision.status === "blocked") {
        failed = decision.reasons.length ? decision.reasons : ["finance_original_evidence_failed"];
        failureText = decision.text;
        request = { messageId: params.messageId ?? "", askSha256: hash(params.ask) };
        return;
      }
      if (
        decision.status !== "verified" ||
        (!decision.auditInput && !decision.auditInputGaps?.length)
      ) {
        return;
      }
      // Only the original host tracker may select a hash-pinned, same-run receipt.
      selection = {
        runId,
        receiptSha256: decision.receiptSha256,
        snapshotPointer: decision.snapshotPointer,
        auditInputGaps: decision.auditInputGaps,
      };
      request = {
        messageId: params.messageId ?? "",
        askSha256: hash(params.ask),
        input: decision.auditInput,
      };
    },
    financeSelection() {
      return selection ? { ...selection } : undefined;
    },
    hasRequest() {
      return request !== undefined;
    },
    hasFailed() {
      return failed !== undefined;
    },
    check(
      payload: ReplyPayload,
      surface: "partial" | "block" | "final",
      stopped = false,
      auditCaller?: CommercialAuditCaller,
    ) {
      if (!request) {
        return { payload, trace: undefined };
      }
      const block = (reasons: string[]) => {
        failed ??= reasons;
        return {
          payload: {
            ...payload,
            text:
              failureText ??
              "本次回答未通过所选答复审计，尚不能采用。请补齐对应证据或修正候选回答后再审阅。",
            mediaUrl: undefined,
            mediaUrls: undefined,
            isError: true,
          },
          trace: {
            decision: "blocked",
            failedReasons: failed,
            candidateSha256: hash(payload.text ?? ""),
            semanticAdoption: "not_proven",
            refusalFeedback: { ...refusalFeedback },
            localAuditBudget: localAuditBudget(),
          },
        };
      };
      // Nothing from an unaudited candidate, including attached media, escapes the explicit flow.
      if (surface !== "final") {
        return {
          payload: { ...payload, text: "", mediaUrl: undefined, mediaUrls: undefined },
          trace: {
            decision: "held",
            failedReasons: ["commercial_final_candidate_pending"],
            semanticAdoption: "not_proven",
          },
        };
      }
      if (failed) {
        return block(failed);
      }
      if (stopped || params.signal?.aborted) {
        return block(["commercial_reply_cancelled"]);
      }
      if (payload.isError) {
        return block(["commercial_upstream_reply_failed"]);
      }
      if (!params.ask.trim()) {
        return block(["commercial_original_ask_not_observed"]);
      }
      if (!params.messageId || request.messageId !== params.messageId) {
        return block(["commercial_message_scope_conflict"]);
      }
      if (!/^[a-f0-9]{64}$/u.test(request.askSha256) || request.askSha256 !== hash(params.ask)) {
        return block(["commercial_ask_hash_conflict"]);
      }
      if (!request.input || typeof request.input !== "object") {
        return block(["commercial_audit_input_not_observed"]);
      }
      if (!payload.text?.trim()) {
        return block(["commercial_final_candidate_not_observed"]);
      }
      if (Buffer.byteLength(payload.text) > 12 * 1024) {
        return block(["commercial_candidate_budget_exceeded"]);
      }
      if (maxLocalAudits !== undefined && completedLocalAudits >= maxLocalAudits) {
        failureText =
          "本次答复的审阅次数已用尽，尚不能采用更多候选回答。请保留当前结果，补齐缺口后另行处理。";
        return block(["commercial_local_audit_budget_exhausted"]);
      }
      const presentation = applyVisibleAnswerAdoptionGate({
        userMessage: params.ask,
        answerText: payload.text,
        presentationOnly: true,
        captureProcessEvidence: true,
      });
      if (presentation.status !== "adopted") {
        return block(presentation.failedReasons);
      }
      try {
        const feedbackCallerBound =
          auditCaller?.messageId === params.messageId &&
          (!financeRunId || financeRunId === auditCaller?.runId);
        const providerCouncilReviewFeedback = readProviderCouncilReviewFeedback({
          systemPrompt: params.historicalSystemPrompt,
          ask: params.ask,
          caller: feedbackCallerBound ? (auditCaller ?? {}) : {},
        });
        const auditInput =
          providerCouncilReviewFeedback || request.input.providerCouncilReviewFeedback
            ? { ...request.input, providerCouncilReviewFeedback }
            : request.input;
        completedLocalAudits += 1;
        const receipt = buildPipelineResult(params.ask, presentation.text, auditInput, auditCaller);
        // Consume the original policy at this existing final-candidate seam. This
        // counts local audits only and does not infer model/provider execution.
        maxLocalAudits = Math.min(
          maxLocalAudits ?? receipt.maxTotalReviewRounds,
          receipt.maxTotalReviewRounds,
        );
        // This is local synchronous auditing, not a new model round or a source fetch.
        if (params.signal?.aborted) {
          return block(["commercial_reply_cancelled"]);
        }
        if (receipt.terminalDecision !== "adopt_visible_answer" || !receipt.ok) {
          failureText = receipt.controlRoomSummary.text;
        }
        const output =
          receipt.terminalDecision === "adopt_visible_answer" && receipt.ok
            ? {
                payload: { ...payload, text: presentation.text },
                trace: { decision: "adopted", failedReasons: receipt.failedReasons },
              }
            : block(
                receipt.failedReasons.length
                  ? receipt.failedReasons
                  : ["commercial_terminal_not_adopted"],
              );
        const auditReceiptSha256 = hash(JSON.stringify(receipt));
        if (receipt.terminalDecision === "return_failed_reason") {
          const invocation = receipt.auditInvocation;
          const caller = invocation.caller;
          const sessionKey = auditCaller?.sessionKey;
          const bound =
            invocation.status === "observed" &&
            auditCaller?.sessionKey?.trim() &&
            auditCaller.runId?.trim() &&
            (!financeRunId || financeRunId === auditCaller.runId) &&
            auditCaller.messageId === params.messageId &&
            caller?.sessionKey === auditCaller.sessionKey &&
            caller.runId === auditCaller.runId &&
            caller.messageId === auditCaller.messageId &&
            invocation.inputs.askSha256 === hash(params.ask) &&
            invocation.inputs.candidateSha256 === hash(presentation.text);
          refusalFeedback.reason = bound
            ? "native_refusal_diagnostic_budget_unconfirmed"
            : "native_refusal_host_binding_not_observed";
          if (bound && !stopped && !params.signal?.aborted && auditCaller && sessionKey) {
            const contextKey = `commercial-refusal:${auditCaller.runId}:${auditReceiptSha256}`;
            const codes = receipt.failedReasons.slice(0, 8);
            const omittedFailedReasons = receipt.failedReasons.length - codes.length;
            const providerGaps = receipt.consumedEvidence.providerCouncil.gaps
              .filter(isProviderCouncilGapCode)
              .slice(0, 4);
            const diagnostic = JSON.stringify({
              schemaVersion: "lcx_commercial_refusal_feedback_v1",
              boundary:
                "historical_native_audit_refusal_diagnostic_only_not_market_fact_or_execution_authority",
              runId: caller?.runId,
              messageId: caller?.messageId,
              auditReceiptSha256,
              askSha256: invocation.inputs.askSha256,
              candidateSha256: invocation.inputs.candidateSha256,
              sessionKey: caller?.sessionKey,
              replyChannelAccountId: caller?.replyChannelAccountId,
              ...(receipt.consumedEvidence.providerCouncil.required &&
              providerGaps.length > 0 &&
              ["missing", "invalid"].includes(receipt.consumedEvidence.providerCouncil.status)
                ? {
                    providerCouncil: {
                      sourceSha256: receipt.consumedEvidence.providerCouncil.sourceSha256,
                      status: receipt.consumedEvidence.providerCouncil.status,
                      gaps: providerGaps,
                      omittedGaps:
                        receipt.consumedEvidence.providerCouncil.gaps.length - providerGaps.length,
                    },
                  }
                : {}),
              failedReasons: codes,
              omittedFailedReasons,
              ...(receipt.languageRoute.selectedLanguage
                ? {
                    languageRoute: {
                      selectedLanguage: receipt.languageRoute.selectedLanguage,
                      candidateLanguage: receipt.languageRoute.candidateLanguage,
                      status: receipt.languageRoute.status,
                    },
                  }
                : {}),
              semanticAdoption: "not_proven",
            });
            const safeCodes =
              codes.length > 0 &&
              codes.every(
                (code) =>
                  code.length <= 128 &&
                  /^[a-z][a-zA-Z0-9_.:/-]*(?:\[[0-9]+\][a-zA-Z0-9_.:/-]*)*$/u.test(code),
              );
            if (!safeCodes) {
              refusalFeedback = {
                status: "not_observed",
                reason: "native_refusal_reason_code_unconfirmed",
                omittedFailedReasons,
              };
            } else if (Buffer.byteLength(diagnostic) > 2048) {
              refusalFeedback = {
                status: "not_observed",
                reason: "native_refusal_diagnostic_budget_exceeded",
                omittedFailedReasons,
              };
            } else {
              if (queuedRefusals.has(contextKey)) {
                refusalFeedback = {
                  status: "already_queued",
                  reason: "same_native_refusal_previously_queued",
                  contextKey,
                  omittedFailedReasons,
                };
              } else if (enqueueSystemEvent(diagnostic, { sessionKey, contextKey })) {
                queuedRefusals.add(contextKey);
                refusalFeedback = {
                  status: "queued",
                  reason: "next_new_session_prompt_queue_only_not_persisted_or_adopted",
                  contextKey,
                  omittedFailedReasons,
                };
              } else {
                refusalFeedback = {
                  status: "already_queued",
                  reason: "original_session_event_queue_duplicate",
                  contextKey,
                  omittedFailedReasons,
                };
              }
            }
          }
        }
        return {
          ...output,
          trace: {
            ...output.trace,
            nativeTerminalDecision: receipt.terminalDecision,
            localAuditBudget: localAuditBudget(),
            controlRoomSummary: receipt.controlRoomSummary,
            nativeFailedReasons: receipt.failedReasons,
            auditReceiptSha256,
            refusalFeedback: { ...refusalFeedback },
            consumedEvidence: receipt.consumedEvidence,
            auditInvocation: receipt.auditInvocation,
            askSha256: hash(params.ask),
            messageId: params.messageId,
            semanticAdoption: "not_proven",
          },
        };
      } catch {
        return block(["commercial_audit_failed"]);
      }
    },
  };
}
