import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { AlpacaSafetyQuoteReadError } from "./finance-alpaca-safety-provider.js";
import type { AlpacaSafetyAccountArithmeticDiagnostic } from "./finance-alpaca-safety-provider.js";
import * as fingerprints from "./finance-caseflow.js";
import { FinanceExecutionSafetyFactsError } from "./finance-execution-safety.js";
import {
  appendFinanceIntradayDecision,
  appendFinanceIntradayOutcome,
  readFinanceIntradayExecutionCoverage,
  readFinanceIntradayAccountHistory,
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

it("reads back original protected reduction phase observations from the intraday outcome ledger", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-protection-diagnostic-"));
  temporary.push(directory);
  await appendFinanceIntradayDecision(directory, input);
  const diagnostic = {
    stage: "restore_protection" as const,
    cancellationConfirmed: true,
    sellExecutionEntered: true,
    filledQuantity: 1,
    protectionRestored: false,
  };
  await appendFinanceIntradayOutcome(directory, {
    signalId: input.signalId,
    status: "uncertain",
    reasons: ["execution_outcome_unresolved"],
    executionSafetyFailure: {
      stage: "execution",
      category: "unexpected",
      operation: "execute_order",
      attempt: {
        phase: "execute",
        disposition: "outcome_unresolved",
        protectedReduction: diagnostic,
      },
    },
  });
  expect(
    (await readFinanceIntradayOutcome(directory, input.signalId))?.executionSafetyFailure?.attempt
      ?.protectedReduction,
  ).toEqual(diagnostic);
});

it("persists exact future-quote timing without accepting contradictory arithmetic", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quote-timing-ledger-"));
  try {
    const quoteTiming = { quoteAtMs: 1791910000100, checkedAtMs: 1791910000000, aheadMs: 100 };
    const input = {
      signalId: "quote-timing",
      status: "refused" as const,
      reasons: ["quote_timestamp_future"],
      executionFailure: {
        stage: "initial_quote" as const,
        category: "unexpected" as const,
        elapsedMs: 1000,
        quote: {
          reason: "alpaca_safety_facts_inconsistent" as const,
          stage: "quote_timestamp_future" as const,
          quoteTiming,
        },
      },
    };
    await appendFinanceIntradayOutcome(directory, input);
    expect(
      (await readFinanceIntradayOutcome(directory, input.signalId))?.executionFailure?.quote
        ?.quoteTiming,
    ).toEqual(quoteTiming);
    await expect(
      appendFinanceIntradayOutcome(directory, {
        ...input,
        signalId: "bad-timing",
        executionFailure: {
          ...input.executionFailure,
          quote: { ...input.executionFailure.quote, quoteTiming: { ...quoteTiming, aheadMs: 0 } },
        },
      }),
    ).rejects.toThrow();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("does not rehash the verified decision prefix for each resident append or scoped read", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-incremental-"));
  temporary.push(directory);
  for (let i = 0; i < 120; i++) {
    await appendFinanceIntradayDecision(directory, { ...input, signalId: `prefix-${i}` });
  }
  const hash = vi.spyOn(fingerprints, "caseflowFingerprint");
  try {
    await appendFinanceIntradayDecision(directory, {
      ...input,
      signalId: "selected",
      instrument: "QQQ",
    });
    await appendFinanceIntradayOutcome(directory, {
      signalId: "selected",
      status: "refused",
      reasons: ["fixture"],
    });
    const selected = await readFinanceIntradayDecisions(directory, { instrument: "QQQ" });
    expect(selected.map((r) => r.input.signalId)).toEqual(["selected"]);
    expect(hash.mock.calls.length).toBeLessThan(10);
  } finally {
    hash.mockRestore();
  }
});

it.each(["body", "chain", "index"] as const)(
  "invalidates the resident proof on external %s corruption even outside the selected scope",
  async (mode) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-external-"));
    temporary.push(directory);
    await appendFinanceIntradayDecision(directory, input);
    await appendFinanceIntradayDecision(directory, {
      ...input,
      signalId: "other",
      instrument: "QQQ",
    });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(financeIntradayControlLedgerPath(directory));
    try {
      db.exec("DROP TRIGGER finance_intraday_decisions_no_update");
      if (mode === "index") {
        db.prepare(
          "UPDATE finance_intraday_decisions SET signal_id='wrong' WHERE sequence=1",
        ).run();
      } else {
        const row = db
          .prepare("SELECT body FROM finance_intraday_decisions WHERE sequence=1")
          .get();
        const body = JSON.parse(String(row?.body));
        if (mode === "body") {
          body.input.reason = "tampered";
          db.prepare("UPDATE finance_intraday_decisions SET body=? WHERE sequence=1").run(
            JSON.stringify(body),
          );
        } else {
          body.previousRef = "f".repeat(64);
          db.prepare("UPDATE finance_intraday_decisions SET body=?,ref=? WHERE sequence=1").run(
            JSON.stringify(body),
            fingerprints.caseflowFingerprint(body),
          );
        }
      }
    } finally {
      db.close();
    }
    await expect(readFinanceIntradayDecisions(directory, { instrument: "QQQ" })).rejects.toThrow(
      /intraday decision/,
    );
    await expect(
      appendFinanceIntradayDecision(directory, { ...input, signalId: "must-not-append" }),
    ).rejects.toThrow(/intraday decision/);
  },
);

