import { createHash } from "node:crypto";
import { ApiCallError } from "./api-call-contract.js";
import { FINANCE_LIVE_NOW_MAX_FUTURE_SKEW_MINUTES } from "./finance-data-gateway.js";
import { resolveFinanceFetch, type FetchImpl } from "./finance-live-market-source.js";
import type {
  FinanceMarketCollectionAdapter,
  FinanceMarketCollectionRequest,
  FinanceMarketCollectionRegistryOptions,
} from "./finance-market-collection-registry.js";

const DOCUMENTATION =
  "https://docs.deribit.com/api-reference/market-data/public-get_book_summary_by_currency";
const MAX_RECORDS = 260;
function currencyFor(request: FinanceMarketCollectionRequest) {
  const symbol = request.instrument.toUpperCase();
  return symbol === "BTC" || symbol === "ETH" ? symbol : undefined;
}

/** Public snapshots only; neither historical evidence nor derivatives execution authority. */
export function createDeribitPublicCollectionAdapters(
  options: {
    fetchImpl?: FetchImpl;
    captureRawResponse?: FinanceMarketCollectionRegistryOptions["captureRawResponse"];
  } = {},
): readonly FinanceMarketCollectionAdapter[] {
  return (["option", "future"] as const).map((kind) => {
    const collection = kind === "option" ? "options_chain" : "market_reference";
    const supports = (request: FinanceMarketCollectionRequest) =>
      request.collection === collection &&
      request.assetClass === "crypto" &&
      request.asOfMode === "live_now" &&
      currencyFor(request) !== undefined;
    const providerName = `deribit-public-${kind}-summary`;
    return {
      id: `deribit_public_${kind}_summary`,
      providerName,
      providerRole: "primary_market_data",
      priority: kind === "option" ? 20 : 25,
      sampleRequest: { instrument: "BTC", assetClass: "crypto", collection },
      supports,
      collect: async (request, signal) => {
        if (!supports(request) || !Number.isFinite(Date.parse(request.asOf))) {
          throw new Error("Deribit summary requires a live-now BTC or ETH crypto request");
        }
        signal.throwIfAborted();
        const limit = request.limit ?? 20;
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECORDS) {
          throw new Error("Deribit summary record limit invalid");
        }
        const currency = currencyFor(request)!;
        const url = new URL("https://www.deribit.com/api/v2/public/get_book_summary_by_currency");
        url.searchParams.set("currency", currency);
        url.searchParams.set("kind", kind);
        const response = await resolveFinanceFetch(options.fetchImpl, { signal })(url.toString(), {
          signal,
        });
        const body = await response.text();
        signal.throwIfAborted();
        const payload: unknown = JSON.parse(body);
        if (
          !payload ||
          typeof payload !== "object" ||
          !("jsonrpc" in payload) ||
          payload.jsonrpc !== "2.0" ||
          "error" in payload ||
          !("result" in payload) ||
          !Array.isArray(payload.result) ||
          payload.result.length === 0
        ) {
          throw new ApiCallError("source_error");
        }
        const observedAt = new Date().toISOString();
        const now = Date.now();
        const maxAgeMs = FINANCE_LIVE_NOW_MAX_FUTURE_SKEW_MINUTES * 60_000;
        const latest = now + maxAgeMs;
        const sha256 = createHash("sha256").update(body).digest("hex");
        const seen = new Set<string>();
        // Validate the full bounded HTTP result before selecting a narrow output; never hide
        // corrupt rows behind the caller's limit or replace missing vendor times with asOf.
        const validated = payload.result.map((value: unknown) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("Deribit summary row invalid");
          }
          const row = value as Record<string, unknown>;
          const name = row.instrument_name;
          const timestamp = row.creation_timestamp;
          if (
            typeof name !== "string" ||
            name.length > 100 ||
            !name.startsWith(`${currency}-`) ||
            row.base_currency !== currency ||
            typeof row.quote_currency !== "string" ||
            !/^[A-Z]{2,8}$/u.test(row.quote_currency) ||
            typeof timestamp !== "number" ||
            !Number.isSafeInteger(timestamp) ||
            timestamp < now - maxAgeMs ||
            timestamp > latest ||
            seen.has(name)
          ) {
            throw new Error("Deribit summary identity or timestamp invalid");
          }
          seen.add(name);
          for (const field of [
            "mark_price",
            "open_interest",
            "volume",
            "bid_price",
            "ask_price",
            "mark_iv",
          ]) {
            const v = row[field];
            if (
              v !== undefined &&
              v !== null &&
              (typeof v !== "number" || !Number.isFinite(v) || v < 0)
            ) {
              throw new Error("Deribit summary numeric field invalid");
            }
          }
          if (typeof row.mark_price !== "number" || typeof row.open_interest !== "number") {
            throw new Error("Deribit summary required market fields missing");
          }
          if (
            typeof row.bid_price === "number" &&
            typeof row.ask_price === "number" &&
            row.bid_price > row.ask_price
          ) {
            throw new Error("Deribit summary crossed quote");
          }
          return { name, timestamp, row };
        });
        const rawArtifact = await options.captureRawResponse?.({
          adapterId: `deribit_public_${kind}_summary`,
          sourceUrlOrArtifact: url.toString(),
          observedAt,
          httpStatus: response.status,
          body,
        });
        signal.throwIfAborted();
        return validated.slice(0, limit).map(({ name, timestamp, row }) => ({
          itemId: name,
          collection,
          providerName,
          providerRole: "primary_market_data" as const,
          sourceFamily: "market_data_api" as const,
          sourceTimestamp: new Date(timestamp).toISOString(),
          observedAt,
          delayStatus: "realtime" as const,
          sourceUrlOrArtifact: rawArtifact ?? url.toString(),
          data: {
            ...row,
            instrumentKind: kind,
            sourceResponseSha256: sha256,
            returnedInstrumentCount: validated.length,
            selectedInstrumentCount: Math.min(limit, validated.length),
            coverage: "bounded_live_book_summary_not_historical_chain",
            documentation: DOCUMENTATION,
            unitBoundary: "vendor_price_and_contract_amount_units_not_assumed_usd",
            useBoundary: "research_snapshot_not_execution_quote_or_trade_permission",
          },
        }));
      },
    };
  });
}
