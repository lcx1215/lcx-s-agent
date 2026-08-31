import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function makeGuardLog(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-quota-preview-"));
  const logPath = path.join(dir, "minimax-brain-training-guard-medium.jsonl");
  await fs.writeFile(
    logPath,
    `${JSON.stringify({
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
            "drawdown_budget_without_weights",
          ],
          promotionReady: false,
        },
      },
    })}\n`,
  );
  return logPath;
}

describe("minimax quota brain saturator preview", () => {
  it("includes simple real-world market and sizing asks in the normal teacher curriculum", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/minimax-quota-brain-saturator.ts",
        "--profile",
        "minimax-plus-brain",
        "--no-failure-focus",
        "--max-calls",
        "4",
        "--duration-minutes",
        "1",
        "--preview-prompts",
        "4",
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        timeout: 20_000,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
        },
      },
    );

    const payload = JSON.parse(stdout) as {
      preview?: {
        failureFocusPrompts: number;
        prompts: Array<{ id: string; userMessage: string }>;
      };
    };
    const promptText = payload.preview?.prompts.map((prompt) => prompt.userMessage).join("\n");

    expect(payload.preview?.failureFocusPrompts).toBe(0);
    expect(promptText).toContain("短口语表层请求，隐藏复杂工作流");
    expect(promptText).toContain("abstracted failure family");
    expect(promptText).toContain("regression proof");
    expect(promptText).toContain("分析最近股市");
    expect(promptText).toContain("关注");
    expect(promptText).toContain("持仓多少");
    expect(promptText).toContain("不能直接给百分比");
    expect(promptText).toContain("research-only");
  });

  it("keeps surplus MiniMax quota pointed at broad senior-trader capability lanes", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/minimax-quota-brain-saturator.ts",
        "--profile",
        "minimax-plus-brain",
        "--no-failure-focus",
        "--max-calls",
        "36",
        "--duration-minutes",
        "1",
        "--preview-prompts",
        "36",
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        timeout: 20_000,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
        },
      },
    );

    const payload = JSON.parse(stdout) as {
      preview?: {
        familyCounts?: Record<string, number>;
        prompts: Array<{ id: string; sourceSummary: string; userMessage: string }>;
      };
    };
    const promptText = payload.preview?.prompts
      .map((prompt) => `${prompt.id}\n${prompt.sourceSummary}\n${prompt.userMessage}`)
      .join("\n");

    expect(payload.preview?.familyCounts).toMatchObject({
      index_etf_constituent_concentration_chain: 1,
      options_iv_skew_event_risk_preflight: 1,
      macro_liquidity_credit_fx_dashboard: 1,
      company_fundamental_filing_dossier: 1,
      portfolio_risk_budget_stress_packet: 1,
      event_risk_calendar_research_loop: 1,
      quant_factor_strategy_absorption_gate: 1,
      multi_source_market_data_conflict_reconciliation: 1,
      financial_modeling_valuation_qc_chain: 1,
      thesis_catalyst_lifecycle_review: 1,
      data_provenance_quality_gate: 1,
      research_artifact_qc_gate: 1,
    });
    expect(promptText).toContain("constituents");
    expect(promptText).toContain("IV term structure");
    expect(promptText).toContain("10-K/10-Q");
    expect(promptText).toContain("walk-forward");
    expect(promptText).toContain("DCF/comps");
    expect(promptText).toContain("post-event correction note");
    expect(promptText).toContain("field definition");
    expect(promptText).toContain("number provenance");
    expect(promptText).toContain("unverified");
  });

  it("shows failure-focused prompts in dry-run output without calling the provider", async () => {
    const guardLogPath = await makeGuardLog();
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/minimax-quota-brain-saturator.ts",
        "--profile",
        "minimax-plus-brain",
        "--max-calls",
        "4",
        "--duration-minutes",
        "1",
        "--guard-log",
        guardLogPath,
        "--preview-prompts",
        "4",
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        timeout: 20_000,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
        },
      },
    );

    const payload = JSON.parse(stdout) as {
      mode: string;
      preview?: {
        failureFocusPrompts: number;
        prompts: Array<{ id: string; userMessage: string }>;
        liveTouched: boolean;
        providerConfigTouched: boolean;
      };
    };

    expect(payload.mode).toBe("dry_run");
    expect(payload.preview?.failureFocusPrompts).toBe(2);
    expect(payload.preview?.prompts.map((prompt) => prompt.id).join("\n")).toContain(
      "single_company_fundamental_risk",
    );
    expect(payload.preview?.prompts.map((prompt) => prompt.userMessage).join("\n")).toContain(
      "timestamped source",
    );
    expect(payload.preview?.liveTouched).toBe(false);
    expect(payload.preview?.providerConfigTouched).toBe(false);
  });
});
