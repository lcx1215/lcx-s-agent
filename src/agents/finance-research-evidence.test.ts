import { describe, expect, it } from "vitest";
import type { FinanceCommitteeEvidence } from "./finance-agent-committee.js";
import {
  annualisedVol,
  FINANCE_DAILY_VOLATILITY_LOOKBACK_CLOSES,
} from "./finance-daily-strategy.js";
import type { FinanceMarketCollectionItem } from "./finance-market-collection-registry.js";
import { summarizeFinanceOptionsChain } from "./finance-options-evidence.js";
import type { FinanceResearchBatchEvidencePacket } from "./finance-research-batch-runner.js";
import {
  buildFinanceHistoricalResearchFeedback,
  buildFinanceMonthlyTrendDerivedEvidence,
  buildFinanceResearchModelEvidence,
  summarizeFinancePriceHistory,
  findUncitedFinanceInstruments,
  findUnsupportedFinanceClaimScope,
  rankFinanceWindowDrawdowns,
} from "./finance-research-evidence.js";

const monthlyTrendAsOf = "2026-09-29T17:00:00.000Z";
const monthlyTrendRule = (ruleId = "trend-rule") => ({
  ruleId,
  form: "cross_asset_trend",
  formVersion: "1",
  emits: "target_weights",
  instruments: ["SPY"],
  schedule: { kind: "monthly", at: "last_trading_day", timezone: "America/New_York" },
  body: { frozenRule: { lookbackMonths: 12 } },
  activeObservedAt: "2026-01-01T00:00:00.000Z",
});
const monthlyTrendEvidence = (
  closes: readonly (readonly [string, number])[],
  options: { divergentDates?: readonly string[]; instrument?: string; timestamp?: string } = {},
): readonly [FinanceCommitteeEvidence, FinanceCommitteeEvidence] => [
  {
    id: "finance-controller:active-strategies",
    source: "finance-strategy-rule-ledger",
    timestamp: monthlyTrendAsOf,
    text: JSON.stringify({ activeRules: [monthlyTrendRule()] }),
  },
  {
    id: `finance-controller:eod:${options.instrument ?? "SPY"}`,
    source: "finance-bar-ledger",
    timestamp: options.timestamp ?? monthlyTrendAsOf,
    text: JSON.stringify({
      instrument: options.instrument ?? "SPY",
      divergentDates: options.divergentDates ?? [],
      closes,
      suppliedBarCount: closes.length,
    }),
  },
];

