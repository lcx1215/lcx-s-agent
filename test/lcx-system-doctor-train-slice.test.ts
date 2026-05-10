import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("LCX system doctor train slice observability", () => {
  it("surfaces the latest balanced Qwen train slice in the guard summary", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/dev/lcx-system-doctor.ts"),
      "utf8",
    );

    expect(source).toContain("function summarizeTrainSliceEvent");
    expect(source).toContain('event.name === "train_slice"');
    expect(source).toContain("latestTrainSlice: summarizeTrainSliceEvent(latestTrainSlice)");
    expect(source).toContain("sourceDataDir: result.sourceDataDir");
    expect(source).toContain("policy: result.policy");
  });

  it("classifies the MiniMax saturator before matching its guard-log argument", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/dev/lcx-system-doctor.ts"),
      "utf8",
    );
    const roleMap = source.slice(source.indexOf(".map((entry) => ({"));
    const saturatorIndex = roleMap.indexOf(
      'entry.command.includes("minimax-quota-brain-saturator")',
    );
    const guardIndex = roleMap.indexOf('entry.command.includes("minimax-brain-training-guard")');

    expect(saturatorIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(saturatorIndex).toBeLessThan(guardIndex);
  });

  it("bounds live Lark probes so a stuck channel check cannot look successful", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/dev/lcx-system-doctor.ts"),
      "utf8",
    );

    expect(source).toContain("LIVE_LARK_DIAGNOSE_TIMEOUT_MS");
    expect(source).toContain("LIVE_CHANNEL_PROBE_TIMEOUT_MS");
    expect(source).toContain("error: `${params.name} timed out after ${params.timeoutMs}ms`");
    expect(source).toMatch(
      /name: "channels-status-probe"[\s\S]*timeoutMs: LIVE_CHANNEL_PROBE_TIMEOUT_MS/u,
    );
    expect(source).toMatch(
      /name: "lark-loop-diagnose"[\s\S]*timeoutMs: LIVE_LARK_DIAGNOSE_TIMEOUT_MS/u,
    );
  });
});