it("revalidates a second writer and chains the next resident append to its committed decision", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-second-writer-"));
  temporary.push(directory);
  const first = await appendFinanceIntradayDecision(directory, input);
  const second = {
    schemaVersion: "lcx_finance_intraday_decision_v1",
    sequence: 2,
    previousRef: first.record.ref,
    recordedAt: new Date().toISOString(),
    input: { ...input, signalId: "external", instrument: "QQQ" },
  };
  const secondRef = fingerprints.caseflowFingerprint(second);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(financeIntradayControlLedgerPath(directory));
  try {
    db.prepare(
      "INSERT INTO finance_intraday_decisions(ref,signal_id,sequence,body) VALUES (?,?,?,?)",
    ).run(secondRef, "external", 2, JSON.stringify(second));
  } finally {
    db.close();
  }
  const third = await appendFinanceIntradayDecision(directory, { ...input, signalId: "third" });
  expect(third.record.sequence).toBe(3);
  expect(third.record.previousRef).toBe(secondRef);
  const selected = await readFinanceIntradayDecisions(directory, { instrument: "QQQ" });
  expect(selected.map((r) => r.ref)).toEqual([secondRef]);
  expect((await appendFinanceIntradayDecision(directory, second.input)).appended).toBe(false);
});

it("reopens an evicted ledger with a full proof and does not retain caller-mutated records", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-reopen-"));
  temporary.push(directory);
  const first = await appendFinanceIntradayDecision(directory, input);
  first.record.input.instrument = "MUTATED";
  for (let i = 0; i < 9; i++) {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-evict-"));
    temporary.push(other);
    await appendFinanceIntradayDecision(other, input);
  }
  const hash = vi.spyOn(fingerprints, "caseflowFingerprint");
  try {
    const rows = await readFinanceIntradayDecisions(directory);
    expect(rows[0].input.instrument).toBe("SPY");
    expect(hash.mock.calls.length).toBeGreaterThanOrEqual(2);
  } finally {
    hash.mockRestore();
  }
});

it("uses the migrated scope index and preserves schema-normalized legacy instruments", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-scope-index-"));
  temporary.push(directory);
  const first = await appendFinanceIntradayDecision(directory, input);
  const { ref: _ref, ...record } = first.record;
  const legacy = { ...record, input: { ...record.input, instrument: " SPY " } };
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(financeIntradayControlLedgerPath(directory));
  try {
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT ref,body FROM finance_intraday_decisions WHERE trim(json_extract(body,'$.input.instrument'))=? ORDER BY sequence",
      )
      .all("SPY");
    expect(JSON.stringify(plan)).toContain("USING INDEX finance_intraday_decisions_instrument");
    db.exec("DROP TRIGGER finance_intraday_decisions_no_update");
    db.prepare("UPDATE finance_intraday_decisions SET body=?,ref=? WHERE sequence=1").run(
      JSON.stringify(legacy),
      fingerprints.caseflowFingerprint(legacy),
    );
  } finally {
    db.close();
  }
  const rows = await readFinanceIntradayDecisions(directory, { instrument: "SPY" });
  expect(rows).toHaveLength(1);
  expect(rows[0].input.instrument).toBe("SPY");
});

it("persists the original account request failure without accepting provider secrets", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "account-request-diagnostic-"));
  temporary.push(directory);
  const outcome = {
    signalId: "account-request-failure",
    status: "refused" as const,
    reasons: ["intraday_execution_unexpected_error"],
    executionFailure: {
      stage: "account_book" as const,
      category: "unexpected" as const,
      elapsedMs: 4000,
      account: {
        stage: "broker_reconciliation" as const,
        code: "ECONNRESET",
        elapsedMs: 3900,
        request: {
          endpoint: "positions" as const,
          phase: "request" as const,
          code: "ECONNRESET",
          elapsedMs: 3000,
        },
      },
    },
  };
  await appendFinanceIntradayOutcome(directory, outcome);
  expect(await readFinanceIntradayOutcome(directory, outcome.signalId)).toEqual(outcome);
  for (const request of [
    { ...outcome.executionFailure.account.request, url: "private-provider-content" },
    { ...outcome.executionFailure.account.request, code: "private-provider-content" },
  ]) {
    await expect(
      appendFinanceIntradayOutcome(directory, {
        ...outcome,
        signalId: "unsafe-request",
        executionFailure: {
          ...outcome.executionFailure,
          account: { ...outcome.executionFailure.account, request },
        },
      } as never),
    ).rejects.toThrow();
  }
});

