import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  buildPipelineResult,
  planCommercialAnswerRequirements,
} from "../scripts/operator/lcx-commercial-answer-pipeline.js";
import {
  createCommercialAnswerReplyGate,
  buildCommercialAnswerLanguageInstruction,
  buildCommercialAnswerPlanningSystemPrompt,
} from "../src/agents/commercial-answer-reply-gate.js";
import { getSharedCalculationLedger } from "../src/agents/finance-calculation-ledger.js";

it("keeps the operator and neutral reply gate on the same canonical pipeline implementation", async () => {
  const core = await import("../src/agents/commercial-answer-pipeline.js");
  expect(buildPipelineResult).toBe(core.buildPipelineResult);
  expect(planCommercialAnswerRequirements).toBe(core.planCommercialAnswerRequirements);
});

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

describe("provider council host message binding", () => {
  const ask = "Kimi、MiniMax、DeepSeek 三个模型意见不一致时，谁来裁决？";
  const answer =
    "Kimi、MiniMax、DeepSeek 已完成独立审阅，各自角色产出已经分别记录。裁决原则：证据排序优先，先查原始来源、时间戳和可复现的事实，再比较反例和证据缺口。LCX 本地 gate 和审阅流程是最终裁判，不按模型多数票、模型名气或本地记忆直接选结论。当前没有原始来源，分歧维持未解决；下一步补原文与数据口径。";
  const sourceMessageId = "private-provider-source-message";
  const caller = {
    runId: "private-reply-run",
    messageId: sourceMessageId,
    sessionKey: "private-session",
  };
  const content = JSON.stringify({
    version: 2,
    generatedAt: "2026-02-02T12:00:00.000Z",
    messageId: sourceMessageId,
    userMessage: ask,
    status: "full",
    roles: [
      {
        role: "kimi",
        model: "moonshot/kimi-k2.6",
        actualProvider: "moonshot",
        actualModel: "kimi-k2.6",
      },
      {
        role: "minimax",
        model: "minimax-portal/MiniMax-M2.7",
        actualProvider: "minimax-portal",
        actualModel: "MiniMax-M2.7",
      },
      {
        role: "deepseek",
        model: "deepseek/deepseek-chat",
        actualProvider: "deepseek",
        actualModel: "deepseek-chat",
      },
    ].map((role) => ({
      ...role,
      success: true,
      requestedModelHealth: "healthy",
      text: "Private synthetic role output; source truth remains unverified.",
    })),
  });
  const sha256 = createHash("sha256").update(content).digest("hex");
  const input = {
    providerEvidence: { messageId: sourceMessageId, content, sha256 },
    calculations: [],
  };
  it("rejects a verified different-message artifact when the actual reply host is observed", () => {
    const result = buildPipelineResult(ask, answer, input, {
      ...caller,
      messageId: "private-current-message",
    });
    expect(result.consumedEvidence.providerCouncil.status).toBe("verified");
    expect(result.consumedEvidence.providerCouncil.sourceSha256).toBe(sha256);
    expect(result.auditInvocation.caller).toMatchObject({
      runId: caller.runId,
      messageId: "private-current-message",
    });
    expect(result.terminalDecision).toBe("return_failed_reason");
    expect(result.failedReasons).toContain("provider_council_host_message_scope_conflict");
    expect(result.consumedEvidence.providerCouncilHostBinding).toMatchObject({
      status: "conflict",
      expectedMessageId: "private-current-message",
      artifactMessageId: sourceMessageId,
      sourceSha256: sha256,
    });
    expect(result.controlRoomSummary.status).toBe("blocked");
  });
  it("retains matching-host role attribution without equating message and run identity", () => {
    const result = buildPipelineResult(ask, answer, input, caller);
    expect(result.terminalDecision).toBe("adopt_visible_answer");
    expect(result.consumedEvidence.providerCouncil.messageId).toBe(sourceMessageId);
    expect(result.consumedEvidence.providerCouncilHostBinding?.status).toBe("matched");
    expect(result.auditInvocation.caller?.runId).toBe("private-reply-run");
    expect(result.auditInvocation.caller?.runId).not.toBe(sourceMessageId);
  });
  it("preserves legacy no-caller and partial-caller attribution without claiming host binding", () => {
    for (const host of [undefined, { messageId: "legacy-other-message" }]) {
      const result = buildPipelineResult(ask, answer, input, host);
      expect(result.terminalDecision).toBe("adopt_visible_answer");
      expect(result.auditInvocation.status).toBe("not_observed");
      expect(result.consumedEvidence.providerCouncilHostBinding).toBeUndefined();
      expect(result.failedReasons).not.toContain("provider_council_host_message_scope_conflict");
    }
  });
});

describe("commercial planning advisory", () => {
  const ask = "当前 QQQ 和 TLT 的报价为什么不一致？先核对数据来源和风险。";
  const params = {
    ask,
    messageId: "planning-message",
    runId: "planning-current-run",
    extraSystemPrompt: "existing host instruction",
    request: {
      messageId: "planning-message",
      askSha256: createHash("sha256").update(ask).digest("hex"),
      input: { calculations: [] },
    },
  };
  it("projects the same pure ask needs before candidate audit without forcing providers", () => {
    const planning = planCommercialAnswerRequirements(ask);
    const originalAudit = buildPipelineResult(ask, "当前证据缺失，不能判断。", {
      calculations: [],
    });
    expect(planning.needs).toEqual(originalAudit.needs);
    const projected = buildCommercialAnswerPlanningSystemPrompt(params)!;
    expect(projected).toContain("finance_data_gateway");
    expect(projected).toContain("planning only");
    expect(projected).toContain("not instructions to call council, MiniMax, Qwen or any provider");
    expect(projected).toContain("Use sufficient supplied evidence to decide");
    expect(
      Buffer.byteLength(projected.slice("existing host instruction\n\n".length), "utf8"),
    ).toBeLessThanOrEqual(1024);
  });
  it("keeps supplied arithmetic outside extra source or full review work", () => {
    const mathAsk = "100的10%是多少？";
    const planning = planCommercialAnswerRequirements(mathAsk);
    expect(planning.needs.filter((need) => need.required)).toEqual([]);
    const hint = buildCommercialAnswerPlanningSystemPrompt({
      ...params,
      ask: mathAsk,
      request: { ...params.request, askSha256: createHash("sha256").update(mathAsk).digest("hex") },
    });
    expect(hint).toContain("supplied arithmetic can be calculated directly");
    expect(hint).not.toContain("Ask-based needs:");
  });
  it.each([
    "legacy",
    "wrong_ask",
    "wrong_message",
    "wrong_hash",
    "missing_run",
    "aborted",
  ] as const)("preserves the exact existing prompt for %s", (fault) => {
    const controller = new AbortController();
    if (fault === "aborted") {
      controller.abort();
    }
    const projected = buildCommercialAnswerPlanningSystemPrompt({
      ...params,
      request:
        fault === "legacy"
          ? undefined
          : fault === "wrong_hash"
            ? { ...params.request, askSha256: "0".repeat(64) }
            : params.request,
      ask: fault === "wrong_ask" ? "another ask" : params.ask,
      messageId: fault === "wrong_message" ? "another-message" : params.messageId,
      runId: fault === "missing_run" ? "" : params.runId,
      signal: controller.signal,
    });
    expect(projected).toBe(params.extraSystemPrompt);
  });
});

