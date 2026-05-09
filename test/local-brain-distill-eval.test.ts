import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("local-brain-distill-eval", () => {
  it("supports current adapter resolution instead of requiring static adapter paths", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        path.join(path.resolve(__dirname, ".."), "scripts/dev/local-brain-distill-eval.ts"),
        "utf8",
      ),
    );

    expect(source).toContain("--adapter latest-passing");
    expect(source).toContain("--resolve-current-adapter");
    expect(source).toContain("--bootstrap-if-missing");
    expect(source).toContain("adapterSelectionStatus");
  });

  it("covers broad finance module taxonomy beyond the old core buckets", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        "broad_finance_module_taxonomy_coverage",
        "--summary-only",
        "--json",
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: { passed: number; total: number; promotionReady: boolean };
      hierarchy: {
        requestedCaseIds: string[];
        autoIncludedPrerequisiteCaseIds: string[];
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.summary).toMatchObject({ passed: 2, total: 2, promotionReady: true });
    expect(payload.hierarchy).toMatchObject({
      requestedCaseIds: ["broad_finance_module_taxonomy_coverage"],
      autoIncludedPrerequisiteCaseIds: ["portfolio_mixed_q_t_nvda"],
    });
  });

  it("keeps local-memory activation promotion-ready in contract-only eval", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        "local_memory_knowledge_activation",
        "--summary-only",
        "--json",
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: { passed: number; total: number; promotionReady: boolean };
      hierarchy: {
        requestedCaseIds: string[];
        autoIncludedPrerequisiteCaseIds: string[];
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.summary).toMatchObject({ passed: 2, total: 2, promotionReady: true });
    expect(payload.hierarchy).toMatchObject({
      requestedCaseIds: ["local_memory_knowledge_activation"],
      autoIncludedPrerequisiteCaseIds: ["portfolio_mixed_q_t_nvda"],
    });
  });

  it("extracts the first balanced JSON object from noisy model output", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-json-"));
    const fakePython = path.join(tempDir, "python");
    writeFileSync(
      fakePython,
      [
        "#!/bin/sh",
        "cat <<'EOF'",
        "preface that the model should not have emitted",
        JSON.stringify({
          task_family: "finance_research_planning",
          primary_modules: ["macro_rates_inflation", "credit_liquidity", "etf_regime"],
          supporting_modules: [],
          required_tools: [],
          missing_data: [],
          risk_boundaries: ["research_only"],
          next_step: "route_to_review",
          rejected_context: ["old_lark_conversation_history"],
        }),
        "trailing explanation with an unmatched { that must not poison parsing",
        "EOF",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--no-adapter",
        "--python",
        fakePython,
        "--case-id",
        "portfolio_mixed_q_t_nvda",
        "--summary-only",
        "--json",
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: { passed: number; total: number; promotionReady: boolean };
    };
    expect(payload.ok).toBe(true);
    expect(payload.summary).toMatchObject({ passed: 1, total: 1, promotionReady: true });
  });

  it("tells the local model not to emit think blocks during eval", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        path.join(path.resolve(__dirname, ".."), "scripts/dev/local-brain-distill-eval.ts"),
        "utf8",
      ),
    );

    expect(source).toContain("/no_think");
    expect(source).toContain("Do not emit chain-of-thought, markdown, or <think> blocks");
    expect(source).toContain("Keep the JSON compact");
  });

  it("runs simple prerequisite cases before complex commodity evals", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        "commodity_fx_inflation_inventory_portfolio_loop",
        "--json",
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: { passed: number; total: number; promotionReady: boolean };
      hierarchy: {
        requestedCaseIds: string[];
        autoIncludedPrerequisiteCaseIds: string[];
        registeredPrerequisiteRuleCount: number;
      };
      cases: Array<{ id: string; acceptance: { ok: boolean } }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.summary).toMatchObject({ passed: 3, total: 3, promotionReady: true });
    expect(payload.hierarchy).toMatchObject({
      requestedCaseIds: ["commodity_fx_inflation_inventory_portfolio_loop"],
      autoIncludedPrerequisiteCaseIds: [
        "plain_language_hidden_complexity_intake",
        "short_lark_commodity_learning_intake",
      ],
    });
    expect(payload.hierarchy.registeredPrerequisiteRuleCount).toBeGreaterThan(10);
    expect(payload.cases.map((entry) => entry.id)).toEqual([
      "plain_language_hidden_complexity_intake",
      "short_lark_commodity_learning_intake",
      "commodity_fx_inflation_inventory_portfolio_loop",
    ]);
    expect(payload.cases.every((entry) => entry.acceptance.ok)).toBe(true);
  });

  it("applies prerequisite hierarchy beyond commodity cases", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        "full_stack_finance_stress_with_red_team,paper_claim_conflicts_with_local_memory_rule",
        "--summary-only",
        "--json",
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: { passed: number; total: number; promotionReady: boolean };
      hierarchy: {
        requestedCaseIds: string[];
        autoIncludedPrerequisiteCaseIds: string[];
        registeredPrerequisiteRuleCount: number;
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.hierarchy.requestedCaseIds).toEqual([
      "full_stack_finance_stress_with_red_team",
      "paper_claim_conflicts_with_local_memory_rule",
    ]);
    expect(payload.hierarchy.registeredPrerequisiteRuleCount).toBeGreaterThan(10);
    expect(payload.hierarchy.autoIncludedPrerequisiteCaseIds).toEqual(
      expect.arrayContaining([
        "portfolio_mixed_q_t_nvda",
        "portfolio_math_without_guessing",
        "single_company_fundamental_risk",
        "external_source_missing_url",
        "paper_learning_internalization_absorption",
      ]),
    );
    expect(payload.summary.total).toBeGreaterThan(2);
    expect(payload.summary.promotionReady).toBe(true);
  });

  it("gates all-domain finance learning behind simple prerequisite evals", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        "all_domain_finance_research_loop",
        "--summary-only",
        "--json",
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: { passed: number; total: number; promotionReady: boolean };
      hierarchy: {
        requestedCaseIds: string[];
        autoIncludedPrerequisiteCaseIds: string[];
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.hierarchy.requestedCaseIds).toEqual(["all_domain_finance_research_loop"]);
    expect(payload.hierarchy.autoIncludedPrerequisiteCaseIds).toEqual(
      expect.arrayContaining([
        "broad_finance_module_taxonomy_coverage",
        "plain_language_hidden_complexity_intake",
        "portfolio_mixed_q_t_nvda",
        "portfolio_math_without_guessing",
        "value_investing_fundamental_core",
        "cross_market_us_a_index_crypto_analysis",
        "commodity_fx_inflation_inventory_portfolio_loop",
        "options_iv_event_risk_no_trade",
        "sentiment_market_external_module_learning",
        "factor_turnover_cost_capacity_guard",
      ]),
    );
    expect(payload.summary.total).toBeGreaterThan(8);
    expect(payload.summary.promotionReady).toBe(true);
  });

  it("gates plain market and position asks as local-brain prerequisites", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        "plain_buy_hold_research_boundary",
        "--summary-only",
        "--json",
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: { passed: number; total: number; promotionReady: boolean };
      hierarchy: {
        requestedCaseIds: string[];
        autoIncludedPrerequisiteCaseIds: string[];
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.hierarchy.requestedCaseIds).toEqual(["plain_buy_hold_research_boundary"]);
    expect(payload.hierarchy.autoIncludedPrerequisiteCaseIds).toEqual(
      expect.arrayContaining([
        "plain_language_hidden_complexity_intake",
        "plain_recent_stock_market_brief_preflight",
        "plain_single_stock_position_sizing_preflight",
      ]),
    );
    expect(payload.summary).toMatchObject({ passed: 4, total: 4, promotionReady: true });
  });

  it("gates external knowledge internalization behind paper and skill prerequisites", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        "external_knowledge_internalization_protocol",
        "--summary-only",
        "--json",
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: { passed: number; total: number; promotionReady: boolean };
      hierarchy: {
        requestedCaseIds: string[];
        autoIncludedPrerequisiteCaseIds: string[];
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.hierarchy.requestedCaseIds).toEqual([
      "external_knowledge_internalization_protocol",
    ]);
    expect(payload.hierarchy.autoIncludedPrerequisiteCaseIds).toEqual(
      expect.arrayContaining([
        "external_source_missing_url",
        "agent_skill_distillation_safety",
        "paper_learning_internalization_absorption",
        "source_coverage_actual_reading_scope",
      ]),
    );
    expect(payload.summary.total).toBeGreaterThan(4);
    expect(payload.summary.promotionReady).toBe(true);
  });

  it("requires abstraction-transfer evals to include adjacent prerequisites", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        "abstraction_transfer_repair_protocol",
        "--summary-only",
        "--json",
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: { promotionReady: boolean; total: number };
      hierarchy: {
        requestedCaseIds: string[];
        autoIncludedPrerequisiteCaseIds: string[];
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.hierarchy.requestedCaseIds).toEqual(["abstraction_transfer_repair_protocol"]);
    expect(payload.hierarchy.autoIncludedPrerequisiteCaseIds).toEqual(
      expect.arrayContaining([
        "plain_language_hidden_complexity_intake",
        "short_lark_commodity_learning_intake",
        "lark_context_pollution_audit",
      ]),
    );
    expect(payload.summary.total).toBeGreaterThanOrEqual(3);
    expect(payload.summary.promotionReady).toBe(true);
  });

  it("gates Anthropic financial-agent learning behind source and workflow prerequisites", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        "anthropic_financial_agent_pattern_distillation",
        "--summary-only",
        "--json",
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: { promotionReady: boolean; total: number };
      hierarchy: {
        requestedCaseIds: string[];
        autoIncludedPrerequisiteCaseIds: string[];
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.hierarchy.requestedCaseIds).toEqual([
      "anthropic_financial_agent_pattern_distillation",
    ]);
    expect(payload.hierarchy.autoIncludedPrerequisiteCaseIds).toEqual(
      expect.arrayContaining([
        "agent_skill_distillation_safety",
        "external_knowledge_internalization_protocol",
        "external_source_missing_url",
        "single_company_fundamental_risk",
        "portfolio_rebalance_no_execution_authority",
      ]),
    );
    expect(payload.summary.total).toBeGreaterThan(5);
    expect(payload.summary.promotionReady).toBe(true);
  });

  it("does not let hardened diagnostic fallback pass an empty generation", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-"));
    const fakePython = path.join(tempDir, "python");
    writeFileSync(fakePython, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--no-adapter",
        "--python",
        fakePython,
        "--hardened",
        "--case-id",
        "paper_learning_internalization_absorption",
        "--json",
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: { passed: number; total: number; promotionReady: boolean; failedCaseIds: string[] };
      cases: Array<{
        id: string;
        parsed: unknown;
        diagnosticFallbackParsed?: unknown;
        parseError?: string;
        acceptance: { ok: boolean };
      }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.summary).toMatchObject({
      passed: 0,
      total: 2,
      passRate: 0,
      failedCaseIds: ["external_source_missing_url", "paper_learning_internalization_absorption"],
      parseErrorCaseIds: [
        "external_source_missing_url",
        "paper_learning_internalization_absorption",
      ],
      promotionReady: false,
    });
    const targetCase = payload.cases.find(
      (entry) => entry.id === "paper_learning_internalization_absorption",
    );
    expect(targetCase?.acceptance.ok).toBe(false);
    expect(targetCase?.parsed).toBeNull();
    expect(targetCase?.diagnosticFallbackParsed).toBeTruthy();
    expect(targetCase?.parseError).toContain("no JSON object found");
  });
});
