import { createHash } from "node:crypto";
import { ApiCallError, runApiSourceCall, type ApiTransportOptions } from "./api-call-contract.js";
import { DEFAULT_FINANCE_HTTP_BODY_MAX_BYTES } from "./finance-http-body.js";
import { resolveFinanceFetch, type FetchImpl } from "./finance-live-market-source.js";
import type {
  FinanceMarketCollectionAdapter,
  FinanceMarketCollectionItem,
  FinanceMarketCollectionRequest,
  FinanceMarketCollectionRegistryOptions,
} from "./finance-market-collection-registry.js";

const BASE_URL = "https://webapi.futunn.com/api/v1.0/quote/";
const ISO_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));
export const FINANCE_FUTU_DATA_DOCUMENTATION = {
  history: "https://open.futunn.com/api/quote/basic-data/history-kline",
  financials: "https://open.futunn.com/api/quote/financials/statements",
  naming: "https://open.futunn.com/api/quote/naming-dictionary",
} as const;

export type FinanceFutuQuoteReadAuthorization = Readonly<{
  accessToken: string;
  scopes: readonly string[];
  expiresAt: string;
}>;
export type FinanceFutuDataClientOptions = ApiTransportOptions & {
  fetchImpl?: FetchImpl;
  resolveQuoteReadAuthorization?: (
    signal: AbortSignal,
  ) => Promise<FinanceFutuQuoteReadAuthorization | undefined>;
};
type FutuErrorReason =
  | "invalid_request"
  | "authorization_unavailable"
  | "quote_read_scope_required"
  | "authorization_expired"
  | "invalid_response"
  | "identity_mismatch"
  | "invalid_source_time"
  | "invalid_currency"
  | "no_data"
  | "provider_error"
  | "qualification_missing";
type QualificationGap =
  | "availability_missing"
  | "identity_mismatch"
  | "availability_evidence_missing"
  | "availability_invalid"
  | "historical_cutoff_exceeded"
  | "local_date_missing"
  | "timezone_missing"
  | "currency_metadata_missing"
  | "completion_unverified";
type QualificationFailure = Readonly<{ sourceRecordId: string; reason: string }>;

/** Error messages intentionally exclude vendor text, credentials and response bodies. */
export class FinanceFutuDataSourceError extends ApiCallError {
  constructor(
    readonly reason: FutuErrorReason,
    kind: ApiCallError["kind"] = "source_error",
    readonly vendorRetCode?: number,
    readonly qualificationGap?: QualificationGap,
    readonly qualificationFailures?: readonly QualificationFailure[],
  ) {
    super(kind);
    this.name = "FinanceFutuDataSourceError";
    this.message = `Futunn data ${reason}${vendorRetCode === undefined ? "" : ` (${vendorRetCode})`}${qualificationGap === undefined ? "" : ` (${qualificationGap})`}${qualificationFailures?.length ? ` ${JSON.stringify(qualificationFailures)}` : ""}`;
  }
}

function fail(reason: FutuErrorReason): never {
  throw new FinanceFutuDataSourceError(reason);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_response");
  }
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
function sourceTime(value: unknown): number {
  // These endpoints document milliseconds, not seconds or a fallback to request.asOf.
  if (!integer(value, Date.UTC(1900, 0, 1), Date.now())) {
    fail("invalid_source_time");
  }
  return value;
}
function currency(value: unknown): value is string {
  return typeof value === "string" && ISO_CURRENCIES.has(value);
}
function validCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2048 &&
    value
      .split("")
      .every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
  );
}

