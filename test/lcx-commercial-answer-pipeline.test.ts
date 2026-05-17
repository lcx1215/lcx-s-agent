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
    expect(payload.summary).toEqual({ passed: 5, failed: 0, total: 5 });
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
        maxTotalReviewRounds: 4,
      }),
    );
    expect(payload.failedReasons).toEqual(
      expect.arrayContaining(["model_answer_chosen_without_evidence_arbitration"]),
    );
    expect(payload.stages).toEqual(
      expect.arrayContaining([
        "local_memory_recall",
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
});