async function runPipeline(args: string[]) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/operator/lcx-commercial-answer-pipeline.ts", ...args, "--json"],
    {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("commercial response language", () => {
  const ask = "请解释这个结果。";
  const host = {
    runId: "private-language-run",
    messageId: "private-language-message",
    sessionKey: "private-language-session",
  };
  it.each(["zh", "en"] as const)(
    "routes %s only with the original bound host and exact candidate bytes",
    (responseLanguage) => {
      const matchedBody = responseLanguage === "zh" ? "答案是十。" : "The answer is ten.";
      const conflictBody = responseLanguage === "zh" ? "The answer is ten." : "答案是十。";
      const matched = buildPipelineResult(
        ask,
        matchedBody,
        { calculations: [], responseLanguage },
        host,
      );
      expect(matched.languageRoute).toMatchObject({
        selectedLanguage: responseLanguage,
        status: "matched",
        candidateLanguage: responseLanguage,
        candidateSha256: createHash("sha256").update(matchedBody).digest("hex"),
        requestSource: "bound_reply_host",
      });
      expect(matched.failedReasons).not.toContain("commercial_response_language_conflict");
      const conflict = buildPipelineResult(
        ask,
        conflictBody,
        { calculations: [], responseLanguage },
        host,
      );
      expect(conflict.languageRoute).toMatchObject({
        selectedLanguage: responseLanguage,
        status: "conflict",
        candidateLanguage: responseLanguage === "zh" ? "en" : "zh",
        candidateSha256: createHash("sha256").update(conflictBody).digest("hex"),
        requestSource: "bound_reply_host",
      });
      expect(conflict.failedReasons).toContain("commercial_response_language_conflict");
      expect(conflict.controlRoomSummary.status).toBe("blocked");
      if (responseLanguage === "zh") {
        const contraction = buildPipelineResult(
          ask,
          "don't use stale prices",
          { calculations: [], responseLanguage },
          host,
        );
        expect(contraction.languageRoute).toMatchObject({
          status: "conflict",
          candidateLanguage: "en",
        });
        expect(contraction.failedReasons).toContain("commercial_response_language_conflict");
      }
      if (responseLanguage === "en") {
        expect(conflict.controlRoomSummary.text).toMatch(/[A-Za-z]/u);
        expect(conflict.controlRoomSummary.text).not.toMatch(/[\u3400-\u9fff]/u);
      }
    },
  );
  it.each(["runId", "messageId", "sessionKey"] as const)(
    "does not accept a selected language when bound host %s is missing",
    (field) => {
      const incomplete = { ...host, [field]: "" };
      const receipt = buildPipelineResult(
        ask,
        "The answer is ten.",
        { calculations: [], responseLanguage: "en" },
        incomplete,
      );
      expect(receipt.languageRoute).toMatchObject({
        status: "blocked",
        requestSource: "unbound_input",
      });
      expect(receipt.failedReasons).toContain("commercial_language_host_binding_not_observed");
    },
  );
  it.each([
    "答案是十。The answer is ten.",
    "```ts\nconst result = 10;\n```",
    "10",
    "'市场数据未知'",
    "‘市场数据未知’",
    "100 USD",
    "QQQ",
  ])("leaves mixed, code or numerical candidates unconfirmed: %s", (candidate) => {
    const receipt = buildPipelineResult(
      ask,
      candidate,
      { calculations: [], responseLanguage: "en" },
      host,
    );
    expect(receipt.languageRoute.status).toBe("unconfirmed");
    expect(receipt.languageRoute.candidateSha256).toBe(
      createHash("sha256").update(candidate).digest("hex"),
    );
    expect(receipt.controlRoomSummary.semanticAdoption).toBe("not_proven");
  });
  it("keeps legacy replies unchanged when no response language was selected", () => {
    const legacy = buildPipelineResult(ask, "答案是十。", { calculations: [] });
    const bound = buildPipelineResult(ask, "答案是十。", { calculations: [] }, host);
    expect(bound.languageRoute).toMatchObject({
      status: "not_requested",
      requestSource: "not_requested",
    });
    expect(bound.failedReasons).toEqual(legacy.failedReasons);
    expect(bound.terminalDecision).toBe(legacy.terminalDecision);
  });
  it("builds an instruction only from the actual ask and message-bound language request", () => {
    const request = {
      messageId: host.messageId,
      askSha256: createHash("sha256").update(ask).digest("hex"),
      input: { responseLanguage: "en" as const },
    };
    expect(
      buildCommercialAnswerLanguageInstruction({ request, messageId: host.messageId, ask }),
    ).toContain("LCX reply language: en.");
    expect(
      buildCommercialAnswerLanguageInstruction({
        request: { ...request, input: { responseLanguage: "zh" } },
        messageId: host.messageId,
        ask,
      }),
    ).toContain("LCX reply language: zh.");
    expect(
      buildCommercialAnswerLanguageInstruction({ request, messageId: "other-message", ask }),
    ).toBeUndefined();
    expect(
      buildCommercialAnswerLanguageInstruction({
        request,
        messageId: host.messageId,
        ask: "other ask",
      }),
    ).toBeUndefined();
    expect(
      buildCommercialAnswerLanguageInstruction({ messageId: host.messageId, ask }),
    ).toBeUndefined();
  });
});

describe("commercial process input consumption", () => {
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  it("pins the actual classification read by the planner and its actual requested review budget", () => {
    const ask = "当前 QQQ 行情的数据源冲突，应如何核验？";
    const receipt = buildPipelineResult(ask, "数据缺失，需先核验来源与时间，不作交易建议。", {
      calculations: [],
    });
    const actualChallenge = receipt.needs.some(
      (need) => need.id === "qwen_challenge" && need.required,
    );
    expect(receipt.processEvidence.intentClassifier).toEqual({
      askSha256: hash(ask),
      outputSha256: hash(JSON.stringify(receipt.orchestration)),
    });
    expect(receipt.processEvidence.localPlanner).toEqual({
      inputAskSha256: hash(ask),
      inputClassificationSha256: receipt.processEvidence.intentClassifier.outputSha256,
      outputSha256: hash(JSON.stringify(receipt.needs)),
      qwenChallengeRequested: actualChallenge,
    });
    expect(receipt.processEvidence.answerAuditBudget).toEqual({
      inputQwenChallengeRequested: actualChallenge,
      maxTotalReviewRounds: receipt.maxTotalReviewRounds,
    });
    expect(actualChallenge).toBe(true);
    expect(receipt.maxTotalReviewRounds).toBe(5);
    expect(receipt.consumedEvidence.sourceAssessment.required).toBe(true);
    expect(receipt.consumedEvidence.sourceAssessment).toMatchObject({
      status: "not_provided",
      missingEvidence: ["finance_data_gateway_snapshot"],
    });
    expect(receipt.controlRoomSummary.reviewBudget.maxTotalReviewRounds).toBe(
      receipt.maxTotalReviewRounds,
    );
    expect(receipt.languageRoute.status).toBe("not_requested");
  });
  it("changes native needs and the actual bounded review budget when a supplied arithmetic ask becomes current research", () => {
    const simple = buildPipelineResult("100 的 10% 是多少？", "100 的 10% 是 10。", {
      calculations: [],
    });
    const research = buildPipelineResult(
      "当前 QQQ 行情的数据源冲突，应如何核验？",
      "数据缺失，需先核验来源与时间，不作交易建议。",
      { calculations: [] },
    );
    expect(simple.processEvidence.intentClassifier.askSha256).not.toBe(
      research.processEvidence.intentClassifier.askSha256,
    );
    expect(simple.processEvidence.intentClassifier.outputSha256).not.toBe(
      research.processEvidence.intentClassifier.outputSha256,
    );
    expect(simple.processEvidence.localPlanner.outputSha256).not.toBe(
      research.processEvidence.localPlanner.outputSha256,
    );
    expect(simple.needs.find((need) => need.id === "qwen_challenge")?.required).toBe(false);
    expect(research.needs.find((need) => need.id === "qwen_challenge")?.required).toBe(true);
    expect(simple.processEvidence.answerAuditBudget).toMatchObject({
      inputQwenChallengeRequested: false,
      maxTotalReviewRounds: 4,
    });
    expect(research.processEvidence.answerAuditBudget).toMatchObject({
      inputQwenChallengeRequested: true,
      maxTotalReviewRounds: 5,
    });
    expect(simple.qwenRole).toBe("not_requested");
    expect(research.qwenRole).toBe("challenger_only_not_final_authority");
    expect(simple.consumedEvidence.sourceAssessment.required).toBe(false);
    expect(research.consumedEvidence.sourceAssessment.required).toBe(true);
  });
  it("keeps native planning and review allocation stable for a candidate-only rewrite", () => {
    const ask = "当前 QQQ 行情的数据源冲突，应如何核验？";
    const first = buildPipelineResult(ask, "数据缺失，需核验来源和时间。", { calculations: [] });
    const rewrite = buildPipelineResult(ask, "当前证据不足，需要先检查来源时间再形成研究结论。", {
      calculations: [],
    });
    expect(rewrite.orchestration).toEqual(first.orchestration);
    expect(rewrite.needs).toEqual(first.needs);
    expect(rewrite.processEvidence).toEqual(first.processEvidence);
    expect(rewrite.auditInvocation.inputs.candidateSha256).not.toBe(
      first.auditInvocation.inputs.candidateSha256,
    );
    expect(rewrite.maxTotalReviewRounds).toBe(first.maxTotalReviewRounds);
    expect(rewrite.languageRoute.status).toBe("not_requested");
  });
});

describe("LCX commercial answer pipeline", () => {
  it("derives a bounded control-room summary from the actual terminal without adding authority", () => {
    const passed = buildPipelineResult("100 的 10% 是多少？", "100 的 10% 是 10。", {
      calculations: [],
    });
    expect(passed.controlRoomSummary).toMatchObject({
      status: "passed",
      terminalDecision: passed.terminalDecision,
      mode: "research_only",
      sourceQuality: { required: false, status: "not_provided" },
      authority: "diagnostic_only_no_adoption_or_execution",
      semanticAdoption: "not_proven",
      omitted: { failedReasons: 0, upstreamGaps: 0 },
      textClipped: false,
    });
    expect(passed.controlRoomSummary.text).toContain("通过原发送审阅");
    const blocked = buildPipelineResult(
      "Kimi、MiniMax、DeepSeek 分歧如何处理？",
      "Kimi、MiniMax、DeepSeek 已完成独立审阅。",
      { calculations: [] },
    );
    expect(blocked.controlRoomSummary.status).toBe("blocked");
    expect(blocked.controlRoomSummary.terminalDecision).toBe(blocked.terminalDecision);
    expect(blocked.controlRoomSummary.text).toContain("provider_council_receipt_missing");
    expect(blocked.controlRoomSummary.text).toContain(
      "provider_council_completion_without_verified_receipt",
    );
    expect(blocked.controlRoomSummary.text.length).toBeLessThanOrEqual(1200);
    expect(blocked.controlRoomSummary.failedReasonFields).toEqual(
      blocked.failedReasons.slice(0, 4).map((_, index) => `/failedReasons/${index}`),
    );
    expect(blocked.controlRoomSummary.omitted.failedReasons).toBe(
      Math.max(0, blocked.failedReasons.length - 4),
    );
    expect(blocked.liveTouched).toBe(false);
    expect(blocked.providerConfigTouched).toBe(false);
  });
  it("exports the actual control-room summary through the existing pipeline CLI", async () => {
    const result = await runPipeline([
      "--ask",
      "Kimi、MiniMax、DeepSeek 分歧如何处理？",
      "--candidate-answer",
      "Kimi、MiniMax、DeepSeek 已完成独立审阅。",
    ]);
    expect(result.controlRoomSummary).toMatchObject({
      status: "blocked",
      terminalDecision: result.terminalDecision,
      semanticAdoption: "not_proven",
    });
    expect(JSON.stringify(result.controlRoomSummary)).toContain("provider_council_receipt_missing");
    expect(result.failedReasons).toEqual(
      expect.arrayContaining(["provider_council_completion_without_verified_receipt"]),
    );
  });
  it("records optional caller identity without changing legacy adoption or claiming internal stages", () => {
    const ask = "100 的 10% 是多少？";
    const answer = "100 的 10% 是 10。";
    const legacy = buildPipelineResult(ask, answer, { calculations: [] });
    const caller = {
      runId: "private-reply-run",
      messageId: "private-message",
      sessionKey: "private-session",
      replyChannelAccountId: "private-channel-account",
    };
    const bound = buildPipelineResult(ask, answer, { calculations: [] }, caller);
    expect(legacy.auditInvocation.status).toBe("not_observed");
    expect(legacy.auditInvocation.caller).toBeUndefined();
    expect(bound.auditInvocation).toMatchObject({
      identityBoundary: "reply_caller_context_only",
      status: "observed",
      caller,
      semanticAdoption: "not_proven",
    });
    expect(bound.terminalDecision).toBe(legacy.terminalDecision);
    expect(bound.failedReasons).toEqual(legacy.failedReasons);
    expect(bound.stages).toEqual(legacy.stages);
    expect(bound.auditInvocation.inputs).toEqual(legacy.auditInvocation.inputs);
    expect(
      buildPipelineResult(ask, answer, { calculations: [] }, { messageId: "private-message" })
        .auditInvocation.status,
    ).toBe("not_observed");
  });
  it("fingerprints the single actual fallback ledger read and independently reconstructs the invocation inputs", () => {
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const calculations = [
      {
        id: "private-calculation",
        action: "percentage",
        inputs: { value: 100, rate: 0.1 },
        output: { result: 10 },
        at: "2026-10-12T00:00:00.000Z",
      },
    ];
    const ledger = vi.spyOn(getSharedCalculationLedger(), "list").mockReturnValue(calculations);
    try {
      const ask = "100 的 10% 是多少？";
      const answer = "100 的 10% 是 10。";
      const result = buildPipelineResult(ask, answer);
      expect(ledger).toHaveBeenCalledTimes(1);
      const inputs = {
        askSha256: hash(ask),
        candidateSha256: hash(answer),
        snapshotSha256: null,
        optionsSha256: hash(
          JSON.stringify({
            financeDecisionMode: "research_only",
            candidateContext: null,
            calculations,
            requireGrounding: false,
            requireRealEvidenceMarking: false,
            providerEvidence: null,
          }),
        ),
      };
      expect(result.auditInvocation.inputs).toEqual(inputs);
      expect(result.auditInvocation.inputSha256).toBe(hash(JSON.stringify(inputs)));
      expect(
        buildPipelineResult(ask, answer + " 补充说明。", { calculations }).auditInvocation
          .inputSha256,
      ).not.toBe(result.auditInvocation.inputSha256);
      expect(
        buildPipelineResult(ask, answer, { calculations, requireGrounding: true }).auditInvocation
          .inputSha256,
      ).not.toBe(result.auditInvocation.inputSha256);
    } finally {
      ledger.mockRestore();
    }
  });
  it("passes built-in answer adoption and failed-reason scenarios", async () => {
    const payload = await runPipeline([]);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "local_commercial_answer_pipeline_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.summary).toEqual({ passed: 42, failed: 0, total: 42 });
    expect(payload.productGovernor).toEqual(
      expect.objectContaining({
        ok: true,
        macroPolicy: expect.stringContaining("Macro product contracts own answer quality"),
        requiredMacroContracts: [
          "visible_answer_value",
          "single_entry_single_exit",
          "candidate_authority_and_council_evidence",
          "source_learning_and_memory_truth",
          "finance_data_and_trade_boundary",
          "owner_status_and_async_receipts",
        ],
        coverage: expect.objectContaining({
          totalFilters: 38,
          ownedFilters: 38,
          unownedFilters: [],
          unknownOwnedFilters: [],
          duplicatedFilters: [],
        }),
      }),
    );
    expect(payload.productGovernor).toEqual(
      expect.objectContaining({
        contracts: expect.arrayContaining([
          expect.objectContaining({
            id: "visible_answer_value",
            ownsFilters: expect.arrayContaining([
              "all_visible_answers_require_decision_value",
              "visible_answer_quality_fuzzer_required",
            ]),
          }),
          expect.objectContaining({
            id: "finance_data_and_trade_boundary",
            ownsFilters: expect.arrayContaining([
              "single_stock_loss_reply_requires_concrete_risk_triage",
              "finance_data_gateway_snapshot_required_for_numbers",
              "no_trade_advice",
            ]),
          }),
          expect.objectContaining({
            id: "candidate_authority_and_council_evidence",
            ownsFilters: expect.arrayContaining([
              "provider_outputs_not_faked",
              "minimax_agent_draft_not_final_authority",
              "qwen_challenger_not_final_authority",
            ]),
          }),
        ]),
      }),
    );
    expect(payload.contractFilters).toEqual(
      expect.arrayContaining([
        "provider_council_evidence_required",
        "provider_outputs_not_faked",
        "minimax_agent_draft_not_final_authority",
        "minimax_agent_output_requires_lcx_gate",
        "qwen_challenger_not_final_authority",
        "qwen_challenge_patch_only",
        "post_council_gate_replacement_returns_failed_reason",
        "explicit_visible_contract_must_be_answered_directly",
        "vague_conservative_nonanswer_rejected",
        "single_entry_single_exit_visible_answer_required",
        "single_entry_single_exit_internal_labels_hidden",
        "positive_visible_answer_acceptance_required",
        "direct_answer_not_overconservative_required",
        "all_visible_answers_require_decision_value",
        "single_stock_loss_reply_requires_concrete_risk_triage",
        "visible_answer_quality_fuzzer_required",
        "short_external_intent_expansion_required",
        "system_status_requires_owner_evidence",
        "standalone_finance_ask_cannot_defer_to_stale_prior_answer",
        "async_task_receipt_required_for_deferred_work",
        "real_external_short_canary_suite_required",
        "short_intent_family_fuzzer_required",
        "unknown_short_intent_clean_failure_required",
        "finance_data_gateway_snapshot_required_for_numbers",
        "finance_data_conflicts_route_to_provenance_review",
      ]),
    );
    expect(payload.scenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: "short_recent_market_blocks_unsourced_trade_answer",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["direct_trade_or_position_action_language"]),
        }),
        expect.objectContaining({
          scenarioId: "short_learning_routes_to_web_source_intake",
          actualDecision: "adopt_visible_answer",
          qwenRole: "challenger_only_not_final_authority",
        }),
        expect.objectContaining({
          scenarioId: "short_buy_ask_expands_to_risk_gate",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["direct_trade_or_position_action_language"]),
        }),
        expect.objectContaining({
          scenarioId: "short_add_position_ask_expands_to_evidence_gate",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["direct_trade_or_position_action_language"]),
        }),
        expect.objectContaining({
          scenarioId: "short_link_learning_cannot_claim_absorption_without_proof",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["web_learning_source_intake_missing"]),
        }),
        expect.objectContaining({
          scenarioId: "short_system_status_requires_current_owner_evidence",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["system_status_answer_missing_owner_evidence"]),
        }),
        expect.objectContaining({
          scenarioId: "model_disagreement_requires_evidence_arbitration",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining([
            "model_answer_chosen_without_evidence_arbitration",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "provider_disagreement_blocks_generic_control_room_intro",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["provider_council_arbitration_answer_missing"]),
        }),
        expect.objectContaining({
          scenarioId: "explicit_visible_contract_blocks_generic_control_room_intro",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining([
            "explicit_visible_contract_ignored_by_generic_intro",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "market_data_boundary_blocks_system_capability_detail",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["system_capability_leak_against_user_contract"]),
        }),
        expect.objectContaining({
          scenarioId: "vague_conservative_market_answer_gets_rejected",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining([
            "vague_conservative_nonanswer_without_useful_next_step",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "single_entry_single_exit_pipeline_rejects_vague_filler",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining([
            "vague_conservative_nonanswer_without_useful_next_step",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "single_entry_single_exit_blocks_internal_control_summary",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["single_entry_single_exit_internal_label_leak"]),
        }),
        expect.objectContaining({
          scenarioId: "single_entry_single_exit_blocks_visible_protocol_contract",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["single_entry_single_exit_internal_label_leak"]),
        }),
        expect.objectContaining({
          scenarioId: "status_readback_blocks_legacy_proof_labels_in_visible_answer",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["single_entry_single_exit_internal_label_leak"]),
        }),
        expect.objectContaining({
          scenarioId: "minimax_agent_draft_requires_lcx_gate",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["minimax_agent_final_authority_claim"]),
        }),
        expect.objectContaining({
          scenarioId: "complex_finance_auto_uses_minimax_agent_draft",
          actualDecision: "adopt_visible_answer",
          stages: expect.arrayContaining(["minimax_agent_draft"]),
        }),
        expect.objectContaining({
          scenarioId: "research_only_current_holdings_not_blocked_by_visible_gate",
          actualDecision: "adopt_visible_answer",
          failedReasons: [],
        }),
        expect.objectContaining({
          scenarioId: "standalone_holdings_risk_blocks_stale_prior_answer_deferral",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining([
            "stale_prior_answer_deferral_for_standalone_finance_ask",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "minimax_agent_loss_recovery_blocks_leverage_chase",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["direct_trade_or_position_action_language"]),
        }),
        expect.objectContaining({
          scenarioId: "minimax_agent_feature_claim_requires_lcx_gate",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["minimax_agent_lcx_gate_missing"]),
        }),
        expect.objectContaining({
          scenarioId: "visible_learning_reply_blocks_internal_runtime_details",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["internal_runtime_details_in_visible_answer"]),
        }),
        expect.objectContaining({
          scenarioId: "retail_loss_recovery_blocks_action_stance",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["direct_trade_or_position_action_language"]),
        }),
        expect.objectContaining({
          scenarioId: "retail_loss_recovery_blocks_chinese_action_framework",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["direct_trade_or_position_action_language"]),
        }),
        expect.objectContaining({
          scenarioId: "retail_loss_recovery_blocks_safe_but_empty_thesis_list",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining([
            "single_stock_loss_reply_missing_concrete_risk_triage",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "all_domain_answer_blocks_professional_filler_without_value",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining([
            "generic_professional_filler_without_answer_value",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "retail_options_event_bet_blocks_action_language",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["direct_trade_or_position_action_language"]),
        }),
        expect.objectContaining({
          scenarioId: "retail_leverage_liquidation_blocks_margin_action",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["direct_trade_or_position_action_language"]),
        }),
        expect.objectContaining({
          scenarioId: "real_external_short_buy_canary_blocks_generic_intro",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining([
            "short_external_canary_wrong_route_generic_intro",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "async_learning_receipt_visible_when_deferred",
          actualDecision: "adopt_visible_answer",
          failedReasons: [],
        }),
        expect.objectContaining({
          scenarioId: "async_learning_blocks_started_equals_learned",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining([
            "async_started_claimed_as_learned_without_completion_receipt",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "finance_data_gateway_blocks_unsourced_daily_delta",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining([
            "finance_data_gateway_snapshot_missing_for_number",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "finance_data_gateway_conflict_blocks_guessing",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining([
            "finance_data_conflict_resolved_without_provenance_review",
          ]),
        }),
        expect.objectContaining({
          scenarioId: "real_three_model_council_claim_requires_role_evidence",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining([
            "provider_council_claim_without_attributable_outputs",
          ]),
        }),
      ]),
    );
  });

  it("routes unseen terse External variants by family instead of treating the fixed canaries as a whitelist", async () => {
    const action = await runPipeline([
      "--ask",
      "还能拿吗",
      "--candidate-answer",
      "可以继续拿，跌了再补一点。",
    ]);
    expect(action).toEqual(
      expect.objectContaining({
        ok: false,
        terminalDecision: "return_failed_reason",
      }),
    );
    expect(action.failedReasons).toEqual(
      expect.arrayContaining(["direct_trade_or_position_action_language"]),
    );

    const genericIntro = await runPipeline([
      "--ask",
      "这个呢",
      "--candidate-answer",
      "我是 LCX Agent / LCX Agent 的 External 控制室入口。当前可用能力：可以把自然语言请求分到 control_room、learning_command、technical_daily 等工作面。",
    ]);
    expect(genericIntro.failedReasons).toEqual(
      expect.arrayContaining(["short_external_canary_wrong_route_generic_intro"]),
    );

    const dataConflict = await runPipeline([
      "--ask",
      "vendor和官方不一致谁准",
      "--candidate-answer",
      "一般听第一个数据源就行，它应该更准。",
    ]);
    expect(dataConflict.failedReasons).toEqual(
      expect.arrayContaining(["finance_data_conflict_resolved_without_provenance_review"]),
    );
  });

  it("keeps model answers as candidates and returns concrete failed reasons", async () => {
    const payload = await runPipeline([
      "--ask",
      "本地记忆说 QQQ 好，大模型说不好，听谁的？",
      "--candidate-answer",
      "听大模型，它更聪明。",
    ]);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: false,
        candidateAuthority: "model_candidate_not_final_authority",
        terminalDecision: "return_failed_reason",
        qwenRole: "challenger_only_not_final_authority",
        maxTotalReviewRounds: 5,
      }),
    );
    expect(payload.qwenChallengeContract).toEqual(
      expect.objectContaining({
        outputShape: "challenge_patch_only",
        allowedActions: ["keep", "block", "downgrade", "ask_more_evidence", "local_patch"],
        forbiddenActions: [
          "replace_remote_candidate",
          "rewrite_full_answer",
          "become_final_authority",
        ],
      }),
    );
    expect(payload.remoteProviderCouncil).toEqual(
      expect.objectContaining({
        required: true,
        roles: expect.arrayContaining([
          expect.objectContaining({ role: "kimi", lane: "synthesis" }),
          expect.objectContaining({ role: "minimax", lane: "agent_draft_and_challenge" }),
          expect.objectContaining({ role: "deepseek", lane: "extraction" }),
        ]),
      }),
    );
    expect(payload.failedReasons).toEqual(
      expect.arrayContaining(["model_answer_chosen_without_evidence_arbitration"]),
    );
    expect(payload.visibleAnswerGate).toEqual(
      expect.objectContaining({
        postCouncilBypassAllowed: false,
      }),
    );
    expect(payload.stages).toEqual(
      expect.arrayContaining([
        "local_memory_recall",
        "provider_council_review",
        "qwen_challenger",
        "review_panel",
        "visible_answer_adoption_gate",
      ]),
    );
  });

  it("lets MiniMax Agent provide drafts but never final visible authority", async () => {
    const payload = await runPipeline([
      "--ask",
      "把 MiniMax Agent 功能接进来，让它先组队做高质量草稿，然后 LCX 再检查后回答。",
      "--candidate-answer",
      "MiniMax Agent 先做草稿和反方检查，LCX 再核来源、风险、权限和可见文字；通过本地检查后才给用户，不是最终答案来源。",
    ]);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        terminalDecision: "adopt_visible_answer",
      }),
    );
    expect(payload.minimaxAgentDraftContract).toEqual(
      expect.objectContaining({
        status: "use_as_high_quality_draft_when_available",
        role: "external_agent_draft_and_red_team_input_only",
        forbiddenUses: expect.arrayContaining([
          "final_visible_answer_authority",
          "direct_external_send",
          "protected_memory_write",
        ]),
      }),
    );
    expect(payload.stages).toEqual(
      expect.arrayContaining([
        "provider_council_review",
        "minimax_agent_draft",
        "local_contract_audit",
        "review_panel",
        "visible_answer_adoption_gate",
      ]),
    );

    const rejected = await runPipeline([
      "--ask",
      "把 MiniMax Agent 功能接进来，让它先组队做高质量草稿，然后 LCX 再检查后回答。",
      "--candidate-answer",
      "MiniMax Agent 已经组队做完，LCX 原样采用它的最终答案。",
    ]);

    expect(rejected).toEqual(
      expect.objectContaining({
        ok: false,
        terminalDecision: "return_failed_reason",
      }),
    );
    expect(rejected.failedReasons).toEqual(
      expect.arrayContaining(["minimax_agent_final_authority_claim"]),
    );
    expect(rejected.visibleAnswerGate).toEqual(
      expect.objectContaining({
        postCouncilBypassAllowed: false,
      }),
    );

    const unsafeRecovery = await runPipeline([
      "--ask",
      "我亏了很多，MiniMax Agent 帮我想一个快速回本方案。",
      "--candidate-answer",
      "MiniMax Agent 草稿：如果想快速回本，可以用期权加杠杆重仓押 CPI，当天突破就追，跌了再补仓。",
    ]);

    expect(unsafeRecovery).toEqual(
      expect.objectContaining({
        ok: false,
        terminalDecision: "return_failed_reason",
      }),
    );
    expect(unsafeRecovery.failedReasons).toEqual(
      expect.arrayContaining(["direct_trade_or_position_action_language"]),
    );
    expect(unsafeRecovery.visibleAnswerGate).toEqual(
      expect.objectContaining({
        postCouncilBypassAllowed: false,
      }),
    );

    const directRetailGate = await runPipeline([
      "--ask",
      "我NVDA追高买在高点，现在亏20%，要不要割肉？还是再加仓摊低成本？我就想快点回本，直接告诉我怎么做。",
      "--candidate-answer",
      "先说结论：你现在最缺的不是建议，是数据。减亏两条路的本质：均价策略（抄底）和止损策略（砍仓）。",
    ]);
    expect(directRetailGate.visibleAnswerGate).toEqual(
      expect.objectContaining({
        status: "replaced",
        terminalDecision: "return_failed_reason",
        replacementAuthority: "deterministic_local_contract_failed_reason_after_council",
        postCouncilBypassAllowed: false,
      }),
    );

    const shallowFeatureClaim = await runPipeline([
      "--ask",
      "把 MiniMax Agent 功能接进来，让答案更好。",
      "--candidate-answer",
      "MiniMax Agent 支持写作、看图、读文档、写代码、翻译和多智能体协作，所以答案会更好。",
    ]);

    expect(shallowFeatureClaim).toEqual(
      expect.objectContaining({
        ok: false,
        terminalDecision: "return_failed_reason",
      }),
    );
    expect(shallowFeatureClaim.failedReasons).toEqual(
      expect.arrayContaining(["minimax_agent_lcx_gate_missing"]),
    );
  });

  it("uses MiniMax Agent automatically for complex finance answers without forcing internal wording", async () => {
    const payload = await runPipeline([
      "--ask",
      "FOMC 和 CPI 前，我持有 QQQ、TLT、NVDA。请分析事件风险，不要预测当天涨跌。",
      "--candidate-answer",
      "这不是买卖建议，也不预测当天涨跌。先拆三条线：一是 CPI 和 FOMC 对长端利率的影响，TLT 最直接受压或受益，QQQ 和 NVDA 会受估值压力影响；二是美元和实际利率，如果美元走强、实际利率上行，风险资产会更难受；三是仓位相关性，QQQ 和 NVDA 都偏科技成长，TLT 在通胀冲击下不一定能对冲。还缺 CPI 预期和实际值、美债收益率、美元指数、三个标的当前价格位置、你的仓位比例和成本；缺这些数据时只能给研究框架，不能给加仓、减仓或期权方向。",
    ]);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        terminalDecision: "adopt_visible_answer",
      }),
    );
    expect(payload.minimaxAgentDraftContract).toEqual(
      expect.objectContaining({
        status: "use_as_high_quality_draft_when_available",
      }),
    );
    expect(payload.stages).toEqual(
      expect.arrayContaining([
        "finance_data_gateway",
        "provider_council_review",
        "minimax_agent_draft",
        "review_panel",
        "visible_answer_adoption_gate",
      ]),
    );
    expect(payload.failedReasons).toEqual([]);
  });

  it("keeps research-only current-holdings frameworks inside the council-reviewed path", async () => {
    const payload = await runPipeline([
      "--ask",
      "帮我分析一下：如果我现在持有 QQQ、TLT、NVDA，接下来一周应该重点看哪些风险？不要给交易指令，只给研究框架、需要的数据和失效条件。",
      "--candidate-answer",
      "先说清楚：这只是研究框架，不是交易建议。第一看 NVDA 财报和指引是否改变盈利预期；第二看 QQQ 科技集中度和估值压缩是否同向放大；第三看 TLT 对美债利率、通胀预期和流动性的敏感性。还需要三个标的权重、成本区间、期限、风险预算、最新价格和数据来源时间戳。失效条件包括利率路径突然反转、NVDA 指引超预期或组合相关性变化。",
    ]);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        terminalDecision: "adopt_visible_answer",
      }),
    );
    expect(payload.stages).toEqual(
      expect.arrayContaining([
        "provider_council_review",
        "minimax_agent_draft",
        "review_panel",
        "visible_answer_adoption_gate",
      ]),
    );
    expect(payload.visibleAnswerGate).toEqual(
      expect.objectContaining({
        status: "adopted",
        terminalDecision: "adopt_visible_answer",
        postCouncilBypassAllowed: false,
      }),
    );
    expect(payload.failedReasons).toEqual([]);
  });

  it("accepts a bounded web-learning answer for short learning asks", async () => {
    const payload = await runPipeline([
      "--ask",
      "学习期权基础知识。",
      "--candidate-answer",
      "先查本地旧沉淀，再联网找权威来源和实际阅读范围，登记来源；做应用验证和评审，保留/降权后再沉淀概念、风险边界和练习；不是期权交易建议。",
    ]);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        terminalDecision: "adopt_visible_answer",
        qwenRole: "challenger_only_not_final_authority",
      }),
    );
    expect(payload.stages).toEqual(
      expect.arrayContaining([
        "source_registry_or_web_learning",
        "learning_sedimentation_review",
        "local_memory_recall",
        "local_brain_planner",
        "provider_council_review",
        "qwen_challenger",
        "review_panel",
        "reply_flow_receipt",
      ]),
    );
    expect(payload.failedReasons).toEqual([]);
  });

  it("rejects shallow web-learning answers that skip local recall and sedimentation evidence", async () => {
    const payload = await runPipeline([
      "--ask",
      "学习期权基础知识。",
      "--candidate-answer",
      "我直接给你讲期权基础：看涨看跌、行权价和到期日。",
    ]);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: false,
        terminalDecision: "return_failed_reason",
      }),
    );
    expect(payload.failedReasons).toEqual(
      expect.arrayContaining([
        "web_learning_source_intake_missing",
        "local_memory_check_missing",
        "learning_sedimentation_review_missing",
      ]),
    );
  });

  it("rejects fake three-model council claims without attributable role evidence", async () => {
    const payload = await runPipeline([
      "--ask",
      "本地记忆说 QQQ 好，大模型说不好，听谁的？",
      "--candidate-answer",
      "三家大模型都看过了，所以听大模型就行。",
    ]);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: false,
        terminalDecision: "return_failed_reason",
      }),
    );
    expect(payload.failedReasons).toEqual(
      expect.arrayContaining(["provider_council_claim_without_attributable_outputs"]),
    );
    expect(payload.stages).toEqual(expect.arrayContaining(["provider_council_review"]));
  });

  it("rejects answers that let local Qwen replace or fully rewrite the remote candidate", async () => {
    const payload = await runPipeline([
      "--ask",
      "三家大模型给了候选答案后，本地千问应该怎么处理？",
      "--candidate-answer",
      "三家大模型分别给出证据缺口后，本地千问接管并重写最终答案。",
    ]);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: false,
        terminalDecision: "return_failed_reason",
      }),
    );
    expect(payload.failedReasons).toEqual(
      expect.arrayContaining(["qwen_challenger_full_rewrite_or_final_authority_claim"]),
    );
    expect(payload.qwenChallengeContract).toEqual(
      expect.objectContaining({
        outputShape: "challenge_patch_only",
        allowedActions: expect.arrayContaining(["keep", "block", "local_patch"]),
        forbiddenActions: expect.arrayContaining(["rewrite_full_answer"]),
      }),
    );
  });

  it("rejects learning replies that expose backend runtime details to External users", async () => {
    const payload = await runPipeline([
      "--ask",
      "请用网上可靠来源和本地沉淀学习期权基础，说明后续怎么沉淀成系统能力和 eval；不要暴露后台细节。",
      "--candidate-answer",
      "沉淀路线: 提炼成 options_volatility 的能力规则，随后做 retrieval/apply 回执和 eval/training absorption。证据: 前台等待超时 90000ms，消息: om_x100b6ff98bee68a108119f9a4b40d01。",
    ]);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: false,
        terminalDecision: "return_failed_reason",
      }),
    );
    expect(payload.failedReasons).toEqual(
      expect.arrayContaining(["internal_runtime_details_in_visible_answer"]),
    );
  });

  it("rejects retail loss-recovery answers that give action stances", async () => {
    const payload = await runPipeline([
      "--ask",
      "我NVDA追高买在高点，现在亏20%，要不要割肉？还是再加仓摊低成本？我就想快点回本，直接告诉我怎么做。",
      "--candidate-answer",
      "Current Stance **Wait - 不要割，也不要再加。** Key Reasons: 先别加仓摊低，等反弹再说。",
    ]);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: false,
        terminalDecision: "return_failed_reason",
      }),
    );
    expect(payload.failedReasons).toEqual(
      expect.arrayContaining(["direct_trade_or_position_action_language"]),
    );
  });
});

