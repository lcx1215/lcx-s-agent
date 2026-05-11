import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("local-brain-plan adapter selection", () => {
  it("uses the guard resolver instead of a static legacy adapter", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/dev/local-brain-plan.ts"),
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
      path.join(repoRoot, "scripts/dev/local-brain-plan.ts"),
      "utf8",
    );

    expect(source).toContain("let searchFrom = 0");
    expect(source).toContain('if (parsed && typeof parsed === "object" && !Array.isArray(parsed))');
    expect(source).not.toContain("JSON.parse(raw.slice(start, end + 1))");
  });

  it("tells the local model not to emit think blocks during planning", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/dev/local-brain-plan.ts"),
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
    const fakePython = path.join(tmp, "python");
    const fakeAdapter = path.join(tmp, "adapter");
    await fs.mkdir(fakeAdapter);
    await fs.writeFile(
      fakePython,
      [
        "#!/bin/sh",
        'printf "%s\\n" "$@" > "$LOCAL_BRAIN_FAKE_PYTHON_LOG"',
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
          "scripts/dev/local-brain-plan.ts",
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
      const loggedArgs = await fs.readFile(argLog, "utf8");
      expect(loggedArgs).toContain("--chat-template-config");
      expect(loggedArgs).toContain('{"enable_thinking":false}');
      expect(loggedArgs).toContain("/no_think");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
