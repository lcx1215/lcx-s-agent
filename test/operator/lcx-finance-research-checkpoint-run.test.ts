import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FinanceResearchRunFailure,
  runCheckpointedFinanceResearch,
} from "../../scripts/operator/lcx-finance-research-checkpoint-run.ts";
import {
  compactFinanceResearchFailure,
  parseArgs,
} from "../../scripts/operator/lcx-finance-research-run.ts";
import { FinanceModelStageFailure } from "../../src/agents/finance-model-checkpoints.ts";
import { runFinanceResearchRun } from "../../src/agents/finance-research-runner.ts";
import { ModelAdapterError } from "../../src/agents/logical-agent-model-router.ts";

let directory: string;
afterEach(async () => {
  vi.useRealTimers();
  if (directory) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "research-budget-"));
  return { directory, runTimeoutMs: 10, maxModelCalls: 2 };
}
const input = {
  input: { ask: "Review SPY", asOf: "2026-09-28T00:00:00Z", horizonMonths: 1 },
  liveFetch: false,
};
async function status() {
  const [id] = await fs.readdir(directory);
  return JSON.parse(await fs.readFile(path.join(directory, id, "run.json"), "utf8"));
}
describe("research CLI checkpoint budget", () => {
  it.each([
    ["provider_payment_required", "provider_billing"],
    ["provider_auth", "provider_access"],
    ["provider_rate_limit", "provider_quota"],
  ] as const)(
    "preserves the %s adapter failure class in the durable checkpoint",
    async (code, failureClass) => {
      const budget = await fixture();
      await expect(
        runCheckpointedFinanceResearch(input, budget, async () => {
          throw new ModelAdapterError(code);
        }),
      ).rejects.toThrow();
      expect(await status()).toMatchObject({ status: "failed", failureClass });
      const summary = compactFinanceResearchFailure(
        new FinanceResearchRunFailure(
          "research_run_failed",
          "run-1",
          "checkpoint.sqlite",
          "2026-10-03T00:00:00Z",
          new ModelAdapterError(code),
        ),
      );
      expect(summary.failure.failureClass).toBe(failureClass);
      expect(summary).not.toHaveProperty("portfolioPlanWritten");
    },
  );
  it("distinguishes batch, model and whole-run limits", () => {
    expect(parseArgs([])).toMatchObject({
      timeoutMs: 120000,
      totalTimeoutMs: 180000,
      runTimeoutMs: 840000,
      maxModelCalls: 48,
      maxModelConcurrency: 2,
    });
    expect(parseArgs(["--run-timeout-ms", "100", "--max-model-calls", "3"])).toMatchObject({
      runTimeoutMs: 100,
      maxModelCalls: 3,
    });
    expect(parseArgs(["--max-model-concurrency", "1"]).maxModelConcurrency).toBe(1);
    expect(() => parseArgs(["--max-model-concurrency", "3"])).toThrow();
    expect(() => parseArgs(["--run-timeout-ms", "0"])).toThrow();
    expect(() => parseArgs(["--max-model-calls", "-1"])).toThrow();
  });
  it("wires both existing checkpoint owners and records completion", async () => {
    const budget = { ...(await fixture()), runTimeoutMs: 10000 };
    let deliveredSignal: AbortSignal | undefined;
    const execute: typeof runFinanceResearchRun = async (options) => {
      expect(options.batchOptions?.checkpoint?.path).toBe(options.modelCheckpoint?.path);
      expect(options.modelCheckpoint?.maxModelCalls).toBe(2);
      deliveredSignal = options.signal;
      expect(options.signal?.aborted).toBe(false);
      return runFinanceResearchRun({ ...options, modelCheckpoint: undefined });
    };
    await runCheckpointedFinanceResearch(input, budget, execute);
    expect(await status()).toMatchObject({ status: "completed", reason: "planned" });
    expect(deliveredSignal?.aborted).toBe(false);
  });
  it("records provider-blocked returned research and permits a fresh run to recover", async () => {
    const budget = { ...(await fixture()), runTimeoutMs: 10000 };
    const planned = await runFinanceResearchRun(input);
    const blocked = await runCheckpointedFinanceResearch(input, budget, async () => ({
      ...planned,
      status: "needs_review",
      answerDecision: "return_failed_reason",
      committee: {
        coverage: {},
        model: {
          status: "failed",
          modelId: "fixture",
          roleCount: 1,
          completedRoleCount: 0,
          modelCallCount: 1,
          realModelInferenceObserved: false,
          allModelCallsAttested: false,
          evidenceMode: "none",
          roleStatuses: [
            {
              taskId: "draft",
              agentId: "research_draft",
              status: "failed",
              error: "model routing failed: provider_payment_required secret-provider-detail",
            },
          ],
        },
      },
    }));
    expect(blocked.answerDecision).toBe("return_failed_reason");
    const saved = await status();
    expect(saved).toMatchObject({
      status: "completed",
      reason: "needs_review",
      failureClass: "provider_billing",
    });
    expect(JSON.stringify(saved)).not.toContain("secret-provider-detail");
    await runCheckpointedFinanceResearch(input, budget, async () => planned);
    const records = await Promise.all(
      (await fs.readdir(directory)).map(async (id) =>
        JSON.parse(await fs.readFile(path.join(directory, id, "run.json"), "utf8")),
      ),
    );
    expect(new Set(records.map((record) => record.runId)).size).toBe(2);
    expect(records.find((record) => record.reason === "planned")).not.toHaveProperty(
      "failureClass",
    );
  });
  it("persists cancellation while pending and refuses a late result", async () => {
    const budget = await fixture();
    const receipt = await runFinanceResearchRun(input);
    vi.useFakeTimers();
    const execute: typeof runFinanceResearchRun = async (options) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(options.signal?.aborted).toBe(true);
      return receipt;
    };
    const promise = runCheckpointedFinanceResearch(input, budget, execute);
    const rejected = expect(promise).rejects.toThrow("research_run_deadline_exceeded");
    await vi.advanceTimersByTimeAsync(10);
    expect(await status()).toMatchObject({ status: "cancelling" });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(await status()).toMatchObject({
      status: "aborted",
      reason: "research_run_deadline_exceeded",
    });
  });
  it("records failures without copying provider errors or credentials", async () => {
    const budget = await fixture();
    await expect(
      runCheckpointedFinanceResearch(input, budget, async () => {
        throw new Error("secret-provider-detail");
      }),
    ).rejects.toThrow();
    expect(await status()).toMatchObject({ status: "failed", reason: "research_run_failed" });
    expect(JSON.stringify(await status())).not.toContain("secret-provider-detail");
  });
  it("classifies provider quota failures without persisting the provider message", async () => {
    const budget = await fixture();
    await expect(
      runCheckpointedFinanceResearch(input, budget, async () => {
        throw new Error("API budget_exhausted Authorization: Bearer sk-test-secret-value");
      }),
    ).rejects.toThrow();
    const saved = await status();
    expect(saved).toMatchObject({ status: "failed", failureClass: "provider_quota" });
    expect(JSON.stringify(saved)).not.toContain("budget_exhausted");
    expect(JSON.stringify(saved)).not.toContain("sk-test-secret-value");
  });
  it("classifies an upstream timeout separately from a quota failure", async () => {
    const budget = await fixture();
    await expect(
      runCheckpointedFinanceResearch(input, budget, async () => {
        throw new Error("ETIMEDOUT while waiting for provider response");
      }),
    ).rejects.toThrow();
    expect(await status()).toMatchObject({ status: "failed", failureClass: "timeout" });
  });
  it("classifies an oversized controller evidence packet without persisting its detail", async () => {
    const budget = await fixture();
    await expect(
      runCheckpointedFinanceResearch(input, budget, async () => {
        throw new Error("controllerEvidence text must be <= 256000 UTF-8 bytes");
      }),
    ).rejects.toThrow();
    const saved = await status();
    expect(saved).toMatchObject({ status: "failed", failureClass: "evidence_contract" });
    expect(JSON.stringify(saved)).not.toContain("controllerEvidence text");
  });
});

