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
    expect(payload.summary).toEqual({ passed: 10, failed: 0, total: 10 });
    expect(payload.contractFilters).toEqual(
      expect.arrayContaining([
        "provider_council_evidence_required",
        "provider_outputs_not_faked",
        "qwen_challenger_not_final_authority",
        "qwen_challenge_patch_only",
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
          scenarioId: "model_disagreement_requires_evidence_arbitration",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining([
            "model_answer_chosen_without_evidence_arbitration",
          ]),
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
          scenarioId: "retail_options_event_bet_blocks_action_language",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["direct_trade_or_position_action_language"]),
        }),
        expect.objectContaining({
          scenarioId: "retail_leverage_liquidation_blocks_margin_action",
          actualDecision: "return_failed_reason",
          failedReasons: expect.arrayContaining(["direct_trade_or_position_action_language"]),
        }),
      ]),
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
          expect.objectContaining({ role: "minimax", lane: "challenge" }),
          expect.objectContaining({ role: "deepseek", lane: "extraction" }),
        ]),
      }),
    );
    expect(payload.failedReasons).toEqual(
      expect.arrayContaining(["model_answer_chosen_without_evidence_arbitration"]),
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
