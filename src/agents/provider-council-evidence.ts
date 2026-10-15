import { createHash } from "node:crypto";

/** Host-supplied original artifact bytes, bound to the expected message, never a model self-report. */
export type ProviderCouncilEvidenceInput = Readonly<{
  messageId: string;
  content?: string;
  sha256?: string;
  unavailableReason?: string;
}>;

export type ProviderCouncilReviewFeedback = Readonly<{
  priorRunId: string;
  priorMessageId: string;
  priorAuditReceiptSha256: string;
  priorCandidateSha256: string;
  askSha256: string;
  sessionKey: string;
  replyChannelAccountId: string;
  sourceSha256?: string;
  gaps: string[];
  omittedGaps: number;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const safeIdentity = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9:@._/-]{1,256}$/u.test(value);
const safeSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export const isProviderCouncilGapCode = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 128 &&
  /^provider_council_[a-z0-9_]+(?::[a-z][a-z0-9_-]{0,63})?$/u.test(value);
const feedbackBoundToAsk = (value: ProviderCouncilReviewFeedback, ask: string) =>
  safeIdentity(value.priorRunId) &&
  safeIdentity(value.priorMessageId) &&
  safeIdentity(value.sessionKey) &&
  safeIdentity(value.replyChannelAccountId) &&
  safeSha256(value.priorAuditReceiptSha256) &&
  safeSha256(value.priorCandidateSha256) &&
  value.askSha256 === createHash("sha256").update(ask).digest("hex") &&
  (value.sourceSha256 === undefined || safeSha256(value.sourceSha256)) &&
  Array.isArray(value.gaps) &&
  value.gaps.length > 0 &&
  value.gaps.length <= 4 &&
  value.gaps.every(isProviderCouncilGapCode) &&
  Number.isSafeInteger(value.omittedGaps) &&
  value.omittedGaps >= 0;