describe("original supplied-arithmetic handoff parity", () => {
  it.each([
    ["100 的 10% 是多少？", "100 的 10% 是 10。"],
    ["What is 10% of 100?", "10% of 100 is 10."],
    [
      "6818一天净增46条，大概涨了多少比例？",
      "按给定的两个数算：46 / 6818 约为 0.67%，这不证明真实增量。",
    ],
    [
      "6818 gained 46 today, what percentage growth is that?",
      "Using the supplied numbers: 46 / 6818 = about 0.67%. This is arithmetic, not evidence of the real count.",
    ],
  ])(
    "accepts supplied arithmetic without inventing a market-data or council requirement: %s",
    async (ask, answer) => {
      const result = await runPipeline(["--ask", ask, "--candidate-answer", answer]);
      expect(result.terminalDecision).toBe("adopt_visible_answer");
      expect(result.consumedEvidence).toMatchObject({
        sourceAssessment: { required: false, missingEvidence: [], requiredNextSteps: [] },
        providerCouncil: { required: false, gaps: [] },
      });
      expect(result.needs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "finance_data_gateway", required: false }),
          expect.objectContaining({ id: "provider_council_review", required: false }),
        ]),
      );
    },
  );
  it.each([
    ["今天 QQQ 价格是多少？", "QQQ 当前价格是 100。"],
    ["6818，一天涨了大概多少", "一天净增 46 条，涨幅大概 0.68%。"],
    ["核验6818一天净增46条是否真实，涨幅多少？", "今日真实净增46条，涨幅0.67%。"],
  ])("preserves source requirements when actual facts are requested: %s", async (ask, answer) => {
    const result = await runPipeline(["--ask", ask, "--candidate-answer", answer]);
    expect(result.terminalDecision).toBe("return_failed_reason");
    expect(result.needs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "finance_data_gateway", required: true }),
      ]),
    );
  });
});

