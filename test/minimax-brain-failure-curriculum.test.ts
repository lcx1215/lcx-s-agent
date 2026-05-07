import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFailureCurriculumPrompts } from "../scripts/dev/minimax-brain-failure-curriculum.js";

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
    expect(prompts[0].sourceSummary).toContain("no live sender");
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
