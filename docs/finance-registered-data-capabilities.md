# Registered finance data capabilities

The canonical collection registry exposes these datasets to
`research_data_autopilot`, the collection tool, and the `all_registered` research
planner. The executable extended catalog is
`src/agents/finance-extended-capability-catalog.ts`; existing adapters remain in
`finance-registered-capability-adapters.ts` and the free collection registry.
Credentials are read from the process environment. Restarting a task does not
require recreating adapters or memorizing URLs.

| Provider       | Available collection routes                                                                                                                                                                                                                                                                                                                                                  | Credential variables                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| FMP            | Stable profiles/EOD; annual and quarterly statements, as-reported statements and growth; metrics/valuation; analyst estimates; news/releases; earnings/distributions/splits; calendars; transcripts; ETF holdings; insider/congressional/13F ownership; SEC filings; directories and constituents; technical indicators; macro; ESG; COT; fundraising; CSV/JSON bulk exports | FMP_API_KEY                                                         |
| Alpha Vantage  | Overview, annual statements, compact daily history, quarterly earnings, dividends, splits, insider transactions, ETF profile with holdings, news sentiment                                                                                                                                                                                                                   | ALPHA_VANTAGE_API_KEY                                               |
| Finnhub        | Profile, metrics, earnings surprises, news, recommendations, price targets, insider trades/sentiment, reported financials                                                                                                                                                                                                                                                    | FINNHUB_API_KEY                                                     |
| Massive        | Adjusted daily bars, news, options snapshots, dividends/splits, ticker overview and directory                                                                                                                                                                                                                                                                                | MASSIVE_API_KEY                                                     |
| Twelve Data    | Daily OHLCV, SMA, EMA, RSI, MACD, Bollinger bands, ATR                                                                                                                                                                                                                                                                                                                       | TWELVE_DATA_API_KEY                                                 |
| Alpaca         | Adjusted daily historical bars using the selected market-data feed; IEX default                                                                                                                                                                                                                                                                                              | ALPACA_API_KEY_ID, ALPACA_API_SECRET_KEY, optional ALPACA_DATA_FEED |
| CoinGecko Demo | Daily price snapshots, global market metrics, coin ID directory, market statistics, metadata and exchange tickers                                                                                                                                                                                                                                                            | COINGECKO_API_KEY                                                   |
| FRED           | Any supported observation series; representative policy rate, GDP, unemployment, CPI and ten-year yield jobs                                                                                                                                                                                                                                                                 | FRED_API_KEY                                                        |

Existing quote adapters are separate from collections. Registration is not proof
of credentials, entitlement, freshness, or successful collection. FMP compatibility
IDs retain `free_basic` for callers, but now use `/stable` endpoints and do not
promise free account access. No adapter accesses trading, orders, wallets or funds.

## Use and retained evidence

Preview the configured plan and the extended catalog, including missing credentials:

```sh
node --import tsx scripts/operator/lcx-finance-capability-collect.ts
```

After loading credentials into the process environment, collect to a new directory:

```sh
node --import tsx scripts/operator/lcx-finance-capability-collect.ts --live --output /secure/new-research-packet
```

Select a particular dataset, instrument and historical window:

```sh
node --import tsx scripts/operator/lcx-finance-capability-collect.ts --live --adapters twelve_data_time_series --symbol MSFT --from 2025-09-01 --to 2026-09-01 --limit 250 --output /secure/new-msft-packet
```

There is one HTTP attempt per endpoint and a 15-second timeout. The operator spaces
Alpha Vantage, Twelve Data and Massive requests to reduce bursts. This is a
one-shot operation; no background schedule is installed. The agent-facing router
continues to use existing API governance and source budgets.

Each successful response from the registered/extended capability engine can be
retained in full through `captureRawResponse`. The operator enables this sink and
writes credential-redacted `.raw.json` artifacts, normalized receipts and a
manifest. Raw bodies survive the normalized 1–250 record limit, including nested
holdings, statement fields, and pagination hints. Source timestamps, HTTP errors,
quota envelopes, parsing errors and unplanned requested adapters remain explicit.
Files are private and existing raw/receipt files are not overwritten.

