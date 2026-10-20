import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createFinanceFutuDataClient,
  createFutuDataCollectionAdapters,
  normalizeFinanceFutuSymbol,
  type FinanceFutuDataClientOptions,
  type FinanceFutuDataCollectionOptions,
} from "./finance-futu-data-source.js";
import { assessFinanceHistoryCoverage } from "./finance-history-coverage.js";
import type { FetchImpl } from "./finance-live-market-source.js";
import {
  createFinanceMarketCollectionRegistry,
  runFinanceMarketCollectionRefresh,
  type FinanceMarketCollectionRequest,
} from "./finance-market-collection-registry.js";

const now = new Date("2026-10-19T12:00:00Z");
const barTime = Date.parse("2026-10-16T04:00:00Z");
const reportTime = Date.parse("2026-03-31T00:00:00Z");
const historyRequest = { symbol: "US.AAPL", start: "2026-10-15", end: "2026-10-16" };
const authorization = () => ({
  accessToken: "fixture-secret-not-for-evidence",
  scopes: ["quote:read"],
  expiresAt: "2026-10-20T00:00:00Z",
});
const bar = (fields: Record<string, unknown> = {}) => ({
  time_key: barTime,
  date: 20261016,
  time_zone: -240,
  open: 100,
  close: 101,
  high: 102,
  low: 99,
  volume: 30,
  turnover: 3015,
  last_close: 99,
  name: "Apple",
  ...fields,
});
const report = (fields: Record<string, unknown> = {}) => ({
  date_time: reportTime,
  fiscal_year: 2026,
  financial_type: 1,
  structure: 8,
  currency_code: "USD",
  accounting_standards: "US_GAAP",
  period_text: "2026/Q1",
  item_list: [
    { field_id: 1, display_name: "Total Revenue", value_type: "amount", data: 1200, yoy: 5 },
  ],
  ...fields,
});
const historyPayload = (fields: Record<string, unknown> = {}) => ({
  ret_code: 0,
  data: { kline_list: [bar()], volume_precision: 0, ...fields },
});
const financialPayload = (fields: Record<string, unknown> = {}) => ({
  ret_code: 0,
  data: { report_list: [report()], ...fields },
  pagination: { has_more: false },
});
function fetchPayload(payload: unknown) {
  return vi.fn<FetchImpl>(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  }));
}
function client(fetchImpl: FetchImpl, overrides: FinanceFutuDataClientOptions = {}) {
  return createFinanceFutuDataClient({
    fetchImpl,
    resolveQuoteReadAuthorization: async () => authorization(),
    retry: { attempts: 1 },
    ...overrides,
  });
}
const collectionRequest = (
  fields: Partial<FinanceMarketCollectionRequest> = {},
): FinanceMarketCollectionRequest => ({
  instrument: "US.AAPL",
  assetClass: "us_equity",
  collection: "eod_history",
  asOf: now.toISOString(),
  asOfMode: "live_now",
  fromDate: historyRequest.start,
  toDate: historyRequest.end,
  limit: 2,
  ...fields,
});
function adapterOptions(fetchImpl: FetchImpl): FinanceFutuDataCollectionOptions {
  return {
    fetchImpl,
    retry: { attempts: 1 },
    resolveQuoteReadAuthorization: async () => authorization(),
    resolveHistoryBarMetadata: async ({ symbol }) => ({
      symbol,
      currency: "USD",
      completed: true,
      availableAt: "2026-10-16T20:15:00Z",
      evidenceRef: "fixture:exchange-close-and-currency",
    }),
    resolveFinancialReportMetadata: async ({ symbol }) => ({
      symbol,
      availableAt: "2026-05-01T00:00:00Z",
      evidenceRef: "fixture:issuer-publication",
    }),
  };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

it("constructs no registered adapter or network activity without explicit authorization and metadata seams", () => {
  const f = fetchPayload(historyPayload());
  expect(createFutuDataCollectionAdapters({ fetchImpl: f })).toEqual([]);
  expect(
    createFutuDataCollectionAdapters({
      fetchImpl: f,
      resolveQuoteReadAuthorization: async () => authorization(),
    }),
  ).toEqual([]);
  expect(f).not.toHaveBeenCalled();
});
it.each(["US.AAPL", "US.BRK.B", "HK.00700", "SH.600000", "SZ.000001", "BJ.430047"])(
  "keeps qualified symbol %s",
  (symbol) => {
    expect(normalizeFinanceFutuSymbol(symbol.toLowerCase())).toBe(symbol);
  },
);
it.each([
  "AAPL",
  "00700",
  "HK.700",
  "HK.99999999",
  "SG.D05",
  "US../AAPL",
  "US.AAPL?account=x",
  "FX.USDHKD",
])("rejects unsupported or ambiguous symbol %s before dispatch", async (symbol) => {
  const f = fetchPayload(historyPayload());
  await expect(client(f).readDailyHistory({ ...historyRequest, symbol })).rejects.toMatchObject({
    reason: "invalid_request",
  });
  expect(f).not.toHaveBeenCalled();
});
it("calls only the documented GET history route, keeps adjustment and raw units, and never puts authorization in evidence", async () => {
  const f = fetchPayload(historyPayload());
  const page = await client(f).readDailyHistory(historyRequest);
  const [url, init] = f.mock.calls[0];
  expect(url).toBe(
    "https://webapi.futunn.com/api/v1.0/quote/US.AAPL/history-kline?start=2026-10-15&end=2026-10-16&ktype=2&autype=0&num=370",
  );
  expect(init?.headers).toEqual({ Authorization: `Bearer ${authorization().accessToken}` });
  expect(init).not.toHaveProperty("method");
  expect(page).toMatchObject({
    symbol: "US.AAPL",
    adjustment: 0,
    volumePrecision: 0,
    bars: [
      {
        sourceTime: new Date(barTime).toISOString(),
        localDate: "2026-10-16",
        timeZoneMinutes: -240,
        raw: { volume: 30, last_close: 99 },
      },
    ],
  });
  expect(page.responseSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(JSON.stringify(page)).not.toContain(authorization().accessToken);
  expect(page.gaps).toContain("currency_not_supplied_by_endpoint");
});
it("uses documented financial cursor/enum fields and keeps the report period distinct from publication", async () => {
  const f = fetchPayload(financialPayload());
  const page = await client(f).readFinancialStatements({
    symbol: "HK.00700",
    statementType: 1,
    financialType: 1,
    currencyCode: "USD",
    limit: 2,
    nextKey: "2026_1/opaque+",
  });
  const url = new URL(f.mock.calls[0][0]);
  expect(url.pathname).toBe("/api/v1.0/quote/HK.00700/financials/statements");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    statement_type: "1",
    financial_type: "1",
    currency_code: "USD",
    limit: "2",
    next_key: "2026_1/opaque+",
  });
  expect(page.reports[0]).toMatchObject({
    reportPeriod: new Date(reportTime).toISOString(),
    currency: "USD",
    raw: { period_text: "2026/Q1", accounting_standards: "US_GAAP" },
  });
  expect(page.reports[0]).not.toHaveProperty("availableAt");
  expect(page.gaps).toContain("publication_and_vintage_not_supplied_by_endpoint");
});
it.each([
  ["missing authorization", undefined, "authorization_unavailable"],
  [
    "missing quote read scope",
    { ...authorization(), scopes: ["openid", "trade:write"] },
    "quote_read_scope_required",
  ],
  [
    "watchlist write scope",
    { ...authorization(), scopes: ["quote:write"] },
    "quote_read_scope_required",
  ],
  ["expired token", { ...authorization(), expiresAt: now.toISOString() }, "authorization_expired"],
  [
    "header injection",
    { ...authorization(), accessToken: "bad\r\nheader" },
    "quote_read_scope_required",
  ],
] as const)("blocks %s before HTTP", async (_name, value, reason) => {
  const f = fetchPayload(historyPayload());
  await expect(
    client(f, { resolveQuoteReadAuthorization: async () => value }).readDailyHistory(
      historyRequest,
    ),
  ).rejects.toMatchObject({ kind: "forbidden", reason });
  expect(f).not.toHaveBeenCalled();
});
it("sanitizes resolver failure text", async () => {
  const f = fetchPayload(historyPayload());
  await expect(
    client(f, {
      resolveQuoteReadAuthorization: async () => {
        throw new Error("secret-token-should-not-escape");
      },
    }).readDailyHistory(historyRequest),
  ).rejects.toMatchObject({ message: "Futunn data authorization_unavailable" });
  expect(f).not.toHaveBeenCalled();
});
it("allows an existing grant with extra scopes while dispatching only the fixed quote GET", async () => {
  const f = fetchPayload(historyPayload());
  await client(f, {
    resolveQuoteReadAuthorization: async () => ({
      ...authorization(),
      scopes: ["openid", "quote:read", "trade:write"],
    }),
  }).readDailyHistory(historyRequest);
  expect(f).toHaveBeenCalledTimes(1);
  expect(new URL(f.mock.calls[0][0]).pathname).toBe("/api/v1.0/quote/US.AAPL/history-kline");
  expect(f.mock.calls[0][1]).not.toHaveProperty("method");
});
it.each([
  [-12006, "forbidden"],
  [-12009, "forbidden"],
  [-12102, "forbidden"],
  [-12011, "rate_limited"],
  [-12301, "timeout"],
  [-10, "source_error"],
] as const)(
  "classifies vendor error %s without refresh or retry side effects",
  async (ret_code, kind) => {
    const f = fetchPayload({ ret_code, ret_msg: authorization().accessToken, data: {} });
    await expect(client(f).readDailyHistory(historyRequest)).rejects.toMatchObject({
      vendorRetCode: ret_code,
      kind,
      message: `Futunn data ${ret_code === -10 ? "no_data" : "provider_error"} (${ret_code})`,
    });
    expect(f).toHaveBeenCalledTimes(1);
  },
);
it("honors governed HTTP 429 and Retry-After without retrying sooner than the budget", async () => {
  const f = vi.fn<FetchImpl>(async () => ({
    ok: false,
    status: 429,
    headers: { get: () => "120" },
    text: async () => "",
  }));
  await expect(
    client(f, { timeoutMs: 100, retry: { attempts: 2 } }).readDailyHistory(historyRequest),
  ).rejects.toMatchObject({ kind: "http_error", httpStatus: 429, retryAfterMs: 120000 });
  expect(f).toHaveBeenCalledTimes(1);
});
it("keeps cached fetchedAt rather than restamping reused evidence", async () => {
  const fetchedAt = "2026-10-19T11:00:00Z";
  const f = vi.fn<FetchImpl>(async () => ({
    ok: true,
    status: 200,
    dataAccess: { kind: "cache", fetchedAt, ageMs: 3600000 },
    text: async () => JSON.stringify(historyPayload()),
  }));
  expect((await client(f).readDailyHistory(historyRequest)).observedAt).toBe(fetchedAt);
});
it("cancels before dispatch and prevents a late authorization resolver from dispatching", async () => {
  const f = fetchPayload(historyPayload());
  const controller = new AbortController();
  let finish!: (value: ReturnType<typeof authorization>) => void;
  let started!: () => void;
  const resolverStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = client(f, {
    resolveQuoteReadAuthorization: () =>
      new Promise((resolve) => {
        finish = resolve;
        started();
      }),
  }).readDailyHistory(historyRequest, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ kind: "cancelled" });
  await resolverStarted;
  controller.abort();
  await rejected;
  finish(authorization());
  await Promise.resolve();
  await Promise.resolve();
  expect(f).not.toHaveBeenCalled();
});
it("bounds the authorization resolver within the original API deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const f = fetchPayload(historyPayload());
  const pending = client(f, {
    timeoutMs: 20,
    resolveQuoteReadAuthorization: () => new Promise(() => {}),
  }).readDailyHistory(historyRequest);
  const rejected = expect(pending).rejects.toMatchObject({ kind: "timeout" });
  await vi.advanceTimersByTimeAsync(21);
  await rejected;
  expect(f).not.toHaveBeenCalled();
});
it.each([
  ["foreign instrument", { symbol: "US.TSLA" }, "identity_mismatch"],
  ["missing time", { time_key: undefined }, "invalid_source_time"],
  ["seconds instead of milliseconds", { time_key: barTime / 1000 }, "invalid_source_time"],
  ["future time", { time_key: now.getTime() + 1 }, "invalid_source_time"],
  ["date outside window", { date: 20261014 }, "invalid_source_time"],
  ["date and timezone disagree", { time_zone: -300 }, "invalid_source_time"],
  ["invalid OHLC", { high: 100 }, "invalid_response"],
  ["numeric string", { volume: "30" }, "invalid_response"],
] as const)(
  "rejects history %s instead of changing identity or inventing source fields",
  async (_name, fields, reason) => {
    await expect(
      client(fetchPayload(historyPayload({ kline_list: [bar(fields)] }))).readDailyHistory(
        historyRequest,
      ),
    ).rejects.toMatchObject({ reason });
  },
);
it("retains missing local date/timezone in raw reads but cannot qualify those bars", async () => {
  const f = fetchPayload(
    historyPayload({ kline_list: [bar({ date: undefined, time_zone: undefined })] }),
  );
  expect((await client(f).readDailyHistory(historyRequest)).gaps).toEqual(
    expect.arrayContaining(["local_date_missing", "timezone_missing"]),
  );
  const receipt = await runFinanceMarketCollectionRefresh({
    request: collectionRequest(),
    adapters: createFutuDataCollectionAdapters(adapterOptions(f)),
  });
  expect(receipt.status).toBe("blocked");
  expect(receipt.records).toEqual([]);
});
it("retains ambiguous history continuation without inventing an end-date cursor", async () => {
  const f = fetchPayload(historyPayload({ next_time: barTime - 86400000 }));
  const page = await client(f).readDailyHistory(historyRequest);
  expect(page).toMatchObject({
    nextTime: barTime - 86400000,
    gaps: expect.arrayContaining(["next_time_end_format_ambiguous"]),
  });
  const capture = vi.fn(async () => "fixture:partial-history");
  const receipt = await runFinanceMarketCollectionRefresh({
    request: collectionRequest(),
    adapters: createFutuDataCollectionAdapters({
      ...adapterOptions(f),
      captureRawResponse: capture,
    }),
  });
  expect(receipt.status).toBe("ready");
  expect(receipt.records[0].data).toMatchObject({
    requestedWindow: { start: historyRequest.start, end: historyRequest.end },
    continuation: { nextTime: barTime - 86400000 },
    sourceGaps: expect.arrayContaining(["next_time_end_format_ambiguous"]),
  });
  expect(capture).toHaveBeenCalledTimes(1);
  expect(f).toHaveBeenCalledTimes(2);
});
it.each([
  ["missing report period", { date_time: undefined }, "invalid_source_time"],
  ["future report period", { date_time: now.getTime() + 1 }, "invalid_source_time"],
  ["missing currency", { currency_code: undefined }, "invalid_currency"],
  ["invalid report period type", { financial_type: 10 }, "invalid_response"],
  [
    "nonfinite field",
    { item_list: [{ field_id: 1, display_name: "Revenue", value_type: "amount", data: "NaN" }] },
    "invalid_response",
  ],
] as const)("rejects financial %s", async (_name, fields, reason) => {
  await expect(
    client(
      fetchPayload(financialPayload({ report_list: [report(fields)] })),
    ).readFinancialStatements({ symbol: "US.AAPL" }),
  ).rejects.toMatchObject({ reason });
});
it("delivers independently attested EOD evidence through the original collection gate", async () => {
  const receipt = await runFinanceMarketCollectionRefresh({
    request: collectionRequest(),
    adapters: createFutuDataCollectionAdapters(adapterOptions(fetchPayload(historyPayload()))),
  });
  expect(receipt.status).toBe("ready");
  expect(receipt.records).toHaveLength(1);
  expect(receipt.records[0]).toMatchObject({
    sourceTimestamp: new Date(barTime).toISOString(),
    delayStatus: "end_of_day",
    data: {
      symbol: "US.AAPL",
      currency: "USD",
      providerSourceTimestamp: new Date(barTime).toISOString(),
      adjustment: 0,
      availableAt: "2026-10-16T20:15:00Z",
      vintageVerification: "not_established_by_this_endpoint",
    },
  });
});
it.each([
  "missing",
  "wrong_currency",
  "foreign_symbol",
  "future_availability",
  "before_bar",
  "not_completed",
])("blocks unqualified EOD metadata %s", async (kind) => {
  const opts = adapterOptions(fetchPayload(historyPayload()));
  opts.resolveHistoryBarMetadata = async () =>
    kind === "missing"
      ? undefined
      : {
          symbol: kind === "foreign_symbol" ? "US.TSLA" : "US.AAPL",
          currency: kind === "wrong_currency" ? "" : "USD",
          completed: kind === "not_completed" ? (false as unknown as true) : true,
          evidenceRef: "fixture:metadata",
          availableAt:
            kind === "future_availability"
              ? "2026-10-20T00:00:00Z"
              : kind === "before_bar"
                ? "2026-10-15T00:00:00Z"
                : "2026-10-16T20:15:00Z",
        };
  const receipt = await runFinanceMarketCollectionRefresh({
    request: collectionRequest(),
    adapters: createFutuDataCollectionAdapters(opts),
  });
  expect(receipt.status).toBe("blocked");
  expect(receipt.records).toEqual([]);
});
it("uses real financial availability for the historical cutoff while retaining the unverified vintage boundary", async () => {
  const opts = adapterOptions(fetchPayload(financialPayload()));
  const request = collectionRequest({
    collection: "financial_statements",
    asOfMode: "historical",
    asOf: "2026-06-01T00:00:00Z",
    fromDate: undefined,
    toDate: undefined,
  });
  const receipt = await runFinanceMarketCollectionRefresh({
    request,
    adapters: createFutuDataCollectionAdapters(opts),
  });
  expect(receipt.status).toBe("ready");
  expect(receipt.records[0]).toMatchObject({
    sourceTimestamp: "2026-05-01T00:00:00Z",
    data: {
      reportPeriod: new Date(reportTime).toISOString(),
      vintageVerification: "not_established_by_this_endpoint",
    },
  });
  const blocked = await runFinanceMarketCollectionRefresh({
    request: { ...request, asOf: "2026-04-01T00:00:00Z" },
    adapters: createFutuDataCollectionAdapters(opts),
  });
  expect(blocked.status).toBe("blocked");
  expect(blocked.records).toEqual([]);
});
it("does not treat report period as publication when the publication resolver has no evidence", async () => {
  const receipt = await runFinanceMarketCollectionRefresh({
    request: collectionRequest({
      collection: "financial_statements",
      fromDate: undefined,
      toDate: undefined,
    }),
    adapters: createFutuDataCollectionAdapters({
      ...adapterOptions(fetchPayload(financialPayload())),
      resolveFinancialReportMetadata: async () => undefined,
    }),
  });
  expect(receipt.status).toBe("blocked");
  expect(receipt.records).toEqual([]);
});
it("keeps a bounded financial page and its continuation without claiming complete report history", async () => {
  const f = fetchPayload({
    ...financialPayload(),
    pagination: { has_more: true, next_key: "2026_1" },
  });
  const receipt = await runFinanceMarketCollectionRefresh({
    request: collectionRequest({
      collection: "financial_statements",
      fromDate: undefined,
      toDate: undefined,
    }),
    adapters: createFutuDataCollectionAdapters(adapterOptions(f)),
  });
  expect(receipt.status).toBe("ready");
  expect(f).toHaveBeenCalledTimes(1);
  expect(receipt.records[0].data).toMatchObject({
    pagination: { hasMore: true, nextKey: "2026_1" },
    sourceGaps: expect.arrayContaining(["more_reports_available"]),
    coverage: "explicit_bounded_request_not_full_history",
  });
});
it("validates the full returned bounded page rather than hiding a corrupt final row", async () => {
  const f = fetchPayload(
    historyPayload({
      kline_list: [bar(), bar({ time_key: barTime - 86400000, date: 20261015, close: "invalid" })],
    }),
  );
  await expect(client(f).readDailyHistory({ ...historyRequest, limit: 2 })).rejects.toMatchObject({
    reason: "invalid_response",
  });
});
it.each([
  { start: "2026-02-30" },
  { end: "2026-10-20" },
  { start: "2026-10-17" },
  { limit: 371 },
  { limit: 0 },
])("rejects invalid date windows or page bounds before dispatch: %j", async (fields) => {
  const f = fetchPayload(historyPayload());
  await expect(client(f).readDailyHistory({ ...historyRequest, ...fields })).rejects.toMatchObject({
    reason: "invalid_request",
  });
  expect(f).not.toHaveBeenCalled();
});
it("keeps HTTP permission denial under the original transport contract", async () => {
  const f = vi.fn<FetchImpl>(async () => ({
    ok: false,
    status: 403,
    text: async () => "private vendor text",
  }));
  await expect(client(f).readFinancialStatements({ symbol: "US.AAPL" })).rejects.toMatchObject({
    kind: "forbidden",
    httpStatus: 403,
  });
  expect(f).toHaveBeenCalledTimes(1);
});
it("rejects a requested/report currency mismatch", async () => {
  await expect(
    client(fetchPayload(financialPayload())).readFinancialStatements({
      symbol: "US.AAPL",
      currencyCode: "HKD",
    }),
  ).rejects.toMatchObject({ reason: "invalid_currency" });
});
it("accepts an already-reported fiscal year that ends in the next calendar year", async () => {
  const f = fetchPayload(financialPayload({ report_list: [report({ fiscal_year: 2027 })] }));
  expect(
    (await client(f).readFinancialStatements({ symbol: "US.AAPL" })).reports[0].raw.fiscal_year,
  ).toBe(2027);
});
it("retains distinct report structures without duplicate collection identities", async () => {
  const f = fetchPayload(
    financialPayload({ report_list: [report({ structure: 14 }), report({ structure: 15 })] }),
  );
  const receipt = await runFinanceMarketCollectionRefresh({
    request: collectionRequest({
      collection: "financial_statements",
      fromDate: undefined,
      toDate: undefined,
    }),
    adapters: createFutuDataCollectionAdapters(adapterOptions(f)),
  });
  expect(receipt.status).toBe("ready");
  expect(new Set(receipt.records.map((item) => item.itemId)).size).toBe(2);
});
it("preserves a specific qualification failure in the original failed source receipt", async () => {
  const opts = adapterOptions(fetchPayload(historyPayload()));
  opts.resolveHistoryBarMetadata = async ({ symbol }) => ({
    symbol,
    currency: "",
    completed: true,
    availableAt: "2026-10-16T20:15:00Z",
    evidenceRef: "fixture:metadata",
  });
  const receipt = await runFinanceMarketCollectionRefresh({
    request: collectionRequest(),
    adapters: createFutuDataCollectionAdapters(opts),
  });
  expect(receipt.status).toBe("blocked");
  expect(JSON.stringify(receipt.sourceAttempts)).toContain("currency_metadata_missing");
});
it("does not enable a foreign asset-class mapping or infer a US listing", () => {
  const adapters = createFutuDataCollectionAdapters(adapterOptions(fetchPayload(historyPayload())));
  expect(
    adapters.some((adapter) => adapter.supports(collectionRequest({ assetClass: "hk_equity" }))),
  ).toBe(false);
  expect(
    adapters.some((adapter) => adapter.supports(collectionRequest({ instrument: "AAPL" }))),
  ).toBe(false);
  expect(
    adapters.some((adapter) =>
      adapter.supports(collectionRequest({ instrument: "HK.00700", assetClass: "equity" })),
    ),
  ).toBe(true);
  expect(
    adapters.some((adapter) =>
      adapter.supports(collectionRequest({ instrument: "SH.600000", assetClass: "stock" })),
    ),
  ).toBe(true);
});
it("keeps valid empty source responses empty instead of manufacturing research evidence", async () => {
  const f = fetchPayload(historyPayload({ kline_list: [] }));
  expect((await client(f).readDailyHistory(historyRequest)).bars).toEqual([]);
  const receipt = await runFinanceMarketCollectionRefresh({
    request: collectionRequest(),
    adapters: createFutuDataCollectionAdapters(adapterOptions(f)),
  });
  expect(receipt.status).toBe("blocked");
  expect(receipt.records).toEqual([]);
});
it("keeps qualified financial rows and the missing pagination gap without claiming complete history", async () => {
  const f = fetchPayload({ ret_code: 0, data: { report_list: [report()] } });
  expect((await client(f).readFinancialStatements({ symbol: "US.AAPL" })).gaps).toContain(
    "pagination_missing",
  );
  const receipt = await runFinanceMarketCollectionRefresh({
    request: collectionRequest({
      collection: "financial_statements",
      fromDate: undefined,
      toDate: undefined,
    }),
    adapters: createFutuDataCollectionAdapters(adapterOptions(f)),
  });
  expect(receipt.status).toBe("ready");
  expect(receipt.records[0].data).toMatchObject({
    sourceGaps: expect.arrayContaining(["pagination_missing"]),
    coverage: "explicit_bounded_request_not_full_history",
  });
});
it("aborts a slow response body under the original deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const f = vi.fn<FetchImpl>(async () => ({
    ok: true,
    status: 200,
    text: () => new Promise(() => {}),
  }));
  const pending = client(f, { timeoutMs: 20 }).readDailyHistory(historyRequest);
  const rejected = expect(pending).rejects.toMatchObject({ kind: "timeout" });
  await vi.advanceTimersByTimeAsync(21);
  await rejected;
  expect(f).toHaveBeenCalledTimes(1);
});
it("uses the existing additionalAdapters registry entry and retains missing metadata reasons", async () => {
  const f = fetchPayload(historyPayload({ kline_list: [bar({ time_zone: 480 })] }));
  const request = collectionRequest({ instrument: "HK.00700", assetClass: "hk_equity" });
  const options = adapterOptions(f);
  options.resolveHistoryBarMetadata = async ({ symbol }) => ({
    symbol,
    currency: "HKD",
    completed: true,
    availableAt: "2026-10-16T08:15:00Z",
    evidenceRef: "fixture:HK-exchange-close-and-currency",
  });
  const adapters = createFinanceMarketCollectionRegistry({
    fetchImpl: f,
    additionalAdapters: createFutuDataCollectionAdapters(options),
  });
  const receipt = await runFinanceMarketCollectionRefresh({ request, adapters });
  expect(receipt.status).toBe("ready");
  expect(receipt.records).toHaveLength(1);
  expect(receipt.records[0].data).toMatchObject({
    symbol: "HK.00700",
    currency: "HKD",
    timezoneOffsetMinutes: 480,
    time_zone: 480,
  });
  expect(f).toHaveBeenCalledTimes(1);
  const unqualified = createFinanceMarketCollectionRegistry({
    fetchImpl: f,
    additionalAdapters: createFutuDataCollectionAdapters({
      ...options,
      resolveHistoryBarMetadata: async () => undefined,
    }),
  });
  const missingAvailability = await runFinanceMarketCollectionRefresh({
    request,
    adapters: unqualified,
  });
  expect(missingAvailability.status).toBe("blocked");
  expect(missingAvailability.records).toEqual([]);
  expect(JSON.stringify(missingAvailability.sourceAttempts)).toContain("availability_missing");
  const missingCurrency = createFinanceMarketCollectionRegistry({
    fetchImpl: f,
    additionalAdapters: createFutuDataCollectionAdapters({
      ...options,
      resolveHistoryBarMetadata: async ({ symbol }) => ({
        symbol,
        currency: "",
        completed: true,
        availableAt: "2026-10-16T08:15:00Z",
        evidenceRef: "fixture:availability-only",
      }),
    }),
  });
  const currencyReceipt = await runFinanceMarketCollectionRefresh({
    request,
    adapters: missingCurrency,
  });
  expect(currencyReceipt.status).toBe("blocked");
  expect(currencyReceipt.records).toEqual([]);
  expect(JSON.stringify(currencyReceipt.sourceAttempts)).toContain("currency_metadata_missing");
});
it("preserves qualified bars and each rejected bar reason without fetching a replacement page", async () => {
  const f = fetchPayload(
    historyPayload({
      next_time: barTime - 2 * 86400000,
      kline_list: [bar(), bar({ time_key: barTime - 86400000, date: 20261015 })],
    }),
  );
  const options = adapterOptions(f);
  options.resolveHistoryBarMetadata = async ({ symbol, bar: value }) =>
    value.localDate === "2026-10-15"
      ? undefined
      : {
          symbol,
          currency: "USD",
          completed: true,
          availableAt: "2026-10-16T20:15:00Z",
          evidenceRef: "fixture:one-qualified-bar",
        };
  const receipt = await runFinanceMarketCollectionRefresh({
    request: collectionRequest(),
    adapters: createFutuDataCollectionAdapters(options),
  });
  expect(receipt.status).toBe("ready");
  expect(f).toHaveBeenCalledTimes(1);
  expect(receipt.records).toHaveLength(1);
  expect(receipt.records[0].data).toMatchObject({
    returnedRecordCount: 2,
    qualifiedRecordCount: 1,
    excludedItems: [
      {
        sourceRecordId: `US.AAPL:1:${new Date(barTime - 86400000).toISOString()}`,
        reason: "availability_missing",
      },
    ],
    sourceGaps: expect.arrayContaining(["next_time_end_format_ambiguous"]),
  });
});
it("feeds normalized trading dates to the original coverage owner while retaining later availability separately", async () => {
  const f = fetchPayload(
    historyPayload({ kline_list: [bar(), bar({ time_key: barTime - 86400000, date: 20261015 })] }),
  );
  const options = adapterOptions(f);
  options.resolveHistoryBarMetadata = async ({ symbol }) => ({
    symbol,
    currency: "USD",
    completed: true,
    availableAt: "2026-10-18T00:00:00Z",
    evidenceRef: "fixture:later-verified-availability",
  });
  const request = collectionRequest({ limit: 3 });
  const receipt = await runFinanceMarketCollectionRefresh({
    request,
    adapters: createFinanceMarketCollectionRegistry({
      fetchImpl: f,
      additionalAdapters: createFutuDataCollectionAdapters(options),
    }),
  });
  expect(receipt.status).toBe("ready");
  expect(receipt.records[0]).toMatchObject({
    sourceTimestamp: new Date(barTime).toISOString(),
    data: { date: "2026-10-16", vendorDate: 20261016, availableAt: "2026-10-18T00:00:00Z" },
  });
  expect(assessFinanceHistoryCoverage(request, receipt.records)).toMatchObject({
    status: "complete",
    expectedDays: 2,
    providers: [{ coveredDays: 2, complete: true }],
  });
  for (const assetClass of ["hk_equity", "cn_equity"]) {
    expect(assessFinanceHistoryCoverage({ ...request, assetClass }, receipt.records).status).toBe(
      "unverified",
    );
  }
});
it("normalizes scaled Futunn volume at the original registry boundary and preserves vendor units", async () => {
  const f = fetchPayload(
    historyPayload({ volume_precision: 2, kline_list: [bar({ volume: 3000 })] }),
  );
  const receipt = await runFinanceMarketCollectionRefresh({
    request: collectionRequest(),
    adapters: createFinanceMarketCollectionRegistry({
      fetchImpl: f,
      additionalAdapters: createFutuDataCollectionAdapters(adapterOptions(f)),
    }),
  });
  expect(receipt.status).toBe("ready");
  expect(receipt.records[0].data).toMatchObject({
    volume: 30,
    vendorVolume: 3000,
    volumePrecision: 2,
  });
});
it("rejects a non-ISO currency instead of publishing a ready canonical currency and unit", async () => {
  const f = fetchPayload(historyPayload());
  const options = adapterOptions(f);
  options.resolveHistoryBarMetadata = async ({ symbol }) => ({
    symbol,
    currency: "ZZZ",
    completed: true,
    availableAt: "2026-10-16T20:15:00Z",
    evidenceRef: "fixture:unrecognized-currency",
  });
  const receipt = await runFinanceMarketCollectionRefresh({
    request: collectionRequest(),
    adapters: createFinanceMarketCollectionRegistry({
      fetchImpl: f,
      additionalAdapters: createFutuDataCollectionAdapters(options),
    }),
  });
  expect(receipt.status).toBe("blocked");
  expect(receipt.records).toEqual([]);
  expect(JSON.stringify(receipt.sourceAttempts)).toContain("currency_metadata_missing");
});
it("preserves raw volume without exposing an unknown scale as canonical volume", async () => {
  const f = fetchPayload(
    historyPayload({ volume_precision: undefined, kline_list: [bar({ volume: 3000 })] }),
  );
  expect((await client(f).readDailyHistory(historyRequest)).bars[0].raw.volume).toBe(3000);
  const receipt = await runFinanceMarketCollectionRefresh({
    request: collectionRequest(),
    adapters: createFutuDataCollectionAdapters(adapterOptions(f)),
  });
  expect(receipt.status).toBe("ready");
  expect(receipt.records[0].data).not.toHaveProperty("volume");
  expect(receipt.records[0].data).toMatchObject({
    vendorVolume: 3000,
    sourceGaps: expect.arrayContaining(["volume_precision_missing"]),
  });
});
it.each(["ZZZ", "GBX"])(
  "rejects unsupported financial currency %s without implicit unit conversion",
  async (currencyCode) => {
    const f = fetchPayload(
      financialPayload({ report_list: [report({ currency_code: currencyCode })] }),
    );
    await expect(client(f).readFinancialStatements({ symbol: "US.AAPL" })).rejects.toMatchObject({
      reason: "invalid_currency",
    });
    const noDispatch = fetchPayload(financialPayload());
    await expect(
      client(noDispatch).readFinancialStatements({ symbol: "US.AAPL", currencyCode }),
    ).rejects.toMatchObject({ reason: "invalid_request" });
    expect(noDispatch).not.toHaveBeenCalled();
  },
);
