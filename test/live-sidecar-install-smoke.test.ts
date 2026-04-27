import { describe, expect, it } from "vitest";
import { buildBlockedReceipt } from "../scripts/dev/live-sidecar-install-smoke.ts";

describe("live sidecar install smoke guard", () => {
  it("builds a blocked receipt without live actions when execute flag is missing", () => {
    const receipt = buildBlockedReceipt({
      generatedAt: "2026-04-27T00:00:00.000Z",
      outputDir: "/tmp/out",
      reason: "missing required --execute-smoke",
      dryRunReceipt: {
        schemaVersion: 1,
        generatedAt: "2026-04-27T00:00:00.000Z",
        targetRoot: "/target",
        legacyRoot: "/legacy",
        outputDir: "/tmp/out",
        receiptPath: "/tmp/out/dry.json",
        noLiveLaunchAgentChange: true,
        preflightReady: true,
        blockedReasons: [],
        actions: [],
        executionBoundary: [],
      },
    });

    expect(receipt.preflightReady).toBe(false);
    expect(receipt.actions).toEqual([]);
    expect(receipt.blockedReasons).toContain("missing required --execute-smoke");
    expect(receipt.executionBoundary.join("\n")).toContain("No plist was copied");
  });

  it("documents that Desktop targets need an explicit override before live execution", () => {
    const receipt = buildBlockedReceipt({
      generatedAt: "2026-04-27T00:00:00.000Z",
      outputDir: "/tmp/out",
      reason: "target root is under Desktop",
      dryRunReceipt: {
        schemaVersion: 1,
        generatedAt: "2026-04-27T00:00:00.000Z",
        targetRoot: "/Users/liuchengxu/Desktop/lcx-s-openclaw",
        legacyRoot: "/Users/liuchengxu/Desktop/openclaw",
        outputDir: "/tmp/out",
        receiptPath: "/tmp/out/dry.json",
        noLiveLaunchAgentChange: true,
        preflightReady: true,
        blockedReasons: [],
        actions: [],
        executionBoundary: [],
      },
    });

    expect(receipt.blockedReasons).toContain("target root is under Desktop");
    expect(receipt.actions).toHaveLength(0);
  });
});
