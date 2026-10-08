import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { AlpacaSafetyQuoteReadError } from "./finance-alpaca-safety-provider.js";
import type { AlpacaSafetyAccountArithmeticDiagnostic } from "./finance-alpaca-safety-provider.js";
import { FinanceExecutionSafetyFactsError } from "./finance-execution-safety.js";
import {
  appendFinanceIntradayDecision,
  appendFinanceIntradayOutcome,
  readFinanceIntradayExecutionCoverage,
  readFinanceIntradayDecisions,
  readFinanceIntradayOutcome,
  readFinanceIntradayOutcomes,
  type FinanceIntradayDecisionInput,
} from "./finance-intraday-control-ledger.js";
import { financeIntradayControlLedgerPath } from "./finance-state-dir.js";

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

function arithmeticDiagnostic(): AlpacaSafetyAccountArithmeticDiagnostic {
  return {
    failedConditions: ["gross_valuation_drift"],
    values: {
      equity: 30000,
      cash: 10000,
      shortMarketValue: 0,
      positionGross: 19999.9,
      longMarketValue: 20000,
      accountGross: 20000,
      grossDrift: 0.1,
      grossDriftTolerance: 0.6,
      cashEquityResidual: 0,
      cashEquityTolerance: 0.01,
      controllerPeakEquity: 30000,
    },
    trackNewHigh: true,
    valuationRetry: {
      firstGrossDrift: 1,
      retryGrossDrift: 0.1,
      firstCoherentTolerance: 0.6,
      retryCoherentTolerance: 0.6,
      cashStable: true,
      quantitiesStable: true,
    },
  };
}

it.each([false, true])(
  "retains legacy or paired arithmetic evidence in the original ledger: %s",
  async (paired) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-valuation-pair-"));
    temporary.push(directory);
    const diagnostic = arithmeticDiagnostic();
    if (!paired) {
      delete diagnostic.valuationRetry;
    }
    const error = new FinanceExecutionSafetyFactsError("account_snapshot_unavailable", {
      reason: "alpaca_safety_facts_inconsistent",
      stage: "account_arithmetic",
      accountArithmetic: diagnostic,
    });
    const expected = structuredClone(diagnostic);
    if (diagnostic.valuationRetry) {
      diagnostic.valuationRetry.firstGrossDrift = 999;
    }
    await appendFinanceIntradayDecision(directory, input);
    await appendFinanceIntradayOutcome(directory, {
      signalId: input.signalId,
      status: "refused",
      reasons: [error.message],
      executionSafetyFailure: {
        stage: "facts",
        category: error.category,
        operation: "read_account_safety_facts",
        provider: error.provider,
      },
    });
    expect(
      (await readFinanceIntradayOutcome(directory, input.signalId))?.executionSafetyFailure
        ?.provider?.accountArithmetic,
    ).toEqual(expected);
  },
);

it.each([
  "raw",
  "null",
  "infinite",
  "negative",
  "missing",
  "bad_boolean",
  "null_tolerance",
] as const)(
  "rejects malformed valuation retry evidence before it reaches the ledger: %s",
  (mode) => {
    const diagnostic = arithmeticDiagnostic();
    const retry = diagnostic.valuationRetry!;
    const malformed = {
      ...diagnostic,
      valuationRetry:
        mode === "null"
          ? null
          : {
              ...retry,
              ...(mode === "raw" ? { body: "PRIVATE_BODY" } : {}),
              ...(mode === "infinite" ? { firstGrossDrift: Number.POSITIVE_INFINITY } : {}),
              ...(mode === "negative" ? { retryGrossDrift: -1 } : {}),
              ...(mode === "missing" ? { retryGrossDrift: undefined } : {}),
              ...(mode === "bad_boolean" ? { cashStable: "true" } : {}),
              ...(mode === "null_tolerance" ? { firstCoherentTolerance: null } : {}),
            },
    };
    expect(
      () =>
        new FinanceExecutionSafetyFactsError("account_snapshot_unavailable", {
          reason: "alpaca_safety_facts_inconsistent",
          stage: "account_arithmetic",
          accountArithmetic: malformed as never,
        }),
    ).toThrow("invalid finance execution safety failure classification");
  },
);

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

  it("reads a set of outcomes from one historical cutoff", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-outcomes-"));
    temporary.push(directory);
    for (const signalId of ["intraday-one", "intraday-two"]) {
      await appendFinanceIntradayDecision(directory, { ...input, signalId });
      await appendFinanceIntradayOutcome(directory, {
        signalId,
        status: "refused",
        reasons: ["risk_gate_blocked"],
      });
    }
    const outcomes = await readFinanceIntradayOutcomes(directory, [
      "intraday-one",
      "intraday-two",
      "intraday-one",
    ]);
    expect([...outcomes.keys()].toSorted()).toEqual(["intraday-one", "intraday-two"]);
    expect(outcomes.get("intraday-one")).toMatchObject({
      status: "refused",
      reasons: ["risk_gate_blocked"],
    });
    expect(
      await readFinanceIntradayOutcomes(directory, ["intraday-one"], {
        asOf: "2000-01-01T00:00:00.000Z",
      }),
    ).toEqual(new Map());
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
        ...(signalId === "refusal"
          ? {
              executionSafetyFailure: {
                stage: "facts",
                category: "cash_changed",
                operation: "read_account_safety_facts",
              } as const,
            }
          : {}),
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
    topExecutionSafetyFailures: [{ stage: "facts", category: "cash_changed", count: 1 }],
  });
  // SQLite may create WAL reader sidecars; no new logical ledger is created.
  expect(
    (await fs.readdir(directory))
      .filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm"))
      .toSorted(),
  ).toEqual(before.filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm")));
});

