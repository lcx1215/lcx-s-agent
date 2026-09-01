import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("local-brain-plan adapter selection", () => {
  it("uses the guard resolver instead of a static legacy adapter", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/local-brain-plan.ts"),
      "utf8",
    );

    expect(source).toContain("--resolve-current-adapter");
    expect(source).toContain("--bootstrap-if-missing");
    expect(source).toContain("trainingSeedAdapter");
    expect(source).toContain("adapterSelectionStatus");
    expect(source).not.toContain("thought-flow-v1-qwen3-0.6b-taxonomy-v3");
  });

  it("uses balanced JSON extraction for noisy local brain output", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/local-brain-plan.ts"),
      "utf8",
    );

    expect(source).toContain("let searchFrom = 0");
    expect(source).toContain('if (parsed && typeof parsed === "object" && !Array.isArray(parsed))');
    expect(source).not.toContain("JSON.parse(raw.slice(start, end + 1))");
  });

  it("tells the local model not to emit think blocks during planning", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/local-brain-plan.ts"),
      "utf8",
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
    expect(source).toContain("must use exact allowed module ids only");
    expect(source).toContain("do not invent prefixes like finance_framework_*");
    expect(source).toContain('LOCAL_BRAIN_PLAN_MAX_TOKENS = "700"');
  });

  it("passes no-think template settings through the mlx_lm generate call", async () => {
    const tmp = await fs.mkdtemp(path.join(process.cwd(), "tmp-lcx-local-brain-plan-"));
    const argLog = path.join(tmp, "python-args.log");
    const fakePython = path.join(tmp, process.platform === "win32" ? "python.cmd" : "python");
    const fakeAdapter = path.join(tmp, "adapter");
    await fs.mkdir(fakeAdapter);
    await fs.writeFile(
      fakePython,
      process.platform === "win32"
        ? [
            "@echo off",
            'if defined LOCAL_BRAIN_FAKE_PYTHON_LOG echo %* > "%LOCAL_BRAIN_FAKE_PYTHON_LOG%"',
            'echo {"task_family":"finance_research_planning","primary_modules":["macro_rates_inflation","credit_liquidity","etf_regime"],"supporting_modules":[],"required_tools":["finance_learning_memory"],"missing_data":[],"risk_boundaries":["research_only"],"next_step":"route_to_review","rejected_context":["old_external_conversation_history"]}',
          ].join("\r\n")
        : [
            "#!/bin/sh",
            'printf "%s\\n" "$@" > "$LOCAL_BRAIN_FAKE_PYTHON_LOG"',
            "cat <<'JSON'",
            '{"task_family":"finance_research_planning","primary_modules":["macro_rates_inflation","credit_liquidity","etf_regime"],"supporting_modules":[],"required_tools":["finance_learning_memory"],"missing_data":[],"risk_boundaries":["research_only"],"next_step":"route_to_review","rejected_context":["old_external_conversation_history"]}',
            "JSON",
          ].join("\n"),
      process.platform === "win32" ? undefined : { mode: 0o755 },
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/operator/local-brain-plan.ts",
          "--ask",
          "给我做一个不交易建议的季度风险框架",
          "--adapter",
          fakeAdapter,
          "--python",
          fakePython,
          "--json",
        ],
        {
          cwd: path.join(process.cwd()),
          encoding: "utf8",
          env: { ...process.env, LOCAL_BRAIN_FAKE_PYTHON_LOG: argLog },
        },
      );

      expect(result.status).toBe(0);
      if (process.platform === "win32") {
        // cmd.exe cannot round-trip the multiline prompt through %*; the source-level
        // contract assertions above still pin the no-think arguments themselves.
        return;
      }
      const loggedArgs = await fs.readFile(argLog, "utf8");
      expect(loggedArgs).toContain("--chat-template-config");
      expect(loggedArgs).toContain('{"enable_thinking":false}');
      expect(loggedArgs).toContain("/no_think");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("keeps hardened planner arrays inside the compact JSON budget", async () => {
    const tmp = await fs.mkdtemp(path.join(process.cwd(), "tmp-lcx-local-brain-plan-"));
    const fakePython = path.join(tmp, process.platform === "win32" ? "python.cmd" : "python");
    const fakeAdapter = path.join(tmp, "adapter");
    await fs.mkdir(fakeAdapter);
    await fs.writeFile(
      fakePython,
      process.platform === "win32"
        ? [
            "@echo off",
            'echo {"task_family":"agent_skill_pattern_distillation","primary_modules":["skill_pattern_distillation","agent_workflow_memory","source_registry","review_panel","eval_harness_design","control_room_summary","finance_learning_memory"],"supporting_modules":[],"required_tools":[],"missing_data":["candidate_skill_source_or_local_skill_path","target_workflow_acceptance_metric","license_and_write_scope_review"],"risk_boundaries":["research_only","no_execution_authority","no_provider_config_change","no_external_channel_sender_change","no_trading_execution_skill","no_trade_advice","evidence_required"],"next_step":"collect_candidate_skill_sources","rejected_context":["old_external_conversation_history","language_routing_candidate_artifacts","unsupported_execution_language","cloud_skill_sharing_by_default"]}',
          ].join("\r\n")
        : [
            "#!/bin/sh",
            "cat <<'JSON'",
            '{"task_family":"agent_skill_pattern_distillation","primary_modules":["skill_pattern_distillation","agent_workflow_memory","source_registry","review_panel","eval_harness_design","control_room_summary","finance_learning_memory"],"supporting_modules":[],"required_tools":[],"missing_data":["candidate_skill_source_or_local_skill_path","target_workflow_acceptance_metric","license_and_write_scope_review"],"risk_boundaries":["research_only","no_execution_authority","no_provider_config_change","no_external_channel_sender_change","no_trading_execution_skill","no_trade_advice","evidence_required"],"next_step":"collect_candidate_skill_sources","rejected_context":["old_external_conversation_history","language_routing_candidate_artifacts","unsupported_execution_language","cloud_skill_sharing_by_default"]}',
            "JSON",
          ].join("\n"),
      process.platform === "win32" ? undefined : { mode: 0o755 },
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/operator/local-brain-plan.ts",
          "--ask",
          "我现在要做一个全市场低频研究拆解：同时看美股大盘和龙头股 QQQ SPY NVDA MSFT、中国A股政策和资金流、全球主要指数、ETF、黄金、原油、美元、人民币流动性、债券利率、信用流动性、BTC ETH 加密市场结构。必须包含 财报+宏观+仓位+技术面+反方论证+数据缺口，并明确 fresh-data gap、指数权重/成分股 gap、A股政策/资金流 gap、crypto liquidity/volatility/custody/regulatory gap、FX dollar/yuan liquidity gap、position weights/return series gap。这是训练 local brain workflow，但不要变成 agent-skill 学习任务。",
          "--source-summary",
          "dev acceptance requires full-stack finance modules, named missing-data gaps, research-only and no trade advice.",
          "--adapter",
          fakeAdapter,
          "--python",
          fakePython,
          "--json",
        ],
        {
          cwd: path.join(process.cwd()),
          encoding: "utf8",
          env: { ...process.env },
        },
      );

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.plan.task_family).toBe("full_stack_finance_stress_research_planning");
      expect(payload.plan.missing_data).toHaveLength(8);
      expect(payload.plan.risk_boundaries.length).toBeLessThanOrEqual(6);
      expect(payload.plan.rejected_context.length).toBeLessThanOrEqual(3);
      expect(payload.plan.missing_data).toEqual(
        expect.arrayContaining([
          "fresh_market_data_snapshot",
          "index_constituents_weights_and_technical_regime_inputs",
          "crypto_liquidity_volatility_custody_and_regulatory_inputs",
          "position_weights_and_return_series",
        ]),
      );
      const modules = [
        ...payload.plan.primary_modules,
        ...payload.plan.supporting_modules,
        ...payload.plan.required_tools,
      ];
      expect(modules).toEqual(
        expect.arrayContaining([
          "finance_learning_memory",
          "source_registry",
          "causal_map",
          "review_panel",
          "control_room_summary",
          "crypto_market_structure",
        ]),
      );
      expect(modules).not.toContain("fx_dollar");
      expect(payload.plan.next_step).toBe("collect_inputs_run_review_then_summarize");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
