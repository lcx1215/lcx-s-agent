import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCheckpointedFinanceResearch } from "../../scripts/operator/lcx-finance-research-checkpoint-run.ts";
import { parseArgs } from "../../scripts/operator/lcx-finance-research-run.ts";
import { runFinanceResearchRun } from "../../src/agents/finance-research-runner.ts";

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
  it("distinguishes batch, model and whole-run limits", () => {
    expect(parseArgs([])).toMatchObject({
      timeoutMs: 120000,
      totalTimeoutMs: 180000,
      runTimeoutMs: 840000,
      maxModelCalls: 48,
    });
    expect(parseArgs(["--run-timeout-ms", "100", "--max-model-calls", "3"])).toMatchObject({
      runTimeoutMs: 100,
      maxModelCalls: 3,
    });
    expect(() => parseArgs(["--run-timeout-ms", "0"])).toThrow();
    expect(() => parseArgs(["--max-model-calls", "-1"])).toThrow();
  });
  it("wires both existing checkpoint owners and records completion", async () => {
    const budget = { ...(await fixture()), runTimeoutMs: 10000 };
    const execute: typeof runFinanceResearchRun = async (options) => {
      expect(options.batchOptions?.checkpoint?.path).toBe(options.modelCheckpoint?.path);
      expect(options.modelCheckpoint?.maxModelCalls).toBe(2);
      expect(options.signal?.aborted).toBe(false);
      return runFinanceResearchRun({ ...options, modelCheckpoint: undefined });
    };
    await runCheckpointedFinanceResearch(input, budget, execute);
    expect(await status()).toMatchObject({ status: "completed", reason: "planned" });
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
});