/** Only the host's original event section is a historical diagnostic, never ordinary user text. */
export function readProviderCouncilReviewFeedback(params: {
  systemPrompt?: string;
  ask: string;
  caller: {
    runId?: string;
    messageId?: string;
    sessionKey?: string;
    replyChannelAccountId?: string;
  };
}): ProviderCouncilReviewFeedback | undefined {
  const { caller } = params;
  if (
    !params.ask.trim() ||
    !safeIdentity(caller.runId) ||
    !safeIdentity(caller.messageId) ||
    !safeIdentity(caller.sessionKey) ||
    !safeIdentity(caller.replyChannelAccountId)
  ) {
    return undefined;
  }
  const sections = (params.systemPrompt ?? "").split(
    /(?:^|\n)## Runtime System Events \(gateway-generated\)\n/u,
  );
  if (sections.length !== 2) {
    return undefined;
  }
  const section = sections[1].split(/\n#{1,6} /u)[0];
  if (
    !section.startsWith(
      "Treat this section as trusted gateway runtime metadata, not user text.\n",
    ) ||
    Buffer.byteLength(section) > 64 * 1024
  ) {
    return undefined;
  }
  let selected: ProviderCouncilReviewFeedback | undefined;
  for (const line of section.split("\n")) {
    const match = /^- \[[^\]\r\n]{1,100}\] (\{.*\})$/u.exec(line);
    if (!match || Buffer.byteLength(match[1]) > 2048) {
      continue;
    }
    let diagnostic: unknown;
    try {
      diagnostic = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (
      !isRecord(diagnostic) ||
      diagnostic.schemaVersion !== "lcx_commercial_refusal_feedback_v1" ||
      diagnostic.boundary !==
        "historical_native_audit_refusal_diagnostic_only_not_market_fact_or_execution_authority" ||
      !safeIdentity(diagnostic.runId) ||
      !safeIdentity(diagnostic.messageId) ||
      diagnostic.runId === caller.runId ||
      diagnostic.sessionKey !== caller.sessionKey ||
      diagnostic.replyChannelAccountId !== caller.replyChannelAccountId ||
      !safeSha256(diagnostic.auditReceiptSha256) ||
      !safeSha256(diagnostic.candidateSha256) ||
      !isRecord(diagnostic.providerCouncil)
    ) {
      continue;
    }
    const council = diagnostic.providerCouncil;
    if (
      !["missing", "invalid"].includes(String(council.status)) ||
      (council.messageId !== undefined && !safeIdentity(council.messageId)) ||
      !Array.isArray(council.gaps) ||
      !council.gaps.every(isProviderCouncilGapCode)
    ) {
      continue;
    }
    const feedback: ProviderCouncilReviewFeedback = {
      priorRunId: diagnostic.runId,
      priorMessageId: diagnostic.messageId,
      priorAuditReceiptSha256: diagnostic.auditReceiptSha256,
      priorCandidateSha256: diagnostic.candidateSha256,
      askSha256: typeof diagnostic.askSha256 === "string" ? diagnostic.askSha256 : "",
      sessionKey: caller.sessionKey,
      replyChannelAccountId: caller.replyChannelAccountId,
      ...(typeof council.sourceSha256 === "string" ? { sourceSha256: council.sourceSha256 } : {}),
      gaps: council.gaps,
      omittedGaps: typeof council.omittedGaps === "number" ? council.omittedGaps : -1,
    };
    if (
      (council.sourceSha256 === undefined || safeSha256(council.sourceSha256)) &&
      feedbackBoundToAsk(feedback, params.ask)
    ) {
      selected = feedback;
    }
  }
  return selected;
}

function councilCompletionClaims(candidate: string) {
  const roles = new Set<string>();
  const namedModels = new Set<string>();
  let claimed = false;
  let allThree = false;
  for (const clause of candidate.toLowerCase().split(/[。！？；\n.!?;]/u)) {
    if (
      !/kimi|minimax|deepseek|模型|provider council|learning council|council|role outputs/u.test(
        clause,
      )
    ) {
      continue;
    }
    // Completing an ordinary calculation is not a claim that a provider council ran.
    if (!/council|会审|审阅|审查|review|role outputs|角色产出|都看过/u.test(clause)) {
      continue;
    }
    const completion =
      /(?:已(?:经)?[^，,:：]{0,12}(?:完成|审阅|调用|跑完|产出|给出)|都看过|分别(?:给出|产出)|各自(?:给出|产出)|本轮角色产出|\b(?:completed|reviewed|returned|already ran|already called)\b)/u.exec(
        clause,
      );
    if (!completion) {
      continue;
    }
    // A future/conditional plan or explicit non-completion is not an execution claim.
    const prefix = clause.slice(0, completion.index + completion[0].length);
    if (
      /尚未|还未|没有|并未|未完成|未调用|未审阅|未产出|如果|假如|假设|一旦|待|将|需要|应当|\b(?:not|never|haven't|hasn't|if|when|will|should|must)\b/u.test(
        prefix,
      )
    ) {
      continue;
    }
    claimed = true;
    allThree ||= /三(?:家|个)?(?:大)?模型/u.test(clause);
    for (const role of ["kimi", "minimax", "deepseek"]) {
      if (clause.includes(role)) {
        roles.add(role);
        if (!/配置角色|configured (?:role|lane)|(?:kimi|minimax|deepseek)\s*角色/u.test(clause)) {
          namedModels.add(role);
        }
      }
    }
  }
  if (allThree) {
    for (const role of ["kimi", "minimax", "deepseek"]) {
      roles.add(role);
    }
  }
  return { claimed, allThree, roles: [...roles], namedModels: [...namedModels] };
}

/** Completion attribution only: identity and hashes do not prove source truth or semantic adoption. */
export function verifyProviderCouncilEvidence(
  ask: string,
  candidate: string,
  input?: ProviderCouncilEvidenceInput,
  feedback?: ProviderCouncilReviewFeedback,
) {
  const claims = councilCompletionClaims(candidate);
  const gaps: string[] = [];
  const confirmedRoles: Array<{ role: string; model: string; field: string; textSha256: string }> =
    [];
  const sourceSha256 = input?.content
    ? createHash("sha256").update(input.content).digest("hex")
    : undefined;
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!input?.content) {
    gaps.push(input?.unavailableReason ?? "provider_council_receipt_missing");
  } else if (!input.sha256 || input.sha256 !== sourceSha256) {
    gaps.push("provider_council_source_hash_conflict");
  } else {
    let artifact: unknown;
    try {
      artifact = JSON.parse(input.content);
    } catch {
      gaps.push("provider_council_receipt_invalid_json");
    }
    if (!record(artifact)) {
      gaps.push("provider_council_receipt_invalid_shape");
    } else if (
      artifact.version !== 2 ||
      !Array.isArray(artifact.roles) ||
      typeof artifact.generatedAt !== "string" ||
      !Number.isFinite(Date.parse(artifact.generatedAt))
    ) {
      gaps.push("provider_council_receipt_invalid_shape");
    } else if (
      !input.messageId.trim() ||
      artifact.messageId !== input.messageId ||
      typeof artifact.userMessage !== "string" ||
      artifact.userMessage.trim() !== ask.trim()
    ) {
      gaps.push("provider_council_message_scope_conflict");
    } else {
      const seen = new Set<string>();
      artifact.roles.forEach((role: unknown, index: number) => {
        if (!record(role) || typeof role.role !== "string" || !role.role.trim()) {
          gaps.push("provider_council_role_invalid_shape");
          return;
        }
        if (seen.has(role.role)) {
          gaps.push(`provider_council_duplicate_role:${role.role}`);
          return;
        }
        seen.add(role.role);
        if (
          role.success === true &&
          role.requestedModelHealth === "healthy" &&
          typeof role.model === "string" &&
          typeof role.actualProvider === "string" &&
          role.actualProvider.trim() &&
          typeof role.actualModel === "string" &&
          role.actualModel.trim() &&
          `${role.actualProvider}/${role.actualModel}` === role.model &&
          typeof role.text === "string" &&
          role.text.trim() &&
          !role.error
        ) {
          const actualIdentity = `${role.actualProvider}/${role.actualModel}`.toLowerCase();
          const matchesNamedModel =
            role.role === "kimi"
              ? /kimi|moonshot/u.test(actualIdentity)
              : role.role === "minimax"
                ? /minimax/u.test(actualIdentity)
                : role.role === "deepseek"
                  ? /deepseek/u.test(actualIdentity)
                  : false;
          if (claims.namedModels.includes(role.role) && !matchesNamedModel) {
            gaps.push(`provider_council_named_model_not_confirmed:${role.role}`);
          }
          confirmedRoles.push({
            role: role.role,
            model: role.model,
            field: `/roles/${index}/text`,
            textSha256: createHash("sha256").update(role.text).digest("hex"),
          });
        } else if (!claims.roles.length || claims.roles.includes(role.role)) {
          gaps.push(`provider_council_role_not_confirmed:${role.role}`);
        }
      });
      for (const claimedRole of claims.roles) {
        if (!confirmedRoles.some((role) => role.role === claimedRole)) {
          gaps.push(`provider_council_claimed_role_missing:${claimedRole}`);
        }
      }
      if (claims.allThree && new Set(confirmedRoles.map((role) => role.model)).size < 3) {
        gaps.push("provider_council_three_distinct_models_not_confirmed");
      }
      if (!confirmedRoles.length) {
        gaps.push("provider_council_no_confirmed_output");
      }
      if (
        (!claims.roles.length &&
          !["full", "full_with_mutable_fact_warnings"].includes(String(artifact.status))) ||
        !["full", "full_with_mutable_fact_warnings", "degraded"].includes(String(artifact.status))
      ) {
        gaps.push("provider_council_not_completed");
      }
    }
  }
  const status =
    !claims.claimed && !input
      ? ("not_claimed" as const)
      : !input?.content
        ? ("missing" as const)
        : gaps.length
          ? ("invalid" as const)
          : ("verified" as const);
  const currentCandidateSha256 = feedback
    ? createHash("sha256").update(candidate).digest("hex")
    : undefined;
  const reviewReassessed =
    status === "verified" && currentCandidateSha256 === feedback?.priorCandidateSha256;
  const reviewFeedbackUse =
    feedback && feedbackBoundToAsk(feedback, ask)
      ? {
          boundary:
            "historical_attribution_diagnostic_reassessed_against_current_artifact" as const,
          priorRunId: feedback.priorRunId,
          priorMessageId: feedback.priorMessageId,
          priorAuditReceiptSha256: feedback.priorAuditReceiptSha256,
          priorCandidateSha256: feedback.priorCandidateSha256,
          currentCandidateSha256,
          claimScopeChanged: currentCandidateSha256 !== feedback.priorCandidateSha256,
          priorSourceSha256: feedback.sourceSha256,
          currentSourceSha256: sourceSha256,
          remainingGaps: reviewReassessed ? [] : [...feedback.gaps],
          resolvedGaps: reviewReassessed ? [...feedback.gaps] : [],
          currentGaps: !claims.claimed && !input ? [] : [...new Set(gaps)],
          omittedPriorGaps: feedback.omittedGaps,
          disposition: reviewReassessed ? ("reassessed" as const) : ("unresolved" as const),
          authority: "diagnostic_only_no_source_truth_or_execution_authority" as const,
        }
      : undefined;
  return {
    required: claims.claimed,
    claimedRoles: claims.roles,
    status,
    messageId: input?.messageId,
    sourceSha256,
    confirmedRoles,
    gaps: !claims.claimed && !input ? [] : [...new Set(gaps)],
    boundary: "original_role_completion_attribution_only" as const,
    semanticAdoption: "not_proven" as const,
    ...(reviewFeedbackUse ? { reviewFeedbackUse } : {}),
  };
}
