import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordedKeys, runResearchBatch } from "./finance-research-batch.js";

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

describe("recordedKeys", () => {
  const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sample-keys-")), "s.jsonl");

  it("counts a priced sample as already sampled", () => {
    const target = file();
    fs.writeFileSync(
      target,
      JSON.stringify({ instrument: "SPY", asOf: "2026-09-21T00:00:00.000Z", lastPrice: 761.69 }) +
        "\n",
    );
    expect(recordedKeys(target).has("SPY|2026-09-21")).toBe(true);
  });

  it("does not let a priceless sample block re-collection forever", () => {
    // Recorded while FMP was refusing the symbol: `lastPrice: 0`, not an observation. Counting
    // it as sampled froze the failure -- every later run skipped it, including the runs after
    // the cause was fixed.
    const target = file();
    fs.writeFileSync(
      target,
      JSON.stringify({ instrument: "QQQ", asOf: "2026-09-21T00:00:00.000Z", lastPrice: 0 }) + "\n",
    );
    expect(recordedKeys(target).has("QQQ|2026-09-21")).toBe(false);
  });
});