it("requires complete new diagnostics while reading legacy diagnostic records", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-safety-diagnostic-"));
  temporary.push(directory);
  await appendFinanceIntradayDecision(directory, input);
  const result = await appendFinanceIntradayOutcome(directory, {
    signalId: input.signalId,
    status: "refused",
    reasons: ["execution_safety_facts_inconsistent:account_arithmetic"],
    executionSafetyFailure: {
      stage: "facts",
      category: "account_snapshot_unavailable",
      operation: "read_account_safety_facts",
      provider: {
        reason: "alpaca_safety_facts_inconsistent",
        stage: "account_arithmetic",
      },
      attempt: {
        phase: "execute",
        disposition: "definite_rejection",
        venueResponse: { httpStatus: 422, brokerCode: 40310000 },
      },
    },
  });
  expect(result.input.executionSafetyFailure).toEqual({
    stage: "facts",
    category: "account_snapshot_unavailable",
    operation: "read_account_safety_facts",
    provider: { reason: "alpaca_safety_facts_inconsistent", stage: "account_arithmetic" },
    attempt: {
      phase: "execute",
      disposition: "definite_rejection",
      venueResponse: { httpStatus: 422, brokerCode: 40310000 },
    },
  });
  expect(await readFinanceIntradayExecutionCoverage(directory)).toMatchObject({
    topExecutionSafetyFailures: [
      {
        stage: "facts",
        category: "account_snapshot_unavailable",
        operation: "read_account_safety_facts",
        provider: { reason: "alpaca_safety_facts_inconsistent", stage: "account_arithmetic" },
        count: 1,
      },
    ],
  });
  await expect(
    appendFinanceIntradayOutcome(directory, {
      signalId: "incomplete-diagnostic",
      status: "refused",
      reasons: ["incomplete diagnostic"],
      executionSafetyFailure: { stage: "facts", category: "cash_changed" } as never,
    }),
  ).rejects.toThrow();
  await expect(
    appendFinanceIntradayOutcome(directory, {
      signalId: "invalid-diagnostic",
      status: "refused",
      reasons: ["bad diagnostic"],
      executionSafetyFailure: {
        stage: "facts",
        category: "raw secret",
        operation: "raw secret",
      } as never,
    }),
  ).rejects.toThrow();

  const legacyDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-safety-legacy-"));
  temporary.push(legacyDirectory);
  await appendFinanceIntradayDecision(legacyDirectory, input);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(financeIntradayControlLedgerPath(legacyDirectory));
  try {
    db.prepare(
      "INSERT INTO finance_intraday_outcomes(signal_id,recorded_at,body) VALUES (?,?,?)",
    ).run(
      input.signalId,
      new Date().toISOString(),
      JSON.stringify({
        signalId: input.signalId,
        status: "refused",
        reasons: ["legacy refusal"],
        executionSafetyFailure: { stage: "facts", category: "cash_changed" },
      }),
    );
  } finally {
    db.close();
  }
  expect(await readFinanceIntradayOutcome(legacyDirectory, input.signalId)).toMatchObject({
    status: "refused",
    executionSafetyFailure: { stage: "facts", category: "cash_changed" },
  });
  expect(await readFinanceIntradayExecutionCoverage(legacyDirectory)).toMatchObject({
    status: "present",
    refused: 1,
    topExecutionSafetyFailures: [{ stage: "facts", category: "cash_changed", count: 1 }],
  });
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

it("accepts safe optional preparation diagnostics and rejects arbitrary provider content", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-failure-diagnostic-"));
  temporary.push(directory);
  const outcome = {
    signalId: "safe-diagnostic",
    status: "refused" as const,
    reasons: ["intraday_execution_unexpected_error"],
    executionFailure: {
      stage: "account_book" as const,
      category: "deadline_exceeded" as const,
      elapsedMs: 120_001,
    },
  };
  await appendFinanceIntradayOutcome(directory, outcome);
  expect(await readFinanceIntradayOutcome(directory, outcome.signalId)).toEqual(outcome);
  const timed = {
    ...outcome,
    signalId: "timed-diagnostic",
    executionFailure: { ...outcome.executionFailure, stageElapsedMs: 20_000 },
  };
  await appendFinanceIntradayOutcome(directory, timed);
  expect(await readFinanceIntradayOutcome(directory, timed.signalId)).toEqual(timed);
  for (const stageElapsedMs of [-1, 0.5, 120_002]) {
    await expect(
      appendFinanceIntradayOutcome(directory, {
        ...timed,
        signalId: `invalid-timing-${stageElapsedMs}`,
        executionFailure: { ...timed.executionFailure, stageElapsedMs },
      }),
    ).rejects.toThrow();
  }
  await expect(
    appendFinanceIntradayOutcome(directory, {
      ...outcome,
      signalId: "unsafe-diagnostic",
      executionFailure: { ...outcome.executionFailure, message: "private provider content" },
    } as never),
  ).rejects.toThrow();
  await expect(
    appendFinanceIntradayOutcome(directory, {
      ...outcome,
      signalId: "unknown-phase",
      executionFailure: { ...outcome.executionFailure, stage: "provider-url" },
    } as never),
  ).rejects.toThrow();
});