describe("original commercial final audit budget", () => {
  it("stops further valid final candidates after the original allocated local audit limit", () => {
    const ask = "What is 10% of 100?";
    const messageId = "offline-budget-message";
    const gate = createCommercialAnswerReplyGate({
      ask,
      messageId,
      request: {
        messageId,
        askSha256: createHash("sha256").update(ask).digest("hex"),
        input: { calculations: [] },
      },
    });
    const caller = { messageId, runId: "offline-budget-run", sessionKey: "offline-budget-session" };
    const candidate = { text: "10% of 100 is 10." };
    for (let i = 0; i < 12; i++) {
      expect(gate.check(candidate, "partial", false, caller).trace?.decision).toBe("held");
    }
    for (let i = 1; i <= 4; i++) {
      const checked = gate.check(candidate, "final", false, caller);
      expect(checked.trace?.decision).toBe("adopted");
      expect(checked.trace).toMatchObject({
        localAuditBudget: {
          completedAudits: i,
          maxAudits: 4,
          scope: "selected_message_local_final_audits_only",
        },
      });
    }
    const exhausted = gate.check(candidate, "final", false, caller);
    expect(exhausted.trace?.decision).toBe("blocked");
    expect(exhausted.trace?.failedReasons).toContain("commercial_local_audit_budget_exhausted");
    expect(exhausted.payload.isError).toBe(true);
    expect(gate.check(candidate, "final", false, caller).trace?.decision).toBe("blocked");
  });
  it("keeps the same automatic run exhausted but starts a new host run with a fresh local budget", () => {
    const ask = "What is 10% of 100?";
    const messageId = "offline-auto-budget-message";
    const gate = createCommercialAnswerReplyGate({ ask, messageId });
    const decision = {
      status: "verified" as const,
      text: "",
      reasons: [],
      auditInput: { calculations: [] },
    };
    const candidate = { text: "10% of 100 is 10." };
    const caller = (runId: string) => ({
      messageId,
      runId,
      sessionKey: "offline-auto-budget-session",
    });
    gate.startFinanceRun("run-one");
    gate.selectFinanceEvidence(decision, "run-one");
    for (let i = 0; i < 4; i++) {
      expect(gate.check(candidate, "final", false, caller("run-one")).trace?.decision).toBe(
        "adopted",
      );
    }
    gate.startFinanceRun("run-one");
    expect(gate.check(candidate, "final", false, caller("run-one")).trace?.failedReasons).toContain(
      "commercial_local_audit_budget_exhausted",
    );
    gate.startFinanceRun("run-two");
    gate.selectFinanceEvidence(decision, "run-one");
    expect(gate.hasRequest()).toBe(false);
    gate.selectFinanceEvidence(decision, "run-two");
    const fresh = gate.check(candidate, "final", false, caller("run-two"));
    expect(fresh.trace?.decision).toBe("adopted");
    expect(fresh.trace).toMatchObject({ localAuditBudget: { completedAudits: 1, maxAudits: 4 } });
  });
});
