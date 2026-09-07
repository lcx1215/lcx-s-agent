# US equity data source runbook

This runbook is the durable entry point for the LCX US-market research data
plane. It covers public price checks, official SEC/macro references, public
news discovery, and optional free-tier registered providers. It does not add
order, account, wallet, or broker authority. The broader source matrix lives in
[`free-finance-api-catalog.md`](./free-finance-api-catalog.md).

## Current source path

The canonical path is:

```text
finance_realtime_source_refresh
  -> finance-realtime-source-registry
  -> source adapters
  -> finance-data-gateway
  -> source/timestamp/conflict receipt
```

For a US common stock, use `assetClass=us_equity` (or `stock`, `equity`, or
`common_stock`). The default public/official path is:

| Source                     | Role                      | Coverage                                            | Credential |
| -------------------------- | ------------------------- | --------------------------------------------------- | ---------- |
| Yahoo chart                | primary market data       | delayed daily/latest chart quote                    | none       |
| Nasdaq public quote        | independent cross-check   | public exchange quote and session metadata          | none       |
| Stooq daily                | independent cross-check   | end-of-day daily CSV when available                 | none       |
| SEC EDGAR companyfacts     | official/issuer reference | XBRL fundamentals and shares outstanding            | none       |
| SEC EDGAR submissions      | official/issuer reference | filing date/form for configured issuer/ETF mappings | none       |
| Treasury Fiscal Data       | official/issuer reference | debt-to-penny and average Treasury interest rates   | none       |
| GDELT DOC                  | independent cross-check   | public article discovery and publication metadata   | none       |
| Google News RSS            | independent cross-check   | public article metadata search                      | none       |
| Yahoo Finance RSS          | independent cross-check   | public finance-news metadata                        | none       |
| Yahoo public chart history | primary market data       | delayed daily OHLCV for chart analysis              | none       |

The optional keyed path is enabled only when the corresponding process
environment values are already present at runtime:

| Environment value                             | Adapter             | Coverage                                                   |
| --------------------------------------------- | ------------------- | ---------------------------------------------------------- |
| `MASSIVE_API_KEY`                             | Massive snapshot    | consolidated US equity snapshot: trade/quote/day fields    |
| `ALPACA_API_KEY_ID` + `ALPACA_API_SECRET_KEY` | Alpaca latest quote | bid/ask/size and midpoint; `ALPACA_DATA_FEED` selects feed |
| `FINNHUB_API_KEY`                             | Finnhub quote       | current/delayed quote, change, session high/low/open       |
| `TWELVE_DATA_API_KEY`                         | Twelve Data quote   | quote, change, session range and volume                    |
| `FMP_API_KEY`                                 | FMP Basic           | free-tier company profile and historical EOD only          |

The existing optional variables remain supported for Alpha Vantage, CoinGecko,
and CoinCap. `FRED_API_KEY` enables the official FRED macro-series adapter;
FRED requires a registered key for its JSON API. Secrets are never accepted in
the tool input schema and are not written into source URLs or receipts. A
missing or partial credential is an unavailable adapter, not a fake success.

## Collection path

Collection-shaped data does not fit a single `last_price` field, so it uses the
same source/time/conflict discipline in a record-oriented receipt:

| Collection        | Sources                                                               | Coverage                                                                                   |
| ----------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `news`            | GDELT, Google News RSS, Yahoo Finance RSS; Massive/Finnhub when keyed | article id, title/description metadata, publisher, tickers, sentiment fields when supplied |
| `options_chain`   | Massive when keyed                                                    | contract details, quote/trade, greeks, IV, open interest, underlying snapshot              |
| `dividends`       | Massive when keyed                                                    | declaration, ex-dividend, record/pay dates, amount and frequency                           |
| `splits`          | Massive when keyed                                                    | execution date, ratio and adjustment metadata                                              |
| `macro_series`    | BLS, Treasury debt/average rates, FRED when keyed                     | official time-series records with observation dates                                        |
| `sec_filings`     | SEC EDGAR submissions                                                 | public filing form, filing/report dates, and primary document metadata                     |
| `company_profile` | FMP Basic when keyed                                                  | free-tier reference/profile fields; timestamp is explicitly unknown                        |
| `eod_history`     | Yahoo public chart; FMP Basic when keyed                              | historical end-of-day records with date and OHLCV fields; Yahoo is the keyless baseline    |

The built-in tool is `finance_market_collection_refresh`. The CLI counterpart
is:

