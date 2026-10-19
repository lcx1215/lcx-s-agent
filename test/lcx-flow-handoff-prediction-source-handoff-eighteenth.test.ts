import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  probeConfiguredPredictionSourceExclusion,
  probePredictionSourceHandoff,
} from "./fixtures/lcx-waterflow-prediction-source-handoff-eighteenth-probe.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function run(assetClass: string, fault?: "missing_source" | "late_body") {
  const network = vi.fn().mockRejectedValue(new Error("real_network_forbidden"));
  vi.stubGlobal("fetch", network);
  const proof = process.env.LCX_PREDICTION_SOURCE_HANDOFF_PROOF_DIR;
  if (proof) {
    await fs.mkdir(proof, { recursive: true });
  }
  const dir = await fs.mkdtemp(
    path.join(proof ?? os.tmpdir(), `prediction-source-${assetClass.trim()}-${fault ?? "normal"}-`),
  );
  if (!proof) {
    temporary.push(dir);
  }
  const result = await probePredictionSourceHandoff({ workspaceDir: dir, assetClass, fault });
  expect(network).not.toHaveBeenCalled();
  return result;
}

describe("prediction identifiers do not dispatch original securities-only sources", () => {
  it("keeps a privately configured AlphaVantage out of prediction source selection", async () => {
    const network = vi.fn().mockRejectedValue(new Error("real_network_forbidden"));
    vi.stubGlobal("fetch", network);
    const result = await probeConfiguredPredictionSourceExclusion();
    expect(result.predictionEligible).toBe(false);
    expect(result.existingClassEligibility.every((row) => row.supported)).toBe(true);
    expect(result.inspection.candidateAdapters).toEqual([]);
    expect(result.calls).toEqual([]);
    expect(result.receipt).toMatchObject({
      status: "blocked",
      adaptersCalled: false,
      sourceAttempts: [],
    });
    expect(network).not.toHaveBeenCalled();
    const proof = process.env.LCX_PREDICTION_SOURCE_HANDOFF_PROOF_DIR;
    if (proof) {
      await fs.mkdir(proof, { recursive: true });
      await fs.writeFile(
        path.join(proof, "actual-configured-source-exclusion.json"),
        JSON.stringify(result, null, 2) + "\n",
      );
    }
  });
  it.each(["prediction_market", " Prediction_Market "])(
    "preserves actual unsupported source block for %s without securities HTTP",
    async (assetClass) => {
      const result = await run(assetClass);
      expect(result.inspection.candidateAdapters).toEqual([]);
      expect(result.calls).toEqual([]);
      expect(result.receipt).toMatchObject({
        status: "blocked",
        adaptersCalled: false,
        sourceAttempts: [],
        selectedSourceIds: [],
        missingEvidence: ["successful_finance_source_observation"],
      });
      expect(result.receipt.snapshot).toBeUndefined();
      expect(result.wholePredictionWorkflowObserved).toBe(false);
    },
  );

  it.each(["equity", "etf"])(
    "retains legitimate %s original parser dispatch",
    async (assetClass) => {
      const result = await run(assetClass);
      expect(result.inspection.candidateAdapters.map((adapter) => adapter.id)).toEqual(
        expect.arrayContaining(["nasdaq_exchange_quote", "stooq_public_daily"]),
      );
      expect(result.calls).toHaveLength(2);
      expect(result.calls.every((call) => call.bodyRead && call.bodyFinished)).toBe(true);
      expect(
        result.receipt.sourceAttempts
          .filter((attempt) =>
            ["nasdaq_exchange_quote", "stooq_public_daily"].includes(attempt.adapterId),
          )
          .map((attempt) => attempt.status),
      ).toEqual(["succeeded", "succeeded"]);
      const quote = result.calls.find((call) => call.url.startsWith("https://api.nasdaq.com/"));
      expect(quote?.url).toContain(`assetclass=${assetClass === "etf" ? "etfs" : "stocks"}`);
      // Two cross-check sources alone do not prove primary/official provenance or prediction capability.
      expect(result.receipt.status).not.toBe("ready");
    },
  );

  it("keeps real missing-file source reads failed in the original refresh terminal", async () => {
    const result = await run("equity", "missing_source");
    expect(result.calls).toHaveLength(2);
    expect(result.calls.every((call) => call.bodyRead && !call.bodyFinished)).toBe(true);
    expect(result.receipt.status).toBe("blocked");
    expect(result.receipt.sourceAttempts.every((attempt) => attempt.status === "failed")).toBe(
      true,
    );
    expect(result.receipt.snapshot).toBeUndefined();
  });

  it("seals original source timeout before delayed bodies without restoring success", async () => {
    const result = await run("equity", "late_body");
    expect(result.calls).toHaveLength(2);
    expect(result.bodyFinishedAtTerminal).toEqual([false, false]);
    expect(result.calls.every((call) => call.bodyFinished)).toBe(true);
    expect(result.receipt.status).toBe("blocked");
    expect(result.receipt.sourceAttempts.every((attempt) => attempt.status === "failed")).toBe(
      true,
    );
    expect(
      result.receipt.sourceAttempts
        .filter((attempt) =>
          ["nasdaq_exchange_quote", "stooq_public_daily"].includes(attempt.adapterId),
        )
        .map((attempt) => attempt.error),
    ).toEqual(["API timeout", "API timeout"]);
    expect(result.terminalUnchangedAfterLateBody).toBe(true);
    expect(result.receipt.snapshot).toBeUndefined();
    expect(result.cleanup).toContain("cancellation acknowledgement unobserved");
  });
});
