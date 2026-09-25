import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendFinanceIntradayDecision,
  readFinanceIntradayDecisions,
  type FinanceIntradayDecisionInput,
} from "./finance-intraday-control-ledger.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((item) => fs.rm(item, { recursive: true, force: true })),
  );
});

const input: FinanceIntradayDecisionInput = {
  signalId: "intraday-abc",
  instrument: "SPY",
  sessionDate: "2026-09-18",
  action: "buy",
  reason: "opening_range_breakout",
  referencePrice: 100,
  referencePriceAt: "2026-09-18T14:05:00.000Z",
  stopPrice: 99,
  targetPrice: 102,
  datasetHeadRef: "a".repeat(64),
  strategyRule: "opening_range_breakout_long_next_bar_v1",
};

describe("finance intraday control ledger", () => {
  it("persists a hash-chained decision and deduplicates its stable signal id", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-control-"));
    temporary.push(directory);
    expect((await appendFinanceIntradayDecision(directory, input)).appended).toBe(true);
    expect((await appendFinanceIntradayDecision(directory, input)).appended).toBe(false);
    const records = await readFinanceIntradayDecisions(directory, {
      instrument: "SPY",
      sessionDate: "2026-09-18",
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.input).toEqual(input);
  });

  it("refuses conflicting content under one signal id", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-control-"));
    temporary.push(directory);
    await appendFinanceIntradayDecision(directory, input);
    await expect(
      appendFinanceIntradayDecision(directory, { ...input, referencePrice: 101 }),
    ).rejects.toThrow(/signalId conflict/);
  });

  it("keeps legacy records readable but requires a snapshot reference for system scope", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-control-binding-"));
    temporary.push(directory);
    await appendFinanceIntradayDecision(directory, input);
    const binding = {
      declarationRef: "b".repeat(64),
      activationRef: "c".repeat(64),
      declaredInstruments: ["SPY"],
      parameters: {
        openingRangeBars: 6,
        rewardRisk: 2,
        intervalSeconds: 300 as const,
        feed: "iex" as const,
      },
      scope: "system_universe" as const,
    };
    await expect(
      appendFinanceIntradayDecision(directory, {
        ...input,
        signalId: "intraday-missing-snapshot-ref",
        strategyBinding: binding,
      }),
    ).rejects.toThrow("requires its validated snapshot reference");
    await appendFinanceIntradayDecision(directory, {
      ...input,
      signalId: "intraday-system-scope",
      strategyBinding: { ...binding, universeSnapshotRef: "d".repeat(64) },
    });
    const records = await readFinanceIntradayDecisions(directory);
    expect(records.map((record) => record.input.strategyBinding?.scope)).toEqual([
      undefined,
      "system_universe",
    ]);
  });
});