it("exposes a failed scheduler summary with the durable checkpoint, never a candidate", () => {
  const summary = compactFinanceResearchFailure(
    new FinanceResearchRunFailure(
      "research_run_deadline_exceeded",
      "run-1",
      "/book/checkpoints.sqlite",
      "2026-09-29T00:00:00Z",
    ),
  );
  expect(summary).toMatchObject({
    status: "failed",
    answerDecision: "return_failed_reason",
    failure: {
      reason: "research_run_deadline_exceeded",
      failureClass: "deadline",
      checkpointPath: "/book/checkpoints.sqlite",
    },
  });
  expect(summary).not.toHaveProperty("portfolioPlanWritten");
  expect(summary).not.toHaveProperty("written");
});

it.each(["committee", "quality"] as const)(
  "cancels cooperative work after %s fails while preserving its original cause",
  async (stage) => {
    const budget = { ...(await fixture()), runTimeoutMs: 10000 };
    let childStopped = false;
    let deliveredSignal: AbortSignal | undefined;
    const original = new Error("fetch failed secret-url-and-token");
    let failure: unknown;
    try {
      await runCheckpointedFinanceResearch(input, budget, async (options) => {
        deliveredSignal = options.signal;
        options.signal!.addEventListener(
          "abort",
          () => {
            childStopped = true;
          },
          { once: true },
        );
        throw new FinanceModelStageFailure(stage, original);
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(FinanceResearchRunFailure);
    expect(failure).toMatchObject({
      reason: "research_run_failed",
      failureClass: "network",
      enteredStage: stage,
    });
    expect(deliveredSignal?.aborted).toBe(true);
    expect(childStopped).toBe(true);
    const saved = await status();
    expect(saved).toMatchObject({
      status: "failed",
      reason: "research_run_failed",
      failureClass: "network",
      enteredStage: stage,
    });
    const summary = compactFinanceResearchFailure(failure as FinanceResearchRunFailure);
    expect(summary.failure).toMatchObject({ enteredStage: stage, failureClass: "network" });
    expect(JSON.stringify([saved, summary])).not.toContain("secret-url-and-token");
  },
);

it.each([
  ["provider_payment_required", "provider_billing"],
  ["provider_auth", "provider_access"],
  ["runtime_timeout", "timeout"],
] as const)(
  "preserves %s classification through the entered-stage wrapper",
  async (code, failureClass) => {
    const budget = { ...(await fixture()), runTimeoutMs: 10000 };
    await expect(
      runCheckpointedFinanceResearch(input, budget, async () => {
        throw new FinanceModelStageFailure("quality", new ModelAdapterError(code));
      }),
    ).rejects.toMatchObject({
      reason: "research_run_failed",
      failureClass,
      enteredStage: "quality",
    });
    expect(await status()).toMatchObject({
      status: "failed",
      failureClass,
      enteredStage: "quality",
    });
  },
);

it("preserves caller cancellation instead of reclassifying failure cleanup as a deadline", async () => {
  const budget = { ...(await fixture()), runTimeoutMs: 10000 };
  const parent = new AbortController();
  await expect(
    runCheckpointedFinanceResearch({ ...input, signal: parent.signal }, budget, async () => {
      parent.abort();
      throw new FinanceModelStageFailure("committee", new Error("original"));
    }),
  ).rejects.toMatchObject({ reason: "research_run_cancelled", failureClass: "cancelled" });
  expect(await status()).toMatchObject({ status: "aborted", reason: "research_run_cancelled" });
});

it("cancels cooperative work even when terminal checkpoint persistence fails", async () => {
  const budget = { ...(await fixture()), runTimeoutMs: 10000 };
  let childStopped = false;
  await expect(
    runCheckpointedFinanceResearch(input, budget, async (options) => {
      options.signal!.addEventListener(
        "abort",
        () => {
          childStopped = true;
        },
        { once: true },
      );
      // Simulate loss of the writable checkpoint directory after the running record.
      await fs.rm(directory, { recursive: true, force: true });
      throw new FinanceModelStageFailure("quality", new Error("original failure"));
    }),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(childStopped).toBe(true);
});
