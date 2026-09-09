# Free and public API catalog

This is the source-selection index for LCX research workflows. “Free” means
only that a public endpoint or a free registration path exists; it does not
mean unlimited, realtime, redistributable, or suitable for durable storage.
Each adapter must retain the provider, source URL, source timestamp, delay
status, and failed attempts. No source in this catalog grants trading, broker,
wallet, account, or order authority.

For agent calls, use `research_data_autopilot`. It is the single read-only
entry point across the finance realtime, finance collection, crypto, macro,
SEC, geospatial, weather, and seismic registries. The agent supplies an intent
and target; the registry chooses all supporting providers automatically.

`pnpm lcx:data` uses the configured default agent workspace for receipts,
independently of the shell's working directory. `--workspace <directory>`
remains an explicit override. Source health recognizes raw collection receipts,
autopilot envelopes, and saved tool-result envelopes; dry-run and evaluation
artifacts never count as live source evidence. Future-dated observations are
excluded; conflicting attempts at the same timestamp retain failure until a
newer successful observation exists. This is recent call evidence, not uptime.

## Registered adapters (availability requires live evidence)

| Source                     | Access path                                      | Current LCX use                                                                         | Boundary                                                                       |
| -------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| SEC EDGAR / `data.sec.gov` | public, no API key                               | companyfacts, submissions, filing metadata; ticker-to-CIK fallback through EDGAR search | official filing/XBRL reference; filing data is lagged relative to market ticks |
| Treasury Fiscal Data       | public, no API key                               | debt-to-penny and average Treasury interest rates                                       | official macro/fiscal reference, not a quote feed                              |
| BLS Public Data API        | public, no API key                               | macro series                                                                            | official macro reference; series availability and revisions remain visible     |
| GDELT DOC 2.0              | public, no API key                               | cross-check news/article discovery                                                      | not a price feed; public service may rate-limit high traffic                   |
| Google News RSS            | public feed, no API key                          | news metadata cross-check                                                               | public RSS metadata only; not issuer or price authority                        |
| Yahoo Finance RSS          | public feed, no API key                          | finance-news metadata cross-check                                                       | public RSS metadata only; endpoint availability and terms may change           |
| Yahoo Finance chart        | public endpoint                                  | delayed quote and daily OHLCV history                                                   | unofficial/public chart path; delayed and subject to endpoint drift            |
| Nasdaq public quote        | public endpoint                                  | exchange/session cross-check                                                            | endpoint and access policy can change                                          |
| Stooq                      | public CSV endpoint                              | end-of-day cross-check                                                                  | may challenge automated traffic; failure is recorded, never hidden             |
| Invesco issuer reference   | public issuer endpoint                           | QQQ issuer/performance reference                                                        | issuer-specific, not a general market feed                                     |
| Bybit, CoinGecko           | public crypto endpoints; CoinGecko may use a key | crypto spot cross-checks                                                                | crypto-only; rate limits and plan entitlements are source evidence             |
| NOAA/NWS, Open-Meteo, USGS | public geospatial/weather/seismic endpoints      | geocode, weather, earthquake context                                                    | contextual sources; not financial authority                                    |

## Credential-gated adapters (plan entitlements vary)

Set keys in the process environment or the local service manager. Never put a
key in a tool argument, source URL, receipt, commit, or documentation example.

| Environment variable                          | Provider                | Enabled surface                                   | Free-tier truth                                                                                                                          |
| --------------------------------------------- | ----------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `COINCAP_API_KEY`                             | CoinCap                 | crypto asset lookup                               | the LCX adapter requires a key; registration alone does not prove usable access                                                          |
| `FRED_API_KEY`                                | FRED                    | official macro collection                         | registered key is required for JSON API access                                                                                           |
| `FMP_API_KEY`                                 | Financial Modeling Prep | profile, history and registered capability routes | Basic free scope is limited; this adapter does not claim FMP news, calendars, insider, fundamentals, intraday, crypto, or forex are free |
| `MASSIVE_API_KEY`                             | Massive                 | quote/collection adapters already present         | free Basic/reference/EOD coverage must be distinguished from paid snapshots, realtime, financials, and other entitlements                |
| `FINNHUB_API_KEY`                             | Finnhub                 | quote and news cross-checks                       | endpoint-level plan and entitlement must be proven by the receipt                                                                        |
| `TWELVE_DATA_API_KEY`                         | Twelve Data             | quote cross-check                                 | free plan is rate-limited and intended for personal/internal use; no redistribution assumption                                           |
| `ALPHA_VANTAGE_API_KEY`                       | Alpha Vantage           | end-of-day/global-quote cross-check               | free key is strongly rate-limited; free access is not realtime execution data                                                            |
| `ALPACA_API_KEY_ID` + `ALPACA_API_SECRET_KEY` | Alpaca market data      | quotes, history and indicative options snapshots  | data-feed entitlement is separate from account/broker authority; LCX does not call trading endpoints                                     |

After a key is registered, verify the selected adapter without exposing it:

```bash
FMP_API_KEY='set-locally' \
  node --import tsx scripts/operator/us-market-collection-live-smoke.ts \
  --live --collection eod_history --symbol AAPL --limit 3

FRED_API_KEY='set-locally' \
  node --import tsx scripts/operator/us-market-collection-live-smoke.ts \
  --live --collection macro_series --series-id DFF --limit 3
```

Use the dry inspection first when checking which adapters are loaded:

