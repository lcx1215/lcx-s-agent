import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runResearchBatch } from "./finance-research-batch.js";

/**
 * Where a sample is recorded decides which book the night run settles.
 *
 * These used to be reached as `state/finance/...` relative to the process working directory, which
 * is the right book only while the caller happens to be started from the repository root. A
 * scheduler is not, and would have written a second samples file beside the first while the night
 * run settled the empty one and reported "no history" forever.
 *
 * An empty instrument list keeps this offline: nothing is collected, so the only thing under test
 * is where the file would go.
 */

const KEY = { FMP_API_KEY: "test-key" };

const savedStateDir = process.env.LCX_FINANCE_STATE_DIR;

afterEach(() => {
  if (savedStateDir === undefined) {
    delete process.env.LCX_FINANCE_STATE_DIR;
  } else {
    process.env.LCX_FINANCE_STATE_DIR = savedStateDir;
  }
});

describe("runResearchBatch sample path", () => {
  it("follows the finance state directory from the environment", async () => {
    process.env.LCX_FINANCE_STATE_DIR = "/tmp/lcx-state-a";
    const result = await runResearchBatch({ instruments: [], env: KEY });
    expect(result.recordPath).toBe(path.join("/tmp/lcx-state-a", "research-samples.jsonl"));
  });

  it("prefers an explicit directory over the environment", async () => {
    process.env.LCX_FINANCE_STATE_DIR = "/tmp/lcx-state-a";
    const result = await runResearchBatch({
      instruments: [],
      env: KEY,
      directory: "/tmp/lcx-state-b",
    });
    expect(result.recordPath).toBe(path.join("/tmp/lcx-state-b", "research-samples.jsonl"));
  });

  it("never hands back a path the working directory can change", async () => {
    // The defect was not the directory name, it was that the answer depended on where the process
    // was started. An absolute path is the minimum that has to be true for the rest to matter.
    process.env.LCX_FINANCE_STATE_DIR = "/tmp/lcx-state-a";
    const result = await runResearchBatch({ instruments: [], env: KEY });
    expect(path.isAbsolute(result.recordPath)).toBe(true);
    expect(result.recordPath).not.toContain("state/finance/");
  });
});
