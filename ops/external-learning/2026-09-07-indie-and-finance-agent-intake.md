# Indie, high-adoption, and finance-agent intake

**Intake ID:** `indie_and_finance_agent_intake_20260907`
**Access date:** `2026-09-07`
**Scope:** GitHub repositories with a usable product/workflow, not only generic
multi-agent frameworks. Stars are an adoption signal, not a quality guarantee.
**Decision:** register the patterns, implement only native LCX contracts, and
keep all finance execution authority outside the system.

## Shortlist

| Repository                                                                                | Maintainer shape              | Official snapshot read on 2026-09-07                                                                                           | Pattern worth absorbing                                                                                                            | Reuse boundary                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund)                         | individual developer          | 63.3k stars, MIT; the README calls it an educational proof of concept and says it does not actually trade                      | fund mandate separate from ticker input; pluggable alpha models; persistent fund cycle; backtest and paper record                  | native LCX finance pipeline only; no broker, order, or investment-advice authority                                                 |
| [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents)           | research organization         | 102,776 stars from the official GitHub API, Apache-2.0; active finance multi-agent repo                                        | specialist financial roles; bull/bear research; risk and portfolio synthesis; checkpoint/resume and decision-log ideas             | implement roles in `LogicalAgentPool`; do not import LangGraph runtime or trading execution                                        |
| [AI4Finance-Foundation/FinRobot](https://github.com/AI4Finance-Foundation/FinRobot)       | finance research organization | 7.9k stars, Apache-2.0; current README describes a 9-agent, 7-pipeline desktop research product                                | deterministic valuation operators separated from LLM narration; numeric provenance; provider failover; debate and traceable report | copy the separation contract and test shape, not the repository runtime or provider configuration                                  |
| [OpenBB-finance/OpenBB](https://github.com/OpenBB-finance/OpenBB)                         | finance software organization | 72.7k stars; repository license is AGPL-3.0                                                                                    | connect-once data layer; vendor normalization; common data surface for analysts, APIs, MCP, and agents; adapter health             | architecture and adapter contracts only; no AGPL source copied into LCX                                                            |
| [TraderAlice/OpenAlice](https://github.com/TraderAlice/OpenAlice)                         | individual/one-person product | 7.0k stars, AGPL-3.0; full-lifecycle trading product with explicit experimental warning                                        | trading-as-versioned-artifact; account snapshots; pre-execution guard pipeline; human stop points                                  | architecture-only; no AGPL code, broker, wallet, private-key, or order surface                                                     |
| [agentailor/cameron](https://github.com/agentailor/cameron)                               | individual developer          | 1 star, MIT; personal-finance agent that asks before every write                                                               | one approval gate for every capability; owner-controlled data; seed-data dogfooding                                                | use the approval/seed-eval pattern; no bank connector or money movement                                                            |
| [wolfbane/cents](https://github.com/wolfbane/cents)                                       | individual developer          | 0 stars, MIT; thesis-driven research CLI with paper-only scope                                                                 | explicit thesis/premises; specialist evidence; conviction changes; calibration-ready holdout                                       | use as an emerging design reference; never treat model conviction as calibrated truth                                              |
| [Caspian-Lin/FinResearch-Agent](https://github.com/Caspian-Lin/FinResearch-Agent)         | small/individual project      | recent repo snapshot; README emphasizes reproducible data → factor → backtest → risk → memo and no broker connection           | reproducible research workflow; data-health checks; benchmark comparison; anti-look-ahead discipline                               | architecture reference only until license and dependency scope are independently refreshed                                         |
| [Schadenfreunde/fin-research-agent](https://github.com/Schadenfreunde/fin-research-agent) | small project                 | 9 stars, MIT; structured cited equity/macro memos with pre-LLM API gathering and strict tool budgets                           | gather structured data before LLM calls; parallel specialist analysts; source coverage log; cited memo                             | absorb the pipeline contract, not its cloud/provider deployment                                                                    |
| [Panniantong/Agent-Reach](https://github.com/Panniantong/Agent-Reach)                     | individual developer          | 78.5k stars, MIT; capability layer with preferred/fallback backends and `doctor`                                               | capability abstraction; preferred/fallback adapter ordering; health diagnosis; explicit cookie/credential boundary                 | relevant to finance/source adapters; never import cookies, tokens, installers, or external senders                                 |
| [EchoAPI](https://www.echoapi.com/wiki/docs/start)                                        | API test/client project       | HTTP, SSE, and TCP request client; the CLI runs one or more saved interface/test cases and exports JSON reports                | real public-case execution, response-contract checks, timing/status receipt, and local CI integration                              | exact CLI `3.0.0` is bootstrapped once under the canonical state root; no webhooks, client certs, secret env, or finance authority |
| [Binance Spot API](https://github.com/binance/binance-spot-api-docs)                      | exchange API                  | official open documentation and public market-data endpoints; public market data uses the data-only endpoint                   | crypto primary ticker, exchange timestamp/latency labels, public REST/WebSocket expansion                                          | public market data only; no API key, order, wallet, or user-data endpoint                                                          |
| [Kraken Spot API](https://docs.kraken.com/api/)                                           | exchange API                  | official public REST/WebSocket market-data endpoints; account is not required for public market data                           | independent crypto ticker and depth/trade cross-check                                                                              | public endpoints only; no authenticated account or order surface                                                                   |
| [Coinbase Exchange API](https://docs.cdp.coinbase.com/exchange/introduction/welcome)      | exchange API                  | public market-data APIs are separated from authenticated trading/account APIs                                                  | independent crypto ticker with exchange event time and 24h volume                                                                  | public market data only; no bearer token, portfolio, or trade endpoint                                                             |
| [Bybit V5 Market API](https://bybit-exchange.github.io/docs/v5/market/tickers)            | exchange API                  | official public spot ticker returns latest price, bid/ask, and 24-hour volume                                                  | low-latency crypto ticker cross-check with server timestamp and latency receipt                                                    | public market endpoints only; no account, order, position, or wallet surface                                                       |
| [OKX Market API](https://www.okx.com/docs-v5/en/#rest-api-market-data-get-ticker)         | exchange API                  | official public ticker returns latest price, bid/ask, volume, and exchange timestamp                                           | low-latency crypto ticker cross-check with exchange timestamp                                                                      | public market endpoints only; no authenticated or trade surface                                                                    |
| [Bitstamp API](https://www.bitstamp.net/api/)                                             | exchange API                  | official public v2 ticker endpoint returns last price, volume, and timestamp                                                   | independent long-running spot-market cross-check                                                                                   | public market endpoint only; no account, order, or wallet surface                                                                  |
| [CoinCap API](https://coincapapi.mintlify.app/quickstart)                                 | public crypto API             | REST API for live crypto assets; API key is optional in the documented quickstart                                              | additional crypto price/volume cross-check and explicit unavailable-source receipt                                                 | never treat one aggregator as truth; current host failure remains visible                                                          |
| [Open-Meteo](https://open-meteo.com/en/docs)                                              | open weather/geocoding API    | public geocoding, forecast, elevation, and environmental APIs; free-tier usage/licence limits apply                            | location resolution, current weather, model/update timestamps, and environmental context                                           | respect attribution/licence and rate limits; no hidden commercial-use assumption                                                   |
| [Nominatim/OpenStreetMap](https://nominatim.org/release-docs/latest/api/Search/)          | open geospatial API           | public forward/reverse geocoding backed by OSM; public instance requires identifying User-Agent and max 1 req/s                | independent geocoding cross-check and OSM object provenance                                                                        | no heavy use, no bypass, no tiles; display OSM attribution                                                                         |
| [USGS Earthquake Feed](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php)     | official geospatial feed      | real-time GeoJSON summary feeds intended for programmatic applications                                                         | event count, maximum magnitude, latest event and source-time receipt                                                               | feed is event context, not a market or risk guarantee                                                                              |
| [NOAA/NWS API](https://www.weather.gov/documentation/services-web-API)                    | official weather API          | public API provides current observations, forecasts, and alerts with cache-friendly responses                                  | official station observation cross-check for weather fields and freshness                                                          | current weather reference only; US station coverage, no alert-sending or operational authority                                     |
| [DemonDamon/FinnewsHunter](https://github.com/DemonDamon/FinnewsHunter)                   | individual developer          | public repository; realtime finance news, sentiment fusion, factor mining, and market-data workflow                            | collect timestamped news packets before sentiment analysis; deduplicate events; preserve retrieval/publication time                | architecture/fixture reference until source, license, scraper, and dependency audit pass                                           |
| [oujingzhou/openfr](https://github.com/oujingzhou/openfr)                                 | individual/small project      | public repository; lightweight finance research agent with market-data adapters, cache, retry/fallback, and market-hours hints | cache-age labels, bounded retry, provider fallback, market-hours awareness                                                         | pattern reference only until license and provider scope are refreshed; no AKShare install by default                               |
| [google-deepmind/amplio](https://github.com/google-deepmind/amplio)                       | research organization         | public harness; crash-resume and run-start source snapshot patterns                                                            | resume from a safe checkpoint with one inherited source snapshot                                                                   | map to the existing canonical state-root checkpoint owner; no second persistence authority                                         |

## What enters LCX

1. **Finance truth layer:** source registry, field definition, timestamp,
   provider conflict, preferred/fallback adapter, and an observable doctor
   result. This strengthens the existing finance data gateway; it does not add a
   second data authority. The native adapter set is Yahoo public chart, Nasdaq
   public exchange quote, Stooq daily, SEC EDGAR official filings, Invesco QQQ
   issuer performance, and the crypto exchange/API set (Binance, Kraken,
   Coinbase, Bybit, OKX, Bitstamp, CoinCap). Alpha Vantage and CoinGecko are available as explicitly
   keyed cross-check adapters; no key is stored in the repository.
   Geospatial data has its own registry for Open-Meteo, Nominatim, NOAA/NWS, and USGS so
   location/weather/event facts do not masquerade as financial prices.
2. **Finance role DAG:** extraction → data/evidence integrity → fundamental,
   technical, macro, sentiment, and opposing research → risk review → report
   precheck. All roles remain logical workers on the shared local model slot.
3. **Numbers/code boundary:** valuation, returns, exposure, drawdown,
   volatility, factor, and backtest calculations remain deterministic code. The
   model can explain, compare, challenge, and format; it cannot invent a number
   or turn a model score into advice.
4. **Thesis and falsification:** every research artifact gets premise ids,
   source receipts, catalyst/invalidation, missing data, counterevidence, and a
   review verdict. Conviction is a research field, not a calibrated forecast.
5. **Versioned and resumable artifacts:** mandate, plan, checkpoint, evidence
   packet, review, and final report are separate receipts. Checkpoints are
   persisted below the active state-root owner at
   `agents/logical-agent-checkpoints/`.
6. **Approval and execution boundary:** the useful part of trading systems is
   the guard pipeline and reversible review artifact. LCX still forbids broker,
   wallet, private-key, order, money-movement, and direct buy/sell authority.

## Second-wave native absorption

- `Agent-Reach` is absorbed as an adapter ordering and doctor pattern in
  `src/agents/finance-realtime-source-registry.ts`; the registry records failed
  preferred sources and successful fallbacks in one receipt.
- `FinnewsHunter` and `openfr` remain evidence/fixture references. Their news,
  sentiment, cache, retry, and market-hours ideas are not imported as scrapers,
  providers, or execution code until a separate source/license/dependency audit
  passes.
- `Amplio` is compared against the existing
  `src/agents/logical-agent-pool-checkpoint-store.ts`; it does not create a
  second checkpoint root.
- `EchoAPI` is a request/test harness, not a market-data authority. LCX now has
  a real CLI runner for one public case iteration plus a JSON/status receipt.
  The exact `echoapi-cli@3.0.0` is installed once under the canonical state-root
  runtime and reused thereafter; the installation records the npm tarball
  integrity and disables install scripts. It sends no webhook, does not inherit
  secret environment variables, and does not grant finance or trading authority.
- Public API adapters are live-capable, not fixture-only: crypto exchange data
  goes through Binance, Kraken, Coinbase, Bybit, OKX, Bitstamp, and CoinCap;
  geospatial context goes through Open-Meteo, Nominatim, NOAA/NWS, and USGS.
  Each source can fail independently, reports observed latency, and remains
  visible in the receipt.

## Rejected direct adoption

- No bulk clone, dependency install, plugin activation, provider switch, model
  switch, training start, or external-channel write is authorized by this
  intake.
- AGPL repositories (`OpenBB`, `OpenAlice`) are architecture references only.
- Credentials, cookies, API keys, broker sessions, wallet access, and personal
  finance data are not imported.
- A high star count does not prove model quality, profitable trading,
  production reliability, or LCX compatibility.
- The same model must not author, execute, and certify its own financial result;
  local deterministic checks and adversarial review remain separate gates.

## Native implementation order

1. Finish canonical state-root checkpoint persistence and restart proof.
2. Run one real local Qwen finance case through the existing MLX/eval owner;
   record raw generation, parsed contract, failure reasons, and boundary.
3. Add a finance-agent fixture to the existing logical-agent DAG with no current
   market data and verify missing-data, provenance, risk, and no-trade gates.
4. [completed locally] Extend the finance data gateway with a preferred/fallback
   adapter-health receipt and multiple native source adapters, using real public
   calls plus fixtures and no credentials. Yahoo remains delayed; Nasdaq is the
   current independent ETF cross-check; crypto uses Binance/Kraken/Coinbase and
   CoinCap; Stooq is challenge-blocked on this host. Add a separate geospatial
   registry for Open-Meteo, Nominatim, and USGS, plus an optional real EchoAPI
   CLI case runner with canonical state-root installation and reuse.
5. Only after those receipts pass, consider additional bounded provider adapters or
   local-model invocation change. No execution path is in this roadmap.

These are system patterns absorbed by LCX owners, not claims that LCX has
learned their model weights, reproduced their performance, or bound their
external services.
