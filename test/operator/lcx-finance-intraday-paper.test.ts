import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFinanceIntradayPaperPayload } from "../../scripts/operator/lcx-finance-intraday-paper.js";
import { syncAlpacaIntradayBars } from "../../src/agents/finance-alpaca-intraday.js";
import {
  FINANCE_ALPACA_MARKET_CALENDAR_SOURCE,
  FINANCE_ALPACA_MARKET_CALENDAR_URL,
  readFinanceAlpacaMarketCalendar,
} from "../../src/agents/finance-alpaca-market-calendar.js";
import { caseflowFingerprint } from "../../src/agents/finance-caseflow.js";
import {
  type FinanceIntradayBar,
  readFinanceIntradayLedger,
} from "../../src/agents/finance-intraday-ledger.js";
import {
  FINANCE_INTRADAY_OPENING_RANGE_RULE,
  FINANCE_INTRADAY_OPENING_RANGE_RULE_V2,
  FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
} from "../../src/agents/finance-intraday-paper.js";

vi.mock("../../src/agents/finance-alpaca-intraday.js", () => ({
  syncAlpacaIntradayBars: vi.fn(),
}));
vi.mock("../../src/agents/finance-intraday-ledger.js", () => ({
  readFinanceIntradayLedger: vi.fn(),
}));
vi.mock("../../src/agents/finance-alpaca-market-calendar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/agents/finance-alpaca-market-calendar.js")>()),
  readFinanceAlpacaMarketCalendar: vi.fn(),
}));

const date = "2026-09-18";
const openAt = `${date}T13:30:00.000Z`;
const closeAt = `${date}T20:00:00.000Z`;
const sourceUrlOrArtifact = `${FINANCE_ALPACA_MARKET_CALENDAR_URL}?start=${date}&end=${date}&date_type=TRADING`;
const calendar = {
  date,
  openAt,
  closeAt,
  openMinute: 570,
  closeMinute: 960,
  observedAt: `${date}T13:29:00.000Z`,
  sourceUrlOrArtifact,
  calendarRef: caseflowFingerprint({
    source: FINANCE_ALPACA_MARKET_CALENDAR_SOURCE,
    sourceUrlOrArtifact,
    date,
    openAt,
    closeAt,
  }),
};

function bars(): FinanceIntradayBar[] {
  return Array.from({ length: 78 }, (_, index) => {
    const start = Date.parse(openAt) + index * 300_000;
    const open = index <= 6 ? 100 : 101;
    const close = index < 6 ? 100 : 101;
    return {
      instrument: "SPY",
      intervalSeconds: 300,
      startAt: new Date(start).toISOString(),
      endAt: new Date(start + 300_000).toISOString(),
      open,
      high: Math.max(open, close),
      low: index < 6 ? 99 : open,
      close,
      volume: 1000,
    };
  });
}

function args(rule: string, feed = "iex"): string[] {
  return [
    "--instrument",
    "spy",
    "--from",
    openAt,
    "--to",
    closeAt,
    "--capital",
    "1000",
    "--max-allocation",
    "1",
    "--fee-bps-per-side",
    "1",
    "--spread-bps",
    "2",
    "--slippage-bps-per-side",
    "1",
    "--strategy-rule",
    rule,
    "--feed",
    feed,
    "--interval-seconds",
    "300",
  ];
}

describe("original intraday replay operator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readFinanceIntradayLedger).mockResolvedValue({
      bars: bars(),
      recordCount: 1,
      headRef: "fixture-head",
    });
    vi.mocked(readFinanceAlpacaMarketCalendar).mockResolvedValue([calendar]);
  });

  it.each([FINANCE_INTRADAY_OPENING_RANGE_RULE_V2, FINANCE_INTRADAY_OPENING_RANGE_RULE_V3])(
    "runs %s through the existing calendar-backed replay without syncing bars",
    async (rule) => {
      const result = await buildFinanceIntradayPaperPayload(args(rule));
      expect(result.receipt.strategyRule).toBe(rule);
      expect(result.receipt.trades).toHaveLength(1);
      expect(result.receipt.trades[0]?.exitReason).toBe("pre_close");
      expect(readFinanceAlpacaMarketCalendar).toHaveBeenCalledOnce();
      expect(result.source.marketCalendar?.sessions).toBe(1);
      expect(syncAlpacaIntradayBars).not.toHaveBeenCalled();
      expect(result.claims).toEqual({
        networkTouched: true,
        credentialsRead: true,
        orderPlaced: false,
        alphaProven: false,
      });
    },
  );

  it("preserves legacy V1 without calendar access", async () => {
    const result = await buildFinanceIntradayPaperPayload(
      args(FINANCE_INTRADAY_OPENING_RANGE_RULE),
    );
    expect(result.receipt.trades).toHaveLength(1);
    expect(readFinanceAlpacaMarketCalendar).not.toHaveBeenCalled();
    expect(result.claims.networkTouched).toBe(false);
  });

  it.each(["iex", "sip"])(
    "selects the requested %s feed and excludes other intervals",
    async (feed) => {
      const selectedBars = bars();
      vi.mocked(readFinanceIntradayLedger).mockResolvedValue({
        bars: [...selectedBars, { ...selectedBars[0], intervalSeconds: 60 }],
        recordCount: 2,
        headRef: "mixed-interval-head",
      });
      const result = await buildFinanceIntradayPaperPayload(
        args(FINANCE_INTRADAY_OPENING_RANGE_RULE_V3, feed),
      );
      expect(readFinanceIntradayLedger).toHaveBeenCalledWith(expect.any(String), {
        instrument: "SPY",
        feed,
      });
      expect(result.source.selectedBars).toBe(78);
      expect(result.receipt.trades).toHaveLength(1);
    },
  );

  it("does not substitute other data when the selected ledger view is empty", async () => {
    vi.mocked(readFinanceIntradayLedger).mockResolvedValue({
      bars: [],
      recordCount: 1,
      headRef: "other-feed-head",
    });
    await expect(
      buildFinanceIntradayPaperPayload(args(FINANCE_INTRADAY_OPENING_RANGE_RULE_V3, "sip")),
    ).rejects.toThrow();
    expect(readFinanceIntradayLedger).toHaveBeenCalledWith(expect.any(String), {
      instrument: "SPY",
      feed: "sip",
    });
  });

  it("rejects an unsupported strategy before ledger, calendar or sync access", async () => {
    await expect(
      buildFinanceIntradayPaperPayload([...args("unsupported"), "--sync-alpaca"]),
    ).rejects.toThrow("--strategy-rule is unsupported");
    expect(readFinanceIntradayLedger).not.toHaveBeenCalled();
    expect(readFinanceAlpacaMarketCalendar).not.toHaveBeenCalled();
    expect(syncAlpacaIntradayBars).not.toHaveBeenCalled();
  });
});