/** Explicit vendor identity only. No unqualified ticker or cross-market fallback. */
export function normalizeFinanceFutuSymbol(value: string): string | undefined {
  const symbol = value.trim().toUpperCase();
  return /^(?:US\.[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*|HK\.\d{5}|(?:SH|SZ|BJ)\.\d{6})$/u.test(symbol) &&
    symbol.length <= 40
    ? symbol
    : undefined;
}
function checkedSymbol(value: string): string {
  return normalizeFinanceFutuSymbol(value) ?? fail("invalid_request");
}
function checkIdentity(value: Record<string, unknown>, symbol: string): void {
  for (const key of ["symbol", "code"]) {
    if (value[key] !== undefined && value[key] !== symbol) {
      fail("identity_mismatch");
    }
  }
}

type FutuReadProvenance = Readonly<{
  symbol: string;
  sourceUrl: string;
  observedAt: string;
  responseSha256: string;
  body: string;
  httpStatus: number;
}>;
export type FinanceFutuDailyBar = Readonly<{
  raw: Readonly<Record<string, unknown>>;
  sourceTime: string;
  localDate?: string;
  timeZoneMinutes?: number;
}>;
export type FinanceFutuHistoryPage = FutuReadProvenance &
  Readonly<{
    bars: readonly FinanceFutuDailyBar[];
    adjustment: 0 | 1 | 2;
    start: string;
    end: string;
    volumePrecision?: number;
    nextTime?: number;
    gaps: readonly string[];
  }>;
export type FinanceFutuFinancialReport = Readonly<{
  raw: Readonly<Record<string, unknown>>;
  reportPeriod: string;
  currency: string;
  financialType: number;
  structure: number;
}>;
export type FinanceFutuFinancialPage = FutuReadProvenance &
  Readonly<{
    reports: readonly FinanceFutuFinancialReport[];
    statementType: 1 | 2 | 3 | 4;
    financialType: number;
    pagination: Readonly<{ hasMore?: boolean; nextKey?: string }>;
    gaps: readonly string[];
  }>;

/** Only two GET quote endpoints. Authorization lifecycle remains owned by the caller. */
export function createFinanceFutuDataClient(options: FinanceFutuDataClientOptions = {}) {
  async function read(url: URL, symbol: string, signal?: AbortSignal) {
    return runApiSourceCall(
      {
        ...options,
        signal: signal ?? options.signal,
        provider: "futunn",
        source: "futunn-quote-read",
        operation: "read",
        authScopeLabel: "configured_read_only",
      },
      async (activeSignal) => {
        let authorization: FinanceFutuQuoteReadAuthorization | undefined;
        try {
          authorization = await options.resolveQuoteReadAuthorization?.(activeSignal);
        } catch {
          activeSignal.throwIfAborted();
          throw new FinanceFutuDataSourceError("authorization_unavailable", "forbidden");
        }
        activeSignal.throwIfAborted();
        if (!authorization) {
          throw new FinanceFutuDataSourceError("authorization_unavailable", "forbidden");
        }
        if (
          !authorization.scopes.includes("quote:read") ||
          !/^[\x21-\x7e]{1,8192}$/u.test(authorization.accessToken)
        ) {
          throw new FinanceFutuDataSourceError("quote_read_scope_required", "forbidden");
        }
        if (
          !Number.isFinite(Date.parse(authorization.expiresAt)) ||
          Date.parse(authorization.expiresAt) <= Date.now()
        ) {
          throw new FinanceFutuDataSourceError("authorization_expired", "forbidden");
        }
        const response = await resolveFinanceFetch(options.fetchImpl, {
          ...options,
          signal: activeSignal,
        })(url.toString(), {
          headers: { Authorization: `Bearer ${authorization.accessToken}` },
          signal: activeSignal,
        });
        const body = await response.text();
        activeSignal.throwIfAborted();
        if (Buffer.byteLength(body, "utf8") > DEFAULT_FINANCE_HTTP_BODY_MAX_BYTES) {
          fail("invalid_response");
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          fail("invalid_response");
        }
        const payload = record(parsed);
        if (!integer(payload.ret_code, -1_000_000, 1_000_000)) {
          fail("invalid_response");
        }
        if (payload.ret_code !== 0) {
          const code = payload.ret_code;
          const kind = [-12006, -12009, -12102].includes(code)
            ? "forbidden"
            : code === -12011
              ? "rate_limited"
              : code === -12301
                ? "timeout"
                : "source_error";
          throw new FinanceFutuDataSourceError(
            code === -10 ? "no_data" : "provider_error",
            kind,
            code,
          );
        }
        const data = record(payload.data);
        checkIdentity(payload, symbol);
        checkIdentity(data, symbol);
        const observedAt = response.dataAccess?.fetchedAt ?? new Date().toISOString();
        if (!Number.isFinite(Date.parse(observedAt)) || Date.parse(observedAt) > Date.now()) {
          fail("invalid_source_time");
        }
        return {
          payload,
          data,
          provenance: {
            symbol,
            sourceUrl: url.toString(),
            observedAt,
            responseSha256: createHash("sha256").update(body).digest("hex"),
            body,
            httpStatus: response.status,
          },
        };
      },
    );
  }
  return {
    async readDailyHistory(
      request: {
        symbol: string;
        start: string;
        end: string;
        adjustment?: 0 | 1 | 2;
        limit?: number;
      },
      signal?: AbortSignal,
    ): Promise<FinanceFutuHistoryPage> {
      const symbol = checkedSymbol(request.symbol);
      const limit = request.limit ?? 370;
      const adjustment = request.adjustment ?? 0;
      if (
        !validDate(request.start) ||
        !validDate(request.end) ||
        request.start > request.end ||
        request.end > new Date().toISOString().slice(0, 10) ||
        !integer(limit, 1, 370) ||
        ![0, 1, 2].includes(adjustment)
      ) {
        fail("invalid_request");
      }
      const url = new URL(`${symbol}/history-kline`, BASE_URL);
      for (const [key, value] of Object.entries({
        start: request.start,
        end: request.end,
        ktype: 2,
        autype: adjustment,
        num: limit,
      })) {
        url.searchParams.set(key, String(value));
      }
      const { data, provenance } = await read(url, symbol, signal);
      if (!Array.isArray(data.kline_list) || data.kline_list.length > limit) {
        fail("invalid_response");
      }
      const gaps = new Set<string>([
        "currency_not_supplied_by_endpoint",
        "completion_not_supplied_by_endpoint",
      ]);
      const seen = new Set<number>();
      const bars = data.kline_list.map((value: unknown) => {
        const row = record(value);
        checkIdentity(row, symbol);
        const timestamp = sourceTime(row.time_key);
        if (
          timestamp < Date.parse(request.start) - 14 * 3_600_000 ||
          timestamp > Date.parse(request.end) + 38 * 3_600_000
        ) {
          fail("invalid_source_time");
        }
        if (seen.has(timestamp)) {
          fail("invalid_response");
        }
        seen.add(timestamp);
        for (const key of ["open", "close", "high", "low", "volume", "turnover"]) {
          if (typeof row[key] !== "number" || !Number.isFinite(row[key]) || row[key] < 0) {
            fail("invalid_response");
          }
        }
        if (
          Number(row.low) > Math.min(Number(row.open), Number(row.close)) ||
          Number(row.high) < Math.max(Number(row.open), Number(row.close)) ||
          Number(row.low) > Number(row.high)
        ) {
          fail("invalid_response");
        }
        let localDate: string | undefined;
        let timeZoneMinutes: number | undefined;
        if (row.date !== undefined) {
          if (!integer(row.date, 19000101, 99991231)) {
            fail("invalid_source_time");
          }
          const date = String(row.date);
          localDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
          if (!validDate(localDate) || localDate < request.start || localDate > request.end) {
            fail("invalid_source_time");
          }
        } else {
          gaps.add("local_date_missing");
        }
        if (row.time_zone !== undefined) {
          if (!integer(row.time_zone, -840, 840)) {
            fail("invalid_source_time");
          }
          timeZoneMinutes = row.time_zone;
          if (
            localDate &&
            new Date(timestamp + timeZoneMinutes * 60_000).toISOString().slice(0, 10) !== localDate
          ) {
            fail("invalid_source_time");
          }
        } else {
          gaps.add("timezone_missing");
        }
        return {
          raw: row,
          sourceTime: new Date(timestamp).toISOString(),
          localDate,
          timeZoneMinutes,
        };
      });
      let nextTime: number | undefined;
      if (data.next_time !== undefined && data.next_time !== null && data.next_time !== 0) {
        nextTime = sourceTime(data.next_time);
        gaps.add("next_time_end_format_ambiguous");
      } else if (bars.length === limit) {
        gaps.add("page_limit_reached_without_completion_proof");
      }
      if (data.volume_precision !== undefined && !integer(data.volume_precision, 0, 12)) {
        fail("invalid_response");
      }
      if (data.volume_precision === undefined) {
        gaps.add("volume_precision_missing");
      }
      return {
        ...provenance,
        bars,
        start: request.start,
        end: request.end,
        adjustment,
        volumePrecision: data.volume_precision,
        nextTime,
        gaps: [...gaps],
      };
    },
    async readFinancialStatements(
      request: {
        symbol: string;
        statementType?: 1 | 2 | 3 | 4;
        financialType?: number;
        currencyCode?: string;
        limit?: number;
        nextKey?: string;
      },
      signal?: AbortSignal,
    ): Promise<FinanceFutuFinancialPage> {
      const symbol = checkedSymbol(request.symbol);
      const statementType = request.statementType ?? 4;
      const financialType = request.financialType ?? 10;
      const limit = request.limit ?? 10;
      if (
        !integer(statementType, 1, 4) ||
        ![1, 2, 3, 4, 5, 6, 7, 10].includes(financialType) ||
        !integer(limit, 1, 50) ||
        (request.currencyCode !== undefined && !currency(request.currencyCode)) ||
        (request.nextKey !== undefined && !validCursor(request.nextKey))
      ) {
        fail("invalid_request");
      }
      const url = new URL(`${symbol}/financials/statements`, BASE_URL);
      for (const [key, value] of Object.entries({
        statement_type: statementType,
        financial_type: financialType,
        limit,
        currency_code: request.currencyCode,
        next_key: request.nextKey,
      })) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
      const { payload, data, provenance } = await read(url, symbol, signal);
      if (!Array.isArray(data.report_list) || data.report_list.length > limit) {
        fail("invalid_response");
      }
      const seenReports = new Set<string>();
      const reports = data.report_list.map((value: unknown) => {
        const row = record(value);
        checkIdentity(row, symbol);
        const reportPeriod = new Date(sourceTime(row.date_time)).toISOString();
        if (
          typeof row.fiscal_year === "number" &&
          Math.abs(new Date(reportPeriod).getUTCFullYear() - row.fiscal_year) > 1
        ) {
          fail("invalid_source_time");
        }
        if (
          !currency(row.currency_code) ||
          (request.currencyCode !== undefined && request.currencyCode !== row.currency_code)
        ) {
          fail("invalid_currency");
        }
        if (
          !integer(row.fiscal_year, 1900, 9999) ||
          !integer(row.financial_type, 1, 7) ||
          (financialType !== 10 && row.financial_type !== financialType) ||
          !integer(row.structure, 1, 19) ||
          typeof row.accounting_standards !== "string" ||
          !row.accounting_standards ||
          !Array.isArray(row.item_list) ||
          row.item_list.length === 0 ||
          row.item_list.length > 1000
        ) {
          fail("invalid_response");
        }
        const reportIdentity = `${reportPeriod}:${row.financial_type}:${row.structure}`;
        if (seenReports.has(reportIdentity)) {
          fail("invalid_response");
        }
        seenReports.add(reportIdentity);
        const fields = new Set<number>();
        for (const item of row.item_list) {
          const field = record(item);
          if (
            !integer(field.field_id, 1, 1_000_000) ||
            fields.has(field.field_id) ||
            typeof field.display_name !== "string" ||
            !["amount", "percent"].includes(String(field.value_type)) ||
            typeof field.data !== "number" ||
            !Number.isFinite(field.data)
          ) {
            fail("invalid_response");
          }
          fields.add(field.field_id);
          for (const key of ["yoy", "qoq"]) {
            if (
              field[key] !== undefined &&
              field[key] !== null &&
              (typeof field[key] !== "number" || !Number.isFinite(field[key]))
            ) {
              fail("invalid_response");
            }
          }
        }
        return {
          raw: row,
          reportPeriod,
          currency: row.currency_code,
          financialType: row.financial_type,
          structure: row.structure,
        };
      });
      const gaps = ["publication_and_vintage_not_supplied_by_endpoint"];
      let hasMore: boolean | undefined;
      let nextKey: string | undefined;
      if (payload.pagination === undefined) {
        gaps.push("pagination_missing");
      } else {
        const pagination = record(payload.pagination);
        if (
          typeof pagination.has_more !== "boolean" ||
          (pagination.next_key !== undefined &&
            pagination.next_key !== null &&
            pagination.next_key !== "" &&
            !validCursor(pagination.next_key))
        ) {
          fail("invalid_response");
        }
        hasMore = pagination.has_more;
        nextKey =
          typeof pagination.next_key === "string" && pagination.next_key
            ? pagination.next_key
            : undefined;
        if (hasMore && !nextKey) {
          fail("invalid_response");
        }
        if (hasMore) {
          gaps.push("more_reports_available");
        }
      }
      return {
        ...provenance,
        reports,
        statementType,
        financialType,
        pagination: { hasMore, nextKey },
        gaps,
      };
    },
  };
}

type AvailabilityMetadata = Readonly<{
  symbol: string;
  availableAt: string;
  evidenceRef: string;
}>;
export type FinanceFutuHistoryBarMetadata = AvailabilityMetadata &
  Readonly<{
    currency: string;
    completed: true;
  }>;
export type FinanceFutuDataCollectionOptions = FinanceFutuDataClientOptions & {
  captureRawResponse?: FinanceMarketCollectionRegistryOptions["captureRawResponse"];
  resolveHistoryBarMetadata?: (
    input: Readonly<{ symbol: string; bar: FinanceFutuDailyBar }>,
    signal: AbortSignal,
  ) => Promise<FinanceFutuHistoryBarMetadata | undefined>;
  resolveFinancialReportMetadata?: (
    input: Readonly<{ symbol: string; report: FinanceFutuFinancialReport }>,
    signal: AbortSignal,
  ) => Promise<AvailabilityMetadata | undefined>;
};
function supportsSymbol(request: FinanceMarketCollectionRequest): boolean {
  const symbol = normalizeFinanceFutuSymbol(request.instrument);
  if (!symbol) {
    return false;
  }
  if (["equity", "stock", "common_stock"].includes(request.assetClass)) {
    return true;
  }
  return symbol.startsWith("US.")
    ? request.assetClass === "us_equity"
    : symbol.startsWith("HK.")
      ? request.assetClass === "hk_equity"
      : ["cn_equity", "a_share"].includes(request.assetClass);
}
function qualify(
  metadata: AvailabilityMetadata | undefined,
  request: FinanceMarketCollectionRequest,
  sourceTimestamp: string,
): AvailabilityMetadata {
  if (!metadata) {
    qualificationFail("availability_missing");
  }
  if (metadata.symbol !== checkedSymbol(request.instrument)) {
    qualificationFail("identity_mismatch");
  }
  if (!metadata.evidenceRef.trim() || metadata.evidenceRef.length > 2048) {
    qualificationFail("availability_evidence_missing");
  }
  if (
    !Number.isFinite(Date.parse(metadata.availableAt)) ||
    Date.parse(metadata.availableAt) < Date.parse(sourceTimestamp) ||
    Date.parse(metadata.availableAt) > Date.now()
  ) {
    qualificationFail("availability_invalid");
  }
  if (
    request.asOfMode !== "live_now" &&
    Date.parse(metadata.availableAt) > Date.parse(request.asOf)
  ) {
    qualificationFail("historical_cutoff_exceeded");
  }
  return metadata;
}
function qualificationFail(gap: QualificationGap): never {
  throw new FinanceFutuDataSourceError("qualification_missing", "source_error", undefined, gap);
}

/** Unbound by default; a successful HTTP read alone cannot make research evidence ready. */
export function createFutuDataCollectionAdapters(
  options: FinanceFutuDataCollectionOptions = {},
): readonly FinanceMarketCollectionAdapter[] {
  if (!options.resolveQuoteReadAuthorization) {
    return [];
  }
  const client = createFinanceFutuDataClient(options);
  const adapters: FinanceMarketCollectionAdapter[] = [];
  for (const collection of ["eod_history", "financial_statements"] as const) {
    if (
      collection === "eod_history"
        ? !options.resolveHistoryBarMetadata
        : !options.resolveFinancialReportMetadata
    ) {
      continue;
    }
    const id = `futunn_quote_read_${collection}`;
    const supports = (request: FinanceMarketCollectionRequest) =>
      request.collection === collection && supportsSymbol(request);
    adapters.push({
      id,
      providerName: id,
      providerRole: "primary_market_data",
      priority: 30,
      supports,
      collect: async (request, signal) => {
        if (!supports(request) || !Number.isFinite(Date.parse(request.asOf))) {
          fail("invalid_request");
        }
        signal.throwIfAborted();
        const symbol = checkedSymbol(request.instrument);
        const limit = request.limit ?? (collection === "eod_history" ? 100 : 10);
        const page =
          collection === "eod_history"
            ? await client.readDailyHistory(
                { symbol, start: request.fromDate ?? "", end: request.toDate ?? "", limit },
                signal,
              )
            : await client.readFinancialStatements({ symbol, limit }, signal);
        const artifact = await options.captureRawResponse?.({
          adapterId: id,
          sourceUrlOrArtifact: page.sourceUrl,
          observedAt: page.observedAt,
          httpStatus: page.httpStatus,
          body: page.body,
        });
        signal.throwIfAborted();
        const entries = "bars" in page ? page.bars : page.reports;
        if (entries.length === 0) {
          fail("no_data");
        }
        const results = await Promise.allSettled(
          entries.map(async (entry): Promise<FinanceMarketCollectionItem> => {
            const bar = "sourceTime" in entry ? entry : undefined;
            const report = "reportPeriod" in entry ? entry : undefined;
            const metadata = bar
              ? await options.resolveHistoryBarMetadata?.({ symbol, bar }, signal)
              : await options.resolveFinancialReportMetadata?.({ symbol, report: report! }, signal);
            signal.throwIfAborted();
            const sourceTimestamp = bar?.sourceTime ?? report!.reportPeriod;
            const qualified = qualify(metadata, request, sourceTimestamp);
            if (bar) {
              if (!bar.localDate) {
                qualificationFail("local_date_missing");
              }
              if (bar.timeZoneMinutes === undefined) {
                qualificationFail("timezone_missing");
              }
              if (!("currency" in qualified) || !currency(qualified.currency)) {
                qualificationFail("currency_metadata_missing");
              }
              if (!("completed" in qualified) || qualified.completed !== true) {
                qualificationFail("completion_unverified");
              }
            }
            const { volume: vendorVolume, ...fieldsWithoutVolume } = entry.raw;
            const volumePrecision = "volumePrecision" in page ? page.volumePrecision : undefined;
            return {
              itemId: `${symbol}:${collection}:${sourceTimestamp}:${report?.financialType ?? "day"}:${report?.structure ?? "ohlcv"}`,
              collection,
              providerName: id,
              providerRole: "primary_market_data" as const,
              sourceFamily: "market_data_api" as const,
              sourceTimestamp: bar ? bar.sourceTime : qualified.availableAt,
              observedAt: page.observedAt,
              delayStatus: bar ? ("end_of_day" as const) : ("official_lagged" as const),
              sourceUrlOrArtifact: artifact ?? page.sourceUrl,
              data: {
                ...(bar ? fieldsWithoutVolume : entry.raw),
                ...(bar
                  ? {
                      date: bar.localDate,
                      vendorDate: entry.raw.date,
                      timezoneOffsetMinutes: bar.timeZoneMinutes,
                      vendorVolume,
                      ...(volumePrecision === undefined
                        ? {}
                        : { volume: Number(vendorVolume) / 10 ** volumePrecision }),
                      adjusted: "adjustment" in page ? page.adjustment !== 0 : undefined,
                      unit: (qualified as FinanceFutuHistoryBarMetadata).currency,
                    }
                  : {}),
                symbol,
                currency: bar
                  ? (qualified as FinanceFutuHistoryBarMetadata).currency
                  : report!.currency,
                providerSourceTimestamp: sourceTimestamp,
                availableAt: qualified.availableAt,
                reportPeriod: report?.reportPeriod,
                sourceTimestampMeaning: bar
                  ? "provider_daily_bar_time"
                  : "evidence_attested_available_at",
                availabilityEvidenceRef: qualified.evidenceRef,
                sourceResponseSha256: page.responseSha256,
                sourceGaps: page.gaps,
                pagination: "pagination" in page ? page.pagination : undefined,
                requestedWindow: "start" in page ? { start: page.start, end: page.end } : undefined,
                continuation: "nextTime" in page ? { nextTime: page.nextTime } : undefined,
                vintageVerification: "not_established_by_this_endpoint",
                adjustment: "adjustment" in page ? page.adjustment : undefined,
                volumePrecision,
                volumeUnitBoundary:
                  "canonical_volume_unscaled_when_precision_known_vendor_volume_retained",
                coverage: "explicit_bounded_request_not_full_history",
                documentation: FINANCE_FUTU_DATA_DOCUMENTATION,
                useBoundary: "research_data_not_execution_quote_or_trade_permission",
              },
            };
          }),
        );
        signal.throwIfAborted();
        const qualifiedItems: FinanceMarketCollectionItem[] = [];
        const qualificationFailures: QualificationFailure[] = [];
        results.forEach((result, index) => {
          if (result.status === "fulfilled") {
            qualifiedItems.push(result.value);
            return;
          }
          const error: unknown = result.reason;
          const entry = entries[index];
          const time = "sourceTime" in entry ? entry.sourceTime : entry.reportPeriod;
          qualificationFailures.push({
            sourceRecordId: `${symbol}:${index}:${time}`,
            reason:
              error instanceof FinanceFutuDataSourceError
                ? (error.qualificationGap ?? error.reason)
                : error instanceof ApiCallError
                  ? error.kind
                  : "metadata_resolver_unavailable",
          });
        });
        if (!qualifiedItems.length) {
          throw new FinanceFutuDataSourceError(
            "qualification_missing",
            "source_error",
            undefined,
            undefined,
            qualificationFailures,
          );
        }
        return qualifiedItems.map((item) => ({
          ...item,
          data: {
            ...item.data,
            returnedRecordCount: entries.length,
            qualifiedRecordCount: qualifiedItems.length,
            excludedItems: qualificationFailures,
          },
        }));
      },
    });
  }
  return adapters;
}