```bash
node --import tsx scripts/operator/us-market-collection-live-smoke.ts
```

The receipt status is the authority for the attempt: `ready` means all
selected adapters succeeded, `needs_review` means records exist but one or
more selected sources failed, and `blocked` means no usable records were
collected.

The durable internal CLI reuses the same autopilot owner:

```bash
pnpm lcx:research:data --live --intent news --target AAPL --json
pnpm lcx:research:data --live --intent crypto_quote --target BTCUSDT --json
```

## Web retrieval and chart/image analysis

`research_web_autopilot` is the durable agent-facing equivalent of a
search-to-source workflow: it calls the configured guarded `web_search`, opens
the top original URLs with `web_fetch`, marks likely government/issuer
references, and returns a receipt containing candidates, opened documents,
timestamps, failures, missing primary evidence, and a `ready`/
`needs_review`/`blocked` status. It does not claim an internal Codex network
connection; a search provider must be configured and its absence remains
visible.

```bash
pnpm lcx:research:web --query "AAPL latest SEC filing" --require-primary
pnpm lcx:research:web --live --query "AAPL latest SEC filing" --require-primary --json
```

`finance_chart_analysis` makes charts useful even when the primary API/model
has no multimodal input:

- The numeric lane fetches keyless Yahoo daily OHLCV through the canonical
  `eod_history` collection and computes auditable trend, return, drawdown,
  moving-average, RSI14, ATR14, support/resistance, volatility, and volume
  features.
- The visual lane accepts an image path, URL, or data URL and returns a guarded
  image content block. A native vision model can inspect it directly; when the
  primary model is text-only, the chart tool automatically invokes the existing
  configured `image`/VLM tool when available.
- Numeric and visual conclusions stay separate, and neither lane grants
  buy/sell, order, sizing, broker, wallet, or external-message authority.

The permanent operator entry point for the numeric lane is:

```bash
pnpm exec tsx scripts/operator/research-data-autopilot-live-smoke.ts \
  --live --intent eod_history --target AAPL --limit 250 --json
pnpm lcx:research:chart --live --symbol AAPL --limit 250 --json
```

## Researched but intentionally not durable-wired

- **Tiingo**: useful free/evaluation quote, IEX, and news surfaces, but the
  free-plan retention/redistribution terms and fundamentals add-on need an
  explicit storage policy before LCX writes durable receipts.
- **Cboe market data**: public documentation exists, but the relevant feeds are
  licensing/onboarding products rather than a stable free REST source.
- **FINRA datasets**: valuable official reference data, but the target endpoint
  and dataset entitlement need a dedicated live contract; a failed guessed URL
  must not be promoted into an adapter.
- **Intrinio, TradingEconomics, Polygon paid tiers, broker order APIs**: useful
  products, but not part of the free/public research boundary.
- **EchoAPI**: a request/API integration tool, not a market-data authority. LCX
  can use its CLI for a permitted request, but the returned data still needs a
  named source, timestamp, and provenance receipt; EchoAPI itself is never
  treated as a provider.

## GDELT service degradation

`gdelt_public_news` retains DOC API failures and paces requests at least five
seconds apart. The public service can still return HTTP 429. Transport receipts
retain allowlisted network codes without logging URLs, headers, or raw errors;
transient GET resets may retry once within the total call budget. Certificate
and authorization failures do not retry.

`gdelt_public_news_titles` uses GDELT's official downloadable TOC files as a
separate, keyless source. It searches titles in two sampled minutes from a
recent 15-minute processing window, at least five minutes behind `asOf`.
For a company name, set `seriesId` to a literal keyword such as `Apple` while
keeping `instrument` as `AAPL`. This is a bounded title sample, not fulltext
search or complete news coverage. Every result retains the sampled file URLs,
content hashes, monitoring timestamps, and missing-file coverage. An empty
sample does not establish that no news exists. Direct batch callers reserve
two HTTP calls per source; the all-source runner already reserves three.

Gzip downloads use the existing proxy-aware, deadline-governed transport with
4 MiB compressed and 16 MiB decoded limits. No browser challenge, login, paid
permission, or rate-limit bypass is used. GDELT explicitly recommends its
[downloadable ngrams and TOC data](https://blog.gdeltproject.org/using-the-new-web-ngrams-dataset-to-find-relevant-coverage/)
while its search infrastructure is being migrated.

## Open-source agent patterns audited

OpenBB, TradingAgents, FinRobot, and the smaller AI Hedge Fund projects were
used as pattern references rather than copied wholesale. The reusable ideas
were: a connector registry, separate fundamental/sentiment/technical/risk
roles, explicit provider keys, and source-specific fallbacks. LCX keeps those
ideas behind its canonical ontology and research-only gateway, so a GitHub
agent's README or a green test cannot promote a provider, model, or execution
authority by itself.

Primary references:

- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [Treasury average interest rates](https://catalog.data.gov/dataset/average-interest-rates-on-u-s-treasury-securities)
- [GDELT DOC 2.0 API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)
- [FMP pricing](https://site.financialmodelingprep.com/developer/docs/pricing)
- [Massive stocks pricing](https://www.massive.com/stocks)
- [Alpha Vantage support and limits](https://www.alphavantage.co/support/)
- [OpenBB connector catalog](https://github.com/OpenBB-finance/OpenBB)
- [TradingAgents](https://github.com/edengilbertus/TradingAgents)
- [FinRobot](https://github.com/AdamBrodowski/finrobot)
