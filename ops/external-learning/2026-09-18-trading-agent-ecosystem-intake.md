# Trading-Agent Ecosystem Intake

**Intake ID:** `trading_agent_ecosystem_intake_20260918`
**Access date:** `2026-09-18`
**Scope:** the open trading/quant agent ecosystem — agent frameworks, MCP servers, and
agent skills — surveyed over the public GitHub API, not from memory.
**Decision:** absorb a small number of _contracts_ into existing LCX owners; register the
genuine gaps as future work with explicit owners; reject every direct adoption that would
grant execution, external-sender, or second-state-root authority.

## Why this intake exists

An earlier pass in this same working session concluded "the high-star quant agents do not
need porting; the mechanisms are largely already present" from a sample of **two**
repositories. That conclusion was challenged, correctly, on coverage grounds. A two-repository
sample cannot support a global negative claim, and the earlier pass had not used any live
network access.

This intake is the redo. It records **how** the survey was performed so the claim strength
matches the evidence, then states what survived and what was falsified.

## Survey method and coverage

`gh` CLI is **not installed** on this host, and no GitHub connector exists in the tool
inventory. The survey therefore used the **public GitHub REST API and
`raw.githubusercontent.com`** — real network access, and independently reproducible.

| Step                                            | Endpoint                                  | Measured result                                             |
| ----------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| Keyword sweep                                   | `GET /search/repositories?q=…&sort=stars` | 10 queries → **109 unique repositories**                    |
| Curated-list sweep                              | `raw.githubusercontent.com/.../README.md` | `LLMQuant/awesome-trading-agents` → **116 unique projects** |
| Per-repo metadata (stars, license, `pushed_at`) | `GET /repos/{owner}/{repo}`               | **37** Agents-class repos fetched one by one                |
| Quota discipline                                | `GET /rate_limit`                         | unauthenticated: search 10/min, core 60/hr — **exhausted**  |

Quota is a real constraint and is recorded rather than hidden: the final license re-check
in this pass returned `403` after two repositories, so several licenses below are marked
**not re-verified in this pass** instead of being asserted.

The curated list also points at four deeper catalogues that were **not** enumerated:
`georgezouq/awesome-ai-in-finance`, `wilsonfreitas/awesome-quant`,
`wangzhe3224/awesome-systematic-trading`, `DataArcTech/Awesome-FinLLMs`. Coverage is
therefore "a broad sweep of the most-adopted projects", **not** "the whole ecosystem".

### Ecosystem shape

The 116 curated projects split into three classes, which matters because they are not
substitutes:

- **Agents** — multi-agent trading (28), single-agent (9), research copilots (6),
  live trading contests (4), prediction markets (3), benchmarks (4), strategy
  self-improvement (4).
- **MCP servers** — market data (17), brokerage (9), research tooling (5),
  TradingView (1), prediction markets (2), backtesting (1).
- **Agent skills** — equity research (7), crypto/DeFi (4), strategy backtesting (3),
  broker execution (3).

### Star ranking (Agents class, fetched one by one on 2026-09-18)

