import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendFinanceIntradayDecision,
  appendFinanceIntradayOutcome,
  readFinanceIntradayExecutionCoverage,
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

it("reads signal coverage without creating a database and distinguishes no fills from no attempts", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-coverage-"));
  temporary.push(directory);
  expect(await readFinanceIntradayExecutionCoverage(directory)).toEqual({ status: "absent" });
  expect(await fs.readdir(directory)).toEqual([]);
  for (const [signalId, status] of [
    ["refusal", "refused"],
    ["sent", "placed"],
    ["unknown", "uncertain"],
    ["pending", null],
  ] as const) {
    await appendFinanceIntradayDecision(directory, { ...input, signalId });
    if (status) {
      await appendFinanceIntradayOutcome(directory, {
        signalId,
        status,
        reasons: status === "refused" ? ["specific risk"] : [],
        ...(status === "placed" ? { receiptId: "receipt-one" } : {}),
      });
    }
  }
  const before = (await fs.readdir(directory)).toSorted();
  const result = await readFinanceIntradayExecutionCoverage(directory);
  expect(result).toMatchObject({
    status: "present",
    candidates: 4,
    placed: 1,
    refused: 1,
    uncertain: 1,
    missingOutcome: 1,
    allRecordedCandidatesUnexecuted: false,
    needsExecutionInspection: true,
    topReasons: [{ reason: "specific risk", count: 1 }],
  });
  // SQLite may create WAL reader sidecars; no new logical ledger is created.
  expect(
    (await fs.readdir(directory))
      .filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm"))
      .toSorted(),
  ).toEqual(before.filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm")));
});
it("does not treat an all-refused history as successful execution", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-refused-"));
  temporary.push(directory);
  await appendFinanceIntradayDecision(directory, input);
  await appendFinanceIntradayOutcome(directory, {
    signalId: input.signalId,
    status: "refused",
    reasons: ["model veto"],
  });
  expect(await readFinanceIntradayExecutionCoverage(directory)).toMatchObject({
    candidates: 1,
    placed: 0,
    refused: 1,
    allRecordedCandidatesUnexecuted: true,
    needsExecutionInspection: true,
  });
});

it("bounds coverage to the latest hundred signals and does not mix older placements into it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-window-"));
  temporary.push(directory);
  for (let index = 0; index < 101; index++) {
    const signalId = `signal-${index}`;
    await appendFinanceIntradayDecision(directory, { ...input, signalId });
    await appendFinanceIntradayOutcome(directory, {
      signalId,
      status: index === 0 ? "placed" : "refused",
      reasons: [],
      ...(index === 0 ? { receiptId: "old-placement" } : {}),
    });
  }
  expect(await readFinanceIntradayExecutionCoverage(directory)).toMatchObject({
    scope: "latest_100_recorded_signals",
    candidates: 100,
    placed: 0,
    refused: 100,
    allRecordedCandidatesUnexecuted: true,
  });
});