describe("deterministic monthly trend evidence", () => {
  it("uses the prior-calendar-month observation and excludes the partial current month", () => {
    const evidence = monthlyTrendEvidence([
      ["2025-08-29", 100],
      ["2025-09-30", 105],
      ["2026-08-31", 110],
      ["2026-09-28", 125],
    ]);

    const [derived] = buildFinanceMonthlyTrendDerivedEvidence(evidence, monthlyTrendAsOf);

    expect(derived).toMatchObject({
      id: "finance-derived:monthly-close-change:trend-rule:SPY",
      source: "finance-bar-ledger; deterministic monthly trend arithmetic",
      timestamp: monthlyTrendAsOf,
    });
    expect(derived?.text).toContain("anchor close 110 on 2026-08-31");
    expect(derived?.text).toContain("prior close 100 on 2025-08-29");
    expect(derived?.text).toContain("formula (anchor/prior - 1) * 100 = +10.0%");
    expect(derived?.text).toContain("month-end session coverage is unverified");
    expect(derived?.text).toContain("not a validated strategy signal");
    expect(derived?.text).toContain("not dividend-reinvested total return");
    expect(derived?.text).toContain(
      "finance-controller:active-strategies,finance-controller:eod:SPY",
    );
  });

  it("allows one supported monthly strategy alongside a different intraday rule", () => {
    const [activeRulesEvidence, eodEvidence] = monthlyTrendEvidence([
      ["2025-08-29", 100],
      ["2026-08-31", 110],
    ]);
    const payload = JSON.parse(activeRulesEvidence.text) as { activeRules: unknown[] };
    payload.activeRules.push({
      ruleId: "opening-range-rule",
      form: "opening_range_breakout",
      instruments: ["SPY"],
    });

    expect(
      buildFinanceMonthlyTrendDerivedEvidence(
        [{ ...activeRulesEvidence, text: JSON.stringify(payload) }, eodEvidence],
        monthlyTrendAsOf,
      ),
    ).toHaveLength(1);
  });

  it("refuses duplicate supported monthly rules as ambiguous", () => {
    const [activeRulesEvidence, eodEvidence] = monthlyTrendEvidence([
      ["2025-08-29", 100],
      ["2026-08-31", 110],
    ]);
    const payload = JSON.parse(activeRulesEvidence.text) as { activeRules: unknown[] };
    payload.activeRules.push(monthlyTrendRule("another-trend-rule"));

    expect(
      buildFinanceMonthlyTrendDerivedEvidence(
        [{ ...activeRulesEvidence, text: JSON.stringify(payload) }, eodEvidence],
        monthlyTrendAsOf,
      ),
    ).toEqual([]);
  });

  it("fails closed when source closes conflict, the required month is missing, or a future close exists", () => {
    const goodCloses: readonly (readonly [string, number])[] = [
      ["2025-08-29", 100],
      ["2026-08-31", 110],
    ];
    expect(
      buildFinanceMonthlyTrendDerivedEvidence(
        monthlyTrendEvidence(goodCloses, { divergentDates: ["SPY@2026-08-31"] }),
        monthlyTrendAsOf,
      ),
    ).toEqual([]);
    expect(
      buildFinanceMonthlyTrendDerivedEvidence(
        monthlyTrendEvidence([["2026-08-31", 110]]),
        monthlyTrendAsOf,
      ),
    ).toEqual([]);
    expect(
      buildFinanceMonthlyTrendDerivedEvidence(
        monthlyTrendEvidence([...goodCloses, ["2026-09-30", 111]]),
        monthlyTrendAsOf,
      ),
    ).toEqual([]);
    expect(
      buildFinanceMonthlyTrendDerivedEvidence(
        monthlyTrendEvidence(goodCloses, { timestamp: "2026-09-29T18:00:00.000Z" }),
        monthlyTrendAsOf,
      ),
    ).toEqual([]);
    expect(
      buildFinanceMonthlyTrendDerivedEvidence(
        monthlyTrendEvidence([
          ["2025-08-29", Number.MIN_VALUE],
          ["2026-08-31", Number.MAX_VALUE],
        ]),
        monthlyTrendAsOf,
      ),
    ).toEqual([]);
    expect(
      buildFinanceMonthlyTrendDerivedEvidence(
        monthlyTrendEvidence([
          ["2025-08-29", 100],
          ["2026-08-31", 110],
          ["2026-09-29", 111],
        ]),
        monthlyTrendAsOf,
      ),
    ).toEqual([]);
  });

  it("labels a mid-month stored observation without claiming a month-end signal", () => {
    const [ruleEvidence, closeEvidence] = monthlyTrendEvidence([
      ["2025-08-14", 100],
      ["2026-08-14", 110],
    ]);
    const [derived] = buildFinanceMonthlyTrendDerivedEvidence(
      [ruleEvidence, closeEvidence],
      monthlyTrendAsOf,
    );

    expect(derived?.text).toContain("anchor close 110 on 2026-08-14");
    expect(derived?.text).toContain("month-end session coverage is unverified");
    expect(derived?.text).toContain("not a validated strategy signal");
  });

  it("exposes the daily engine volatility with its actual close window and provenance", () => {
    const closes: [string, number][] = [];
    for (
      let date = new Date("2025-09-29T00:00:00.000Z");
      date < new Date("2026-09-29T00:00:00.000Z");
      date.setUTCDate(date.getUTCDate() + 1)
    ) {
      if (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
        continue;
      }
      const offset = closes.length;
      closes.push([date.toISOString().slice(0, 10), 100 + offset * 0.02 + (offset % 5) * 0.1]);
    }
    const evidence = monthlyTrendEvidence(closes);
    const derived = buildFinanceMonthlyTrendDerivedEvidence(evidence, monthlyTrendAsOf);
    const volatility = derived.find((item) =>
      item.id.startsWith("finance-derived:annualised-volatility:trend-rule:SPY"),
    );
    const expected = annualisedVol(
      closes.slice(-FINANCE_DAILY_VOLATILITY_LOOKBACK_CLOSES).map(([, close]) => close),
    );

    expect(volatility).toMatchObject({
      source: "finance-bar-ledger; deterministic daily-return risk-normalisation",
      timestamp: monthlyTrendAsOf,
    });
    expect(volatility?.text).toContain(
      "method=log(close_t/close_t-1), sample variance (n-1), sqrt(variance*252)",
    );
    expect(volatility?.text).toContain(
      `${FINANCE_DAILY_VOLATILITY_LOOKBACK_CLOSES} supplied closes and ${FINANCE_DAILY_VOLATILITY_LOOKBACK_CLOSES - 1} daily-return intervals`,
    );
    expect(volatility?.text).toContain(
      "the value matches the daytime engine calculation over the same latest 253 closes",
    );
    expect(volatility?.text).toContain(`annualisedVol=${expected.toFixed(8)}`);
    expect(volatility?.text).toContain("from 2025-10-09 to 2026-09-28");
    expect(volatility?.text).toContain(
      "raw evidence IDs=finance-controller:active-strategies,finance-controller:eod:SPY",
    );

    const tooShort = buildFinanceMonthlyTrendDerivedEvidence(
      monthlyTrendEvidence(closes.slice(-FINANCE_DAILY_VOLATILITY_LOOKBACK_CLOSES + 1)),
      monthlyTrendAsOf,
    );
    expect(
      tooShort.some((item) => item.id.startsWith("finance-derived:annualised-volatility:")),
    ).toBe(false);
  });
});

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
  it("accepts instrument-bound ledger evidence without demanding a market-price citation", () => {
    const evidence = [
      { id: "finance-model:SPY", text: "SPY price series" },
      { id: "ledger", text: 'Position {"instrument":"SPY","quantity":27}' },
      { id: "fees", text: "Account-wide fees are unallocated" },
      {
        id: "finance-night:broker-profit:2026-09-28",
        text: "Account totals: 3 buy fills. Requested review: SPY",
      },
      { id: "other", text: "SPYG position" },
    ];
    const claim = {
      id: "position",
      text: "SPY quantity is 27",
      status: "supported" as const,
      evidenceIds: ["ledger"],
    };
    expect(findUncitedFinanceInstruments(evidence, [claim])).toEqual([]);
    expect(
      findUncitedFinanceInstruments(evidence, [
        {
          ...claim,
          evidenceIds: ["ledger", "fees"],
          evidenceRelations: [
            { evidenceId: "ledger", relation: "context" },
            { evidenceId: "fees", relation: "supports" },
          ],
        },
      ]),
    ).toEqual(["position:finance-model:SPY"]);

    for (const id of ["fees", "other", "nonexistent", "finance-night:broker-profit:2026-09-28"]) {
      expect(findUncitedFinanceInstruments(evidence, [{ ...claim, evidenceIds: [id] }])).toEqual([
        "position:finance-model:SPY",
      ]);
    }
  });

  it("rejects instrument fill claims backed only by account aggregates, even with a price citation", () => {
    const evidence = [
      { id: "finance-model:SPY", text: "SPY price series" },
      {
        id: "finance-night:broker-profit:2026-09-28",
        text: "Account totals: buyFills=3; unattributedFillCount=3. Requested review: SPY",
      },
    ];
    const claim = {
      id: "spy-buys",
      text: "Three SPY buy fills are recorded",
      status: "supported" as const,
      evidenceIds: evidence.map((item) => item.id),
      evidenceRelations: evidence.map((item) => ({
        evidenceId: item.id,
        relation: "supports" as const,
      })),
    };
    expect(findUnsupportedFinanceClaimScope(evidence, [claim])).toEqual([
      "spy-buys:finance-model:SPY:instrument_fill_claim_cites_account_aggregate_only",
    ]);
  });

  it("rejects broker aggregate fill attribution without a finance-model packet when the target is declared", () => {
    const evidence = [
      {
        id: "finance-night:broker-profit:2026-09-28",
        text: "Account totals: buyFills=3; unattributedFillCount=3.",
      },
    ];
    const claim = {
      id: "spy-buys-no-price",
      text: "Three SPY buy fills are recorded",
      status: "supported" as const,
      evidenceIds: [evidence[0].id],
    };
    expect(findUnsupportedFinanceClaimScope(evidence, [claim], ["SPY"])).toEqual([
      "spy-buys-no-price:finance-model:SPY:instrument_fill_claim_cites_account_aggregate_only",
    ]);
  });

  it("does not accept a ticker context sentence as an instrument-specific fill bridge", () => {
    const evidence = [
      { id: "finance-model:SPY", text: "SPY price series" },
      {
        id: "finance-night:broker-profit:2026-09-28",
        text: "Account totals: buyFills=3; unattributedFillCount=3.",
      },
      { id: "news", text: "SPY has three buy fills according to the review context." },
    ];
    const claim = {
      id: "spy-buys-context",
      text: "Three SPY buy fills are recorded",
      status: "supported" as const,
      evidenceIds: evidence.map((item) => item.id),
    };
    expect(findUnsupportedFinanceClaimScope(evidence, [claim])).toHaveLength(1);
    expect(
      findUnsupportedFinanceClaimScope(
        [
          ...evidence,
          {
            id: "fills",
            text: '{"instrument":"SPY","fills":[{"side":"buy"},{"side":"buy"},{"side":"buy"}]}',
          },
        ],
        [{ ...claim, evidenceIds: [...claim.evidenceIds, "fills"] }],
      ),
    ).toEqual([]);
    expect(
      findUnsupportedFinanceClaimScope(
        [
          ...evidence,
          {
            id: "spy-fills",
            text: '{"instrument":"SPY","buyFills":3}',
          },
        ],
        [{ ...claim, evidenceIds: [...claim.evidenceIds, "spy-fills"] }],
      ),
    ).toEqual([]);
  });

  it("rejects zero-count sell claims in English and Chinese", () => {
    const evidence = [
      { id: "finance-model:SPY", text: "SPY price series" },
      {
        id: "finance-night:broker-profit:2026-09-28",
        text: "Account totals: sellFills=0; unattributedFillCount=3.",
      },
    ];
    const claims = [
      {
        id: "spy-zero-sells",
        text: "Zero SPY sell fills were recorded",
        status: "supported" as const,
        evidenceIds: evidence.map((item) => item.id),
      },
      {
        id: "spy-no-sells",
        text: "No SPY sell fills were recorded",
        status: "supported" as const,
        evidenceIds: evidence.map((item) => item.id),
      },
      {
        id: "spy-cn-no-sells",
        text: "SPY 没有卖出成交",
        status: "supported" as const,
        evidenceIds: evidence.map((item) => item.id),
      },
      {
        id: "spy-cn-zero-sells",
        text: "SPY 零笔卖出成交",
        status: "supported" as const,
        evidenceIds: evidence.map((item) => item.id),
      },
    ];
    expect(findUnsupportedFinanceClaimScope(evidence, claims)).toEqual(
      claims.map(
        (claim) =>
          `${claim.id}:finance-model:SPY:instrument_fill_claim_cites_account_aggregate_only`,
      ),
    );
  });

  it("does not infer zero instrument executions from an empty decision log and unattributed fills", () => {
    const evidence = [
      { id: "finance-night:intraday:2026-09-27", text: '{"decisions":[]}' },
      {
        id: "finance-night:broker-profit:2026-09-27",
        text: JSON.stringify({
          accounts: [
            {
              buyFills: 3,
              sellFills: 0,
              attributedFillCount: 0,
              unattributedFillCount: 3,
            },
          ],
        }),
      },
    ];
    const claim = {
      id: "no-spy-execution",
      text: "No controller-authorized SPY trades executed on 2026-09-27",
      status: "supported" as const,
      evidenceIds: evidence.map((entry) => entry.id),
      evidenceRelations: evidence.map((entry) => ({
        evidenceId: entry.id,
        relation: "supports" as const,
      })),
    };

    expect(findUnsupportedFinanceClaimScope(evidence, [claim], ["SPY"])).toEqual([
      "no-spy-execution:finance-model:SPY:empty_intraday_decisions_do_not_establish_zero_instrument_fills",
    ]);
    expect(
      findUnsupportedFinanceClaimScope(evidence, [{ ...claim, status: "uncertain" }], ["SPY"]),
    ).toEqual([]);

    const withInstrumentFill = [
      ...evidence,
      {
        id: "finance-night:broker-profit:instrument-detail",
        text: '{"accounts":[{"instruments":[{"instrument":"SPY","buyFills":1,"sellFills":0}]}]}',
      },
    ];
    const claimWithInstrumentFill = {
      ...claim,
      evidenceIds: withInstrumentFill.map((entry) => entry.id),
      evidenceRelations: withInstrumentFill.map((entry) => ({
        evidenceId: entry.id,
        relation: "supports" as const,
      })),
    };
    expect(
      findUnsupportedFinanceClaimScope(withInstrumentFill, [claimWithInstrumentFill], ["SPY"]),
    ).toEqual([
      "no-spy-execution:finance-model:SPY:no_execution_claim_conflicts_with_instrument_fills",
    ]);
  });

  it("only accepts instrument fill bridges whose structured side and count match the claim", () => {
    const evidence = [
      { id: "finance-model:SPY", text: "SPY price series" },
      {
        id: "finance-night:broker-profit:2026-09-28",
        text: "Account totals: buyFills=3; unattributedFillCount=3.",
      },
      { id: "empty", text: '{"instrument":"SPY","fills":[]}' },
      {
        id: "wrong-count",
        text: '{"instrument":"SPY","fills":[{"side":"buy"},{"side":"buy"}]}',
      },
      {
        id: "wrong-side",
        text: '{"instrument":"SPY","fills":[{"side":"sell"},{"side":"sell"},{"side":"sell"}]}',
      },
      {
        id: "wrong-count-field",
        text: '{"instrument":"SPY","buyFills":2}',
      },
    ];
    const claim = {
      id: "spy-buys-matched",
      text: "Three SPY buy fills are recorded",
      status: "supported" as const,
      evidenceIds: evidence.map((item) => item.id),
    };
    for (const id of ["empty", "wrong-count", "wrong-side", "wrong-count-field"]) {
      expect(
        findUnsupportedFinanceClaimScope(evidence, [
          {
            ...claim,
            evidenceIds: ["finance-model:SPY", "finance-night:broker-profit:2026-09-28", id],
          },
        ]),
      ).toEqual([
        "spy-buys-matched:finance-model:SPY:instrument_fill_claim_cites_account_aggregate_only",
      ]);
    }
    expect(
      findUnsupportedFinanceClaimScope(evidence, [
        {
          ...claim,
          evidenceIds: ["finance-model:SPY", "finance-night:broker-profit:2026-09-28"],
        },
      ]),
    ).toEqual([
      "spy-buys-matched:finance-model:SPY:instrument_fill_claim_cites_account_aggregate_only",
    ]);
    expect(
      findUnsupportedFinanceClaimScope(
        [
          ...evidence,
          {
            id: "matching-rows",
            text: '{"instrument":"SPY","fills":[{"side":"buy"},{"side":"buy"},{"side":"buy"}]}',
          },
          { id: "matching-count", text: '{"instrument":"SPY","buyFills":3}' },
        ],
        [
          {
            ...claim,
            evidenceIds: [
              "finance-model:SPY",
              "finance-night:broker-profit:2026-09-28",
              "matching-rows",
              "matching-count",
            ],
          },
        ],
      ),
    ).toEqual([]);
  });

  it("recognizes Chinese fill and fee-loss counterexamples", () => {
    const evidence = [
      { id: "finance-model:SPY", text: "SPY price series" },
      {
        id: "finance-night:broker-profit:2026-09-28",
        text: "账户汇总：买入成交数=3，未归因成交数=3；两笔手续费未分配。",
      },
    ];
    const claims = [
      {
        id: "spy-cn-fills",
        text: "SPY 有三笔买入成交",
        status: "supported" as const,
        evidenceIds: evidence.map((item) => item.id),
      },
      {
        id: "spy-cn-loss",
        text: "未分配手续费导致 SPY 亏损",
        status: "supported" as const,
        evidenceIds: evidence.map((item) => item.id),
      },
    ];
    expect(findUnsupportedFinanceClaimScope(evidence, claims)).toEqual([
      "spy-cn-fills:finance-model:SPY:instrument_fill_claim_cites_account_aggregate_only",
      "spy-cn-loss:finance-model:SPY:instrument_fee_loss_claim_lacks_attributed_fee_bridge",
    ]);
    expect(
      findUnsupportedFinanceClaimScope(
        [
          ...evidence,
          {
            id: "spy-fee-allocation",
            text: '{"instrument":"SPY","feeAmount":1.25,"allocated":true}',
          },
        ],
        [{ ...claims[1], evidenceIds: [...claims[1].evidenceIds, "spy-fee-allocation"] }],
      ),
    ).toEqual([]);
  });

  it("rejects instrument-specific causal fee claims when cited records say fees are unallocated", () => {
    const evidence = [
      { id: "finance-model:SPY", text: "SPY price series" },
      {
        id: "finance-night:broker-profit:2026-09-28",
        text: "Two fee activities are unallocated; costs are not reconciled.",
      },
    ];
    const claim = {
      id: "spy-fee-loss",
      text: "Unallocated fees caused SPY net losses",
      status: "supported" as const,
      evidenceIds: evidence.map((item) => item.id),
      evidenceRelations: evidence.map((item) => ({
        evidenceId: item.id,
        relation: "supports" as const,
      })),
    };
    expect(findUnsupportedFinanceClaimScope(evidence, [claim])).toEqual([
      "spy-fee-loss:finance-model:SPY:instrument_fee_loss_claim_lacks_attributed_fee_bridge",
    ]);
  });

  it("requires saved multi-rule provenance claims to be split by rule", () => {
    const rulesEvidenceId = "finance-night:rules:2026-09-27";
    const evidence = [
      {
        id: rulesEvidenceId,
        text: JSON.stringify({
          activeRules: [
            {
              ruleId: "trend_risk_normalised_v1",
              instruments: ["SPY", "QQQ"],
              provenance: {
                readScope: "research_only",
                notes:
                  "公开方法蒸馏，不是任何管理人的实际参数；skill 明确声明当前状态为材料与规则可复核，不是收益验证",
              },
            },
            {
              ruleId: "opening_range_breakout_long_pre_close_v2",
              instruments: ["SPY"],
              provenance: {
                readScope: "Alpaca Paper calendar and IEX 5-minute bars",
                notes:
                  "Adds a calendar-bound pre-close exit to the frozen v1 entry, stop, and reward-target rules. Optiver article informs the decision-loop design, not the alpha signal.",
              },
            },
          ],
        }),
      },
    ];
    const combinedClaim = {
      id: "combined-rule-scope",
      text: "Both trend_risk_normalised_v1 and opening_range_breakout_long_pre_close_v2 are research_only and have no return validation.",
      status: "supported" as const,
      evidenceIds: [rulesEvidenceId],
    };

    expect(findUnsupportedFinanceClaimScope(evidence, [combinedClaim], ["SPY"])).toEqual([
      "combined-rule-scope:finance-night:rules:2026-09-27:multi_rule_scope_claim_requires_split",
    ]);
    expect(
      findUnsupportedFinanceClaimScope(
        evidence,
        [
          {
            ...combinedClaim,
            text: "Both trend_risk_normalised_v1 and opening_range_breakout_long_pre_close_v2 are listed in the active rule ledger.",
          },
        ],
        ["SPY"],
      ),
    ).toEqual([]);
    expect(
      findUnsupportedFinanceClaimScope(
        evidence,
        [
          {
            ...combinedClaim,
            id: "trend-rule-scope",
            text: "Active rule trend_risk_normalised_v1 includes SPY and has provenance research_only and no return validation.",
          },
          {
            ...combinedClaim,
            id: "opening-rule-scope",
            text: "opening_range_breakout_long_pre_close_v2 is SPY only and has readScope Alpaca Paper calendar and IEX 5-minute bars; no research_only or return validation statement is present in its provenance.",
          },
        ],
        ["SPY"],
      ),
    ).toEqual([]);
  });

  it("keeps account observations, qualified fee limitations, and instrument ledger quantities admissible", () => {
    const evidence = [
      { id: "finance-model:SPY", text: "SPY price series" },
      { id: "ledger", text: 'Position {"instrument":"SPY","quantity":27}' },
      { id: "broker", text: "Account totals: 3 unattributed buy fills; fees are unallocated." },
    ];
    const claims = [
      {
        id: "account-fills",
        text: "The account reports 3 unattributed buy fills",
        status: "supported" as const,
        evidenceIds: ["broker"],
      },
      {
        id: "fee-limit",
        text: "SPY-specific fees cannot be determined from the unallocated activities",
        status: "uncertain" as const,
        evidenceIds: ["broker"],
        basis: "The broker record marks those fee activities unallocated.",
        uncertainty: "The activities may include SPY but lack instrument attribution.",
      },
      {
        id: "spy-quantity",
        text: "SPY ledger quantity is 27",
        status: "supported" as const,
        evidenceIds: ["ledger"],
      },
    ];
    expect(findUnsupportedFinanceClaimScope(evidence, claims)).toEqual([]);
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
  it("derives citeable daily volatility from clean batch closes and keeps the short-window gap explicit", () => {
    const asOf = "2026-09-10T00:00:00.000Z";
    const buildRows = (count: number) => {
      const dates: string[] = [];
      const date = new Date("2026-09-09T00:00:00.000Z");
      while (dates.length < count) {
        if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) {
          dates.push(date.toISOString().slice(0, 10));
        }
        date.setUTCDate(date.getUTCDate() - 1);
      }
      return dates
        .toReversed()
        .map((value, index) => row(value, 100 + index * 0.03 + (index % 7) * 0.2));
    };
    const makePacket = (records: readonly FinanceMarketCollectionItem[]) =>
      ({
        schemaVersion: "lcx_finance_research_batch_v1",
        boundary: "finance_research_batch_research_only",
        decisionMode: "research_only",
        correlationId: "daily-volatility-batch",
        asOf,
        useCase: "test",
        status: "completed",
        committeeEvidence: [],
        budget: {},
        jobs: [
          {
            jobId: "finance-batch:spy-eod",
            request: {
              instrument: "SPY",
              assetClass: "us_equity",
              collection: "eod_history",
              asOf,
            },
            status: "ready",
            receipt: { records },
          },
        ],
      }) as unknown as FinanceResearchBatchEvidencePacket;

    const closes = buildRows(FINANCE_DAILY_VOLATILITY_LOOKBACK_CLOSES);
    const evidence = buildFinanceResearchModelEvidence(makePacket(closes));
    const spy = evidence.find((item) => item.id === "finance-model:SPY");
    const expectedVolatility = annualisedVol(closes.map((item) => item.data.close as number));
    const firstDate = closes[0]?.data.date;
    const lastDate = closes.at(-1)?.data.date;

    expect(spy?.text).toContain(`annualisedDailyVol=${expectedVolatility.toFixed(8)}`);
    expect(spy?.text).toContain(
      `volatilityWindow=253 closes/252 returns ${String(firstDate)}..${String(lastDate)}`,
    );
    expect(spy?.text).toContain(
      "audit receipt ID only=finance-batch:spy-eod; cite this observation as finance-model:SPY",
    );
    expect(spy?.text).toContain("finance-batch:spy-eod");

    const shortSpy = buildFinanceResearchModelEvidence(makePacket(buildRows(252))).find(
      (item) => item.id === "finance-model:SPY",
    );
    expect(shortSpy?.text).toContain(
      "annualisedDailyVol=unavailable; requires 253 clean unique daily closes",
    );
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
    const reused = buildFinanceResearchModelEvidence({
      ...packet,
      jobs: packet.jobs.map((job) => ({
        ...job,
        sourceReuse: {
          kind: "durable_collection_snapshot" as const,
          sourceId: "treasury-source",
          snapshotId: "stored-snapshot-ref",
          capturedAt: "2026-09-09T23:30:00Z",
          reusedAt: packet.asOf,
        },
      })),
    }).at(-1)?.text;
    expect(reused).toContain("originally capturedAt=2026-09-09T23:30:00Z");
    expect(reused).toContain("no new source fetch");
    expect(reused).toContain("latest tot_pub_debt_out_amt=100");
  });

  it("keeps Treasury security categories separate when they share an observation date", () => {
    const packet = macroPacket([
      macroRecord("2026-08-31", "United States Savings Securities", "3.145"),
      macroRecord("2026-08-31", "United States Savings Inflation Securities", "4.496"),
    ]);

    const text = buildFinanceResearchModelEvidence(packet).at(-1)?.text ?? "";
    expect(text).toContain("United States Savings Securities");
    expect(text).toContain("latest avg_interest_rate_amt=3.145");
    expect(text).toContain("United States Savings Inflation Securities");
    expect(text).toContain("latest avg_interest_rate_amt=4.496");
    expect(text).not.toContain("previous=3.145");
  });

  it("compares observations only within the same macro series dimensions", () => {
    const packet = macroPacket([
      macroRecord("2026-07-31", "United States Savings Securities", "3.100"),
      macroRecord("2026-08-31", "United States Savings Securities", "3.145"),
    ]);

    const text = buildFinanceResearchModelEvidence(packet).at(-1)?.text ?? "";
    expect(text).toContain("latest avg_interest_rate_amt=3.145");
    expect(text).toContain("previous=3.1 (2026-07-31)");
  });

  it("reports conflicting values for one macro series on the same date", () => {
    const packet = macroPacket([
      macroRecord("2026-08-31", "United States Savings Securities", "3.145"),
      macroRecord("2026-08-31", "United States Savings Securities", "3.200"),
    ]);

    const text = buildFinanceResearchModelEvidence(packet).at(-1)?.text ?? "";
    expect(text).toContain("same observation date has conflicting values");
    expect(text).toContain("3.145");
    expect(text).toContain("3.2");
    expect(text).not.toContain("latest avg_interest_rate_amt=3.2");
  });

  it("preserves the single-series macro summary and discloses missing vintage data", () => {
    const packet = macroPacket([
      macroRecord("2026-07-31", undefined, "3.100", "DGS10"),
      macroRecord("2026-08-31", undefined, "3.145", "DGS10"),
    ]);

    const text = buildFinanceResearchModelEvidence(packet).at(-1)?.text ?? "";
    expect(text).toContain("DGS10");
    expect(text).toContain("latest value=3.145");
    expect(text).toContain("previous=3.1 (2026-07-31)");
    expect(text).toContain("vintage interval=unverified..unverified");
  });

  it("keeps units as part of macro series identity", () => {
    const packet = macroPacket([
      macroRecord("2026-08-31", undefined, "3.145", "DGS10", "percent"),
      macroRecord("2026-08-31", undefined, "314.5", "DGS10", "basis points"),
    ]);

    const text = buildFinanceResearchModelEvidence(packet).at(-1)?.text ?? "";
    expect(text).toContain('"unit":"percent"');
    expect(text).toContain('"unit":"basis points"');
    expect(text).not.toContain("same observation date has conflicting values");
  });

  it("labels the observation period separately from the source capture timestamp", () => {
    const record = macroRecord("2026-08-31", undefined, "3.145", "DGS10");
    const packet = macroPacket([{ ...record, sourceTimestamp: "2026-09-09T00:00:00.000Z" }]);
    const text = buildFinanceResearchModelEvidence(packet).at(-1)?.text ?? "";
    expect(text).toContain("observation period=2026-08-31");
    expect(text).not.toContain("observation period=2026-09-09");
    expect(text).toContain("publication time=unverified");
  });

  function macroPacket(records: FinanceMarketCollectionItem[]): FinanceResearchBatchEvidencePacket {
    return {
      schemaVersion: "lcx_finance_research_batch_v1",
      boundary: "finance_research_batch_research_only",
      decisionMode: "research_only",
      correlationId: "macro-dimensions",
      asOf: "2026-09-10T00:00:00Z",
      useCase: "test",
      status: "completed",
      committeeEvidence: [],
      budget: {},
      jobs: [
        {
          request: {
            instrument: "avg_interest_rates",
            assetClass: "macro_series",
            collection: "macro_series",
            asOf: "2026-09-10T00:00:00Z",
          },
          status: "ready",
          receipt: { records },
        },
      ],
    } as unknown as FinanceResearchBatchEvidencePacket;
  }

  function macroRecord(
    date: string,
    securityDescription: string | undefined,
    value: string,
    seriesId = "avg_interest_rates",
    unit?: string,
  ): FinanceMarketCollectionItem {
    return {
      itemId: `${seriesId}-${date}-${securityDescription ?? ""}`,
      collection: "macro_series",
      providerName: "official-macro-data",
      providerRole: "official_or_issuer_reference",
      sourceFamily: "official_macro_data",
      sourceTimestamp: `${date}T00:00:00.000Z`,
      observedAt: `${date}T00:00:00.000Z`,
      delayStatus: "official_lagged",
      sourceUrlOrArtifact: "https://example.test/macro",
      data: {
        ...(seriesId === "avg_interest_rates" ? {} : { seriesId }),
        record_date: date,
        ...(securityDescription ? { security_desc: securityDescription } : {}),
        ...(unit ? { unit } : {}),
        ...(seriesId === "avg_interest_rates" ? { avg_interest_rate_amt: value } : { value }),
      },
    } as FinanceMarketCollectionItem;
  }

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

  it("keeps module-requested operating and technical collections in model evidence", () => {
    const packet = {
      schemaVersion: "lcx_finance_research_batch_v1",
      boundary: "finance_research_batch_research_only",
      decisionMode: "research_only",
      correlationId: "module-collections",
      asOf: "2026-09-10T00:00:00Z",
      useCase: "test",
      status: "completed",
      committeeEvidence: [],
      budget: {},
      jobs: [
        {
          jobId: "aapl-fundamentals",
          request: {
            instrument: "AAPL",
            assetClass: "us_equity",
            collection: "financial_statements",
            asOf: "2026-09-10T00:00:00Z",
          },
          status: "ready",
          receipt: {
            records: [
              {
                itemId: "aapl-cash-flow-1",
                collection: "financial_statements",
                providerName: "fixture-financials",
                providerRole: "issuer_reference",
                sourceFamily: "company_fundamentals",
                sourceTimestamp: "2026-07-01T00:00:00Z",
                observedAt: "2026-09-10T00:00:00Z",
                delayStatus: "official_lagged",
                sourceUrlOrArtifact: "fixture://financials",
                data: { statement: "cash_flow", operatingCashFlow: 100, capex: 20 },
              },
            ],
          },
        },
        {
          jobId: "aapl-technical",
          request: {
            instrument: "AAPL",
            assetClass: "us_equity",
            collection: "technical_indicators",
            asOf: "2026-09-10T00:00:00Z",
          },
          status: "ready",
          receipt: {
            records: [
              {
                itemId: "aapl-sma-1",
                collection: "technical_indicators",
                providerName: "fixture-technical",
                providerRole: "derived_market_data",
                sourceFamily: "market_data_api",
                sourceTimestamp: "2026-09-09T00:00:00Z",
                observedAt: "2026-09-10T00:00:00Z",
                delayStatus: "end_of_day",
                sourceUrlOrArtifact: "fixture://technical",
                data: { indicator: "SMA", period: 200, value: 210 },
              },
            ],
          },
        },
      ],
    } as unknown as FinanceResearchBatchEvidencePacket;

    const evidence = buildFinanceResearchModelEvidence(packet);
    const aapl = evidence.find((item) => item.id === "finance-model:AAPL");
    expect(aapl?.text).toContain("financial_statements records=1");
    expect(aapl?.text).toContain("operatingCashFlow");
    expect(aapl?.text).toContain("technical_indicators records=1");
    expect(aapl?.text).toContain("SMA");
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

it("projects quality failure without fabricating a soft-module replan and preserves bounded omissions", () => {
  const receipt = {
    plan: { asOf: "2026-10-04T00:00:00Z" },
    moduleExecution: {
      nodes: [{ nodeId: "math", moduleId: "quant", status: "succeeded" }],
      replanFeedback: { status: "completed", nextAction: "none", remainingSoftReplans: 1 },
    },
    gates: [{ id: "quality", passed: false, reason: "claim:fees_unknown" }],
    missingEvidence: [],
  };
  expect(
    buildFinanceHistoricalResearchFeedback({
      receipt,
      sourceRef: "dated.json",
      sourceSha256: "a".repeat(64),
    }),
  ).toMatchObject({
    status: "present",
    replanStatus: "completed",
    nextAction: "none",
    failures: [],
    failedGates: [{ id: "quality", reason: "claim:fees_unknown" }],
  });
  const result = buildFinanceHistoricalResearchFeedback({
    receipt: {
      ...receipt,
      moduleExecution: {
        ...receipt.moduleExecution,
        nodes: Array.from({ length: 20 }, (_, i) => ({
          nodeId: `n${i}`,
          moduleId: "quant",
          status: "failed",
          missingEvidence: Array.from({ length: 10 }, () => "中".repeat(120)),
        })),
      },
    },
    sourceRef: "dated.json",
    sourceSha256: "a".repeat(64),
  });
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(2048);
  expect(Number(result.omittedFailures)).toBeGreaterThan(0);
  expect(
    buildFinanceHistoricalResearchFeedback({
      receipt: { ...receipt, gates: [] },
      sourceRef: "dated.json",
      sourceSha256: "a".repeat(64),
    }).status,
  ).toBe("no_gap");
});

it("keeps the primary failed node and critical quality reason ahead of generic source gaps under UTF8 pressure", () => {
  const receipt = {
    status: "needs_review",
    plan: { asOf: "2026-10-04T00:00:00Z" },
    moduleExecution: {
      nodes: Array.from({ length: 4 }, (_, i) => ({
        nodeId: `primary${i}`,
        moduleId: "technical_timing",
        status: "failed",
        missingEvidence: Array.from({ length: 4 }, (_, j) => `missing-${j}:` + "中".repeat(30)),
      })),
      replanFeedback: {
        status: "replan_soft",
        nextAction: "revise_soft_modules",
        remainingSoftReplans: 1,
      },
    },
    quality: {
      attempts: [
        {
          feedback: [
            "critical_quality_claim_fees_unknown",
            ...Array.from({ length: 3 }, () => "中".repeat(120)),
          ],
        },
      ],
    },
    gates: [{ id: "quality", passed: false, reason: "claim_fees_unknown" }],
    missingEvidence: Array.from({ length: 4 }, (_, i) => `generic-${i}:` + "中".repeat(30)),
  };
  const result = buildFinanceHistoricalResearchFeedback({
    receipt,
    sourceRef: "dated.json",
    sourceSha256: "a".repeat(64),
  });
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(2048);
  expect(result).toMatchObject({
    status: "present",
    failures: expect.arrayContaining([expect.objectContaining({ nodeId: "primary0" })]),
    qualityFeedback: expect.arrayContaining(["critical_quality_claim_fees_unknown"]),
    failedGates: [{ id: "quality", reason: "claim_fees_unknown" }],
  });
  expect(Number(result.omittedSourceGaps)).toBeGreaterThan(0);
});
