import { execFile } from "node:child_process";
import { access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("local-brain-open-eval", () => {
  async function runOpenEval(
    providerCommand = "node --import tsx test/fixtures/local-brain-open-eval-provider.ts",
    providerTimeoutMs?: number,
  ) {
    type ExecFailure = {
      stdout?: string;
      stderr?: string;
    };
    type RunResult = { stdout: string };
    const command = ["--json", "--provider-command", providerCommand];
    if (providerTimeoutMs) {
      command.push("--provider-timeout-ms", String(providerTimeoutMs));
    }
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/dev/local-brain-open-eval.ts", ...command],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
    ).catch((error): RunResult => {
      const failure = error as ExecFailure;
      return { stdout: failure.stdout ?? "" };
    });

    return JSON.parse(stdout) as {
      ok: boolean;
      summary: { passed: number; total: number; failedCaseIds: string[] };
      cases: Array<{
        id: string;
        plan: { source_summary_from_provider?: string } | null;
        acceptance: { ok: boolean; error?: string };
      }>;
    };
  }

  it("runs the provider command without a shell", async () => {
    const result = await runOpenEval();

    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({ passed: 5, total: 5, failedCaseIds: [] });
  });

  it("passes source summary into the provider via env", async () => {
    const result = await runOpenEval();
    const byId = Object.fromEntries(
      result.cases
        .filter((entry) => typeof entry.plan?.source_summary_from_provider === "string")
        .map((entry) => [entry.id, entry.plan.source_summary_from_provider]),
    ) as Record<string, string>;

    expect(byId["cross_market_us_a_index_crypto"]).toBe(
      "open eval cross-market finance case spanning US equities, China A-shares, global indices, crypto, FX/liquidity, memory recall, and review handoff.",
    );
    expect(byId["source_missing_learning_gate"]).toBe(
      "open eval external learning request missing source path.",
    );
    expect(byId["agent_skill_distillation_safety"]).toBe(
      "open eval agent-skill distillation request requiring source review, isolated skill install, eval harness, and protected-memory guardrails.",
    );
    expect(byId["quant_math_missing_inputs"]).toBe(
      "open eval quant planning request missing weights and return series.",
    );
    expect(byId["lark_context_pollution_ops_first"]).toBe(
      "open eval ops audit request, explicitly not a finance research request.",
    );
  });

  it("rejects shell metacharacters in provider commands", async () => {
    const marker = path.join(os.tmpdir(), `openclaw-local-brain-open-eval-injection-${Date.now()}`);
    await rm(marker, { force: true });

    await expect(
      execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/dev/local-brain-open-eval.ts",
          "--json",
          "--provider-command",
          `node --import tsx test/fixtures/local-brain-open-eval-provider.ts; touch ${marker}`,
        ],
        { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
      ),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining("unsupported shell metacharacters"),
    });
    await expect(access(marker)).rejects.toThrow();
  });

  it("supports quoted path arguments in provider command", async () => {
    const result = await runOpenEval(
      'node --import tsx "test/fixtures/local-brain-open-eval-provider.ts"',
    );
    expect(result.ok).toBe(true);
  });

  it("supports single-quoted provider path arguments", async () => {
    const result = await runOpenEval(
      "node --import tsx 'test/fixtures/local-brain-open-eval-provider.ts'",
    );
    expect(result.ok).toBe(true);
  });

  it("fails fast when provider returns bad JSON", async () => {
    const result = await runOpenEval(
      "node --import tsx test/fixtures/local-brain-open-eval-provider-bad-json.ts",
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toEqual({
      passed: 0,
      total: 5,
      failedCaseIds: [
        "cross_market_us_a_index_crypto",
        "source_missing_learning_gate",
        "agent_skill_distillation_safety",
        "quant_math_missing_inputs",
        "lark_context_pollution_ops_first",
      ],
    });
    expect(result.summary.failedCaseIds).toEqual([
      "cross_market_us_a_index_crypto",
      "source_missing_learning_gate",
      "agent_skill_distillation_safety",
      "quant_math_missing_inputs",
      "lark_context_pollution_ops_first",
    ]);
    const errors = result.cases.map((entry) => entry.acceptance.error);
    expect(errors.every((entry) => typeof entry === "string")).toBe(true);
    expect(errors.join("|")).toContain("provider returned no JSON");
  });

  it("fails fast when provider command times out", async () => {
    const result = await runOpenEval(
      "node --import tsx test/fixtures/local-brain-open-eval-provider-timeout.ts",
      10,
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toEqual({
      passed: 0,
      total: 5,
      failedCaseIds: [
        "cross_market_us_a_index_crypto",
        "source_missing_learning_gate",
        "agent_skill_distillation_safety",
        "quant_math_missing_inputs",
        "lark_context_pollution_ops_first",
      ],
    });
    expect(result.summary.failedCaseIds).toEqual([
      "cross_market_us_a_index_crypto",
      "source_missing_learning_gate",
      "agent_skill_distillation_safety",
      "quant_math_missing_inputs",
      "lark_context_pollution_ops_first",
    ]);
    expect(result.cases[0].acceptance.error).toContain("provider timed out after");
  });

  it("rejects invalid provider timeout values", async () => {
    await expect(
      execFileAsync(process.execPath, [
        "--import",
        "tsx",
        "scripts/dev/local-brain-open-eval.ts",
        "--provider-timeout-ms",
        "-1",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Usage: node --import tsx"),
    });
    await expect(
      execFileAsync(process.execPath, [
        "--import",
        "tsx",
        "scripts/dev/local-brain-open-eval.ts",
        "--provider-timeout-ms",
        "abc",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Usage: node --import tsx"),
    });
    await expect(
      execFileAsync(process.execPath, [
        "--import",
        "tsx",
        "scripts/dev/local-brain-open-eval.ts",
        "--provider-timeout-ms",
        "0",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Usage: node --import tsx"),
    });
  });
});
