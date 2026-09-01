import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFailureCurriculumPrompts } from "../scripts/operator/minimax-brain-failure-curriculum.js";

async function makeGuardLog(lines: unknown[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-failure-curriculum-"));
  const logPath = path.join(dir, "minimax-brain-training-guard-medium.jsonl");
  await fs.writeFile(logPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return logPath;
}

describe("minimax brain failure curriculum", () => {
  it("turns latest eval failures into targeted MiniMax teacher prompts", async () => {
    const logPath = await makeGuardLog([
      {
        at: "2026-05-07T12:16:42.750Z",
        event: "step_non_passing",
        name: "candidate_hardened_eval",
        result: {
          adapterPath: "/tmp/adapter-r18",
          summary: {
            passed: 53,
            total: 59,
            passRate: 0.898,
            failedCaseIds: [
              "human_brain_finance_decomposition",
              "short_lark_commodity_learning_intake",
              "scenario_probability_no_model_math_guessing",
            ],
            promotionReady: false,
          },
        },
      },
    ]);

    const prompts = await buildFailureCurriculumPrompts({
      guardLogPath: logPath,
      maxPrompts: 2,
      startIndex: 7,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0].id).toContain("short_lark_commodity_learning_intake");
    expect(prompts[0].userMessage).toContain("学习大宗商品");
    expect(prompts[0].sourceSummary).toContain("passed 53/59");
    expect(prompts[0].sourceSummary).toContain("no external channel sender");
    expect(prompts[1].id).toContain("human_brain_finance_decomposition");
    expect(prompts.every((prompt) => prompt.userMessage.includes("验收码"))).toBe(true);
  });

  it("uses a generic targeted repair prompt for newly added unknown eval failures", async () => {
    const logPath = await makeGuardLog([
      {
        at: "2026-05-07T12:16:42.750Z",
        event: "step_non_passing",
        name: "candidate_hardened_eval",
        result: {
          adapterPath: "/tmp/adapter-r18",
          summary: {
            passed: 1,
            total: 2,
            passRate: 0.5,
            failedCaseIds: ["future_new_finance_case"],
            promotionReady: false,
          },
        },
      },
    ]);

    const prompts = await buildFailureCurriculumPrompts({
      guardLogPath: logPath,
      maxPrompts: 1,
      startIndex: 0,
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0].id).toContain("future_new_finance_case");
    expect(prompts[0].userMessage).toContain("eval 失败项 future_new_finance_case");
    expect(prompts[0].userMessage).toContain("research");
  });

  it("has specific recipes for the current retained Qwen seed failures", async () => {
    const logPath = await makeGuardLog([
      {
        at: "2026-05-08T21:18:35.211Z",
        event: "step_non_passing",
        name: "candidate_hardened_eval",
        result: {
          adapterPath: "/tmp/adapter-r3",
          summary: {
            passed: 55,
            total: 64,
            passRate: 0.859,
            failedCaseIds: [
              "single_company_fundamental_risk",
              "current_market_data_freshness_boundary",
              "rate_shock_duration_equity_chain",
              "nvda_capex_supplier_second_order_risk",
              "a_share_policy_flow_us_tech_spillover",
              "recession_soft_landing_scenario_tree",
              "index_concentration_mag7_portfolio_risk",
              "drawdown_budget_without_weights",
              "data_vendor_conflict_reconciliation",
            ],
            promotionReady: false,
          },
        },
      },
    ]);

    const prompts = await buildFailureCurriculumPrompts({
      guardLogPath: logPath,
      maxPrompts: 9,
      startIndex: 20,
    });
    const promptText = prompts.map((prompt) => prompt.userMessage).join("\n");

    expect(prompts).toHaveLength(9);
    expect(promptText).not.toContain("修复 eval 失败项");
    expect(promptText).toContain("10-K/10-Q");
    expect(promptText).toContain("timestamped source");
    expect(promptText).toContain("DV01");
    expect(promptText).toContain("AI capex");
    expect(promptText).toContain("Mag7");
    expect(promptText).toContain("drawdown budget");
    expect(promptText).toContain("数据供应商冲突");
  });

  it("teaches structured data provenance failures to use the data review target", async () => {
    const logPath = await makeGuardLog([
      {
        at: "2026-05-13T15:20:00.000Z",
        event: "step_non_passing",
        name: "candidate_hardened_eval",
        result: {
          adapterPath: "/tmp/adapter-r12",
          summary: {
            passed: 75,
            total: 76,
            passRate: 0.987,
            failedCaseIds: ["data_provenance_quality_gate"],
            promotionReady: false,
          },
        },
      },
    ]);

    const prompts = await buildFailureCurriculumPrompts({
      guardLogPath: logPath,
      maxPrompts: 1,
      startIndex: 0,
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0].userMessage).toContain("data_provenance_quality_review_input");
    expect(prompts[0].userMessage).toContain("不能把结构化数据当文章抽取");
  });

  it("turns parse-recovered eval cases into output-contract failure focus prompts", async () => {
    const logPath = await makeGuardLog([
      {
        at: "2026-05-18T16:42:58.646Z",
        event: "step_non_passing",
        name: "stable_hardened_eval",
        result: {
          adapterPath: "/tmp/adapter-r2",
          summary: {
            passed: 200,
            total: 200,
            passRate: 1,
            failedCaseIds: [],
            parseRecoveredCaseIds: [
              "core_options_event_boundary_02",
              "core_thesis_catalyst_lifecycle_06",
              "research_artifact_qc_expansion_03",
            ],
            promotionReady: false,
          },
        },
      },
    ]);

    const prompts = await buildFailureCurriculumPrompts({
      guardLogPath: logPath,
      maxPrompts: 3,
      startIndex: 40,
    });
    const promptText = prompts.map((prompt) => prompt.userMessage).join("\n");
    const summaryText = prompts.map((prompt) => prompt.sourceSummary).join("\n");

    expect(prompts.map((prompt) => prompt.id)).toEqual([
      "failure_focus_core_options_event_boundary_02_00040",
      "failure_focus_core_thesis_catalyst_lifecycle_06_00041",
      "failure_focus_research_artifact_qc_expansion_03_00042",
    ]);
    expect(promptText).toContain("JSON 必须闭合");
    expect(promptText).toContain("options_iv_skew_gamma_and_event_calendar");
    expect(promptText).toContain("original_thesis_source_and_date");
    expect(promptText).toContain("research_artifact_qc_and_number_provenance_checklist");
    expect(summaryText).toContain("parseRecovered");
    expect(summaryText).toContain("compact valid JSON is required before promotion");
  });

  it("uses specific high-priority recipes for the retained promotion blocker set", async () => {
    const logPath = await makeGuardLog([
      {
        at: "2026-05-20T16:57:14.919Z",
        event: "step_non_passing",
        name: "candidate_hardened_eval",
        result: {
          adapterPath: "/tmp/adapter-r2",
          summary: {
            passed: 205,
            total: 205,
            passRate: 1,
            failedCaseIds: [],
            parseRecoveredCaseIds: [
              "core_senior_risk_packet_01",
              "core_valuation_qc_boundary_04",
              "core_valuation_qc_boundary_05",
              "alternative_source_expansion_05",
            ],
            promotionReady: false,
          },
        },
      },
    ]);

    const prompts = await buildFailureCurriculumPrompts({
      guardLogPath: logPath,
      maxPrompts: 4,
      startIndex: 55,
    });
    const promptText = prompts.map((prompt) => prompt.userMessage).join("\n");
    const summaryText = prompts.map((prompt) => prompt.sourceSummary).join("\n");

    expect(prompts.map((prompt) => prompt.id)).toEqual([
      "failure_focus_core_senior_risk_packet_01_00055",
      "failure_focus_core_valuation_qc_boundary_04_00056",
      "failure_focus_core_valuation_qc_boundary_05_00057",
      "failure_focus_alternative_source_expansion_05_00058",
    ]);
    expect(promptText).not.toContain("修复 eval 失败项");
    expect(promptText).toContain("senior_trader_failure_focus_promotion_chain");
    expect(promptText).toContain("valuation_assumption_inputs");
    expect(promptText).toContain("模型分歧");
    expect(promptText).toContain("do_not_claim_eval_absorbed_from_receipts");
    expect(summaryText).toContain("compact valid JSON is required before promotion");
  });

  it("returns no prompts when no failed eval evidence exists", async () => {
    const logPath = await makeGuardLog([
      {
        at: "2026-05-07T12:16:42.750Z",
        event: "step_ok",
        name: "candidate_hardened_eval",
        result: {
          adapterPath: "/tmp/adapter-ok",
          summary: { passed: 59, total: 59, passRate: 1, failedCaseIds: [], promotionReady: true },
        },
      },
    ]);

    await expect(
      buildFailureCurriculumPrompts({ guardLogPath: logPath, maxPrompts: 4 }),
    ).resolves.toEqual([]);
  });
});
