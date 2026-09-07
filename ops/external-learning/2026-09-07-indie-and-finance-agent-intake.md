# Indie, high-adoption, and finance-agent intake

**Intake ID:** `indie_and_finance_agent_intake_20260907`
**Access date:** `2026-09-07`
**Scope:** GitHub repositories with a usable product/workflow, not only generic
multi-agent frameworks. Stars are an adoption signal, not a quality guarantee.
**Decision:** register the patterns, implement only native LCX contracts, and
keep all finance execution authority outside the system.

## Shortlist

| Repository                                                                                | Maintainer shape              | Official snapshot read on 2026-09-07                                                                                           | Pattern worth absorbing                                                                                                            | Reuse boundary                                                                                       |
| ----------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund)                         | individual developer          | 63.3k stars, MIT; the README calls it an educational proof of concept and says it does not actually trade                      | fund mandate separate from ticker input; pluggable alpha models; persistent fund cycle; backtest and paper record                  | native LCX finance pipeline only; no broker, order, or investment-advice authority                   |
| [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents)           | research organization         | 102,776 stars from the official GitHub API, Apache-2.0; active finance multi-agent repo                                        | specialist financial roles; bull/bear research; risk and portfolio synthesis; checkpoint/resume and decision-log ideas             | implement roles in `LogicalAgentPool`; do not import LangGraph runtime or trading execution          |
| [AI4Finance-Foundation/FinRobot](https://github.com/AI4Finance-Foundation/FinRobot)       | finance research organization | 7.9k stars, Apache-2.0; current README describes a 9-agent, 7-pipeline desktop research product                                | deterministic valuation operators separated from LLM narration; numeric provenance; provider failover; debate and traceable report | copy the separation contract and test shape, not the repository runtime or provider configuration    |
| [OpenBB-finance/OpenBB](https://github.com/OpenBB-finance/OpenBB)                         | finance software organization | 72.7k stars; repository license is AGPL-3.0                                                                                    | connect-once data layer; vendor normalization; common data surface for analysts, APIs, MCP, and agents; adapter health             | architecture and adapter contracts only; no AGPL source copied into LCX                              |
| [TraderAlice/OpenAlice](https://github.com/TraderAlice/OpenAlice)                         | individual/one-person product | 7.0k stars, AGPL-3.0; full-lifecycle trading product with explicit experimental warning                                        | trading-as-versioned-artifact; account snapshots; pre-execution guard pipeline; human stop points                                  | architecture-only; no AGPL code, broker, wallet, private-key, or order surface                       |
| [agentailor/cameron](https://github.com/agentailor/cameron)                               | individual developer          | 1 star, MIT; personal-finance agent that asks before every write                                                               | one approval gate for every capability; owner-controlled data; seed-data dogfooding                                                | use the approval/seed-eval pattern; no bank connector or money movement                              |
| [wolfbane/cents](https://github.com/wolfbane/cents)                                       | individual developer          | 0 stars, MIT; thesis-driven research CLI with paper-only scope                                                                 | explicit thesis/premises; specialist evidence; conviction changes; calibration-ready holdout                                       | use as an emerging design reference; never treat model conviction as calibrated truth                |
| [Caspian-Lin/FinResearch-Agent](https://github.com/Caspian-Lin/FinResearch-Agent)         | small/individual project      | recent repo snapshot; README emphasizes reproducible data → factor → backtest → risk → memo and no broker connection           | reproducible research workflow; data-health checks; benchmark comparison; anti-look-ahead discipline                               | architecture reference only until license and dependency scope are independently refreshed           |
| [Schadenfreunde/fin-research-agent](https://github.com/Schadenfreunde/fin-research-agent) | small project                 | 9 stars, MIT; structured cited equity/macro memos with pre-LLM API gathering and strict tool budgets                           | gather structured data before LLM calls; parallel specialist analysts; source coverage log; cited memo                             | absorb the pipeline contract, not its cloud/provider deployment                                      |
| [Panniantong/Agent-Reach](https://github.com/Panniantong/Agent-Reach)                     | individual developer          | 78.5k stars, MIT; capability layer with preferred/fallback backends and `doctor`                                               | capability abstraction; preferred/fallback adapter ordering; health diagnosis; explicit cookie/credential boundary                 | relevant to finance/source adapters; never import cookies, tokens, installers, or external senders   |
| [EchoAPI](https://www.echoapi.com/wiki/docs/start)                                        | API test/client project       | HTTP, SSE, and TCP request client with environments, scripts, cookies, and response assertions; VS Code support is MIT         | request authoring and response-contract test surface; redacted fixture import                                                      | not a market-data provider; no cookies, environment secrets, scripts, or remote writes imported      |
| [DemonDamon/FinnewsHunter](https://github.com/DemonDamon/FinnewsHunter)                   | individual developer          | public repository; realtime finance news, sentiment fusion, factor mining, and market-data workflow                            | collect timestamped news packets before sentiment analysis; deduplicate events; preserve retrieval/publication time                | architecture/fixture reference until source, license, scraper, and dependency audit pass             |
| [oujingzhou/openfr](https://github.com/oujingzhou/openfr)                                 | individual/small project      | public repository; lightweight finance research agent with market-data adapters, cache, retry/fallback, and market-hours hints | cache-age labels, bounded retry, provider fallback, market-hours awareness                                                         | pattern reference only until license and provider scope are refreshed; no AKShare install by default |
| [google-deepmind/amplio](https://github.com/google-deepmind/amplio)                       | research organization         | public harness; crash-resume and run-start source snapshot patterns                                                            | resume from a safe checkpoint with one inherited source snapshot                                                                   | map to the existing canonical state-root checkpoint owner; no second persistence authority           |

## What enters LCX

1. **Finance truth layer:** source registry, field definition, timestamp,
   provider conflict, preferred/fallback adapter, and an observable doctor
   result. This strengthens the existing finance data gateway; it does not add a
   second data authority. The native adapter set is Yahoo public chart, Nasdaq
   public exchange quote, Stooq daily, SEC EDGAR official filings, and the
   Invesco QQQ issuer performance endpoint. Alpha Vantage is available as an
   explicitly keyed cross-check adapter; no key is stored in the repository.
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
- `EchoAPI` is a request/test harness, not a market-data authority. Its useful
  pattern is redacted cURL import plus response-schema assertions; its cookies,
  environment variables, scripts, and remote-write capabilities remain outside
  LCX.

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
   adapter-health receipt and multiple native source adapters, using fixtures
   first and no credentials. Yahoo remains delayed; Nasdaq is the current
   independent exchange cross-check; Stooq is additionally attempted but
   challenge-blocked on this host; SEC and Invesco are official reference paths.
5. Only after those receipts pass, consider additional bounded provider adapters or
   local-model invocation change. No execution path is in this roadmap.

These are system patterns absorbed by LCX owners, not claims that LCX has
learned their model weights, reproduced their performance, or bound their
external services.
