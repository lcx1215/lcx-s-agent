import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFinanceDailyCycleOperator } from "../scripts/operator/lcx-finance-daily-cycle.js";
import {
  financeResearchSamplesPath,
  financeResearchScoredPath,
} from "../src/agents/finance-state-dir.js";
import {
  readFinanceScoredFloorSamples,
  readFinanceTuningProposals,
  runFinanceTuningLifecycle,
} from "../src/agents/finance-tuning-lifecycle.js";

const transport = vi.hoisted(() => ({
  bars: [{ date: "2026-02-02", close: 120 }],
  seriesReads: 0,
}));
vi.mock("../src/agents/finance-outcome-backfill.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/finance-outcome-backfill.js")>();
  return {
    ...actual,
    backfillOutcomes: (input: Parameters<typeof actual.backfillOutcomes>[0]) =>
      actual.backfillOutcomes({
        ...input,
        seriesFor: async () => {
          transport.seriesReads++;
          return transport.bars;
        },
      }),
  };
});
vi.mock("../src/config/config.js", () => ({
  loadConfig: () => {
    throw new Error("offline night probe may not read live configuration");
  },
}));

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-native-night-"));
  transport.seriesReads = 0;
  transport.bars = [{ date: "2026-02-02", close: 120 }];
  vi.stubGlobal("fetch", () => {
    throw new Error("offline night probe may not call external transport");
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(directory, { recursive: true, force: true });
});

async function night(asOf = "2026-02-01T23:00:00.000Z") {
  return runFinanceDailyCycleOperator([
    "--json",
    "--dir",
    directory,
    "--mode",
    "night",
    "--as-of",
    asOf,
  ]);
}
async function retain(name: string, result: unknown) {
  const destination = process.env.LCX_NIGHT_CALIBRATION_PROOF_DIR;
  if (!destination) {
    return;
  }
  const target = path.join(destination, name);
  await fs.mkdir(target, { recursive: true });
  await fs.cp(directory, path.join(target, "private-book"), { recursive: true });
  await fs.writeFile(
    path.join(target, "native-result.json"),
    JSON.stringify(
      {
        result,
        seriesReads: transport.seriesReads,
        scoredReadback: readFinanceScoredFloorSamples(directory),
        proposalReadback: readFinanceTuningProposals(directory),
        boundary:
          "original_night_operator_and_writers_fixture_input_and_price_transport_no_execution",
        fullAutomaticScene: "not_proven",
      },
      null,
      2,
    ) + "\n",
  );
}

describe("original night source → settlement → scored writer → calibration consumer", () => {
  it.each([
    { close: 120, outcome: 1, proposals: 1 },
    { close: 80, outcome: 0, proposals: 0 },
  ] as const)(
    "uses the actual $close source price to change calibration output",
    async ({ close, outcome, proposals }) => {
      transport.bars = [{ date: "2026-02-02", close }];
      const samples = Array.from({ length: 5 }, (_, i) => ({
        asOf: `2026-01-0${i + 1}T14:00:00.000Z`,
        instrument: "SPY",
        direction: "buy",
        conviction: 0.7,
        lastPrice: 100,
        horizonDays: 27,
      }));
      await fs.writeFile(
        financeResearchSamplesPath(directory),
        samples.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
      const settlement = await night("2026-02-02T23:00:00.000Z");
      const tuning = runFinanceTuningLifecycle({
        directory,
        generatedAt: "2026-02-02T23:00:00.000Z",
      });
      await retain(`source-${close}`, { settlement, tuning });
      expect(settlement.ok).toBe(true);
      expect(settlement.scoredFiled).toMatchObject({ appended: 5 });
      expect(readFinanceScoredFloorSamples(directory)).toEqual(
        samples.map(() => ({ conviction: 0.7, outcome })),
      );
      expect(tuning.proposal.samplesUsed).toBe(5);
      expect(tuning.newlyRecorded).toBe(proposals);
      expect(tuning.promotions).toEqual([]);
      expect(tuning.paperExecutionPromotion.status).toBe("blocked");
    },
  );

  it.each(["missing", "unreadable", "invalid_json"] as const)(
    "preserves the exact %s sample source failure without calling settlement",
    async (fault) => {
      const filename = financeResearchSamplesPath(directory);
      if (fault === "unreadable") {
        await fs.mkdir(filename);
      }
      if (fault === "invalid_json") {
        await fs.writeFile(filename, "{not json}\n");
      }
      const result = await night();
      await retain(fault, result);
      expect(result.ok).toBe(false);
      expect(result.failureKind).toBe("night_sample_source_gate");
      expect(result.sampleSource).toMatchObject({ path: filename, status: fault });
      expect(result.sampleCount).toBeNull();
      expect(result.issues).toContain(`night_sample_source_${fault}`);
      expect(result.scoredFiled).toMatchObject({ appended: 0 });
      expect(transport.seriesReads).toBe(0);
      expect(readFinanceScoredFloorSamples(directory)).toEqual([]);
    },
  );

  it("distinguishes a readable empty sample stream from a missing source", async () => {
    await fs.writeFile(financeResearchSamplesPath(directory), "\n");
    const result = await night();
    await retain("empty", result);
    expect(result.ok).toBe(true);
    expect(result.sampleSource).toMatchObject({ status: "available" });
    expect(result.sampleCount).toBe(0);
    expect(transport.seriesReads).toBe(0);
  });

  it("does not file future outcomes or propose a floor before the cutoff, then files actual later outcomes once", async () => {
    const samples = Array.from({ length: 5 }, (_, i) => ({
      asOf: `2026-01-0${i + 1}T14:00:00.000Z`,
      instrument: "SPY",
      direction: "buy",
      conviction: 0.7,
      lastPrice: 100,
      horizonDays: 27,
    }));
    await fs.writeFile(
      financeResearchSamplesPath(directory),
      samples.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    const first = await night();
    const beforeTuning = runFinanceTuningLifecycle({
      directory,
      generatedAt: "2026-02-01T23:00:00.000Z",
    });
    await retain("future", { settlement: first, tuning: beforeTuning });
    expect(first.ok).toBe(false);
    expect(first.scored).toEqual([]);
    expect(first.pending).toHaveLength(5);
    expect(first.scoredFiled).toMatchObject({ appended: 0 });
    expect(beforeTuning.newlyRecorded).toBe(0);
    expect(beforeTuning.proposal.samplesUsed).toBe(0);
    expect(beforeTuning.promotions).toEqual([]);
    const later = await night("2026-02-02T23:00:00.000Z");
    const tuning = runFinanceTuningLifecycle({
      directory,
      generatedAt: "2026-02-02T23:00:00.000Z",
    });
    await retain("later", { settlement: later, tuning });
    expect(later.ok).toBe(true);
    expect(later.scoredFiled).toMatchObject({ appended: 5 });
    expect(readFinanceScoredFloorSamples(directory)).toEqual(
      samples.map(() => ({ conviction: 0.7, outcome: 1 })),
    );
    expect(tuning.proposal.samplesUsed).toBe(5);
    expect(tuning.newlyRecorded).toBe(1);
    expect(readFinanceTuningProposals(directory)).toEqual(tuning.proposal.proposals);
    expect(tuning.paperExecutionPromotion.status).toBe("blocked");
    expect(tuning.promotions).toEqual([]);
    const bytes = await fs.readFile(financeResearchScoredPath(directory));
    const replay = await night("2026-02-02T23:00:00.000Z");
    expect(replay.scoredFiled).toMatchObject({ appended: 0, skipped: 5 });
    expect(await fs.readFile(financeResearchScoredPath(directory))).toEqual(bytes);
  });
});