```bash
node --import tsx scripts/operator/us-market-collection-live-smoke.ts \
  --live --collection macro_series --series-id CUSR0000SA0 --json
node --import tsx scripts/operator/us-market-collection-live-smoke.ts \
  --live --collection macro_series --series-id debt_to_penny --json
node --import tsx scripts/operator/us-market-collection-live-smoke.ts \
  --live --collection news --symbol AAPL --json
node --import tsx scripts/operator/us-market-collection-live-smoke.ts \
  --live --collection sec_filings --symbol AAPL --json
node --import tsx scripts/operator/us-market-collection-live-smoke.ts \
  --live --collection eod_history --symbol AAPL --json
```

The macro, SEC, and public-news commands need no credentials. Options and
corporate-action collections remain blocked until a permitted provider key is
available. FMP profile/EOD collections become candidates only after
`FMP_API_KEY` is supplied; the adapter does not claim that paid FMP endpoints
are free.

## Agent-owned routing

The agent-facing entry point is `research_data_autopilot`. It accepts an intent
such as `quote`, `crypto_quote`, `news`, `sec_filings`, `eod_history`,
`macro_series`, `geocode`, `weather`, or `earthquake`, plus one target. It
automatically loads every public adapter and every registered-key adapter
available in the process environment, calls all supporting sources, and
returns the canonical receipt. Provider URLs and `sourceIds` are intentionally
not part of this entry point: source priority, fallback, cross-checking, and
failure visibility stay inside the registries.

The autopilot defaults to a read-only live fetch when the agent calls it. It
still returns `blocked` or `needs_review` when evidence is absent or a source
fails, and its boundary explicitly excludes trading, broker, wallet, order,
message-sender, and protected-memory authority.

The same owner is permanently available through the internal CLI; dry mode is
the default and `--live` is explicit:

```bash
pnpm lcx:research:data --intent news --target AAPL
pnpm lcx:research:data --live --intent eod_history --target AAPL --limit 3 --json
pnpm lcx:research:data --live --intent weather --target 31.23,121.47 --json
```

## Web evidence and chart analysis

`research_web_autopilot` is the LCX web-evidence entry point. It composes the
existing guarded `web_search` and `web_fetch` owners into one loop:

```text
query -> search leads -> deduplicate URLs -> open original pages
      -> mark likely official references -> retain failures/timestamps
      -> ready | needs_review | blocked receipt
```

Search snippets are leads, not facts. The tool only calls a page “opened
evidence” after `web_fetch` returns content, leaves external text marked
untrusted, and reports missing search/fetch provider configuration instead of
pretending to have Codex's internal network. The provider still comes from the
configured LCX web-search adapter (Brave/Perplexity/Grok/Gemini/Kimi as
available); `--live` is explicit in the CLI:

```bash
pnpm lcx:research:web --query "AAPL latest SEC filing" --require-primary
pnpm lcx:research:web --live --query "AAPL latest SEC filing" --require-primary --json
pnpm lcx:research:chart --live --symbol AAPL --limit 250 --json
```

`finance_chart_analysis` has two separate lanes. With a symbol it fetches
keyless Yahoo daily OHLCV through `eod_history`, keeps optional FMP results as a
cross-check, and computes deterministic total return, trend slope, drawdown,
SMA20/50/200 when covered, RSI14, ATR14, support/resistance, volatility, and
volume ratio. With `image`, a native vision model receives a guarded image
block; when the primary model is text-only, the tool automatically invokes the
configured image/VLM tool when one is available. Pixel-only annotations remain
a visual-model responsibility; the numeric path never invents them.

```text
structured OHLCV -> deterministic features -> sourced research context
chart image      -> image block -> native/configured vision review
```

Both lanes remain research-only: they do not produce orders, sizing, broker,
wallet, or sender actions.

## Local verification

Dry inspection, with no network call:

```bash
pnpm exec tsx scripts/operator/finance-data-gateway-live-smoke.ts --asset-class us_equity --symbol AAPL
```

Real public/official fetch, explicitly opt-in:

```bash
node --import tsx scripts/operator/finance-data-gateway-live-smoke.ts \
  --live --asset-class us_equity --symbol AAPL --json
```

Every attempt records success/failure and latency. The gateway keeps
`needs_review` when source values conflict or timestamps are materially apart;
it does not select a number by model preference. Every current numeric value
must retain its source URL, source timestamp, field definition, and delay
status.

## Source boundaries

- SEC `data.sec.gov` and EDGAR search are read-only data references.
- The adapters do not submit filings, place trades, access accounts, or call
  broker/order endpoints.
- A successful HTTP response is not a quality verdict. The canonical gateway
  still requires provider-role coverage and checks conflicts/freshness.
- API plans differ. A keyed adapter being configured proves only that it can
  be attempted; live plan/entitlement and feed latency remain receipt evidence.
