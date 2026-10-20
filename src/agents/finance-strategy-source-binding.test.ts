import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __test } from "../../scripts/operator/finance-strategy-all-methods.ts";

function fixture() {
  const timestamp = "2026-09-10 04:37:28";
  const call = "SPY261016C00762000";
  const put = "SPY261016P00762000";
  const snapshot = {
    timestamp,
    symbol: "SPY",
    data: {
      symbol: "SPY",
      current_price: 762.4,
      options: [
        { option: call, bid: 13, ask: 14, iv: 0.2 },
        { option: put, bid: 12, ask: 13, iv: 0.21 },
      ],
    },
  };
  const raw = Buffer.from(JSON.stringify(snapshot));
  const receipt = {
    source_url: "https://cdn.cboe.com/api/global/delayed_quotes/options/SPY.json",
    http_status: 200,
    fetched_at: "2026-09-10T08:45:02Z",
    observed_as_of: timestamp,
    raw_sha256: createHash("sha256").update(raw).digest("hex"),
  };
  const tail = {
    module: "M10",
    quote_timestamp: timestamp,
    spot: 762.4,
    put: { contract: put, expiry: "2026-10-16", strike: 762, bid: 12, ask: 13, iv: 0.21 },
  };
  const volatility = {
    module: "M11",
    quote_timestamp: timestamp,
    spot: 762.4,
    contract_pair: { call, put, expiry: "2026-10-16", strike: 762 },
  };
  return { snapshot, raw, receipt, tail, volatility };
}

