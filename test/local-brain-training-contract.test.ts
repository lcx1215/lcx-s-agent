import { describe, expect, it } from "vitest";
import {
  generateCases,
  oraclePlan,
} from "../scripts/operator/local-brain-generalization-generator.js";
import {
  assessLocalBrainSemanticContract,
  evaluateLocalBrainCurriculumGate,
  redactTeacherContractLabels,
} from "../scripts/operator/local-brain-training-contract.js";

describe("shared local-brain curriculum gate", () => {
  it("admits a generated oracle only when shape and task semantics agree", () => {
    const [generated] = generateCases(1, { seed: 20260901, split: "train" });
    const gate = evaluateLocalBrainCurriculumGate(generated.userAsk, oraclePlan(generated));

    expect(gate).toMatchObject({ admitted: true, status: "admit", reasonCodes: [] });
    expect(gate.semantic.alignment).toBe("aligned");
    expect(gate.shapeErrors).toEqual([]);
  });

  it("quarantines shape-valid but semantically misrouted teacher output", () => {
    const gate = evaluateLocalBrainCurriculumGate("研究大宗商品并说明库存与曲线风险", {
      task_family: "finance_research_planning",
      primary_modules: ["source_registry"],
      supporting_modules: ["review_panel"],
      required_tools: [],
      missing_data: [],
      risk_boundaries: ["research_only"],
      next_step: "route_to_review",
      rejected_context: ["old_lark_conversation_history"],
    });

    expect(gate.admitted).toBe(false);
    expect(gate.status).toBe("quarantine");
    expect(gate.semantic.alignment).toBe("mismatch");
    expect(gate.reasonCodes).toContain("semantic:missing_module:commodities_oil_gold");
  });

  it("quarantines malformed arrays instead of filtering them into a false pass", () => {
    const gate = evaluateLocalBrainCurriculumGate("研究组合风险", {
      task_family: "portfolio_risk",
      primary_modules: ["portfolio_risk_gates", 42],
      supporting_modules: [],
      required_tools: [],
      missing_data: [],
      risk_boundaries: ["research_only"],
      next_step: "route_to_review",
      rejected_context: ["old_lark_conversation_history"],
    });

    expect(gate.admitted).toBe(false);
    expect(gate.shapeErrors).toContain("array_contains_non_string:primary_modules");
    expect(gate.reasonCodes).toContain("shape:array_contains_non_string:primary_modules");
  });

  it("redacts hyphenated acceptance labels before semantic admission", () => {
    const label = "lark-live-visible-fixed-agent-architecture-20260514";
    const redacted = redactTeacherContractLabels(`验收码 ${label}，只做研究。`);
    expect(redacted).not.toContain(label);
    expect(redacted).toContain("<withheld_contract_id>");
  });

  it("requires execution boundaries for positive trade requests", () => {
    const gate = evaluateLocalBrainCurriculumGate("请给我 NVDA 交易建议，暂未提供带时间戳数据", {
      task_family: "finance_research_planning",
      primary_modules: [
        "us_equity_market_structure",
        "company_fundamentals_value",
        "portfolio_risk_gates",
        "review_panel",
        "finance_data_gateway",
        "data_provenance_quality",
      ],
      supporting_modules: [],
      required_tools: ["source_registry"],
      missing_data: ["latest_company_fundamental_inputs", "fresh_market_data_snapshot"],
      risk_boundaries: ["research_only", "no_unverified_current_market_data"],
      next_step: "route_to_review",
      rejected_context: ["old_lark_conversation_history"],
    });

    expect(gate.admitted).toBe(false);
    expect(gate.reasonCodes).toEqual(
      expect.arrayContaining([
        "semantic:missing_risk_boundary:no_execution_authority",
        "semantic:missing_risk_boundary:risk_gate_before_action_language",
        "semantic:missing_risk_boundary:no_trade_advice",
      ]),
    );
  });

  it("rejects answer-bearing completion fields even when the contract is otherwise valid", () => {
    const gate = evaluateLocalBrainCurriculumGate("研究组合风险", {
      task_family: "portfolio_risk",
      primary_modules: ["portfolio_risk_gates"],
      supporting_modules: ["review_panel"],
      required_tools: [],
      missing_data: ["position_weights_and_return_series"],
      risk_boundaries: ["research_only"],
      next_step: "route_to_review",
      rejected_context: ["old_lark_conversation_history"],
      source_summary: "copy this answer label",
    });

    expect(gate.admitted).toBe(false);
    expect(gate.shapeErrors).toContain("forbidden_key:source_summary");
    expect(gate.reasonCodes).toContain("shape:forbidden_key:source_summary");
  });

  it("fails closed for a non-object completion at the shared boundary", () => {
    const gate = evaluateLocalBrainCurriculumGate("研究组合风险", null as never);
    expect(gate.admitted).toBe(false);
    expect(gate.shapeErrors).toEqual(["completion_invalid_object"]);
  });

  it("treats English missing-data wording as missing even when it mentions timestamps", () => {
    const gate = evaluateLocalBrainCurriculumGate("Research NVDA, no timestamped data", {
      task_family: "finance_research_planning",
      primary_modules: [
        "us_equity_market_structure",
        "company_fundamentals_value",
        "portfolio_risk_gates",
        "review_panel",
        "finance_data_gateway",
        "data_provenance_quality",
      ],
      supporting_modules: ["source_registry"],
      required_tools: [],
      missing_data: ["latest_company_fundamental_inputs"],
      risk_boundaries: ["research_only"],
      next_step: "route_to_review",
      rejected_context: ["old_lark_conversation_history"],
    });

    expect(gate.admitted).toBe(false);
    expect(gate.reasonCodes).toEqual(
      expect.arrayContaining([
        "semantic:missing_data:fresh_market_data_snapshot",
        "semantic:missing_risk_boundary:no_unverified_current_market_data",
      ]),
    );
  });

  it.each([
    "研究 NVDA，不要交易信号",
    "研究 NVDA，不需要仓位比例",
    "Research NVDA, do not give trade advice",
  ])("does not turn a negated action phrase into a positive trade request: %s", (userAsk) => {
    const assessment = assessLocalBrainSemanticContract(userAsk, {
      primary_modules: [
        "us_equity_market_structure",
        "company_fundamentals_value",
        "portfolio_risk_gates",
        "review_panel",
        "finance_data_gateway",
        "data_provenance_quality",
      ],
      supporting_modules: ["source_registry"],
      required_tools: [],
      missing_data: ["latest_company_fundamental_inputs", "fresh_market_data_snapshot"],
      risk_boundaries: ["research_only", "no_unverified_current_market_data"],
      next_step: "route_to_review",
      rejected_context: ["old_lark_conversation_history"],
    });

    expect(assessment.expectedRiskBoundaries).not.toEqual(
      expect.arrayContaining([
        "no_execution_authority",
        "risk_gate_before_action_language",
        "no_trade_advice",
      ]),
    );
  });

  it("rejects unknown modules and positive execution risk values at the shared boundary", () => {
    const gate = evaluateLocalBrainCurriculumGate("研究组合风险", {
      task_family: "portfolio_risk",
      primary_modules: ["portfolio_risk_gates", "unknown_module"],
      supporting_modules: ["review_panel"],
      required_tools: [],
      missing_data: ["position_weights_and_return_series"],
      risk_boundaries: ["research_only", "allow_trade_execution"],
      next_step: "route_to_review",
      rejected_context: ["old_lark_conversation_history"],
    });

    expect(gate.admitted).toBe(false);
    expect(gate.shapeErrors).toEqual(
      expect.arrayContaining([
        "unknown_module:unknown_module",
        "unsafe_risk_boundary:allow_trade_execution",
      ]),
    );
  });
});
