import { describe, expect, it } from "vitest";
import type { FinanceMarketCollectionItem } from "./finance-market-collection-registry.js";
import { summarizeFinanceOptionsChain } from "./finance-options-evidence.js";
import type { FinanceResearchBatchEvidencePacket } from "./finance-research-batch-runner.js";
import {
  buildFinanceResearchModelEvidence,
  summarizeFinancePriceHistory,
  findUncitedFinanceInstruments,
  rankFinanceWindowDrawdowns,
} from "./finance-research-evidence.js";
const row = (
  date: string,
  close: number,
  providerName = "primary",
): FinanceMarketCollectionItem => ({
  itemId: date,
  collection: "eod_history",
  providerName,
  providerRole: "primary_market_data",
  sourceFamily: "market_data_api",
  sourceTimestamp: `${date}T20:00:00Z`,
  observedAt: "2026-09-10T00:00:00Z",
  delayStatus: "end_of_day",
  sourceUrlOrArtifact: "fixture://prices",
  data: { date, close },
});
const optionRow = ({
  ticker,
  contractType,
  strike,
  expiration,
  impliedVolatility,
  bid,
  ask,
  openInterest,
  sourceTimestamp = "2026-09-09T20:00:00Z",
}: {
  ticker: string;
  contractType: "call" | "put";
  strike: number;
  expiration: string;
  impliedVolatility: number;
  bid: number;
  ask: number;
  openInterest: number;
  sourceTimestamp?: string;
}): FinanceMarketCollectionItem => ({
  itemId: ticker,
  collection: "options_chain",
  providerName: "massive-us-equity-options-chain",
  providerRole: "primary_market_data",
  sourceFamily: "market_data_api",
  sourceTimestamp,
  observedAt: sourceTimestamp,
  delayStatus: "delayed",
  sourceUrlOrArtifact: "https://api.massive.com/v3/snapshot/options/SPY",
  data: {
    details: {
      ticker,
      contract_type: contractType,
      strike_price: strike,
      expiration_date: expiration,
    },
    implied_volatility: impliedVolatility,
    last_quote: { bid, ask },
    open_interest: openInterest,
  },
});
describe("finance price arithmetic before model prompting", () => {
  it("ranks actual drawdown magnitude without putting every cryptocurrency ahead of stocks", () => {
    const common = { from: "2026-03-09", to: "2026-09-09" };
    const result = rankFinanceWindowDrawdowns([
      { ...common, instrument: "BTCUSDT", maxDrawdownPct: -28.689 },
      { ...common, instrument: "TSLA", maxDrawdownPct: -33.002 },
      { ...common, instrument: "ETHUSDT", maxDrawdownPct: -35.186 },
      { ...common, from: "2026-03-10", instrument: "SP500", maxDrawdownPct: -6.455 },
    ]);
    expect(result[0]?.ranked.map((entry) => entry.instrument)).toEqual([
      "ETHUSDT",
      "TSLA",
      "BTCUSDT",
    ]);
    expect(result[1]?.ranked.map((entry) => entry.instrument)).toEqual(["SP500"]);
  });
  it("rejects a real but unrelated evidence ID for an explicitly named instrument", () => {
    const evidence = [{ id: "finance-model:SPY" }, { id: "finance-model:ETHUSDT" }];
    const claims = [
      {
        id: "c1",
        text: "ETHUSDT +23.841%",
        status: "supported" as const,
        evidenceIds: ["finance-model:SPY"],
      },
    ];
    expect(findUncitedFinanceInstruments(evidence, claims)).toEqual(["c1:finance-model:ETHUSDT"]);
    expect(
      findUncitedFinanceInstruments(evidence, [
        { ...claims[0], evidenceIds: ["finance-model:ETHUSDT"] },
      ]),
    ).toEqual([]);
  });
  it("computes path drawdown and window return rather than counting rows", () => {
    const result = summarizeFinancePriceHistory(
      [
        row("2026-09-01", 100),
        row("2026-09-02", 120),
        row("2026-09-03", 90),
        row("2026-09-04", 110),
      ],
      "2026-09-10T00:00:00Z",
    );
    expect(result.summaries[0]).toMatchObject({
      priceReturnPct: 10,
      maxDrawdownPct: -25,
      currentDrawdownPct: -8.333,
    });
    expect(result.summaries[0]?.returnsByObservationPct[21]).toBeNull();
    expect(result.summaries[0]?.observationWindows[1]).toEqual({
      from: "2026-09-03",
      to: "2026-09-04",
    });
    expect(result.summaries[0]?.observationWindows[21]).toBeNull();
  });
  it("deduplicates same dates but rejects a conflicting source series", () => {
    const base = row("2026-09-01", 100);
    const result = summarizeFinancePriceHistory(
      [base, base, row("2026-09-01", 102)],
      "2026-09-10T00:00:00Z",
    );
    expect(result).toMatchObject({ duplicates: 2, conflicts: 1, usable: false });
  });
  it("does not combine different providers or feed definitions", () => {
    const result = summarizeFinancePriceHistory(
      [row("2026-09-01", 100), row("2026-09-02", 200, "iex")],
      "2026-09-10T00:00:00Z",
    );
    expect(result.summaries).toHaveLength(2);
    expect(result.summaries.every((s) => s.priceReturnPct === 0)).toBe(true);
  });
  it("excludes unfinished days, invalid calendar dates and nonpositive prices", () => {
    const result = summarizeFinancePriceHistory(
      [row("2026-09-10", 100), row("2026-02-30", 100), row("2026-09-02", 0), row("2026-09-03", 90)],
      "2026-09-10T22:00:00Z",
    );
    expect(result.invalid).toBe(3);
    expect(result.summaries[0]?.observations).toBe(1);
  });
  it("allows post-cutoff records only when live-now evidence is bounded", () => {
    const postCutoff = row("2026-09-08", 100);
    const historical = summarizeFinancePriceHistory([postCutoff], "2026-09-08T12:00:00Z");
    const liveNow = summarizeFinancePriceHistory([postCutoff], "2026-09-08T12:00:00Z", {
      asOfMode: "live_now",
      futureTimestampLimitMs: Date.parse("2026-09-08T20:05:00Z"),
    });

    expect(historical.summaries).toHaveLength(0);
    expect(liveNow.summaries).toHaveLength(1);
  });

  it("keeps Treasury provider-specific numeric fields in model evidence", () => {
    const packet = {
      schemaVersion: "lcx_finance_research_batch_v1",
      boundary: "finance_research_batch_research_only",
      decisionMode: "research_only",
      correlationId: "treasury-evidence",
      asOf: "2026-09-10T00:00:00Z",
      useCase: "test",
      status: "completed",
      committeeEvidence: [],
      budget: {},
      jobs: [
        {
          request: {
            instrument: "debt_to_penny",
            assetClass: "macro_series",
            collection: "macro_series",
            asOf: "2026-09-10T00:00:00Z",
          },
          status: "ready",
          receipt: {
            records: [
              {
                itemId: "debt-1",
                collection: "macro_series",
                providerName: "treasury-fiscal-debt-to-penny",
                providerRole: "official_or_issuer_reference",
                sourceFamily: "official_macro_data",
                sourceTimestamp: "2026-09-04T00:00:00Z",
                observedAt: "2026-09-04T00:00:00Z",
                delayStatus: "official_lagged",
                sourceUrlOrArtifact: "https://fiscaldata.treasury.gov",
                data: { record_date: "2026-09-04", tot_pub_debt_out_amt: "100" },
              },
            ],
          },
        },
      ],
    } as unknown as FinanceResearchBatchEvidencePacket;

    expect(buildFinanceResearchModelEvidence(packet).at(-1)?.text).toContain(
      "latest tot_pub_debt_out_amt=100",
    );
  });

  it("turns an options chain into source-bound Black-Scholes evidence in the model packet", () => {
    const packet = {
      schemaVersion: "lcx_finance_research_batch_v1",
      boundary: "finance_research_batch_research_only",
      decisionMode: "research_only",
      correlationId: "options-evidence",
      asOf: "2026-09-10T00:00:00Z",
      useCase: "test",
      status: "completed",
      committeeEvidence: [],
      budget: {},
      jobs: [
        {
          jobId: "spy-prices",
          request: {
            instrument: "SPY",
            assetClass: "us_equity",
            collection: "eod_history",
            asOf: "2026-09-10T00:00:00Z",
          },
          status: "ready",
          receipt: { records: [row("2026-09-09", 100)] },
        },
        {
          jobId: "spy-options",
          request: {
            instrument: "SPY",
            assetClass: "us_equity",
            collection: "options_chain",
            asOf: "2026-09-10T00:00:00Z",
          },
          status: "ready",
          receipt: {
            records: [
              optionRow({
                ticker: "O:SPY261009C00100000",
                contractType: "call",
                strike: 100,
                expiration: "2026-10-09",
                impliedVolatility: 0.2,
                bid: 9,
                ask: 11,
                openInterest: 100,
              }),
              optionRow({
                ticker: "O:SPY261009P00100000",
                contractType: "put",
                strike: 100,
                expiration: "2026-10-09",
                impliedVolatility: 0.25,
                bid: 8,
                ask: 10,
                openInterest: 80,
              }),
            ],
          },
        },
      ],
    } as unknown as FinanceResearchBatchEvidencePacket;

    const evidence = buildFinanceResearchModelEvidence(packet);
    const spy = evidence.find((item) => item.id === "finance-model:SPY");
    expect(spy?.text).toContain("Options chain (usable)");
    expect(spy?.text).toContain("delta=");
    expect(spy?.text).toContain("gamma=");
    expect(spy?.text).toContain("OI-weighted gamma=");
    expect(spy?.text).toContain("put/call OI ratio=0.8");
  });

  it("blocks an options summary when the quote is too wide or the contract is stale", () => {
    const summary = summarizeFinanceOptionsChain(
      [
        optionRow({
          ticker: "O:SPY261009C00100000",
          contractType: "call",
          strike: 100,
          expiration: "2026-10-09",
          impliedVolatility: 0.2,
          bid: 1,
          ask: 3,
          openInterest: 100,
        }),
        optionRow({
          ticker: "O:SPY260801C00100000",
          contractType: "call",
          strike: 100,
          expiration: "2026-08-01",
          impliedVolatility: 0.2,
          bid: 9,
          ask: 10,
          openInterest: 100,
          sourceTimestamp: "2026-09-09T20:00:00Z",
        }),
      ],
      {
        asOf: "2026-09-10T00:00:00Z",
        underlyingSpot: 100,
        underlyingSpotAt: "2026-09-09",
      },
    );
    expect(summary.status).toBe("insufficient");
    expect(summary.eligibleContracts).toBe(0);
    expect(summary.warnings.join(" ")).toContain("no contract passed liquidity gates");
  });
});