One response is not a complete provider database. Directory pages, bulk parts,
Alpaca page tokens, compact Alpha Vantage history, and Demo CoinGecko history have
coverage limits. Retain `continuationRequired` and the raw response when planning
another page/window. The full response contains only what the provider returned;
it does not imply all years, all tickers, all permissions or unlimited quota.

## Agent intents and future use

Use these intents directly through `research_data_autopilot`:

| Research need                                                | Intent                                       |
| ------------------------------------------------------------ | -------------------------------------------- |
| Revenue, cash generation, debt and growth                    | financial_statements                         |
| Valuation ratios, DCF models, financial/ESG scores           | valuation                                    |
| Consensus, price targets and rating changes                  | analyst_estimates                            |
| Reported earnings and estimates                              | earnings                                     |
| Institutional, insider and congressional disclosures         | ownership                                    |
| ETF components, weights and exposures                        | etf_holdings                                 |
| Economic, earnings, IPO and distribution dates               | event_calendar                               |
| Transcript dates and explicitly selected transcript content  | transcripts                                  |
| Technical studies                                            | technical_indicators                         |
| Symbols, sector/index membership, market and crypto metadata | market_reference                             |
| Provider bulk exports                                        | bulk_dataset                                 |
| Historical bars, news, SEC filings and macro observations    | eod_history, news, sec_filings, macro_series |

Requests that require a period must specify it. For transcripts and institutional
positions use `seriesId: "2025-Q4"` (operator `--series 2025-Q4`). For bulk EOD use
`seriesId: "2026-09-04"`; profile bulk parts use `seriesId: "part:0"`. These are
example periods, not claims of the latest filing or trading date. Period-dependent
routes remain visible as unplanned in representative all-source plans until the
request supplies the period. The bulk profile discovery job reads part zero only.

All 28 FMP documentation families have representative executable routes, including
bulk. Coverage is by useful dataset family, not every product variant. Different
intraday resolutions, custom valuation inputs, private fund CIKs, deeper bulk
parts and provider-specific entitlement upgrades still require explicit parameters
and contract verification. An unknown future dataset is not automatically supported.

## Time and interpretation

Fiscal periods are not publication times. Original fields are preserved; profiles
without provider timestamps are marked as retrieved snapshots with unknown delay.
Forecast target dates and scheduled events are retained as such, never relabelled
as realized historical observations. These snapshots do not establish point-in-time
backtest validity. CoinGecko daily snapshots are not exchange OHLC closes; Alpaca
IEX bars are not consolidated SIP coverage. Current-day daily bars and invalid
prices are excluded by the registered capability engine.

Use raw artifacts for subsequent extraction, receipts for provenance/failures,
and existing research quality gates for freshness and cross-source comparison.
Local acquisition does not prove a model used the evidence or delivered an answer.

Official contracts: [FMP](https://site.financialmodelingprep.com/developer/docs),
[Alpha Vantage](https://www.alphavantage.co/documentation/),
[Finnhub SDK](https://github.com/Finnhub-Stock-API/finnhub-python),
[Massive](https://massive.com/docs/rest/stocks/tickers/ticker-overview),
[Twelve Data](https://twelvedata.com/docs/introduction/overview),
[Alpaca](https://docs.alpaca.markets/us/reference/stockbars),
[CoinGecko](https://docs.coingecko.com/reference/endpoint-overview),
[FRED](https://fred.stlouisfed.org/docs/api/fred/series_observations.html).

## Runtime credentials and source health

The finance option resolvers read the existing state directory's
`finance-caseflow/credentials.env` on each default Agent call. Only the finance
credential allowlist is read; process environment values take precedence, and
an explicitly empty variable disables the saved key. The loader does not change
global process environment, model/provider settings, or write credentials.

Call `research_data_autopilot` with `intent: "source_health", target: "all"`
for provider and route counts plus configuration and recent call evidence.
A successful call expires from the recent-success category after 24 hours.
This is a liveness observation window, not a market-data freshness threshold.
Packet quality and timestamps remain separate; a callable source can return
stale data. Missing credentials, disabled routes, unverified routes and recent
failures remain visible. Offline replays do not establish live source health.

Live finance calls through the Agent tool save a receipt by default; callers may
explicitly set `writeReceipt: false`. The health view reads operator and current
workspace receipts. It does not claim continuous uptime, probe unused endpoints,
install a schedule, or bypass account entitlements. A running service still needs
to load the updated code before these changes affect that process.
