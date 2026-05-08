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
            "unverified_live_market_data_boundary",
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
        "scripts/dev/minimax-quota-brain-saturator.ts",
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

  it("shows failure-focused prompts in dry-run output without calling the provider", async () => {
    const guardLogPath = await makeGuardLog();
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/minimax-quota-brain-saturator.ts",
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