it("round-trips strict quote diagnostics and preserves terminal idempotency", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quote-diagnostic-ledger-"));
  temporary.push(directory);
  const outcome = {
    signalId: "quote-get-failure",
    status: "refused" as const,
    reasons: ["intraday_execution_unexpected_error"],
    executionFailure: {
      stage: "initial_quote" as const,
      category: "unexpected" as const,
      elapsedMs: 44750,
      quote: {
        reason: "alpaca_safety_snapshot_read_unavailable" as const,
        stage: "quote_snapshot" as const,
        httpStatus: 429,
      },
    },
  };
  expect((await appendFinanceIntradayOutcome(directory, outcome)).appended).toBe(true);
  expect(await readFinanceIntradayOutcome(directory, outcome.signalId)).toEqual(outcome);
  expect((await appendFinanceIntradayOutcome(directory, outcome)).appended).toBe(false);
  await expect(
    appendFinanceIntradayOutcome(directory, {
      ...outcome,
      executionFailure: {
        ...outcome.executionFailure,
        quote: { ...outcome.executionFailure.quote, httpStatus: 503 },
      },
    }),
  ).rejects.toThrow();
});

it.each([
  "raw",
  "status0",
  "status600",
  "fraction",
  "nan",
  "reason",
  "stage",
  "account",
  "dispatch",
  "cancelled",
] as const)("rejects unsafe or non-quote diagnostic fields (%s)", async (mode) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quote-invalid-ledger-"));
  temporary.push(directory);
  const quote = {
    reason: "alpaca_safety_snapshot_read_unavailable",
    stage: "quote_snapshot",
    httpStatus: 429,
    ...(mode === "raw" ? { message: "PRIVATE_BODY" } : {}),
    ...(mode === "status0"
      ? { httpStatus: 0 }
      : mode === "status600"
        ? { httpStatus: 600 }
        : mode === "fraction"
          ? { httpStatus: 429.1 }
          : mode === "nan"
            ? { httpStatus: Number.NaN }
            : {}),
    ...(mode === "reason" ? { reason: "PRIVATE_BODY" } : {}),
    ...(mode === "stage" ? { stage: "account_snapshot" } : {}),
  };
  await expect(
    appendFinanceIntradayOutcome(directory, {
      signalId: mode,
      status: "refused",
      reasons: ["intraday_execution_unexpected_error"],
      executionFailure: {
        stage:
          mode === "account"
            ? "account_book"
            : mode === "dispatch"
              ? "order_dispatch"
              : "initial_quote",
        category: mode === "cancelled" ? "cancelled" : "unexpected",
        elapsedMs: 1,
        quote,
      },
    } as never),
  ).rejects.toThrow();
});

it.each([
  "quote_freshness",
  "quote_payload_invalid",
  "quote_bid_invalid",
  "quote_ask_invalid",
  "quote_timestamp_missing",
  "quote_bid_non_positive",
  "quote_ask_below_bid",
  "quote_timestamp_invalid",
  "quote_timestamp_future",
  "quote_age_exceeded",
  "quote_read_duration_exceeded",
] as const)(
  "retains legacy and precise quote classifications through the original durable ledger: %s",
  async (stage) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-quote-cause-"));
    temporary.push(directory);
    const reason =
      stage === "quote_age_exceeded" || stage === "quote_read_duration_exceeded"
        ? "alpaca_safety_quote_expired"
        : "alpaca_safety_facts_inconsistent";
    const quoteError = new AlpacaSafetyQuoteReadError(reason, { stage });
    expect(quoteError.diagnostic?.stage).toBe(stage);
    const factsError = new FinanceExecutionSafetyFactsError("account_snapshot_unavailable", {
      reason,
      stage,
    });
    await appendFinanceIntradayDecision(directory, input);
    await appendFinanceIntradayOutcome(directory, {
      signalId: input.signalId,
      status: "refused",
      reasons: [factsError.message],
      executionSafetyFailure: {
        stage: "facts",
        category: factsError.category,
        operation: "read_account_safety_facts",
        provider: factsError.provider,
      },
    });
    const recalled = await readFinanceIntradayOutcome(directory, input.signalId);
    expect(recalled?.executionSafetyFailure?.provider).toEqual({ reason, stage });
    expect(recalled?.status).toBe("refused");
  },
);
