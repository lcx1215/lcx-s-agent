import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRealCostLedger,
  writeRealCostLedger,
  collectUsageTokens,
  summarizeRealModelRequestUsage,
} from "../scripts/operator/lcx-real-cost-ledger.ts";
import type { ModelRequestRecord } from "../src/agents/model-request-trajectory.js";

describe("LCX real cost ledger", () => {
  it("keeps confirmed calls separate from estimated tokens and unknown billing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-real-cost-ledger-"));
    const logDir = path.join(root, "logs");
    const reviewDir = path.join(root, "memory/external-brain-distillation-reviews/day");
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
      reviewRoot: path.join(root, "memory/external-brain-distillation-reviews"),
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

it("does not add total tokens to input/output or cache/reasoning subsets", () => {
  expect(
    collectUsageTokens({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 50 },
        completion_tokens_details: { reasoning_tokens: 10 },
      },
    }),
  ).toBe(120);
  expect(collectUsageTokens({ usage: { input_tokens: 100, output_tokens: 20 } })).toBe(120);
  expect(
    collectUsageTokens([{ usage: { total_tokens: 120 } }, { usage: { total_tokens: 80 } }]),
  ).toBe(200);
});
it("attributes usage to attempt time, retains real retries, and withholds conflicting or aborted usage", () => {
  const row = (
    requestId: string,
    ts: string,
    stage: ModelRequestRecord["stage"],
    extra = {},
  ): ModelRequestRecord => ({
    schema: "lcx_model_request_metadata_v1",
    requestId,
    ts,
    stage,
    source: "finance_engine",
    provider: "fixture",
    modelId: "fixture",
    role: "risk_check",
    ...extra,
  });
  const a = "2026-10-14T19:00:00Z",
    b = "2026-10-14T20:00:00Z";
  const result = summarizeRealModelRequestUsage(
    [
      row("before", "2026-10-14T18:59:59Z", "attempt_started"),
      row("before", a, "usage_received", { totalTokens: 999 }),
      row("one", a, "attempt_started"),
      row("one", a, "usage_received", { totalTokens: 120 }),
      row("one", b, "usage_received", { totalTokens: 120 }),
      row("retry", a, "attempt_started", { attempt: 2 }),
      row("retry", a, "request_aborted"),
      row("conflict", a, "attempt_started"),
      row("conflict", a, "usage_received", { totalTokens: 10 }),
      row("conflict", a, "usage_received", { totalTokens: 20 }),
    ],
    { startAt: a, endAt: b },
  );
  expect(result).toMatchObject({
    attempts: 3,
    usageRequests: 1,
    unknownUsageRequests: 2,
    observedTokens: 120,
    conflictingUsageRequests: 1,
    billedCost: null,
  });
  expect(result.byTask[0].aborted).toBe(1);
});

it("feeds native model usage into the original ledger without treating a declared subscription as billing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-cost-owner-"));
  try {
    const metadata = path.join(root, "lcx-model-request-metadata.jsonl");
    const base = {
      schema: "lcx_model_request_metadata_v1",
      requestId: "native",
      source: "finance_engine",
      provider: "fixture",
      modelId: "fixture",
      role: "research_draft",
    };
    await fs.writeFile(
      metadata,
      [
        { ...base, ts: "2026-10-14T19:00:00Z", stage: "attempt_started" },
        {
          ...base,
          ts: "2026-10-14T19:00:01Z",
          stage: "usage_received",
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    const result = await buildRealCostLedger({
      checkedAt: "2026-10-14T20:00:00Z",
      logDir: root,
      reviewRoot: root,
      councilRoot: root,
      monthlySubscriptionCostCny: 10,
      modelRequestMetadataPath: metadata,
      modelUsageWindow: { startAt: "2026-10-14T18:00:00Z", endAt: "2026-10-14T20:00:00Z" },
      outputPaths: {
        latestJsonPath: path.join(root, "out.json"),
        latestMarkdownPath: path.join(root, "out.md"),
      },
    });
    expect(result.modelRequestUsage).toMatchObject({
      status: "observed",
      attempts: 1,
      usageRequests: 1,
      observedTokens: 120,
      billedCost: null,
    });
    expect(result.summary.confirmedBilledCostCny).toBeNull();
    expect(result.summary.declaredMonthlySubscriptionCostCny).toBe(10);
    await writeRealCostLedger(result);
    expect(JSON.parse(await fs.readFile(path.join(root, "out.json"), "utf8"))).toMatchObject({
      modelRequestUsage: { observedTokens: 120 },
    });
    expect(await fs.readFile(path.join(root, "out.md"), "utf8")).toContain("非账单");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
