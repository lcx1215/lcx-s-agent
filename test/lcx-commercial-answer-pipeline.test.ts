import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function runPipeline(args: string[]) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/dev/lcx-commercial-answer-pipeline.ts", ...args, "--json"],
    {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("LCX commercial answer pipeline", () => {
  it("passes built-in answer adoption and failed-reason scenarios", async () => {
    const payload = await runPipeline([]);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_commercial_answer_pipeline_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.summary).toEqual({ passed: 41, failed: 0, total: 41 });
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
        "single_stock_loss_reply_requires_concrete_risk_triage",
        "visible_answer_quality_fuzzer_required",
        "short_lark_intent_expansion_required",
        "system_status_requires_owner_evidence",
        "standalone_finance_ask_cannot_defer_to_stale_prior_answer",
        "async_task_receipt_required_for_deferred_work",
        "real_lark_short_canary_suite_required",
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
          scenarioId: "real_lark_short_buy_canary_blocks_generic_intro",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["short_lark_canary_wrong_route_generic_intro"]),
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

  it("routes unseen terse Lark variants by family instead of treating the fixed canaries as a whitelist", async () => {
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
      "我是 LCX Agent / OpenClaw 的 Lark 控制室入口。当前可用能力：可以把自然语言请求分到 control_room、learning_command、technical_daily 等工作面。",
    ]);
    expect(genericIntro.failedReasons).toEqual(
      expect.arrayContaining(["short_lark_canary_wrong_route_generic_intro"]),
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
          "direct_lark_send",
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

  it("rejects learning replies that expose backend runtime details to Lark users", async () => {
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
