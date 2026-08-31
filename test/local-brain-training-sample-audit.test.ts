import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessLocalBrainSemanticContract,
  buildLocalBrainTrainingPrompt,
  findAnswerBearingContractTokens,
  redactTeacherContractLabels,
} from "../scripts/dev/local-brain-training-contract.js";
import { auditTrainingSamples } from "../scripts/dev/local-brain-training-sample-audit.js";

const completion = JSON.stringify({
  task_family: "portfolio_risk",
  primary_modules: ["portfolio_risk_gates"],
  supporting_modules: ["review_panel"],
  required_tools: ["review_panel"],
  missing_data: ["position_weights_and_return_series"],
  risk_boundaries: ["research_only"],
  next_step: "route_to_review",
  rejected_context: ["old_lark_conversation_history"],
});

function oldPrompt(userOrTask: string, sourceSummary: string): string {
  return [
    "STATIC CONTRACT",
    "",
    "source_kind: brain_distillation_review",
    `user_or_task: ${userOrTask}`,
    `source_summary: ${sourceSummary}`,
  ].join("\n");
}

describe("local brain training sample audit", () => {
  it("flags shape-valid teacher rows that miss shared task semantics", () => {
    const assessment = assessLocalBrainSemanticContract("研究大宗商品并说明库存与曲线风险", {
      task_family: "finance_research_planning",
      primary_modules: ["source_registry"],
      supporting_modules: ["review_panel"],
      required_tools: [],
      missing_data: [],
      risk_boundaries: ["research_only"],
    });

    expect(assessment.alignment).toBe("mismatch");
    expect(assessment.missingModules).toContain("commodities_oil_gold");
    expect(assessment.missingData).toContain("commodity_curve_roll_yield_and_inventory_inputs");
  });

  it("accepts a complete commodity learning contract without case labels", () => {
    const assessment = assessLocalBrainSemanticContract(
      "学习原油，research-only，不输出交易建议。",
      {
        task_family: "commodity_learning",
        primary_modules: [
          "finance_learning_memory",
          "source_registry",
          "eval_harness_design",
          "commodities_oil_gold",
          "macro_rates_inflation",
          "portfolio_risk_gates",
          "finance_data_gateway",
          "data_provenance_quality",
        ],
        supporting_modules: ["review_panel"],
        required_tools: [],
        missing_data: [
          "source_url_or_local_source_path",
          "actual_reading_scope_receipt",
          "commodity_curve_roll_yield_and_inventory_inputs",
          "fresh_market_data_snapshot",
        ],
        risk_boundaries: [
          "research_only",
          "no_execution_authority",
          "no_trade_advice",
          "risk_gate_before_action_language",
          "commodity_framework_not_trade_signal",
          "no_unverified_current_market_data",
        ],
      },
    );

    expect(assessment.alignment).toBe("aligned");
    expect(assessment.missingModules).toEqual([]);
    expect(assessment.missingData).toEqual([]);
    expect(assessment.missingRiskBoundaries).toEqual([]);
  });

  it("does not mistake a pure trade prohibition for a buy/sell request", () => {
    const assessment = assessLocalBrainSemanticContract("只做研究，不要交易建议，也不要下单。", {
      task_family: "research_safety_preflight",
      primary_modules: [],
      supporting_modules: [],
      required_tools: [],
      missing_data: [],
      risk_boundaries: ["research_only"],
    });

    expect(assessment.alignment).not.toBe("mismatch");
    expect(assessment.expectedRiskBoundaries).not.toContain("no_execution_authority");
    expect(assessment.expectedRiskBoundaries).not.toContain("risk_gate_before_action_language");
  });

  it("keeps an explicit buy question on the trade-safety path", () => {
    const assessment = assessLocalBrainSemanticContract("NVDA 要不要买入，只做研究不要下单。", {
      task_family: "equity_research_preflight",
      primary_modules: [
        "us_equity_market_structure",
        "company_fundamentals_value",
        "portfolio_risk_gates",
        "review_panel",
        "finance_data_gateway",
        "data_provenance_quality",
      ],
      supporting_modules: [],
      required_tools: [],
      missing_data: ["latest_company_fundamental_inputs", "fresh_market_data_snapshot"],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "risk_gate_before_action_language",
        "no_trade_advice",
        "no_unverified_current_market_data",
      ],
    });

    expect(assessment.alignment).toBe("aligned");
  });

  it("requires fresh evidence rather than treating an old conclusion as supplied data", () => {
    const assessment = assessLocalBrainSemanticContract(
      "NVDA 怎么研究，已有旧结论但没有带时间戳数据。",
      {
        task_family: "equity_research_preflight",
        primary_modules: [
          "us_equity_market_structure",
          "company_fundamentals_value",
          "portfolio_risk_gates",
          "review_panel",
          "finance_data_gateway",
          "data_provenance_quality",
        ],
        supporting_modules: [],
        required_tools: [],
        missing_data: ["latest_company_fundamental_inputs", "fresh_market_data_snapshot"],
        risk_boundaries: ["research_only", "no_unverified_current_market_data"],
      },
    );

    expect(assessment.alignment).toBe("aligned");
    expect(assessment.missingData).toEqual([]);
  });

  it("reports repeated skeletons, answer-bearing source leakage, teacher novelty, and trajectory coverage", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-training-sample-audit-"));
    const dataDir = path.join(root, "dataset");
    await fs.mkdir(dataDir, { recursive: true });
    const teacherRow = {
      prompt: oldPrompt(
        "请研究 portfolio_risk_gates",
        '{"candidateText":"answer-bearing plan","primaryModules":["portfolio_risk_gates"]}',
      ),
      completion,
      meta: { sourceKind: "brain_distillation_review", trajectory: "student-1" },
    };
    const duplicateRow = { ...teacherRow, meta: { sourceKind: "brain_distillation_review" } };
    const neutralRow = {
      prompt: oldPrompt("研究组合风险", "high-level receipt"),
      completion,
      meta: { sourceKind: "curated_seed" },
    };
    await fs.writeFile(
      path.join(dataDir, "train.jsonl"),
      `${JSON.stringify(teacherRow)}\n${JSON.stringify(duplicateRow)}\n${JSON.stringify(neutralRow)}\n`,
    );
    await fs.writeFile(path.join(dataDir, "valid.jsonl"), `${JSON.stringify(neutralRow)}\n`);
    await fs.writeFile(
      path.join(dataDir, "test.jsonl"),
      `${JSON.stringify({ ...neutralRow, prompt: "held-out" })}\n`,
    );

    const report = await auditTrainingSamples({ dataDir });
    const train = report.splits as Record<string, Record<string, unknown>>;
    expect(report.curriculumReady).toBe(false);
    expect(train.train.curriculumReady).toBe(false);
    expect(train.train.repetition).toMatchObject({ duplicateRows: 1, duplicateGroups: 1 });
    expect(train.train.leakage).toMatchObject({
      sourceSummaryOutputFieldRows: 2,
      sourceSummaryContractIdRows: 2,
      promptContractFieldRows: 0,
      userOrTaskContractFieldRows: 0,
      answerBearingPromptTokenRows: 2,
    });
    expect(train.train.teacherNovelty).toMatchObject({
      rows: 2,
      uniquePairs: 1,
      uniqueCompletionsNotInNonTeacher: 0,
      structuredTrajectoryRows: 1,
    });
    expect(train.train.studentTrajectoryCoverage).toMatchObject({
      structuredMetaRows: 1,
      rowsWithAnyTrajectoryEvidence: 1,
    });
    expect(report.splitOverlap).toMatchObject({ trainValid: 1, trainTest: 0 });
  });

  it("redacts and audits hyphenated acceptance labels", async () => {
    const answerBearingLabel = "lark-live-visible-fixed-agent-architecture-20260514";
    const userAsk = `live验收：请只回复 ${answerBearingLabel}，并说明这是重启后的真实链路。`;

    expect(findAnswerBearingContractTokens(userAsk)).toEqual([answerBearingLabel]);
    const redacted = redactTeacherContractLabels(userAsk);
    expect(redacted).not.toContain(answerBearingLabel);
    expect(redacted).toContain("live验收");

    const prompt = buildLocalBrainTrainingPrompt({ userAsk });
    const dynamicUserAsk = /^user_or_task:\s*([^\n]*)/mu.exec(prompt)?.[1] ?? "";
    expect(findAnswerBearingContractTokens(dynamicUserAsk)).toEqual([]);

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-training-hyphen-label-"));
    const dataDir = path.join(root, "dataset");
    await fs.mkdir(dataDir, { recursive: true });
    const row = {
      prompt: oldPrompt(userAsk, "ordinary research receipt"),
      completion,
      meta: { sourceKind: "curated_seed" },
    };
    await fs.writeFile(path.join(dataDir, "train.jsonl"), `${JSON.stringify(row)}\n`);
    await fs.writeFile(path.join(dataDir, "valid.jsonl"), `${JSON.stringify(row)}\n`);
    await fs.writeFile(
      path.join(dataDir, "test.jsonl"),
      `${JSON.stringify({ ...row, prompt: oldPrompt("普通研究任务", "ordinary research receipt") })}\n`,
    );

    const report = await auditTrainingSamples({ dataDir });
    const splits = report.splits as Record<string, Record<string, unknown>>;
    expect(splits.train.leakage).toMatchObject({
      answerBearingPromptTokenRows: 1,
      answerBearingPromptTokenRate: 1,
      answerBearingPromptTokenFields: [["userOrTask", 1]],
    });
    expect(
      (splits.train.leakage as Record<string, unknown>).answerBearingPromptTokenExamples,
    ).toEqual([
      {
        row: 0,
        sourceKind: "curated_seed",
        hits: [{ field: "userOrTask", token: answerBearingLabel }],
      },
    ]);
  });
});