it("recovers bounded account outcomes across sessions without attributing anonymous or foreign failures", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-account-history-"));
  temporary.push(directory);
  vi.useFakeTimers();
  const start = Date.parse("2026-09-18T18:00:00.000Z");
  for (let index = 0; index < 30; index++) {
    vi.setSystemTime(start + index * 1000);
    const signalId = `history-${index}`;
    await appendFinanceIntradayDecision(directory, {
      ...input,
      signalId,
      instrument: index === 0 ? "IWM" : "SPY",
    });
    await appendFinanceIntradayOutcome(directory, {
      signalId,
      status: index === 0 ? "uncertain" : "refused",
      reasons:
        index === 10 ? ["\u0001".repeat(240), "\u0002".repeat(240)] : ["account_read_failed"],
      ...(index === 28
        ? {}
        : {
            executionScope: {
              accountId: index === 29 ? "foreign" : "selected",
              venue: "alpaca:paper" as const,
            },
          }),
    });
  }
  const asOf = "2026-09-21T13:00:00.000Z";
  const history = await readFinanceIntradayAccountHistory(directory, {
    accountId: "selected",
    asOf,
  });
  expect(history).toMatchObject({
    status: "observed",
    scannedOutcomes: 24,
    earlierHistoryMayBeOmitted: true,
    omittedEntries: 16,
  });
  expect(history.entries).toHaveLength(8);
  expect(history.entries[0]).toMatchObject({
    signalId: "history-27",
    status: "refused",
    reviewStatus: "not_observed",
    decision: "unknown",
    reasons: ["account_read_failed"],
    decisionRef: expect.stringMatching(/^[a-f0-9]{64}$/u),
    outcomeRef: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  // A bounded recent snapshot must still permit recovery of an older original.
  const recovered = new Set(history.entries.map((entry) => entry.signalId));
  let cursor = "nextCursor" in history ? history.nextCursor : null;
  let pageCount = 0;
  while (typeof cursor === "string") {
    expect(pageCount++).toBeLessThan(20);
    const page = await readFinanceIntradayAccountHistory(directory, {
      accountId: "selected",
      asOf,
      cursor,
      maximumEntries: 2,
    });
    expect(page.status).toBe("observed");
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(4_000);
    if (page.entries.some((entry) => entry.signalId === "history-10")) {
      expect(page.entries.find((entry) => entry.signalId === "history-10")?.detailGap).toContain(
        "oversize_entry_details_omitted",
      );
    }
    expect(page.entries.length).toBeLessThanOrEqual(8);
    page.entries.forEach((entry) => recovered.add(entry.signalId));
    cursor = "nextCursor" in page ? page.nextCursor : null;
  }
  expect(recovered.size).toBe(28);
  expect(recovered.has("history-0")).toBe(true);
  const initialCursor = "nextCursor" in history ? history.nextCursor : undefined;
  if (typeof initialCursor !== "string") {
    throw new Error("missing historical continuation");
  }
  expect(
    await readFinanceIntradayAccountHistory(directory, {
      accountId: "foreign",
      asOf,
      cursor: initialCursor,
    }),
  ).toMatchObject({ status: "unavailable" });
  expect(
    await readFinanceIntradayAccountHistory(directory, {
      accountId: "selected",
      asOf: "2026-09-20T13:00:00.000Z",
      cursor: initialCursor,
    }),
  ).toMatchObject({ status: "unavailable" });
  vi.setSystemTime(new Date("2026-09-21T14:00:00.000Z"));
  await appendFinanceIntradayDecision(directory, {
    ...input,
    signalId: "new-after-history-cutoff",
  });
  await appendFinanceIntradayOutcome(directory, {
    signalId: "new-after-history-cutoff",
    status: "refused",
    reasons: ["new observation"],
    executionScope: { accountId: "selected", venue: "alpaca:paper" },
  });
  const resumed = await readFinanceIntradayAccountHistory(directory, {
    accountId: "selected",
    asOf: "2026-09-22T13:00:00.000Z",
    cursor: initialCursor,
  });
  expect(resumed.status).toBe("observed");
  expect(resumed).toMatchObject({ historyAsOf: asOf, latestOutcomeRefreshed: true });
  expect(resumed.entries[0].signalId).toBe("new-after-history-cutoff");
  expect(resumed.entries.some((entry) => entry.signalId === "history-26")).toBe(true);
  const exact = await readFinanceIntradayAccountHistory(directory, {
    accountId: "selected",
    asOf,
    signalIds: ["history-0", "history-29"],
  });
  expect(exact.entries.map((entry) => entry.signalId)).toEqual(["history-0"]);
  expect(exact).toMatchObject({ missingSignalIndexes: [1], nextCursor: null });
  // Reopen the same original book after a weekend; no in-memory feedback cache is needed.
  expect(
    await readFinanceIntradayAccountHistory(directory, { accountId: "selected", asOf }),
  ).toEqual(history);
  const earlier = await readFinanceIntradayAccountHistory(directory, {
    accountId: "selected",
    asOf: "2026-09-18T18:00:02.000Z",
  });
  expect(earlier.entries.map((entry) => entry.signalId)).toEqual(["history-1", "history-0"]);
  expect(earlier.entries.find((entry) => entry.status === "uncertain")?.status).toBe("uncertain");
  expect(history.scopeLimitation).toContain("without_native_account_identity");
});

it("retains terminal history and drains multiple fresh outcomes across natural cutoffs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-two-stream-history-"));
  temporary.push(directory);
  vi.useFakeTimers();
  try {
    const append = async (signalId: string, at: string) => {
      vi.setSystemTime(new Date(at));
      await appendFinanceIntradayDecision(directory, { ...input, signalId });
      await appendFinanceIntradayOutcome(directory, {
        signalId,
        status: "refused",
        reasons: ["original scoped outcome"],
        executionScope: { accountId: "account", venue: "alpaca:paper" },
      });
    };
    for (let index = 0; index < 18; index++) {
      await append(
        `old-${index}`,
        new Date(Date.parse("2026-09-18T18:00:00Z") + index * 1000).toISOString(),
      );
    }
    const cutoff = "2026-09-18T19:00:00.000Z";
    const initial = await readFinanceIntradayAccountHistory(directory, {
      accountId: "account",
      asOf: cutoff,
    });
    if (!("resumeCursor" in initial) || !initial.resumeCursor) {
      throw new Error("missing initial resume");
    }
    let cursor = initial.resumeCursor;
    expect(cursor.length).toBeLessThanOrEqual(512);
    const token = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      scope: string;
      at: string;
      sequence: number;
    };
    const legacy = Buffer.from(
      JSON.stringify({ scope: token.scope, at: token.at, sequence: token.sequence }),
    ).toString("base64url");
    expect(
      await readFinanceIntradayAccountHistory(directory, {
        accountId: "account",
        asOf: cutoff,
        cursor: legacy,
      }),
    ).toMatchObject({ status: "observed" });
    const recoveredOld = new Set(initial.entries.map((entry) => entry.signalId));
    // Same-time outcomes exercise the sequence tie-breaker of the ascending fresh watermark.
    for (let index = 0; index < 11; index++) {
      await append(`fresh-${index}`, cutoff);
    }
    const recoveredFresh = new Set<string>();
    let terminal: Awaited<ReturnType<typeof readFinanceIntradayAccountHistory>> = initial;
    for (let round = 0; round < 6; round++) {
      const page = await readFinanceIntradayAccountHistory(directory, {
        accountId: "account",
        asOf: new Date(Date.parse(cutoff) + (round + 1) * 60_000).toISOString(),
        cursor,
      });
      expect(page.status).toBe("observed");
      expect(page.entries.length).toBeLessThanOrEqual(8);
      expect("scannedOutcomes" in page ? page.scannedOutcomes : Infinity).toBeLessThanOrEqual(24);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(12_000);
      for (const entry of page.entries) {
        (entry.signalId.startsWith("old-") ? recoveredOld : recoveredFresh).add(entry.signalId);
      }
      if (!("resumeCursor" in page) || !page.resumeCursor) {
        throw new Error("missing resume cursor");
      }
      cursor = page.resumeCursor;
      terminal = page;
      if ("nextCursor" in page && page.nextCursor === null) {
        break;
      }
    }
    expect(recoveredOld.size).toBe(18);
    expect(recoveredFresh.size).toBe(11);
    expect(terminal).toMatchObject({ historicalWindowComplete: true, nextCursor: null });
    const quiet = await readFinanceIntradayAccountHistory(directory, {
      accountId: "account",
      asOf: "2026-09-19T19:00:00.000Z",
      cursor,
    });
    expect(quiet).toMatchObject({ status: "observed", entries: [], nextCursor: null });
    await append("fresh-after-terminal", "2026-09-19T19:01:00.000Z");
    const renewed = await readFinanceIntradayAccountHistory(directory, {
      accountId: "account",
      asOf: "2026-09-19T19:02:00.000Z",
      cursor,
    });
    expect(renewed.status).toBe("observed");
    expect(renewed.entries.map((entry) => entry.signalId)).toEqual(["fresh-after-terminal"]);
  } finally {
    vi.useRealTimers();
  }
});
