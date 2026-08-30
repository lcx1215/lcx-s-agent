import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      summary: {
        passed: number;
        total: number;
        promotionReady: boolean;
        capabilitySuites: {
          boundary: string;
          suites: Array<{ id: string; evaluated: number; passed: number; status: string }>;
        };
      };
      hierarchy: {
        requestedCaseIds: string[];
        autoIncludedPrerequisiteCaseIds: string[];
      };
      cases: Array<{
        id: string;
        parsed: {
          required_tools: string[];
          missing_data: string[];
        };
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.summary).toMatchObject({ passed: 2, total: 2, promotionReady: true });
    expect(payload.summary.capabilitySuites.boundary).toBe(
      "local_eval_capability_suite_results_only",
    );
    expect(payload.summary.capabilitySuites.suites.some((suite) => suite.evaluated > 0)).toBe(true);
    expect(payload.hierarchy).toMatchObject({
      requestedCaseIds: ["broad_finance_module_taxonomy_coverage"],
      autoIncludedPrerequisiteCaseIds: ["portfolio_mixed_q_t_nvda"],
    });
  });

  it("covers single-stock synthetic curve timing as a bounded eval case", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        "single_stock_curve_technical_timing_preflight",
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
      cases: Array<{
        id: string;
        parsed: {
          primary_modules: string[];
          supporting_modules: string[];
          required_tools: string[];
          missing_data: string[];
          risk_boundaries: string[];
          rejected_context: string[];
        };
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.summary.promotionReady).toBe(true);
    expect(payload.summary.passed).toBe(payload.summary.total);
    expect(payload.hierarchy.requestedCaseIds).toEqual([
      "single_stock_curve_technical_timing_preflight",
    ]);
    expect(payload.hierarchy.autoIncludedPrerequisiteCaseIds).toEqual(
      expect.arrayContaining([
        "plain_buy_hold_research_boundary",
        "single_company_fundamental_risk",
      ]),
    );
    const targetCase = payload.cases.find(
      (entry) => entry.id === "single_stock_curve_technical_timing_preflight",
    );
    const modules = [
      ...(targetCase?.parsed.primary_modules ?? []),
      ...(targetCase?.parsed.supporting_modules ?? []),
      ...(targetCase?.parsed.required_tools ?? []),
    ];
    expect(modules).toEqual(
      expect.arrayContaining([
        "technical_timing",
        "company_fundamentals_value",
        "portfolio_risk_gates",
        "source_registry",
        "data_provenance_quality",
        "review_panel",
      ]),
    );
    expect(targetCase?.parsed.risk_boundaries).toEqual(
      expect.arrayContaining([
        "technical_timing_not_standalone_alpha",
        "risk_gate_before_action_language",
        "no_trade_advice",
      ]),
    );
    expect(targetCase?.parsed.rejected_context).toEqual(
      expect.arrayContaining(["direct_buy_sell_answer", "technical_timing_as_standalone_alpha"]),
    );
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

  it("covers all-module knowledge internalization as a generic chain", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        "all_module_knowledge_internalization_chain",
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
    expect(payload.summary.promotionReady).toBe(true);
    expect(payload.summary.passed).toBe(payload.summary.total);
    expect(payload.hierarchy.requestedCaseIds).toEqual([
      "all_module_knowledge_internalization_chain",
    ]);
    expect(payload.hierarchy.autoIncludedPrerequisiteCaseIds).toEqual(
      expect.arrayContaining([
        "external_knowledge_internalization_protocol",
        "local_memory_knowledge_activation",
        "abstraction_transfer_repair_protocol",
      ]),
    );
    const targetCase = payload.cases.find(
      (entry) => entry.id === "all_module_knowledge_internalization_chain",
    );
    expect(targetCase?.parsed.missing_data).toContain("module_learning_pipeline_review_status");
  });

  it("routes interviews blogs sentiment and viral executive events through alternative-source gates", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        [
          "viral_ceo_dinner_industry_signal_source_gate",
          "management_interview_hbm_supply_chain_signal",
          "investor_blog_thesis_source_quality_gate",
          "podcast_social_sentiment_hypothesis_gate",
          "alternative_source_to_fundamental_followthrough_chain",
        ].join(","),
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
      evalRegistry: {
        boundary: string;
        currentCaseCount: number;
        promotionTargetCaseCount: number;
        suites: Array<{ id: string; currentCaseCount: number; targetCaseCount: number }>;
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.summary).toMatchObject({ passed: 12, total: 12, promotionReady: true });
    expect(payload.evalRegistry).toMatchObject({
      boundary: "local_eval_registry_expansion_plan_only",
      promotionTargetCaseCount: 200,
    });
    expect(payload.evalRegistry.currentCaseCount).toBeGreaterThanOrEqual(205);
    expect(payload.evalRegistry.suites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "finance_source_quality",
          currentCaseCount: expect.any(Number),
          targetCaseCount: 50,
        }),
        expect.objectContaining({
          id: "lark_short_intake",
          currentCaseCount: expect.any(Number),
          targetCaseCount: 30,
        }),
      ]),
    );
  });

  it("keeps offensive stock opportunity research gated but non-passive", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        "offensive_stock_opportunity_research",
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
      cases: Array<{
        id: string;
        parsed: {
          missing_data: string[];
          risk_boundaries: string[];
          rejected_context: string[];
        };
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.summary.promotionReady).toBe(true);
    expect(payload.summary.passed).toBe(payload.summary.total);
    expect(payload.hierarchy.requestedCaseIds).toEqual(["offensive_stock_opportunity_research"]);
    expect(payload.hierarchy.autoIncludedPrerequisiteCaseIds).toEqual(
      expect.arrayContaining([
        "plain_recent_stock_market_brief_preflight",
        "single_company_fundamental_risk",
        "financial_modeling_valuation_qc_chain",
        "thesis_catalyst_lifecycle_review",
      ]),
    );
    const targetCase = payload.cases.find(
      (entry) => entry.id === "offensive_stock_opportunity_research",
    );
    expect(targetCase?.parsed.missing_data).toEqual(
      expect.arrayContaining([
        "sector_scope_and_style_bucket",
        "upside_driver_and_market_mispricing_hypothesis",
        "red_team_invalidation_evidence",
      ]),
    );
    expect(targetCase?.parsed.risk_boundaries).toEqual(
      expect.arrayContaining([
        "opportunity_ranking_not_buy_list",
        "small_position_trial_requires_user_constraints",
        "no_trade_advice",
      ]),
    );
    expect(targetCase?.parsed.rejected_context).toContain("overly_conservative_refusal_only");
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

  it("recovers useful partial hardened JSON without pretending it is promotion-ready", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-partial-json-"));
    const fakePython = path.join(tempDir, "python");
    writeFileSync(
      fakePython,
      [
        "#!/bin/sh",
        "cat <<'EOF'",
        '{"task_family":"finance_research_planning","primary_modules":["finance_framework_macro_rates_inflation_producer","credit_liquidity","etf_regime"],"supporting_modules":["review_tier","source_registry_lookup"],"required_tools":["artifact_memory_recall"',
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
        "--hardened",
        "--case-id",
        "portfolio_mixed_q_t_nvda",
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
      summary: {
        passed: number;
        total: number;
        promotionReady: boolean;
        parseErrorCaseIds: string[];
        parseRecoveredCaseIds: string[];
      };
      cases: Array<{
        id: string;
        parsed: {
          primary_modules: string[];
          supporting_modules: string[];
          required_tools: string[];
        };
        parseRecovered?: boolean;
        acceptance: { ok: boolean };
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.summary).toMatchObject({
      passed: 1,
      total: 1,
      promotionReady: false,
      parseErrorCaseIds: [],
      parseRecoveredCaseIds: ["portfolio_mixed_q_t_nvda"],
    });
    const targetCase = payload.cases.find((entry) => entry.id === "portfolio_mixed_q_t_nvda");
    expect(targetCase?.parseRecovered).toBe(true);
    expect(targetCase?.acceptance.ok).toBe(true);
    const moduleFields = [
      ...(targetCase?.parsed.primary_modules ?? []),
      ...(targetCase?.parsed.supporting_modules ?? []),
      ...(targetCase?.parsed.required_tools ?? []),
    ];
    expect(moduleFields).toEqual(
      expect.arrayContaining(["macro_rates_inflation", "credit_liquidity", "etf_regime"]),
    );
    expect(moduleFields).not.toContain("finance_framework_macro_rates_inflation_producer");
    expect(moduleFields).not.toContain("review_tier");
    expect(moduleFields).not.toContain("source_registry_lookup");
  });

  it("recovers task-family-only factor eval stalls without promotion", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-factor-stall-"));
    const fakePython = path.join(tempDir, "python");
    writeFileSync(
      fakePython,
      ["#!/bin/sh", "cat <<'EOF'", '{"task_family":"etf_factor_backtest             ', "EOF"].join(
        "\n",
      ),
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
        "--hardened",
        "--case-id",
        "factor_turnover_cost_capacity_guard",
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
      summary: {
        passed: number;
        total: number;
        promotionReady: boolean;
        parseRecoveredCaseIds: string[];
      };
      cases: Array<{
        id: string;
        parsed: {
          primary_modules: string[];
          supporting_modules: string[];
          required_tools: string[];
          missing_data: string[];
          risk_boundaries: string[];
        };
        parseRecovered?: boolean;
        acceptance: { ok: boolean };
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.summary).toMatchObject({
      passed: 3,
      total: 3,
      promotionReady: false,
      parseRecoveredCaseIds: [
        "external_source_missing_url",
        "factor_backtest_overfit_guard",
        "factor_turnover_cost_capacity_guard",
      ],
    });
    const targetCase = payload.cases.find(
      (entry) => entry.id === "factor_turnover_cost_capacity_guard",
    );
    expect(targetCase?.parseRecovered).toBe(true);
    expect(targetCase?.acceptance.ok).toBe(true);
    const moduleFields = [
      ...(targetCase?.parsed.primary_modules ?? []),
      ...(targetCase?.parsed.supporting_modules ?? []),
      ...(targetCase?.parsed.required_tools ?? []),
    ];
    expect(moduleFields).toEqual(
      expect.arrayContaining([
        "quant_math",
        "finance_learning_memory",
        "source_registry",
        "portfolio_risk_gates",
        "review_panel",
        "etf_regime",
      ]),
    );
    expect(targetCase?.parsed.missing_data).toEqual(
      expect.arrayContaining([
        "sample_out_validation_plan",
        "survivor_bias_and_lookahead_bias_check",
        "walk_forward_or_cross_validation_evidence",
      ]),
    );
    expect(targetCase?.parsed.risk_boundaries).toEqual(
      expect.arrayContaining([
        "backtest_overfit_check_required",
        "sample_out_validation_required",
        "survivor_bias_check_required",
        "no_trade_advice",
      ]),
    );
  });

  it("tells the local model not to emit think blocks during eval", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        path.join(path.resolve(__dirname, ".."), "scripts/dev/local-brain-distill-eval.ts"),
        "utf8",
      ),
    );

    expect(source).toContain("/no_think");
    expect(source).toContain("QWEN_NO_THINK_CHAT_TEMPLATE_CONFIG = '{\"enable_thinking\":false}'");
    expect(source).toContain("--chat-template-config");
    expect(source).toContain("Do not emit chain-of-thought, markdown, or <think> blocks");
    expect(source).toContain("Keep the JSON compact and complete");
    expect(source).toContain("LOCAL_BRAIN_OUTPUT_CONTRACT_HINTS");
    expect(source).toContain("always close the final brace");
    expect(source).toContain("Use this exact compact shape");
    expect(source).toContain('risk_boundaries":["research_only"]');
    expect(source).toContain("Recommended module ids for this case");
    expect(source).toContain("normalizeLocalBrainModuleList");
    expect(source).toContain("must use exact recommended module ids only");
    expect(source).toContain("do not invent prefixes like finance_framework_*");
    expect(source).toContain('LOCAL_BRAIN_EVAL_MAX_TOKENS = "700"');
    expect(source).toContain("TIMEOUT_PRONE_COMPACT_EVAL_CASE_IDS");
    expect(source).toContain('LOCAL_BRAIN_EVAL_TIMEOUT_PRONE_MAX_TOKENS = "360"');
  });

  it("passes no-think template settings through the mlx_lm generate call", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-args-"));
    const argLog = path.join(tempDir, "python-args.log");
    const fakePython = path.join(tempDir, "python");
    writeFileSync(
      fakePython,
      [
        "#!/bin/sh",
        'printf "%s\\n" "$@" >> "$EVAL_FAKE_PYTHON_LOG"',
        "cat <<'JSON'",
        '{"task_family":"finance_research_planning","primary_modules":["macro_rates_inflation","credit_liquidity","etf_regime"],"supporting_modules":[],"required_tools":["finance_learning_memory"],"missing_data":[],"risk_boundaries":["research_only"],"next_step":"route_to_review","rejected_context":["old_lark_conversation_history"]}',
        "JSON",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
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
          env: {
            ...process.env,
            EVAL_FAKE_PYTHON_LOG: argLog,
          },
        },
      );

      expect(result.status).toBe(0);
      const loggedArgs = readFileSync(argLog, "utf8");
      expect(loggedArgs).toContain("--chat-template-config");
      expect(loggedArgs).toContain('{"enable_thinking":false}');
      expect(loggedArgs).toContain("--prompt-cache-file");
      expect(loggedArgs).toContain("cache_prompt");
      expect(loggedArgs).toContain("/no_think");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps eval prompts compact for broad internalization cases", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-prompt-"));
    const argLog = path.join(tempDir, "python-args.jsonl");
    const fakePython = path.join(tempDir, "python");
    writeFileSync(
      fakePython,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.appendFileSync(process.env.EVAL_FAKE_PYTHON_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);",
        "console.log(JSON.stringify({",
        "task_family: 'module_learning_internalization',",
        "primary_modules: ['agent_workflow_memory','source_registry','finance_learning_memory','skill_pattern_distillation','eval_harness_design','review_panel','control_room_summary'],",
        "supporting_modules: [],",
        "required_tools: [],",
        "missing_data: ['source_url_or_local_source_path','actual_reading_scope','module_learning_pipeline_review_status'],",
        "risk_boundaries: ['research_only','no_protected_memory_write'],",
        "next_step: 'route_to_review',",
        "rejected_context: ['old_lark_conversation_history']",
        "}));",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/dev/local-brain-distill-eval.ts",
          "--no-adapter",
          "--python",
          fakePython,
          "--case-id",
          "all_module_knowledge_internalization_chain",
          "--summary-only",
          "--json",
        ],
        {
          cwd: path.resolve(__dirname, ".."),
          encoding: "utf8",
          env: {
            ...process.env,
            EVAL_FAKE_PYTHON_LOG: argLog,
          },
        },
      );

      const records = readFileSync(argLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const prompts = records
        .map((args) => {
          const promptIndex = args.indexOf("--prompt");
          return promptIndex >= 0 ? (args[promptIndex + 1] ?? "") : "";
        })
        .filter(Boolean);
      const targetPrompt = prompts.find((prompt) =>
        prompt.includes("source-to-capability-to-retrieval-to-application-to-eval-to-review"),
      );

      expect(targetPrompt).toBeTruthy();
      expect(targetPrompt?.length).toBeLessThan(5_500);
      expect(targetPrompt).toContain("Relevant compact contract hints");
      expect(targetPrompt).toContain("missing_data <= 12");
      expect(targetPrompt).toContain("risk_boundaries <= 6");
      expect(targetPrompt).toContain("All module learning uses the same internalization chain");
      expect(targetPrompt).not.toContain("External financial agent frameworks such as Anthropic");
      expect(targetPrompt).not.toContain("when code is i.");
      expect(targetPrompt).not.toContain("and keep.");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses tighter prompt and token budgets for timeout-prone finance preflight cases", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-timeout-prone-"));
    const argLog = path.join(tempDir, "python-args.jsonl");
    const fakePython = path.join(tempDir, "python");
    writeFileSync(
      fakePython,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.appendFileSync(process.env.EVAL_FAKE_PYTHON_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);",
        "console.log(JSON.stringify({",
        "task_family: 'single_company_risk_preflight',",
        "primary_modules: ['company_fundamentals_value','causal_map','portfolio_risk_gates','quant_math','technical_timing','macro_rates_inflation','source_registry','review_panel','agent_workflow_memory','eval_harness_design','finance_learning_memory','credit_liquidity','cross_asset_liquidity','fx_currency_liquidity','global_index_regime','us_equity_market_structure','etf_regime'],",
        "supporting_modules: [],",
        "required_tools: ['control_room_summary'],",
        "missing_data: ['current_total_assets_and_position_size','position_weights_cost_basis_and_risk_limits','position_weights_and_return_series','portfolio_weights_and_risk_limits','latest_10q_10k_or_earnings_release','latest_company_fundamental_inputs','revenue_quality_margin_fcf_roic_and_balance_sheet_inputs','valuation_range_and_margin_of_safety_inputs','original_example','abstracted_failure_family','adjacent_non_identical_scenario','shared_contract','regression_proof','hidden_workflow_scope','user_visible_summary_contract','market_scope_and_time_window','fresh_market_data_snapshot','source_timestamp_and_vendor','price_volume_breadth_and_technical_regime_inputs'],",
        "risk_boundaries: ['research_only','no_model_math_guessing','risk_gate_before_action_language','position_sizing_requires_user_constraints_and_risk_budget','no_unverified_filing_claims','no_trade_advice','do_not_answer_literal_short_phrase_only','do_not_stop_at_original_example','proof_required_before_claiming_transfer','no_raw_json_visible_reply','no_unverified_current_market_data','technical_timing_not_standalone_alpha'],",
        "next_step: 'route_to_review',",
        "rejected_context: ['old_lark_conversation_history']",
        "}));",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
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
          "single_company_fundamental_risk,plain_single_stock_position_sizing_preflight",
          "--summary-only",
          "--json",
        ],
        {
          cwd: path.resolve(__dirname, ".."),
          encoding: "utf8",
          env: {
            ...process.env,
            EVAL_FAKE_PYTHON_LOG: argLog,
          },
        },
      );

      expect(result.status).toBe(0);
      const records = readFileSync(argLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const timeoutProneRecords = records.filter((args) => {
        const prompt = args[args.indexOf("--prompt") + 1] ?? "";
        return prompt.includes("只研究 NVDA 基本面风险") || prompt.includes("关注 NVDA 持仓多少");
      });
      expect(timeoutProneRecords.length).toBe(2);
      for (const args of timeoutProneRecords) {
        const prompt = args[args.indexOf("--prompt") + 1] ?? "";
        expect(args[args.indexOf("--max-tokens") + 1]).toBe("360");
        expect(prompt.length).toBeLessThan(4_500);
        expect(prompt).toContain("Parse-stability compact eval");
        expect(prompt).not.toContain("External financial agent frameworks such as Anthropic");
      }
      expect(timeoutProneRecords[0]?.[timeoutProneRecords[0].indexOf("--prompt") + 1]).toContain(
        "missing_data <= 4",
      );
      expect(timeoutProneRecords[1]?.[timeoutProneRecords[1].indexOf("--prompt") + 1]).toContain(
        "missing_data <= 6",
      );
      expect(timeoutProneRecords[1]?.[timeoutProneRecords[1].indexOf("--prompt") + 1]).toContain(
        "risk_boundaries <= 5",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses compact parse-stability prompts for the six recovered cases and nearby families", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-parse-stability-"));
    const argLog = path.join(tempDir, "python-args.jsonl");
    const fakePython = path.join(tempDir, "python");
    writeFileSync(
      fakePython,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.appendFileSync(process.env.EVAL_FAKE_PYTHON_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);",
        "const prompt = process.argv[process.argv.indexOf('--prompt') + 1] || '';",
        "if (prompt.includes('去学习这篇金融论文并沉淀成规则')) { console.log(JSON.stringify({task_family:'external_source_missing_url',primary_modules:['finance_learning_memory','source_registry'],supporting_modules:[],required_tools:[],missing_data:['source_url_or_local_source_path'],risk_boundaries:['research_only'],next_step:'request_source',rejected_context:['old_lark_conversation_history']})); process.exit(0); }",
        "const parseList = (label) => { const match = new RegExp(`${label}: ([^\\\\n.]+)`).exec(prompt); return match ? match[1].split(',').map((item) => item.trim()).filter(Boolean) : []; };",
        "const modules = parseList('Recommended module ids for this case');",
        "const missing = parseList('Required missing_data ids for this case');",
        "const risk = ['research_only', ...parseList('Required risk_boundaries for this case').filter((item) => item !== 'research_only')];",
        "console.log(JSON.stringify({task_family:'parse_stability_eval',primary_modules:modules.slice(0,8),supporting_modules:modules.slice(8,14),required_tools:modules.slice(14,20),missing_data:missing,risk_boundaries:risk,next_step:'route_to_review',rejected_context:['old_lark_conversation_history']}));",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
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
          "core_options_event_boundary_02,core_thesis_catalyst_lifecycle_06,research_artifact_qc_expansion_03,broad_finance_module_taxonomy_coverage,private_credit_nonbank_leverage_stress_waterflow,short_lark_commodity_scope_01,short_lark_commodity_scope_04,external_knowledge_expansion_04,adversarial_scenario_no_guess_02",
          "--summary-only",
          "--json",
        ],
        {
          cwd: path.resolve(__dirname, ".."),
          encoding: "utf8",
          env: {
            ...process.env,
            EVAL_FAKE_PYTHON_LOG: argLog,
          },
        },
      );

      expect(result.status).toBe(0);
      const records = readFileSync(argLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const targetRecords = records.filter((args) => {
        const prompt = args[args.indexOf("--prompt") + 1] ?? "";
        return prompt.includes("Parse-stability compact eval");
      });
      expect(targetRecords.length).toBeGreaterThanOrEqual(9);
      for (const args of targetRecords) {
        const prompt = args[args.indexOf("--prompt") + 1] ?? "";
        expect(args[args.indexOf("--max-tokens") + 1]).toBe("360");
        expect(prompt).toContain("Parse-stability compact eval");
        expect(prompt).toContain("missing_data <=");
        expect(prompt).toContain("risk_boundaries <=");
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("runs a neutral blind raw-contract eval without oracle labels or promotion proof", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-blind-"));
    const fakePython = path.join(tempDir, "python");
    const argLog = path.join(tempDir, "python-args.jsonl");
    const receiptPath = path.join(tempDir, "blind-receipt.json");
    writeFileSync(
      fakePython,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `const argLog = ${JSON.stringify(argLog)};`,
        "fs.appendFileSync(argLog, `${JSON.stringify(process.argv.slice(2))}\\n`);",
        "const prompt = process.argv[process.argv.indexOf('--prompt') + 1] || '';",
        "if (prompt.includes('Recommended module ids for this case') || prompt.includes('Required missing_data ids for this case') || prompt.includes('Required risk_boundaries for this case') || prompt.includes('Relevant compact contract hints')) process.exit(23);",
        "console.log(JSON.stringify({task_family:'portfolio_research_preflight',primary_modules:['macro_rates_inflation','credit_liquidity','etf_regime','company_fundamentals_value','portfolio_risk_gates'],supporting_modules:[],required_tools:[],missing_data:[],risk_boundaries:['research_only'],next_step:'route_to_review',rejected_context:['old_lark_conversation_history']}));",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/dev/local-brain-distill-eval.ts",
          "--no-adapter",
          "--python",
          fakePython,
          "--blind",
          "--case-id",
          "portfolio_mixed_q_t_nvda",
          "--summary-only",
          "--json",
          "--receipt",
          receiptPath,
        ],
        {
          cwd: path.resolve(__dirname, ".."),
          encoding: "utf8",
          env: { ...process.env, LOCAL_BRAIN_EVAL_PROMPT_CACHE: "0" },
        },
      );

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        blind: boolean;
        evaluationMode: string;
        promptMode: string;
        labelDisclosure: boolean;
        responsePrefill: string | null;
        modelSelfStartMode: string | null;
        modelSelfStartedJson: boolean | null;
        learningClaim: string;
        summary: {
          rawContractPassCount: number;
          modelContractReadyCaseIds: string[];
          modelContractFailureCaseIds: string[];
          hardeningAppliedCaseIds: string[];
          parseRetryCaseIds: string[];
          strictModelProofRequired: boolean;
          promotionReady: boolean;
        };
        cases?: unknown;
      };
      expect(payload).toMatchObject({
        blind: true,
        evaluationMode: "blind_raw_contract",
        promptMode: "neutral",
        labelDisclosure: false,
        responsePrefill: "{",
        modelSelfStartMode: "structural_prefill",
        modelSelfStartedJson: false,
        learningClaim: "not_proven_by_contract_eval",
      });
      expect(payload.cases).toBeUndefined();
      expect(payload.summary).toMatchObject({
        rawContractPassCount: 1,
        modelContractReadyCaseIds: ["portfolio_mixed_q_t_nvda"],
        modelContractFailureCaseIds: [],
        hardeningAppliedCaseIds: [],
        parseRetryCaseIds: [],
        strictModelProofRequired: true,
        promotionReady: false,
      });

      const records = readFileSync(argLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(records).toHaveLength(1);
      const prompt = records[0]?.[records[0]?.indexOf("--prompt") + 1] ?? "";
      expect(prompt).toContain("Blind neutral raw-contract eval");
      expect(prompt).toContain("Allowed module ids");
      expect(prompt).not.toContain("source_summary:");
      expect(prompt).not.toContain("Recommended module ids for this case");
      expect(prompt).not.toContain("Required missing_data ids for this case");
      expect(prompt).not.toContain("Required risk_boundaries for this case");
      expect(prompt).not.toContain("Relevant compact contract hints");
      expect(records[0]).toContain("--prefill-response");
      expect(records[0]).toContain("{");

      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
        requested: {
          evaluationMode: string;
          blind: boolean;
          promptMode: string;
          labelDisclosure: boolean;
          responsePrefill: string | null;
          modelSelfStartMode: string | null;
          modelSelfStartedJson: boolean | null;
        };
        proof: {
          blindRawContract: boolean;
          promptMode: string;
          labelDisclosure: boolean;
          modelContractReady: boolean;
          promotionReady: boolean;
        };
        caseReceipts: Array<{
          id: string;
          rawAcceptanceOk?: boolean;
          modelContractReady?: boolean;
          hardeningApplied?: boolean;
          parseRecovered?: boolean;
        }>;
      };
      expect(receipt.requested).toMatchObject({
        evaluationMode: "blind_raw_contract",
        blind: true,
        promptMode: "neutral",
        labelDisclosure: false,
        responsePrefill: "{",
        modelSelfStartMode: "structural_prefill",
        modelSelfStartedJson: false,
      });
      expect(receipt.proof).toMatchObject({
        blindRawContract: true,
        promptMode: "neutral",
        labelDisclosure: false,
        modelContractReady: true,
        promotionReady: false,
      });
      expect(receipt.caseReceipts).toEqual([
        expect.objectContaining({
          id: "portfolio_mixed_q_t_nvda",
          rawAcceptanceOk: true,
          modelContractReady: true,
          hardeningApplied: false,
        }),
      ]);
      expect(receipt.caseReceipts[0]).not.toHaveProperty("parseRecovered");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps blind malformed output as a parse failure without retry or recovery", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-blind-parse-"));
    const fakePython = path.join(tempDir, "python");
    const argLog = path.join(tempDir, "python-args.jsonl");
    writeFileSync(
      fakePython,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `const argLog = ${JSON.stringify(argLog)};`,
        "fs.appendFileSync(argLog, `${JSON.stringify(process.argv.slice(2))}\\n`);",
        'process.stdout.write(\'{"task_family":"portfolio_research_preflight"\');',
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/dev/local-brain-distill-eval.ts",
          "--no-adapter",
          "--python",
          fakePython,
          "--neutral",
          "--no-response-prefill",
          "--case-id",
          "portfolio_mixed_q_t_nvda",
          "--summary-only",
          "--json",
        ],
        {
          cwd: path.resolve(__dirname, ".."),
          encoding: "utf8",
          env: { ...process.env, LOCAL_BRAIN_EVAL_PROMPT_CACHE: "0" },
        },
      );

      expect(result.status).toBe(1);
      const payload = JSON.parse(result.stdout) as {
        evaluationMode: string;
        responsePrefill: string | null;
        modelSelfStartedJson: boolean | null;
        summary: {
          failedCaseIds: string[];
          parseErrorCaseIds: string[];
          parseRecoveredCaseIds: string[];
          parseRetryCaseIds: string[];
          promotionReady: boolean;
        };
      };
      expect(payload).toMatchObject({
        evaluationMode: "blind_raw_contract",
        responsePrefill: null,
        modelSelfStartMode: "unassisted",
        modelSelfStartedJson: true,
      });
      expect(payload.summary).toMatchObject({
        failedCaseIds: ["portfolio_mixed_q_t_nvda"],
        parseErrorCaseIds: ["portfolio_mixed_q_t_nvda"],
        parseRecoveredCaseIds: [],
        parseRetryCaseIds: [],
        promotionReady: false,
      });
      const records = readFileSync(argLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(records).toHaveLength(1);
      expect(records[0]?.some((arg) => arg === "--prompt")).toBe(true);
      expect(records[0]?.some((arg) => arg === "--prefill-response")).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("scores generated held-out rows through a neutral prompt without label leakage", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-heldout-"));
    const fakePython = path.join(tempDir, "python");
    const caseFile = path.join(tempDir, "holdout.jsonl");
    const argLog = path.join(tempDir, "python-args.jsonl");
    const receiptPath = path.join(tempDir, "holdout-receipt.json");
    writeFileSync(
      caseFile,
      `${JSON.stringify({
        id: "gen_holdout_commodity_01",
        userAsk: "我想研究原油，先说明缺什么输入，不要给交易信号。",
        featureSignature:
          "ac:commodity|ds:1|lr:0|ss:0|tw:0|pc:0|xm:0|rt:0|fd:0|ev:1|tt:0|vm:0|at:0",
        provenance: {
          schemaVersion: "lcx_generalization_case_v1",
          generator: "local-brain-generalization-harness",
          generatorVersion: "feature-signature-v1",
          split: "holdout",
          seed: 20260830,
          holdoutFraction: 0.2,
        },
        target: {
          requiredModules: ["commodities_oil_gold", "portfolio_risk_gates"],
          forbiddenModules: [],
          minModuleMatches: 2,
          requiredMissingData: ["commodity_curve_roll_yield_and_inventory_inputs"],
          requiredRiskBoundaries: ["commodity_framework_not_trade_signal"],
        },
      })}\n`,
      "utf8",
    );
    writeFileSync(
      fakePython,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `const argLog = ${JSON.stringify(argLog)};`,
        "const prompt = process.argv[process.argv.indexOf('--prompt') + 1] || '';",
        "fs.appendFileSync(argLog, `${JSON.stringify(process.argv.slice(2))}\\n`);",
        "if (prompt.includes('commodity_curve_roll_yield_and_inventory_inputs') || prompt.includes('ac:commodity') || prompt.includes('generated held-out case') || prompt.includes('source_summary:')) process.exit(23);",
        "console.log(JSON.stringify({task_family:'commodity_research_preflight',primary_modules:['commodities_oil_gold','portfolio_risk_gates'],supporting_modules:[],required_tools:[],missing_data:['commodity_curve_roll_yield_and_inventory_inputs'],risk_boundaries:['research_only','commodity_framework_not_trade_signal'],next_step:'request_missing_inputs',rejected_context:['old_lark_conversation_history']}));",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/dev/local-brain-distill-eval.ts",
          "--no-adapter",
          "--python",
          fakePython,
          "--blind",
          "--case-file",
          caseFile,
          "--summary-only",
          "--json",
          "--receipt",
          receiptPath,
        ],
        {
          cwd: path.resolve(__dirname, ".."),
          encoding: "utf8",
          env: { ...process.env, LOCAL_BRAIN_EVAL_PROMPT_CACHE: "0" },
        },
      );

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        caseSource: string;
        caseFile: string;
        caseFileSha256: string;
        caseFileBytes: number;
        caseFileProvenance: {
          schemaVersion: string;
          generator: string;
          generatorVersion: string;
          split: string;
          seed: number;
          holdoutFraction: number;
        };
        promptMode: string;
        labelDisclosure: boolean;
        hierarchy: { requestedCaseIds: string[] };
        summary: { rawContractPassCount: number; promotionReady: boolean };
      };
      expect(payload).toMatchObject({
        caseSource: "generated_holdout_file",
        caseFile,
        caseFileSha256: expect.any(String),
        caseFileBytes: expect.any(Number),
        caseFileProvenance: {
          schemaVersion: "lcx_generalization_case_v1",
          generator: "local-brain-generalization-harness",
          generatorVersion: "feature-signature-v1",
          split: "holdout",
          seed: 20260830,
          holdoutFraction: 0.2,
        },
        promptMode: "neutral",
        labelDisclosure: false,
        hierarchy: { requestedCaseIds: ["gen_holdout_commodity_01"] },
        summary: { rawContractPassCount: 1, promotionReady: false },
      });
      const args = JSON.parse(readFileSync(argLog, "utf8").trim()) as string[];
      const prompt = args[args.indexOf("--prompt") + 1] ?? "";
      expect(prompt).toContain("Blind neutral raw-contract eval");
      expect(prompt).toContain("我想研究原油");
      expect(prompt).not.toContain("commodity_curve_roll_yield_and_inventory_inputs");
      expect(prompt).not.toContain("ac:commodity");
      expect(prompt).not.toContain("source_summary:");

      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
        requested: {
          caseSource: string;
          caseFile: string;
          caseFileSha256: string;
          caseFileBytes: number;
          caseFileProvenance: { split: string; holdoutFraction: number };
          labelDisclosure: boolean;
        };
        caseReceipts: Array<{
          caseSource: string;
          featureSignature: string;
          modelContractReady: boolean;
        }>;
      };
      expect(receipt.requested).toMatchObject({
        caseSource: "generated_holdout_file",
        caseFile,
        caseFileSha256: expect.any(String),
        caseFileBytes: expect.any(Number),
        caseFileProvenance: { split: "holdout", holdoutFraction: 0.2 },
        labelDisclosure: false,
      });
      expect(receipt.caseReceipts).toEqual([
        expect.objectContaining({
          caseSource: "generated_holdout_file",
          featureSignature:
            "ac:commodity|ds:1|lr:0|ss:0|tw:0|pc:0|xm:0|rt:0|fd:0|ev:1|tt:0|vm:0|at:0",
          modelContractReady: true,
        }),
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects generated case files without verifiable holdout provenance", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-provenance-"));
    const caseFile = path.join(tempDir, "invalid-holdout.jsonl");
    const baseCase = {
      id: "gen_invalid_provenance_01",
      userAsk: "研究原油，先列缺失数据，不要给交易建议。",
      featureSignature: "ac:commodity|ds:1|lr:0|ss:0|tw:0|pc:0|xm:0|rt:0|fd:0|ev:1|tt:0|vm:0|at:0",
      target: {
        requiredModules: ["commodities_oil_gold"],
        forbiddenModules: [],
        minModuleMatches: 1,
        requiredMissingData: ["commodity_curve_roll_yield_and_inventory_inputs"],
        requiredRiskBoundaries: ["research_only"],
      },
    };

    try {
      writeFileSync(caseFile, `${JSON.stringify(baseCase)}\n`, "utf8");
      const missingProvenance = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/dev/local-brain-distill-eval.ts",
          "--no-adapter",
          "--blind",
          "--case-file",
          caseFile,
          "--summary-only",
          "--json",
        ],
        { cwd: path.resolve(__dirname, ".."), encoding: "utf8" },
      );
      expect(missingProvenance.status).toBe(1);
      expect(missingProvenance.stderr).toContain("featureSignature/provenance/target");

      writeFileSync(
        caseFile,
        `${JSON.stringify({
          ...baseCase,
          provenance: {
            schemaVersion: "lcx_generalization_case_v1",
            generator: "local-brain-generalization-harness",
            generatorVersion: "feature-signature-v1",
            split: "train",
            seed: 20260830,
            holdoutFraction: 0.2,
          },
        })}\n`,
        "utf8",
      );
      const trainLabeledAsHoldout = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/dev/local-brain-distill-eval.ts",
          "--no-adapter",
          "--blind",
          "--case-file",
          caseFile,
          "--summary-only",
          "--json",
        ],
        { cwd: path.resolve(__dirname, ".."), encoding: "utf8" },
      );
      expect(trainLabeledAsHoldout.status).toBe(1);
      expect(trainLabeledAsHoldout.stderr).toContain("invalid holdout provenance");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not extract a valid object hidden inside noisy blind output", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-envelope-"));
    const fakePython = path.join(tempDir, "python");
    writeFileSync(
      fakePython,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('prefix ' + JSON.stringify({task_family:'portfolio_research_preflight',primary_modules:['macro_rates_inflation','credit_liquidity','etf_regime','company_fundamentals_value','portfolio_risk_gates'],supporting_modules:[],required_tools:[],missing_data:[],risk_boundaries:['research_only'],next_step:'route_to_review',rejected_context:['old_lark_conversation_history']}) + ' suffix');",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/dev/local-brain-distill-eval.ts",
          "--no-adapter",
          "--python",
          fakePython,
          "--blind",
          "--no-response-prefill",
          "--case-id",
          "portfolio_mixed_q_t_nvda",
          "--summary-only",
          "--json",
        ],
        {
          cwd: path.resolve(__dirname, ".."),
          encoding: "utf8",
          env: { ...process.env, LOCAL_BRAIN_EVAL_PROMPT_CACHE: "0" },
        },
      );

      expect(result.status).toBe(1);
      const payload = JSON.parse(result.stdout) as {
        summary: { parseErrorCaseIds: string[]; rawContractPassCount: number };
      };
      expect(payload.summary).toMatchObject({
        parseErrorCaseIds: ["portfolio_mixed_q_t_nvda"],
        rawContractPassCount: 0,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("retries one malformed six-case output without upgrading it to model proof", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-parse-retry-"));
    const fakePython = path.join(tempDir, "python");
    const argLog = path.join(tempDir, "python-args.jsonl");
    const receiptPath = path.join(tempDir, "parse-retry-receipt.json");
    writeFileSync(
      fakePython,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `const argLog = ${JSON.stringify(argLog)};`,
        "fs.appendFileSync(argLog, `${JSON.stringify(process.argv.slice(2))}\\n`);",
        "const promptIndex = process.argv.indexOf('--prompt');",
        "const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] || '' : '';",
        "const parseList = (label) => { const match = new RegExp(`${label}: ([^\\\\n.]+)`).exec(prompt); return match ? match[1].split(',').map((item) => item.trim()).filter(Boolean) : []; };",
        "const modules = parseList('Recommended module ids for this case');",
        "const missing = parseList('Required missing_data ids for this case');",
        "const risk = ['research_only', ...parseList('Required risk_boundaries for this case').filter((item) => item !== 'research_only')];",
        "if (prompt.includes('凭感觉软着陆概率多少？') && !prompt.includes('Parse retry compact mode')) {",
        '  process.stdout.write(\'{"task_family":"scenario_probability_gate","primary_modules":["macro_rates_inflation"\');',
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({task_family:'parse_retry_contract',primary_modules:modules.slice(0,8),supporting_modules:modules.slice(8,14),required_tools:modules.slice(14,20),missing_data:missing,risk_boundaries:risk,next_step:'route_to_review',rejected_context:['old_lark_conversation_history']}));",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
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
          "adversarial_scenario_no_guess_02",
          "--summary-only",
          "--json",
          "--receipt",
          receiptPath,
        ],
        {
          cwd: path.resolve(__dirname, ".."),
          encoding: "utf8",
          env: {
            ...process.env,
            EVAL_FAKE_PYTHON_LOG: argLog,
            LOCAL_BRAIN_EVAL_PROMPT_CACHE: "0",
          },
        },
      );

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        summary: {
          parseErrorCaseIds: string[];
          parseRecoveredCaseIds: string[];
          parseRetryCaseIds: string[];
          modelContractFailureCaseIds: string[];
          promotionReady: boolean;
        };
        cases?: unknown;
      };
      expect(payload.cases).toBeUndefined();
      expect(payload.summary).toMatchObject({
        parseErrorCaseIds: [],
        parseRecoveredCaseIds: ["adversarial_scenario_no_guess_02"],
        parseRetryCaseIds: ["adversarial_scenario_no_guess_02"],
        promotionReady: false,
      });
      expect(payload.summary.modelContractFailureCaseIds).toContain(
        "adversarial_scenario_no_guess_02",
      );

      const records = readFileSync(argLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const retryRecords = records.filter((args) => {
        const promptIndex = args.indexOf("--prompt");
        return (args[promptIndex + 1] ?? "").includes("Parse retry compact mode");
      });
      expect(retryRecords).toHaveLength(1);
      const retryArgs = retryRecords[0] ?? [];
      expect(retryArgs[retryArgs.indexOf("--max-tokens") + 1]).toBe("320");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
        caseReceipts: Array<{
          id: string;
          initialGenerationStatus?: string;
          initialOutputChars?: number;
          initialOutputSha256?: string;
          parseErrorKind?: string;
        }>;
      };
      const targetReceipt = receipt.caseReceipts.find(
        (entry) => entry.id === "adversarial_scenario_no_guess_02",
      );
      expect(targetReceipt).toMatchObject({
        initialGenerationStatus: "invalid_json",
        parseErrorKind: "initial_parse",
      });
      expect(targetReceipt?.initialOutputChars).toBeGreaterThan(0);
      expect(targetReceipt?.initialOutputSha256).toMatch(/^[a-f0-9]{16}$/u);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps hardened acceptance separate from the raw model contract", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-hardening-delta-"));
    const fakePython = path.join(tempDir, "python");
    writeFileSync(
      fakePython,
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({",
        "task_family: 'cross_market_finance_research_planning',",
        "primary_modules: ['finance_framework_us_equity_market_structure_producer','global_index_regime','company_fundamentals_value','quant_math','portfolio_risk_gates','causal_map','review_panel'],",
        "supporting_modules: [],",
        "required_tools: [],",
        "missing_data: ['fresh_market_data_snapshot'],",
        "risk_boundaries: ['research_only'],",
        "next_step: 'request_missing_inputs',",
        "rejected_context: ['old_lark_conversation_history']",
        "}));",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
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
          "index_concentration_mag7_portfolio_risk",
          "--json",
        ],
        {
          cwd: path.resolve(__dirname, ".."),
          encoding: "utf8",
          env: { ...process.env, LOCAL_BRAIN_EVAL_PROMPT_CACHE: "0" },
        },
      );

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        summary: {
          failedCaseIds: string[];
          rawContractPassCount: number;
          modelContractReadyCaseIds: string[];
          modelContractFailureCaseIds: string[];
          rawContractNormalizationCaseIds: string[];
          hardeningAppliedCaseIds: string[];
          promotionReady: boolean;
        };
        cases: Array<{
          id: string;
          acceptance: { ok: boolean };
          rawAcceptance?: { ok: boolean };
          modelContractReady?: boolean;
          hardeningApplied?: boolean;
          hardeningChangedFields?: string[];
        }>;
      };
      const targetCase = payload.cases.find(
        (entry) => entry.id === "index_concentration_mag7_portfolio_risk",
      );
      expect(payload.summary.failedCaseIds).toEqual([]);
      expect(payload.summary.rawContractPassCount).toBe(0);
      expect(payload.summary.modelContractReadyCaseIds).not.toContain(
        "index_concentration_mag7_portfolio_risk",
      );
      expect(payload.summary.modelContractFailureCaseIds).toContain(
        "index_concentration_mag7_portfolio_risk",
      );
      expect(payload.summary.rawContractNormalizationCaseIds).toContain(
        "index_concentration_mag7_portfolio_risk",
      );
      expect(payload.summary.hardeningAppliedCaseIds).toContain(
        "index_concentration_mag7_portfolio_risk",
      );
      expect(payload.summary.promotionReady).toBe(false);
      expect(targetCase?.acceptance.ok).toBe(true);
      expect(targetCase?.rawAcceptance?.ok).toBe(false);
      expect(targetCase?.modelContractReady).toBe(false);
      expect(targetCase?.hardeningApplied).toBe(true);
      expect(targetCase?.hardeningChangedFields).toEqual(
        expect.arrayContaining(["missing_data", "risk_boundaries"]),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("pins exact required data and risk ids in complex eval prompts", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-prompt-ids-"));
    const argLog = path.join(tempDir, "python-args.jsonl");
    const fakePython = path.join(tempDir, "python");
    writeFileSync(
      fakePython,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.appendFileSync(process.env.EVAL_FAKE_PYTHON_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);",
        "console.log(JSON.stringify({",
        "task_family: 'crypto_liquidity_research_planning',",
        "primary_modules: ['cross_asset_liquidity','crypto_market_structure','global_index_regime','portfolio_risk_gates','source_registry','review_panel'],",
        "supporting_modules: [],",
        "required_tools: [],",
        "missing_data: ['crypto_liquidity_volatility_custody_and_regulatory_inputs','fresh_market_data_snapshot','portfolio_weights_and_risk_limits'],",
        "risk_boundaries: ['research_only','no_high_leverage_crypto','no_unverified_cross_market_claims'],",
        "next_step: 'route_to_review',",
        "rejected_context: ['old_lark_conversation_history']",
        "}));",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
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
          "stablecoin_liquidity_crypto_equity_bridge",
          "--summary-only",
          "--json",
        ],
        {
          cwd: path.resolve(__dirname, ".."),
          encoding: "utf8",
          env: {
            ...process.env,
            EVAL_FAKE_PYTHON_LOG: argLog,
          },
        },
      );

      expect(result.stdout).toBeTruthy();
      const records = readFileSync(argLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const prompts = records
        .map((args) => {
          const promptIndex = args.indexOf("--prompt");
          return promptIndex >= 0 ? (args[promptIndex + 1] ?? "") : "";
        })
        .filter(Boolean);
      const targetPrompt = prompts.find((prompt) =>
        prompt.includes("stablecoin and exchange reserve signal"),
      );

      expect(targetPrompt).toBeTruthy();
      expect(targetPrompt).toContain("Required missing_data ids for this case");
      expect(targetPrompt).toContain("crypto_liquidity_volatility_custody_and_regulatory_inputs");
      expect(targetPrompt).toContain("Required risk_boundaries for this case");
      expect(targetPrompt).toContain("no_unverified_cross_market_claims");
      expect(targetPrompt).toContain("Include these ids exactly; do not paraphrase");
      expect(targetPrompt?.length).toBeLessThan(5_500);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("recovers partial JSON emitted before a local MLX timeout without allowing promotion", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-timeout-"));
    const fakePython = path.join(tempDir, "python");
    writeFileSync(
      fakePython,
      [
        "#!/usr/bin/env node",
        'process.stdout.write(\'{"task_family":"finance_research_planning","primary_modules":["macro_rates_inflation","credit_liquidity","etf_regime"],"supporting_modules":["company_fundamentals_value","portfolio_risk_gates"],"required_tools":[],"missing_data":[],"risk_boundaries":["research_only"],"next_step":"route_to_review","rejected_context":["old_lark_conversation_history"]\');',
        "setInterval(() => {}, 1000);",
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
        "--hardened",
        "--case-id",
        "portfolio_mixed_q_t_nvda",
        "--timeout-ms",
        "2500",
        "--json",
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
        env: {
          ...process.env,
          LOCAL_BRAIN_EVAL_PROMPT_CACHE: "0",
        },
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: {
        passed: number;
        total: number;
        promotionReady: boolean;
        parseErrorCaseIds: string[];
        parseRecoveredCaseIds: string[];
      };
      cases: Array<{
        id: string;
        parseRecovered?: boolean;
        parseError?: string;
        initialGenerationStatus?: string;
        initialOutputChars?: number;
        initialOutputSha256?: string;
        acceptance: { ok: boolean };
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.summary).toMatchObject({
      passed: 1,
      total: 1,
      promotionReady: false,
      parseErrorCaseIds: [],
      parseRecoveredCaseIds: ["portfolio_mixed_q_t_nvda"],
    });
    const targetCase = payload.cases.find((entry) => entry.id === "portfolio_mixed_q_t_nvda");
    expect(targetCase?.acceptance.ok).toBe(true);
    expect(targetCase?.parseRecovered).toBe(true);
    expect(targetCase?.parseError).toContain("timed out after 2500ms");
    expect(targetCase?.initialGenerationStatus).toBe("generation_error");
    expect(targetCase?.initialOutputChars).toBeGreaterThan(0);
    expect(targetCase?.initialOutputSha256).toMatch(/^[a-f0-9]{16}$/u);
  });

  it("distinguishes a valid contract failure from a parse error and writes a compact receipt", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-receipt-"));
    const fakePython = path.join(tempDir, "python");
    const receiptPath = path.join(tempDir, "targeted-eval-receipt.json");
    writeFileSync(
      fakePython,
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({",
        "task_family: 'cross_market_finance_research_planning',",
        "primary_modules: ['us_equity_market_structure','global_index_regime','company_fundamentals_value','quant_math','portfolio_risk_gates','causal_map'],",
        "supporting_modules: [],",
        "required_tools: [],",
        "missing_data: ['fresh_market_data_snapshot'],",
        "risk_boundaries: ['research_only'],",
        "next_step: 'request_missing_inputs',",
        "rejected_context: ['old_lark_conversation_history']",
        "}));",
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
        "index_concentration_mag7_portfolio_risk",
        "--summary-only",
        "--json",
        "--receipt",
        receiptPath,
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
        env: { ...process.env, LOCAL_BRAIN_EVAL_PROMPT_CACHE: "0" },
      },
    );

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      summary: {
        failedCaseIds: string[];
        parseErrorCaseIds: string[];
        parseRecoveredCaseIds: string[];
      };
      cases?: unknown;
      receiptPath: string;
    };
    expect(payload.summary).toMatchObject({
      parseErrorCaseIds: [],
      parseRecoveredCaseIds: [],
    });
    expect(payload.summary.failedCaseIds).toContain("index_concentration_mag7_portfolio_risk");
    expect(payload.cases).toBeUndefined();
    expect(payload.receiptPath).toBe(receiptPath);

    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      schemaVersion: string;
      boundary: string;
      requested: { evaluationMode: string; learningClaim: string };
      summary: { parseErrorCaseIds: string[] };
      proof: { modelContractReady: boolean; promotionProof: boolean; learningClaim: string };
      caseReceipts: Array<{
        id: string;
        status: string;
        acceptanceOk: boolean;
        rawAcceptanceOk?: boolean;
        modelContractReady?: boolean;
      }>;
    };
    expect(receipt).toMatchObject({
      schemaVersion: "lcx_local_brain_eval_receipt_v1",
      boundary: "local_brain_eval_receipt_only",
      requested: {
        evaluationMode: "raw_contract",
        learningClaim: "not_proven_by_contract_eval",
      },
      summary: { parseErrorCaseIds: [] },
      proof: {
        modelContractReady: false,
        promotionProof: false,
        learningClaim: "not_proven_by_contract_eval",
      },
    });
    expect(receipt.caseReceipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "index_concentration_mag7_portfolio_risk",
          status: "failed",
          acceptanceOk: false,
          rawAcceptanceOk: false,
          modelContractReady: false,
        }),
      ]),
    );
    expect(JSON.stringify(receipt)).not.toContain("rawOutput");
  });

  it("retries empty MLX timeouts with a compact prompt without allowing promotion", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-empty-timeout-"));
    const fakePython = path.join(tempDir, "python");
    const targetTimeoutPath = path.join(tempDir, "target-timeout.txt");
    const argLog = path.join(tempDir, "python-args.jsonl");
    writeFileSync(
      fakePython,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `const targetTimeoutPath = ${JSON.stringify(targetTimeoutPath)};`,
        `const argLog = ${JSON.stringify(argLog)};`,
        "fs.appendFileSync(argLog, `${JSON.stringify(process.argv.slice(2))}\\n`);",
        "const promptIndex = process.argv.indexOf('--prompt');",
        "const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] || '' : '';",
        "const isTargetStandardPrompt = prompt.includes('我想给软着陆') && !prompt.includes('Timeout retry compact mode');",
        "if (isTargetStandardPrompt && !fs.existsSync(targetTimeoutPath)) {",
        "  fs.writeFileSync(targetTimeoutPath, '1');",
        "  setInterval(() => {}, 1000);",
        "}",
        "else {",
        "  console.log(JSON.stringify({",
        "    task_family: 'scenario_probability_missing_inputs_research_preflight',",
        "    primary_modules: ['macro_rates_inflation','credit_liquidity','etf_regime','company_fundamentals_value','quant_math','portfolio_risk_gates','finance_learning_memory','source_registry'],",
        "    supporting_modules: ['causal_map','review_panel'],",
        "    required_tools: [],",
        "    missing_data: ['position_weights_and_return_series','portfolio_weights_and_risk_limits','current_rates_and_inflation_inputs'],",
        "    risk_boundaries: ['research_only','no_model_math_guessing','no_trade_advice'],",
        "    next_step: 'request_missing_inputs',",
        "    rejected_context: ['old_lark_conversation_history']",
        "  }));",
        "}",
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
        "--hardened",
        "--case-id",
        "scenario_probability_no_model_math_guessing",
        "--timeout-ms",
        "2500",
        "--json",
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
        env: {
          ...process.env,
          LOCAL_BRAIN_EVAL_PROMPT_CACHE: "0",
        },
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: {
        passed: number;
        total: number;
        promotionReady: boolean;
        parseRecoveredCaseIds: string[];
      };
      cases: Array<{
        id: string;
        parseRecovered?: boolean;
        parseError?: string;
        acceptance: { ok: boolean };
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.summary).toMatchObject({
      passed: 4,
      total: 4,
      promotionReady: false,
      parseRecoveredCaseIds: expect.arrayContaining([
        "scenario_probability_no_model_math_guessing",
      ]),
    });
    const targetCase = payload.cases.find(
      (entry) => entry.id === "scenario_probability_no_model_math_guessing",
    );
    expect(targetCase?.acceptance.ok).toBe(true);
    expect(targetCase?.parseRecovered).toBe(true);
    expect(targetCase?.parseError).toContain("timed out after 2500ms");

    const records = readFileSync(argLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(records.length).toBe(5);
    const retryArgs = records.find((args) => {
      const promptIndex = args.indexOf("--prompt");
      return (args[promptIndex + 1] ?? "").includes("Timeout retry compact mode");
    });
    expect(retryArgs).toBeDefined();
    const retryArgsValue = retryArgs ?? [];
    const promptIndex = retryArgsValue.indexOf("--prompt");
    const maxTokenIndex = retryArgsValue.indexOf("--max-tokens");
    expect(retryArgsValue[promptIndex + 1]).toContain("Timeout retry compact mode");
    expect(retryArgsValue[maxTokenIndex + 1]).toBe("320");
  });

  it("cleans up the active mlx child when the eval wrapper receives a termination signal", async () => {
    const source = readFileSync(
      path.resolve(__dirname, "..", "scripts/dev/local-brain-distill-eval.ts"),
      "utf8",
    );

    expect(source).toContain("activeGenerateChild");
    expect(source).toContain("terminateActiveGenerateChild");
    expect(source).toContain("process.once(signal");
    expect(source).toContain('child.kill("SIGTERM")');
    expect(source).toContain('child.kill("SIGKILL")');
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

  it("keeps current real-market stress families wired into existing finance modules", () => {
    const requestedCaseIds = [
      "treasury_supply_term_premium_portfolio_risk",
      "private_credit_nonbank_leverage_stress_waterflow",
      "ai_capex_power_grid_index_concentration_risk",
      "energy_inflation_cross_asset_shock_risk",
    ];
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        requestedCaseIds.join(","),
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
      summary: { promotionReady: boolean };
      hierarchy: {
        requestedCaseIds: string[];
        autoIncludedPrerequisiteCaseIds: string[];
      };
      cases: Array<{ id: string; acceptance: { ok: boolean } }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.summary.promotionReady).toBe(true);
    expect(payload.hierarchy.requestedCaseIds).toEqual(requestedCaseIds);
    expect(payload.hierarchy.autoIncludedPrerequisiteCaseIds).toEqual(
      expect.arrayContaining([
        "rate_shock_duration_equity_chain",
        "nvda_capex_supplier_second_order_risk",
        "commodity_fx_inflation_inventory_portfolio_loop",
      ]),
    );
    for (const caseId of requestedCaseIds) {
      expect(payload.cases.find((entry) => entry.id === caseId)?.acceptance.ok, caseId).toBe(true);
    }
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

  it("gates five-project external agent upgrades behind existing-owner distillation", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        "external_agent_upgrade_five_project_distillation",
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
      "external_agent_upgrade_five_project_distillation",
    ]);
    expect(payload.hierarchy.autoIncludedPrerequisiteCaseIds).toEqual(
      expect.arrayContaining([
        "external_knowledge_internalization_protocol",
        "agent_skill_distillation_safety",
        "source_coverage_actual_reading_scope",
        "abstraction_transfer_repair_protocol",
      ]),
    );
    expect(payload.summary.total).toBeGreaterThanOrEqual(5);
    expect(payload.summary.promotionReady).toBe(true);
  });

  it("routes prediction-market and Polymarket strategy sources through research-only audit gates", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        "prediction_market_research_strategy_distillation",
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
      "prediction_market_research_strategy_distillation",
    ]);
    expect(payload.hierarchy.autoIncludedPrerequisiteCaseIds).toEqual(
      expect.arrayContaining([
        "external_knowledge_internalization_protocol",
        "external_agent_upgrade_five_project_distillation",
        "source_coverage_actual_reading_scope",
      ]),
    );
    expect(payload.summary.total).toBeGreaterThanOrEqual(5);
    expect(payload.summary.promotionReady).toBe(true);
  });

  it("keeps strengthened prediction-market liquidity and resolution gates promotion-ready", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        "prediction_market_research_strategy_distillation",
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
      hierarchy: { requestedCaseIds: string[] };
    };

    expect(payload.ok).toBe(true);
    expect(payload.hierarchy.requestedCaseIds).toEqual([
      "prediction_market_research_strategy_distillation",
    ]);
    expect(payload.summary.total).toBeGreaterThanOrEqual(5);
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

  it("covers valuation QC, thesis lifecycle, data provenance, and artifact QC gates", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        "financial_modeling_valuation_qc_chain,thesis_catalyst_lifecycle_review,data_provenance_quality_gate,research_artifact_qc_gate",
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
      "financial_modeling_valuation_qc_chain",
      "thesis_catalyst_lifecycle_review",
      "data_provenance_quality_gate",
      "research_artifact_qc_gate",
    ]);
    expect(payload.hierarchy.autoIncludedPrerequisiteCaseIds).toEqual(
      expect.arrayContaining(["single_company_fundamental_risk", "external_source_missing_url"]),
    );
    expect(payload.summary.total).toBeGreaterThanOrEqual(6);
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
