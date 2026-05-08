import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("local-brain-distill-eval", () => {
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
      };
      cases: Array<{ id: string; acceptance: { ok: boolean } }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.summary).toMatchObject({ passed: 2, total: 2, promotionReady: true });
    expect(payload.hierarchy).toMatchObject({
      requestedCaseIds: ["commodity_fx_inflation_inventory_portfolio_loop"],
      autoIncludedPrerequisiteCaseIds: ["short_lark_commodity_learning_intake"],
    });
    expect(payload.hierarchy.registeredPrerequisiteRuleCount).toBeGreaterThan(10);
    expect(payload.cases.map((entry) => entry.id)).toEqual([
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
    expect(payload.summary).toEqual({
      passed: 0,
      total: 2,
      passRate: 0,
      failedCaseIds: ["external_source_missing_url", "paper_learning_internalization_absorption"],
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
