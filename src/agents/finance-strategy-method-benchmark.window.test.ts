import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { __test as allMethods } from "../../scripts/operator/finance-strategy-all-methods.ts";
import { __test, runBenchmark } from "../../scripts/operator/finance-strategy-method-benchmark.ts";
import * as collection from "./finance-market-collection-registry.js";

describe("benchmark evaluation window after warmup", () => {
  const dates: string[] = [];
  const cursor = new Date("2024-01-01T00:00:00.000Z");
  while (dates.length < 330) {
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const evaluationDates = dates.slice(300);
  let receipt: Awaited<ReturnType<typeof runBenchmark>>;
  beforeAll(async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline fixture only"));
    vi.spyOn(collection, "runFinanceMarketCollectionRefresh").mockImplementation(
      async ({ request }) => ({
        schemaVersion: collection.FINANCE_MARKET_COLLECTION_SCHEMA_VERSION,
        refreshId: `fixture:${request.instrument}:${request.fromDate}`,
        boundary: "finance_market_collection_research_only",
        request,
        status: "ready",
        records: dates
          .filter((date) => date >= request.fromDate! && date <= request.toDate!)
          .map((date) => ({
            itemId: `${request.instrument}:${date}`,
            collection: "eod_history",
            providerName: "offline-fixture",
            providerRole: "primary_market_data",
            sourceFamily: "market_data_api",
            sourceTimestamp: `${date}T21:00:00.000Z`,
            observedAt: request.asOf,
            delayStatus: "delayed",
            sourceUrlOrArtifact: "fixture:flat-close",
            data: { date, close: 100 },
          })),
        sourceAttempts: [],
        selectedSourceIds: ["offline-fixture"],
        missingEvidence: [],
        requiredNextSteps: [],
        adaptersCalled: true,
        notTouched: ["network", "models", "trading"],
      }),
    );
    receipt = await runBenchmark([
      "--symbols",
      "SPY,QQQ,IWM",
      "--lookback",
      "20",
      "--cost-bps",
      "15",
      "--from-date",
      evaluationDates[0],
      "--to-date",
      evaluationDates.at(-1)!,
      "--as-of",
      `${evaluationDates.at(-1)}T23:59:00.000Z`,
      "--stress",
    ]);
  });
  afterAll(() => vi.restoreAllMocks());

  it("binds native benchmark receipts to the evaluated instruments and window", () => {
    expect(allMethods.localBenchmarkSourcesReady(receipt.data)).toBe(true);
    const changes = [
      (data: typeof receipt.data) => {
        data.sourceReceipts[0].symbol = "WRONG";
      },
      (data: typeof receipt.data) => {
        data.sourceReceipts.pop();
      },
      (data: typeof receipt.data) => {
        data.sourceReceipts[0].chunks = [];
      },
      (data: typeof receipt.data) => {
        data.sourceReceipts[0].lastSourceTimestamp = "2020-01-01T00:00:00Z";
      },
      (data: typeof receipt.data) => {
        data.sourceReceipts[0].chunks[0].toDate = "2020-01-01";
      },
    ];
    changes.push(
      (data) => {
        for (const chunk of data.sourceReceipts[0].chunks) {
          chunk.recordCount = 0;
        }
      },
      (data) => {
        for (const chunk of data.sourceReceipts[0].chunks) {
          chunk.recordCount = 1;
        }
      },
      (data) => {
        data.sourceReceipts[1].symbol = data.sourceReceipts[0].symbol;
      },
      (data) => {
        data.sourceReceipts[0].lastSourceTimestamp = "2099-01-01T00:00:00Z";
      },
      (data) => {
        const chunk = data.sourceReceipts[0].chunks[0];
        data.sourceReceipts[0].chunks = [
          { ...chunk, fromDate: data.fromDate, toDate: data.fromDate },
          { ...chunk, fromDate: data.toDate, toDate: data.toDate },
        ];
      },
    );
    const reversed = structuredClone(receipt.data);
    for (const source of reversed.sourceReceipts) {
      source.chunks.reverse();
    }
    expect(allMethods.localBenchmarkSourcesReady(reversed)).toBe(true);
    for (const change of changes) {
      const data = structuredClone(receipt.data);
      change(data);
      expect(allMethods.localBenchmarkSourcesReady(data)).toBe(false);
    }
  });

  it("charges both entry and liquidation after warmup even when prices are flat", () => {
    const cost = 15 / 10_000;
    const expectedReturn = (1 - cost) ** 2 - 1;
    expect(receipt.portfolio.buy_hold.metric.totalReturn).toBeCloseTo(expectedReturn, 12);
    expect(receipt.portfolio.buy_hold.metric.turnover).toBe(2);
    for (const comparison of Object.values(receipt.comparisons)) {
      expect(comparison.baseline?.totalReturn).toBeCloseTo(expectedReturn, 12);
      expect(comparison.baseline?.turnover).toBe(2);
    }
  });

  it("labels and partitions stress results using only the evaluated dates", () => {
    const stress = receipt.stressMatrix!;
    expect(stress.variants).toHaveLength(48);
    const expectedWindows = [0, 10, 20].map(
      (start) => `${evaluationDates[start]}..${evaluationDates[start + 9]}`,
    );
    for (const variant of stress.variants) {
      expect(variant.baseline.observations).toBe(evaluationDates.length - 1);
      for (const periods of [variant.baselinePeriods, variant.enrichedPeriods]) {
        expect(periods.map((period) => period.window)).toEqual(expectedWindows);
        expect(periods.map((period) => period.metric.observations)).toEqual([9, 9, 9]);
      }
      expect(variant.baseline.totalReturn).toBeCloseTo((1 - variant.costBps / 10_000) ** 2 - 1, 12);
    }
  });

  it("uses warmup signals while opening a fresh funded position for either method", () => {
    const rows = dates.map((date, index) => ({
      date,
      close: 100 + index,
      sourceTimestamp: `${date}T21:00:00.000Z`,
    }));
    const rowsBySymbol = { SPY: rows, QQQ: rows, IWM: rows };
    const cost = 0.005;
    const expected = (401 / 400 - cost) * (428 / 401) * (429 / 428 - cost) - 1;
    for (const method of ["buy_hold", "trend_breadth_gate"] as const) {
      const evaluated = __test.evaluateSeries(
        "SPY",
        rowsBySymbol,
        dates,
        20,
        0.5,
        cost,
        method,
        300,
      );
      expect(evaluated.positions).toEqual([0, ...Array(29).fill(1)]);
      expect(evaluated.metric.totalReturn).toBeCloseTo(expected, 12);
      expect(evaluated.metric.turnover).toBe(2);
    }
  });

  it("does not charge an exit for a warmup position that was never funded", () => {
    const rows = dates.map((date, index) => ({
      date,
      close: index < 299 ? 100 + index : 10,
      sourceTimestamp: `${date}T21:00:00.000Z`,
    }));
    const evaluated = __test.evaluateSeries(
      "SPY",
      { SPY: rows, QQQ: rows, IWM: rows },
      dates,
      20,
      0.5,
      0.005,
      "trend_breadth_gate",
      300,
    );
    expect(evaluated.positions).toEqual(Array(30).fill(0));
    expect(evaluated.metric.totalReturn).toBe(0);
    expect(evaluated.metric.turnover).toBe(0);
  });
});