describe("Cboe source binding", () => {
  it("accepts the producer's native receipt and the same historical snapshot for both methods", () => {
    const { receipt, tail, volatility, raw } = fixture();
    expect(__test.cboeSourceReady(receipt, tail, raw)).toBe(true);
    expect(__test.cboeSourceReady(receipt, volatility, raw)).toBe(true);
  });

  it("requires the raw bytes to match the retained hash", () => {
    const { receipt, tail, raw } = fixture();
    expect(__test.cboeSourceReady(receipt, tail)).toBe(false);
    expect(__test.cboeSourceReady(receipt, tail, Buffer.concat([raw, Buffer.from(" ")]))).toBe(
      false,
    );
  });

  it("does not substitute download time for quote time", () => {
    const { receipt, tail, raw } = fixture();
    expect(
      __test.cboeSourceReady(receipt, { ...tail, quote_timestamp: receipt.fetched_at }, raw),
    ).toBe(false);
    expect(
      __test.cboeSourceReady({ ...receipt, observed_as_of: "2025-09-10 04:37:28" }, tail, raw),
    ).toBe(false);
  });

  it("rejects wrong underlying, contracts and quote values", () => {
    const { receipt, tail, volatility, raw } = fixture();
    expect(
      __test.cboeSourceReady(
        { ...receipt, source_url: receipt.source_url.replace("SPY", "QQQ") },
        tail,
        raw,
      ),
    ).toBe(false);
    expect(
      __test.cboeSourceReady(
        receipt,
        { ...tail, put: { ...tail.put, contract: "QQQ261016P00762000" } },
        raw,
      ),
    ).toBe(false);
    expect(__test.cboeSourceReady(receipt, { ...tail, put: { ...tail.put, bid: 100 } }, raw)).toBe(
      false,
    );
    expect(
      __test.cboeSourceReady(receipt, { ...tail, put: { ...tail.put, strike: 760 } }, raw),
    ).toBe(false);
    expect(
      __test.cboeSourceReady(
        receipt,
        {
          ...volatility,
          contract_pair: { ...volatility.contract_pair, call: volatility.contract_pair.put },
        },
        raw,
      ),
    ).toBe(false);
  });

  it("does not accept matching missing or invalid IV as evidence", () => {
    const { snapshot, receipt, tail } = fixture();
    for (const iv of [undefined, null, -0.1, 0]) {
      const changed = {
        ...snapshot,
        data: {
          ...snapshot.data,
          options: snapshot.data.options.map((option) => ({ ...option, iv })),
        },
      };
      const raw = Buffer.from(JSON.stringify(changed));
      const source = { ...receipt, raw_sha256: createHash("sha256").update(raw).digest("hex") };
      expect(__test.cboeSourceReady(source, { ...tail, put: { ...tail.put, iv } }, raw)).toBe(
        false,
      );
    }
  });

  it("rejects malformed quote time even with a matching hash", () => {
    const { snapshot, receipt, tail } = fixture();
    snapshot.timestamp = "2026-02-30 04:37:28";
    const raw = Buffer.from(JSON.stringify(snapshot));
    expect(
      __test.cboeSourceReady(
        {
          ...receipt,
          observed_as_of: snapshot.timestamp,
          raw_sha256: createHash("sha256").update(raw).digest("hex"),
        },
        { ...tail, quote_timestamp: snapshot.timestamp },
        raw,
      ),
    ).toBe(false);
  });

  it("loads only the canonical local snapshot and leaves missing evidence unready", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-cboe-binding-"));
    try {
      expect(await __test.readCboeSnapshot(root)).toBeUndefined();
      const file = path.join(root, "experiments/real_market/raw/cboe_spy_options.json");
      await fs.mkdir(path.dirname(file), { recursive: true });
      const { raw, receipt, tail } = fixture();
      await fs.writeFile(file, raw);
      expect(__test.cboeSourceReady(receipt, tail, await __test.readCboeSnapshot(root))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function yahooFixture(
  symbol: string,
  dates = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"],
) {
  const body = {
    chart: {
      error: null,
      result: [
        {
          meta: { symbol },
          timestamp: dates.map((day) => Date.parse(`${day}T21:00:00Z`) / 1000),
          indicators: {
            quote: [{ close: dates.map(() => 100) }],
            adjclose: [{ adjclose: dates.map(() => 101) }],
          },
        },
      ],
    },
  };
  const raw = Buffer.from(JSON.stringify(body));
  const receipt = {
    symbol,
    http_status: 200,
    fetched_at: "2026-01-08T00:00:00Z",
    observed_as_of: dates.at(-1),
    source_url: `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${Date.parse("2026-01-01") / 1000}&period2=${Date.parse("2026-01-08") / 1000}&interval=1d`,
    raw_sha256: createHash("sha256").update(raw).digest("hex"),
  };
  return { raw, receipt, body };
}

function eventFixture() {
  const id = "SP500-2026-01-08";
  const url = "https://press.spglobal.com/2026-01-05-Announcement%2C-Inc";
  const raw = Buffer.from(
    '<link rel="canonical" href="https://press.spglobal.com/2026-01-05-Announcement,-Inc" />\n<!-- ITEMDATE: 2026-01-05 18:00:00 EST -->',
  );
  const receipt = {
    source_url: url,
    http_status: 200,
    fetched_at: "2026-01-08T00:00:00Z",
    raw_sha256: createHash("sha256").update(raw).digest("hex"),
    bytes: raw.byteLength,
  };
  const event = {
    event_id: id,
    source_url: url,
    source_receipt: receipt,
    announcement_date: "2026-01-05",
    effective_date: "2026-01-08",
    tickers: ["QQQ"],
    entry_date: "2026-01-06",
    exit_date: "2026-01-07",
  };
  return { event, receipts: { [id]: receipt }, raw: { [id]: raw } };
}

describe("native historical source binding", () => {
  const result = { universe: ["SPY", "QQQ"], sample: { start: "2026-01-05", end: "2026-01-07" } };
  function sources() {
    const spy = yahooFixture("SPY");
    const qqq = yahooFixture("QQQ");
    return {
      spy,
      qqq,
      receipts: { SPY: spy.receipt, QQQ: qqq.receipt },
      raw: { SPY: spy.raw, QQQ: qqq.raw },
    };
  }

  it("accepts native historical evidence and ignores unrelated receipts", () => {
    const { receipts, raw } = sources();
    expect(
      __test.historicalSourcesReady(
        "M02",
        result,
        { ...receipts, UNRELATED: { http_status: 503 } },
        raw,
      ),
    ).toBe(true);
    expect(__test.historicalSourcesReady("M02", result, receipts, undefined)).toBe(false);
    expect(__test.historicalSourcesReady("M02", result, { SPY: receipts.SPY }, raw)).toBe(false);
  });

  it("rejects mismatched symbol, URL, timestamp and raw content", () => {
    const { receipts, raw } = sources();
    const bad = [
      { ...receipts.SPY, symbol: "QQQ" },
      { ...receipts.SPY, source_url: receipts.SPY.source_url.replace("chart/SPY", "chart/QQQ") },
      { ...receipts.SPY, source_url: receipts.SPY.source_url.replace("chart/SPY", "chart/%ZZ") },
      { ...receipts.SPY, observed_as_of: "2025-01-07" },
      { ...receipts.SPY, fetched_at: "2026-01-06T00:00:00Z" },
      { ...receipts.SPY, raw_sha256: "0".repeat(64) },
      { ...receipts.SPY, status: "needs_review" },
    ];
    for (const spy of bad) {
      expect(__test.historicalSourcesReady("M02", result, { ...receipts, SPY: spy }, raw)).toBe(
        false,
      );
    }
  });

  it("honors the request's exclusive upper bound", () => {
    const { receipts, raw } = sources();
    const url = new URL(receipts.SPY.source_url);
    url.searchParams.set("period2", String(Date.parse("2026-01-07") / 1000));
    expect(
      __test.historicalSourcesReady(
        "M02",
        result,
        { ...receipts, SPY: { ...receipts.SPY, source_url: url.href } },
        raw,
      ),
    ).toBe(false);
  });

  it("checks body-level provider errors and actual symbol despite a valid hash", () => {
    const { receipts, raw, spy } = sources();
    for (const changed of [
      { chart: { ...spy.body.chart, error: { code: "Not Found" } } },
      {
        chart: {
          ...spy.body.chart,
          result: [{ ...spy.body.chart.result[0], meta: { symbol: "QQQ" } }],
        },
      },
    ]) {
      const bytes = Buffer.from(JSON.stringify(changed));
      expect(
        __test.historicalSourcesReady(
          "M02",
          result,
          {
            ...receipts,
            SPY: { ...receipts.SPY, raw_sha256: createHash("sha256").update(bytes).digest("hex") },
          },
          { ...raw, SPY: bytes },
        ),
      ).toBe(false);
    }
  });

  it("rejects single-point history and inflated common observation counts", () => {
    const spy = yahooFixture("SPY", ["2026-01-07"]);
    const qqq = yahooFixture("QQQ", ["2026-01-07"]);
    expect(
      __test.historicalSourcesReady(
        "M02",
        result,
        { SPY: spy.receipt, QQQ: qqq.receipt },
        { SPY: spy.raw, QQQ: qqq.raw },
      ),
    ).toBe(false);
    const full = yahooFixture("SPY");
    const tnx = yahooFixture("^TNX");
    const receipts = { SPY: full.receipt, "^TNX": tnx.receipt };
    const raw = { SPY: full.raw, "^TNX": tnx.raw };
    expect(
      __test.historicalSourcesReady(
        "M03",
        { sample: { start: "2026-01-05", end: "2026-01-06", observations: 3 } },
        receipts,
        raw,
      ),
    ).toBe(false);
  });

  it("derives M07 price and NAV inputs from its rows and the run manifest", () => {
    const price = yahooFixture("UTF");
    const nav = yahooFixture("XUTFX");
    const data = { results: [{ cef: "UTF", nav_proxy: "XUTFX" }], data: "monthly observations" };
    const manifest = { start: "2026-01-05", end_requested: "2026-01-07" };
    const receipts = { UTF: price.receipt, XUTFX: nav.receipt };
    const raw = { UTF: price.raw, XUTFX: nav.raw };
    expect(__test.historicalSourcesReady("M07", data, receipts, raw, manifest)).toBe(true);
    expect(__test.historicalSourcesReady("M07", data, receipts, raw)).toBe(false);
    expect(__test.historicalSourcesReady("M07", data, { UTF: price.receipt }, raw, manifest)).toBe(
      false,
    );
  });

  it("aligns M04 by independent month closes, including weekend month-end labels", () => {
    const monthly = (symbol: string, dates: string[]) => {
      const source = yahooFixture(symbol, dates);
      const url = new URL(source.receipt.source_url);
      url.searchParams.set("period2", String(Date.parse("2026-04-01") / 1000));
      return {
        ...source,
        receipt: { ...source.receipt, source_url: url.href, fetched_at: "2026-04-01T00:00:00Z" },
      };
    };
    const qqq = monthly("QQQ", ["2026-01-30", "2026-02-26", "2026-03-31"]);
    const spy = monthly("SPY", ["2026-01-29", "2026-02-27", "2026-03-30"]);
    const result = {
      target: "QQQ",
      factor_proxies: ["SPY"],
      sample: {
        start: "2026-02-28",
        end: "2026-03-31",
        monthly_observations: 2,
      },
    };
    const receipts = { QQQ: qqq.receipt, SPY: spy.receipt };
    const raw = { QQQ: qqq.raw, SPY: spy.raw };
    expect(__test.historicalSourcesReady("M04", result, receipts, raw)).toBe(true);
    expect(
      __test.historicalSourcesReady(
        "M04",
        { ...result, sample: { ...result.sample, monthly_observations: 3 } },
        receipts,
        raw,
      ),
    ).toBe(false);
  });

  it("requires M03's next SPY close beyond the final signal date", () => {
    const spy = yahooFixture("SPY", ["2026-01-05", "2026-01-06"]);
    const tnx = yahooFixture("^TNX");
    const sample = { sample: { start: "2026-01-05", end: "2026-01-06", observations: 2 } };
    const receipts = { SPY: spy.receipt, "^TNX": tnx.receipt };
    const raw = { SPY: spy.raw, "^TNX": tnx.raw };
    expect(__test.historicalSourcesReady("M03", sample, receipts, raw)).toBe(false);
    const next = yahooFixture("SPY");
    expect(
      __test.historicalSourcesReady(
        "M03",
        sample,
        { ...receipts, SPY: next.receipt },
        { ...raw, SPY: next.raw },
      ),
    ).toBe(true);
  });

  it("binds M09 to each event's tickers and exact entry and exit closes without a sample field", () => {
    const { event } = eventFixture();
    const { receipts, raw } = sources();
    expect(__test.historicalSourcesReady("M09", { events: [event] }, receipts, raw)).toBe(true);
    expect(
      __test.historicalSourcesReady(
        "M09",
        { events: [{ ...event, exit_date: event.entry_date }] },
        receipts,
        raw,
      ),
    ).toBe(true);
    const incomplete = yahooFixture("QQQ", ["2026-01-05", "2026-01-07"]);
    expect(
      __test.historicalSourcesReady(
        "M09",
        { events: [event] },
        { ...receipts, QQQ: incomplete.receipt },
        { ...raw, QQQ: incomplete.raw },
      ),
    ).toBe(false);
    expect(
      __test.historicalSourcesReady(
        "M09",
        { events: [{ ...event, tickers: ["MISSING"] }] },
        receipts,
        raw,
      ),
    ).toBe(false);
  });
});

describe("official announcement source binding", () => {
  it("matches every event to its retained announcement bytes, URL and publication date", () => {
    const { event, receipts, raw } = eventFixture();
    expect(__test.officialEventSourcesReady([event], receipts, raw)).toBe(true);
    expect(__test.officialEventSourcesReady([event], receipts, {})).toBe(false);
    expect(__test.officialEventSourcesReady([event, event], receipts, raw)).toBe(false);
    expect(
      __test.officialEventSourcesReady(
        [{ ...event, announcement_date: "2025-01-05" }],
        receipts,
        raw,
      ),
    ).toBe(false);
    expect(
      __test.officialEventSourcesReady(
        [{ ...event, source_receipt: { ...event.source_receipt, raw_sha256: "0".repeat(64) } }],
        receipts,
        raw,
      ),
    ).toBe(false);
  });

  it("rejects a different article or publication date even after its hash is updated", () => {
    const { event } = eventFixture();
    for (const html of [
      '<link rel="canonical" href="https://press.spglobal.com/2026-01-05-Other" /><!-- ITEMDATE: 2026-01-05 18:00:00 EST -->',
      '<link rel="canonical" href="https://press.spglobal.com/2026-01-05-Announcement,-Inc" /><!-- ITEMDATE: 2025-01-05 18:00:00 EST -->',
    ]) {
      const bytes = Buffer.from(html);
      const receipt = {
        ...event.source_receipt,
        raw_sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
      };
      expect(
        __test.officialEventSourcesReady(
          [{ ...event, source_receipt: receipt }],
          { [event.event_id]: receipt },
          { [event.event_id]: bytes },
        ),
      ).toBe(false);
    }
  });
});