| Repository                                                                          | Stars       | Note                                      |
| ----------------------------------------------------------------------------------- | ----------- | ----------------------------------------- |
| [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents)     | **107,277** | bull/bear research, risk synthesis        |
| [virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund)                   | **63,436**  | educational POC; states it does not trade |
| [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)                         | **33,608**  | MIT; pushed 2026-09-17; "Shadow Account"  |
| TradingAgents-CN                                                                    | 31,848      | Chinese-localised fork                    |
| [HKUDS/AI-Trader](https://github.com/HKUDS/AI-Trader)                               | **22,369**  | agent-native platform; OpenClaw client    |
| NoFxAiOS/nofx                                                                       | 12,922      |                                           |
| QuantDinger                                                                         | 11,704      |                                           |
| ValueCell                                                                           | 11,007      |                                           |
| [AI4Finance-Foundation/FinRobot](https://github.com/AI4Finance-Foundation/FinRobot) | 8,024       |                                           |
| [TraderAlice/OpenAlice](https://github.com/TraderAlice/OpenAlice)                   | 7,085       | AGPL-3.0 (prior pass)                     |
| AutoHedge                                                                           | 6,135       |                                           |
| CloddsBot                                                                           | 2,755       |                                           |
| atlas-gic                                                                           | 2,188       | Autoresearch Loop; factor evolution       |
| ai-market-maker                                                                     | 2,102       |                                           |
| lumibot                                                                             | 2,074       |                                           |
| LangAlpha                                                                           | 1,754       |                                           |
| FinMem                                                                              | 960         |                                           |
| ContestTrade                                                                        | 679         |                                           |

Only the linked entries had their `owner/repo` path fetched directly; the remaining rows are
recorded by the name observed in the sweep, and their exact owner path must be resolved before
any reuse. **At least eight projects above 7k stars had been missed entirely** by the
two-sample pass.

## Official sources reviewed

Read on 2026-09-18. Stars, license, and `pushed_at` are that day's snapshot; any future
reuse must refresh the revision and license.

| Source                                                             | Reusable mechanism                                                                                                                                                                                      | License / reuse boundary                                                | LCX decision                                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `HKUDS/Vibe-Trading` (33,608★, MIT)                                | **Shadow Account**: parse broker journal → behaviour profile (disposition effect, overtrading, momentum chasing, anchoring) → extract explicit rules → shadow backtest against the actual path → report | MIT; behavioural analysis of the owner's own records                    | **Register as a gap.** No LCX counterpart exists. See "Confirmed gaps" ②                                               |
| `HKUDS/AI-Trader` (22,369★; README badge MIT, API `license: null`) | Agent-native trading platform: one-message agent registration, experiment/challenge/leaderboard, live mark-to-market scoring, paper trading, copy trading                                               | MIT per README badge; **API reports `null`** — resolve before any reuse | **Integration opportunity, not a port.** Registration is an external-channel write → **not authorised by this intake** |
| `TauricResearch/TradingAgents` (107,277★)                          | Specialist financial roles; bull/bear adversarial research; risk and portfolio synthesis; decision-log memory                                                                                           | Apache-2.0 (prior pass); not re-verified                                | **Already owned.** Adversarial lane is _mandatory_ in LCX, not optional                                                |
| `virattt/ai-hedge-fund` (63,436★)                                  | Fund mandate separate from ticker input; pluggable alpha models; persistent fund cycle                                                                                                                  | MIT (prior pass); README states it does not trade                       | **Already owned.** Native finance pipeline + paper adapter                                                             |
| `AI4Finance-Foundation/FinRobot` (8,024★)                          | Deterministic valuation operators separated from LLM narration; numeric provenance                                                                                                                      | Apache-2.0 (prior pass); not re-verified                                | **Already owned.** `quality-harness-quality.ts` enforces a stricter version                                            |
| `TraderAlice/OpenAlice` (7,085★)                                   | Trading-as-versioned-artifact; account snapshots; pre-execution guard pipeline                                                                                                                          | AGPL-3.0 (prior pass)                                                   | **Architecture reference only.** No AGPL source enters LCX                                                             |
| `atlas-gic` (2,188★)                                               | Autoresearch Loop + Agent Spawning; four-layer desks; PRISM regime training                                                                                                                             | not re-verified                                                         | **Downrank.** Highest cost, and the interface to `finance-strategy-method-catalog` is unverified                       |
| `QuantMind` (~1.5k★)                                               | Integrates Microsoft RD-Agent for factor evolution                                                                                                                                                      | not re-verified                                                         | **Downrank** with `atlas-gic` (same gap ③)                                                                             |

## Pattern-to-owner map

| External pattern                    | LCX owner                                               | Current proof                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| specialist roles / bull-bear debate | `src/agents/finance-agent-committee.ts`                 | committee runtime exercised; adversarial lane is a required lane, not optional                                                |
| deterministic math, no model math   | `src/agents/tools/quant-math-tool.ts`                   | CAGR / Calmar / Sharpe / Sortino / max-drawdown / drawdown-duration / VaR as pure functions                                   |
| numeric grounding gate              | `src/agents/quality-harness-quality.ts:175,197`         | refuses an answer whose numbers lack cited evidence **with the same unit and timestamp** — stricter than the surveyed version |
| pre-execution guard pipeline        | `src/agents/finance-execution-adapter.ts`               | declarative adapter + risk budget + structured refusal reasons; **paper adapter only**                                        |
| execution receipt                   | `src/agents/finance-execution-adapter.ts`               | `lcx_finance_execution_receipt_v1`, refusal reasons enumerated                                                                |
| append-only position ledger         | `src/agents/finance-position-ledger.ts`                 | hash-chained SQLite ledger, migration ledger, idempotent by `receiptId`                                                       |
| equity curve projection             | `src/agents/finance-equity-curve.ts`                    | levels sampled at mark instants; no interpolation; annualisation requires a caller-declared period                            |
| checkpoint / resumable run          | `src/agents/logical-agent-pool-checkpoint-store.ts`     | plan-fingerprinted checkpoints under the canonical state root                                                                 |
| strategy cost/stress benchmarking   | `scripts/operator/finance-strategy-method-benchmark.ts` | price-series input, hypothetical-strategy metrics, cost in bps, stress matrix. **Not** the ledger's object                    |

## Where LCX is already stronger (do not port these)

These were re-checked against the source in this pass, because the earlier pass had made
claims in both directions that did not survive contact with the code:

1. **Numeric grounding.** The earlier pass asserted LCX lacked a grounding gate. It does
   not lack one — `quality-harness-quality.ts:175,197` refuses a finance answer whose
   numbers are not backed by cited evidence _with the same unit and timestamp_. That is
   stricter than the "drop unverified numbers" behaviour seen in the surveyed projects.
2. **Adversarial review.** `REQUIRED_LANES` **forces** an `adversarial_challenge` lane.
   In the surveyed frameworks this is a configuration choice; here it is mandatory.
3. **Durable ledger discipline.** The surveyed trading products persist state in an
   application database with audit logs. LCX's position ledger is hash-chained, refuses
   in-place mutation via triggers, and re-derives positions by projection so stored
   holdings cannot drift from the recorded fills.
4. **Execution authority default.** LCX's execution seam is default-closed with no real
   venue adapter. Several surveyed projects ship broker/order paths by default.

## Confirmed gaps

Three of these were verified against LCX source in this pass; one was verified by reading
the external README.

① **No durable thesis object.** _Narrower than it first appeared._ `thesis` **is** already
declared (`LCX_ONTOLOGY_DOMAIN_ENTITY_TYPES`), and `thesis_catalyst_lifecycle` is a wired
module with a task family, an alias (`thesis_catalyst_lifecycle_review`), eval families,
evidence families (`thesis_evidence`), a doctrine card (`HOLDINGS_THESIS_REVALIDATION_…`),
and real consumers (`holdings_thesis_revalidation`, `visible-answer-adoption-gate.ts`).
What does **not** exist is a **persisted thesis entity with lifecycle state** — an id'd
record with evidence links and transitions (active / invalidated / realised) comparable to
the position ledger. Today thesis is vocabulary plus prompt content plus an answer
requirement, not a stored object.

② **No behaviour profile of the owner's own trading.** Verified absent: the terms
`disposition_effect`, `overtrading`, `momentum_chasing`, `anchoring` have **zero** matches
in `src/`. Vibe-Trading's Shadow Account analyses the owner's broker journal for
behavioural patterns and compares the actual path against a shadow backtest. LCX has
`trade_journal_post_mortem_learning` as a _prompt family_ only.
**Same-name warning:** LCX's `shadow_replay` / `shadow_live` nodes mean _isolated replay of
an external pattern_ — a different concept. Do not conflate them.

③ **No factor/alpha evolution loop.** The surveyed ecosystem has Autoresearch loops that
propose, evaluate, and promote factors. LCX has language distillation and self-repair, but
no factor evolution. **Highest cost of the three**, and it depends on an interface to
`finance-strategy-method-catalog.ts` that has **not** been checked.

④ **Not integrated with any agent-native platform.** `HKUDS/AI-Trader` explicitly lists
**OpenClaw** among supported agents and registers an agent by having it read
`https://ai4trade.ai/SKILL.md`. This is an _integration_ opportunity, not a mechanism to
port — and it is **not** authorised here, because registration publishes signals and
supports copy trading, i.e. external-channel writes and trade mirroring.

## Rejected direct adoption

- No clone, dependency install, plugin activation, provider switch, model switch, training
  start, or external-channel write is authorised by this intake.
- **No agent-platform registration.** Joining an agent-native trading platform publishes
  signals and enables copy trading. That is outside LCX's `research_only` /
  `no_execution_authority` boundary.
- AGPL projects are architecture references only; no source is copied.
- A high star count is an adoption signal, not evidence of model quality, profitability,
  reliability, or LCX compatibility.
- The surveyed "shadow"/"journal"/"thesis" terms do not map onto LCX terms with the same
  spelling. Every mapping above was checked in source, not inferred from the name.

## Absorption plan

| Item                                                | Decision              | Owner / next action                                                                                                                  |
| --------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Ecosystem survey                                    | **keep**              | this file; refresh stars/license before any future reuse                                                                             |
| Grounding, adversarial lane, ledger, guard pipeline | **already owned**     | no action — recorded here so it is not "ported" twice                                                                                |
| Durable thesis entity with lifecycle state          | **candidate**         | would extend the finance domain next to `finance-position-ledger.ts`; requires an ontology node + filters + a migration ledger entry |
| Behaviour profile from own fills (Shadow Account)   | **candidate**         | highest value-per-cost; reads the existing receipt/mark stream; would add behavioural _labels_, and must not become advice           |
| Factor/alpha evolution loop                         | **downrank**          | depends on an unchecked `finance-strategy-method-catalog.ts` interface; do not start before that check                               |
| `HKUDS/AI-Trader` platform registration             | **discard (for now)** | external-channel write + copy trading; would need an explicit owner decision outside this intake                                     |

## Acceptance gates for future expansion

Any item above may advance only when it supplies:

1. exact source URL, revision, license, and read scope;
2. a mapping to an existing LCX owner and canonical ontology vocabulary;
3. deterministic replay and focused tests for the failure it claims to prevent;
4. no new state root and no hidden authority;
5. an explicit keep/downrank/discard decision after an adjacent real workflow;
6. separate evidence for runtime, model quality, promotion, external binding, and
   user-visible observation.

## Evidence layers

Stated separately, because they are not interchangeable:

- **Survey / network evidence:** real API calls on 2026-09-18; counts and star figures
  above are measured. Quota exhaustion is recorded, not hidden.
- **Repository evidence:** every "already owned" and "verified absent" row was re-read in
  LCX source during this pass.
- **Not yet proven:** that any candidate gap improves LCX output; that a licence is
  compatible for any repo marked _not re-verified_; that `AI-Trader`'s API `license: null`
  resolves to MIT.
- **Not claimed:** that LCX has learned any model weights, reproduced any surveyed
  performance, or bound any external service.
