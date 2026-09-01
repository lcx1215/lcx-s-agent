import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRealCostLedger } from "../scripts/operator/lcx-real-cost-ledger.ts";

describe("LCX real cost ledger", () => {
  it("keeps confirmed calls separate from estimated tokens and unknown billing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-real-cost-ledger-"));
    const logDir = path.join(root, "logs");
    const reviewDir = path.join(root, "memory/lark-brain-distillation-reviews/day");
    const councilDir = path.join(root, "bank/knowledge/learning-councils");
    await fs.mkdir(logDir, { recursive: true });
    await fs.mkdir(reviewDir, { recursive: true });
    await fs.mkdir(councilDir, { recursive: true });
    await fs.writeFile(
      path.join(logDir, "minimax-quota-brain-saturator-2026-05-28.jsonl"),
      [
        JSON.stringify({
          at: "2026-05-28T00:00:00.000Z",
          event: "step_ok",
          name: "minimax_teacher_batch",
          result: {
            teacher: "MiniMax-M2.7",
            source: "direct-api",
            mock: false,
            acceptedCandidates: 2,
            failures: [],
            providerSkippedPromptIds: [],
          },
        }),
        JSON.stringify({
          at: "2026-05-28T00:01:00.000Z",
          event: "step_failed",
          name: "minimax_teacher_batch",
          result: {
            teacher: "MiniMax-M2.7",
            source: "direct-api",
            mock: false,
            acceptedCandidates: 1,
            failures: [{ id: "bad_json", error: "bad" }],
            providerSkippedPromptIds: ["empty_payload"],
          },
        }),
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(reviewDir, "minimax-a.json"),
      JSON.stringify({
        acceptedCandidates: [
          { userMessage: "hello world", candidateText: "teacher answer" },
          { userMessage: "你好", candidateText: "回答" },
        ],
      }),
    );
    await fs.writeFile(
      path.join(councilDir, "provider-smoke.json"),
      JSON.stringify({
        generatedAt: "2026-05-28T00:02:00.000Z",
        roles: [
          {
            role: "kimi",
            model: "moonshot/kimi-k2.6",
            providerFamily: "moonshot",
            success: true,
            text: "kimi synthesis",
            usage: { total_tokens: 10 },
          },
          {
            role: "deepseek",
            model: "custom-api-deepseek-com/deepseek-v4-flash",
            providerFamily: "custom-api-deepseek-com",
            success: false,
            error: "rate limited",
          },
        ],
      }),
    );

    const ledger = await buildRealCostLedger({
      checkedAt: "2026-05-28T01:00:00.000Z",
      logDir,
      reviewRoot: path.join(root, "memory/lark-brain-distillation-reviews"),
      councilRoot: councilDir,
      monthlySubscriptionCostCny: undefined,
      outputPaths: {
        latestJsonPath: "/tmp/lcx-real-cost-ledger-latest.json",
        latestMarkdownPath: "/tmp/lcx-real-cost-ledger-latest.md",
      },
    });

    expect(ledger.summary.confirmedProviderCalls).toBe(7);
    expect(ledger.summary.confirmedAcceptedTeacherSamples).toBe(4);
    expect(ledger.summary.confirmedProviderFailuresOrSkips).toBe(3);
    expect(ledger.summary.confirmedBilledCostCny).toBeNull();
    expect(ledger.summary.confirmedUsageTokens).toBe(10);
    expect(ledger.summary.councilRoleCalls).toBe(2);
    expect(ledger.summary.estimatedCapturedTextTokens).toBeGreaterThan(0);
    expect(ledger.byModel.map((row) => row.model)).toContain("moonshot/kimi-k2.6");
    expect(ledger.byModel.map((row) => row.model)).toContain(
      "custom-api-deepseek-com/deepseek-v4-flash",
    );
    expect(ledger.markdown).toContain("真实已确认");
    expect(ledger.markdown).toContain("不能把估算 Token 当真钱");
    expect(ledger.markdown).toContain("Kimi/MiniMax/DeepSeek");
  });
});
