# Finance automatic lifecycle owner map

This is an orientation and anti-drift map, not a second workflow, registry, or
state authority. When it disagrees with source, the canonical owners named
below win. Update this map only after the owner source and its proof change.

## Non-negotiable shape

Day, intraday, and night are phases of one paper-trading lifecycle owned by
`scripts/operator/lcx-finance-scheduler.ts`. A phase may invoke an existing
owner; it must not reimplement research, execution, settlement, promotion, or
state in the scheduler.

```text
observe state
  -> collect timestamped evidence
  -> select and execute finance-module DAG
  -> committee and quality review
  -> compile a bounded portfolio/strategy candidate
  -> deterministic readiness, mandate, risk, quote and reconciliation gates
  -> paper adapter
  -> execution and position receipts with optional source-decision references
  -> night settlement, reflection and news review
  -> scored directional outcomes
  -> forecast-calibration proposal (ends at review; no execution promotion)

execution receipts + scoped broker history
  -> fill and fee reconciliation
  -> account trading book
  -> gross marked-value and fee-adjusted realized-trade diagnostics
  -> source-decision link coverage (where producers supply stable references)
  -> strategy/candidate attribution + benchmark + out-of-sample net evidence
  -> paper-execution promotion contract [not implemented]
```

An arrow exists only when the downstream owner consumes an upstream durable
receipt. A Flow Graph edge, imported module, configured connector, tool name,
or successful model call is not proof of that handoff.

## Open method development and immediate adaptation

Research may retain, revise or propose competing mechanisms whenever relevant evidence
changes. The 20-session economic review is a comparison window, never a waiting period
or a fixed strategy list. A loss alone does not invalidate a method; a win alone cannot
qualify it or expand account authority.

The original research operator's existing `--persist-theses` path also consumes optional
quality-supported `financeStrategyRuleProposals`. It verifies the original claim, basis,
instrument, evidence content and cutoff before declaring a content-addressed **draft**
in the existing strategy-rule ledger. Repeated proposals cannot overwrite, reopen or
activate earlier declarations. Arbitrary form names remain admissible as drafts.
Lifecycle feedback validates these drafts with the actual native form owners and exposes
missing implementation/contract work to existing strategy-applicability inspection; the
continued presence of a draft does not itself schedule another model request.

The original rule operator validates a declaration's implemented form/body/timing before
its separate `--activate` event. Unknown forms require an implementation and scoped
validation; they cannot silently execute trend or ORB logic. Native contract validation
is not a backtest, observed profit, economic promotion or permission to place orders.
Existing execution and risk owners still decide every Paper order. ORB identities are
open within its implemented versions; legacy identity/version bindings and exit semantics
remain pinned, and new identities retain original intraday ownership and deduplication.

Original trade review receives the same-account/rule/activation aggregate of observed
protective exits before the two detailed examples are selected. This can challenge the
next judgment immediately across symbols; it omits ordinary exits and open gains and
must not be called whole-method net performance. Whole-method FIFO attribution remains
in original research/lifecycle feedback, with unverified fees explicit.

## Decision loop and selective research

The lifecycle diagram names available owners; it is not a checklist requiring
every module or research stage for every order. The original trade decision
review (`src/agents/finance-trade-decision-review.ts`) starts with supplied
account, market and execution evidence. When evidence suffices, decide. For a
specific unresolved hypothesis, select a registered tool or Skill, inspect its
actual result, and incorporate it into the judgment before proceeding. Use exact
math tools for calculations. Broader research and specialist review remain
available when the task or existing contract requires them.

An intraday reviewer may veto with `strategyReassessment`: a concrete mechanism
contradiction, an observable recheck condition, and an optional alternative
research hypothesis. The original outcome ledger retains it. Before a later
discretionary review, the original execution owner supplies the latest appraisal
from the same account, instrument, rule and activation, excluding the current
signal and evidence after the decision cutoff. Automatic carry-forward expires
after 24 hours; the original history remains available for selective recall.
The model must record `strategyFeedbackResponse` against that prior signal:
`still_relevant` requires a current veto and reassessment, while `resolved` permits
a fresh decision and stops carrying the old concern. Account/data failures or a
recent loss alone do not establish strategy invalidation. Protective exits retain
their original review bypass. If the scoped recheck is unavailable, refuse that
candidate and retain the unresolved appraisal rather than silently applying the
same rule through model-failure fallback; other fallback paths remain unchanged.
No new store, scheduler or execution authority is
introduced.

Lifecycle feedback exposes unresolved appraisals to the existing Harness, behind
position, recovery and execution uncertainty priorities. The existing
`finance_research_run` planning owner may scope a mechanism/alternative question;
its plan-only receipt does not prove modules ran or a replacement was activated.
The original research/thesis contracts and activation/execution gates still own
those steps. An offline carry-forward test proves wiring, not natural model
adaptation, strategy profitability or permission to deploy a new strategy.

When recorded daily prices conflict, the original evidence loop can return bounded
retained provenance choices. A non-pair math request may explicitly select one
exact origin and source label through the existing bar reader. No source is
automatically preferred; missing labels and conflicts within the selected source
remain unavailable. Keep competing-source disagreement visible, and distinguish
source selection from verified coverage, adjustment equivalence or a fresh quote.
This reads the existing book and adds no provider call or execution authority.

Keep funding, scope, timestamps, quote freshness, duplicate prevention, risk,
review and reconciliation checks under their existing owners. Tool selection
never waives them. Persist a short decision reason, source references, actual
execution result and uncertainty; fetch supporting fields on demand rather than
copying full research or market history into each decision. A useful fragment
retains its provenance and missing context; partial evidence is not complete
evidence. Prove improvement by tracing a real candidate's tool result into its
judgment and subsequent outcome, not by counting agents, modules or trades.

The original execution-feedback recall verifies native account, venue, instrument,
direction and event times. Within its four-original budget, prefer the same native
direction before ranking operation time. Label the historical side and any
opposite-direction fallback; a search-summary match is not proof of direction.
This is prior context for judgment, not a new execution gate or automatic veto.

## Profit-first quantitative rule

Directional hit rate is a forecast-classification measure, not economic
break-even. A trade threshold must start from payoff and costs, for example
`E[net P&L] = p * E[win] - (1 - p) * E[loss] - E[costs]`, with costs and
payoffs scoped to the same strategy, instrument, venue, and observation window.
Risk, drawdown, benchmark, and out-of-sample evidence then decide whether the
result is usable. This describes the evidence contract to build; it is not a
claim that the current promotion path implements it.

Statistical appraisal follows that economic definition. Keep return measurement,
decision attribution, and skill appraisal separate; declare a comparable,
investable benchmark before scoring; retain the full tested-trial count and
return distribution before applying selection-bias or non-normality corrections.
The current receipts do not yet carry enough strategy/trial lineage or net-return
history to calculate those corrections.

## Canonical owners

| Concern                                        | Canonical owner                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Resident timing, phase deduplication, recovery | `scripts/operator/lcx-finance-scheduler.ts`                                                                                          |
| Day allocation and rebalance                   | `scripts/operator/lcx-finance-daily-cycle.ts`, `src/agents/finance-daily-cycle.ts`                                                   |
| Intraday observation and paper action          | `src/agents/finance-intraday-monitor.ts`, `src/agents/finance-intraday-execution.ts`                                                 |
| Research source batch                          | `src/agents/finance-research-batch.ts`, `src/agents/finance-research-batch-runner.ts`                                                |
| Finance-module selection and DAG               | `src/agents/finance-brain-orchestration.ts`, `src/agents/finance-module-composition.ts`                                              |
| Module tool dispatch and receipts              | `src/agents/finance-module-execution.ts`                                                                                             |
| Model committee and quality review             | `src/agents/finance-agent-committee.ts`, `src/agents/quality-harness.ts`                                                             |
| Research run and visible candidate gate        | `src/agents/finance-research-runner.ts`                                                                                              |
| Strategy budget proposal compilation           | `src/agents/finance-research-portfolio-plan.ts`, `src/agents/finance-portfolio-composition.ts`                                       |
| Strategy lifecycle                             | `src/agents/finance-strategy-rule-ledger.ts`                                                                                         |
| Readiness                                      | `src/agents/finance-rule-readiness-state.ts`                                                                                         |
| Execution authority and safety                 | `src/agents/finance-intent-compiler.ts`, `src/agents/finance-execution-safety.ts`, execution adapter owners                          |
| Positions and broker reconciliation            | `src/agents/finance-position-ledger.ts`, `src/agents/finance-account-trading-book.ts`, Alpaca history/reconciliation owners          |
| Gross diagnostics and drawdown                 | `src/agents/finance-equity-curve.ts`, `src/agents/tools/quant-math-tool.ts`, `src/agents/tools/finance-position-ledger-read-tool.ts` |
| Night outcome settlement                       | `scripts/operator/lcx-finance-daily-cycle.ts`, `src/agents/finance-outcome-backfill.ts`                                              |
| Reflection                                     | `src/agents/finance-reflection.ts`                                                                                                   |
| Forecast-direction calibration                 | `src/agents/finance-calibrated-floor.ts`, `src/agents/tools/finance-calibration-read-tool.ts`                                        |
| Forecast-calibration proposal                  | `src/agents/finance-tuning-proposal.ts`, `src/agents/finance-tuning-lifecycle.ts`                                                    |
| Paper-execution promotion                      | Not implemented; `src/agents/finance-paper-promotion.ts` excludes legacy directional records from execution                          |
| Central Harness finance feedback               | `src/agents/finance-automatic-lifecycle-feedback.ts`                                                                                 |
| Structural wrong-flow detection                | `scripts/operator/lcx-flow-graph.ts`                                                                                                 |

## Whole-account economic evaluation

The existing night scheduler captures account close observations through the original
read-only Alpaca transport and seals them in the existing broker-history ledger.
`finance-paper-economic-window.ts` evaluates actual calendar-close equity alongside
primary-market SPY/QQQ closing auctions and vendor dividend/split adjustment factors.
The normal account-research and night-review evidence readers consume those sealed
observations at their own cutoff. This adds no trading authority or separate state store.

Keep verified initial funding distinct from an unverified opening-day close. External
cashflows without before/after valuations make returns unknown. Posted charges already
included in account equity are not deducted twice; pending fees and model currency bills
remain separate unknowns. Retain the repair boundary and inherited-position attribution
gaps rather than assigning all subsequent account performance to new decisions. Vendor
adjustment factors are a total-return proxy, not exact dividend reinvestment executions.
The twenty-session comparison window never blocks immediate evidence-led adaptation.

## Soft and hard responsibilities

Models may select analytical lenses, interpret sourced evidence, build causal
hypotheses and scenarios, summarize news, challenge a thesis, and propose
bounded strategy budgets or tuning candidates. Model output remains evidence or
a candidate.

TypeScript owns source timestamps and provenance, schemas, actual module-tool
dispatch receipts, DAG dependency failure, stage and mode compatibility,
readiness, portfolio bounds, execution mandate, quote freshness, reconciliation,
deduplication, recovery, venue binding, order safety, and ledger writes.
Forecast-direction calibration may describe hit rate and Brier score, but it
cannot promote a paper execution threshold. Promotion requires a separate
strategy-attributed, reconciled net-trade evidence contract. Numeric limits are controller-declared policy/state and may be
changed only through their owner transition; they are not hidden constants
invented by a model or by the scheduler.

## Finance arsenal

The canonical module catalog currently contains these reusable lenses:

- Regime and transmission: `macro_rates_inflation`, `etf_regime`,
  `cross_asset_liquidity`, `fx_currency_liquidity`, `global_index_regime`,
  `us_equity_market_structure`, `china_a_share_policy_flow`,
  `crypto_market_structure`, `credit_liquidity`, `commodities_oil_gold`,
  `fx_dollar`.
- Instrument and timing: `company_fundamentals_value`, `technical_timing`,
  `options_volatility`, `event_driven`.
- Control and challenge: `portfolio_risk_gates`, `quant_math`, `causal_map`,
  `finance_learning_memory`.

Ten framework domains have real producer tools. Their success requires a
source-backed structured producer input, a successful producer call, and a
successful core inspection. The remaining lenses use deterministic math or the
finance-learning retrieval substrate. Selection is not execution; every node
must leave a per-tool receipt.

The source arsenal includes the market collection and realtime registries,
public price/history adapters, FRED macro series, GDELT and RSS news, registered
credential-backed company/fundamental/options/event/reference adapters, local
bar and position ledgers, broker history, and scored research outcomes. A
configured adapter is usable only when the registry selects it and the run
records a timestamped attempt.

## Durable state machines

- Scheduler: `idle -> running -> succeeded|failed`; day/night are deduplicated
  by ET date, and a prior `running` attempt requires reconciliation.
- Source/model checkpoint: `reserved -> completed`; an interrupted reservation
  is `uncertain`, never assumed not to have run.
- Research packet: `planned|candidate|needs_review|blocked`.
- Strategy rule: `draft -> active -> retired`; retirement is terminal.
- Intraday decision: append-only decision followed by exactly one
  `placed|refused|uncertain` outcome.
- Execution: reservation/recovery and append-only receipt/position projection;
  unknown venue outcome is not safe to replay.

All finance state resolves through `src/agents/finance-state-dir.ts`. SQLite
ledgers own positions, outcomes, strategy rules, bars, and intraday decisions;
JSON/JSONL receipts own scheduler attempts, research samples/scores, proposals,
and bounded latest views. No owner may silently introduce another finance state
root.

## Historical handoff snapshot (2026-09-24 source)

This snapshot predates the method/version attribution and whole-account evaluation
described above; its historical gaps are not a current repair checklist.

1. Night settlement may dispatch the canonical tuning lifecycle after newly
   appended scored outcomes. Its input is binary forecast-direction accuracy;
   `lcx_finance_tuning_proposal_v2` records review-only calibration proposals.
2. Legacy paper-promotion rows are preserved for audit and may seed the
   historical calibration comparison. They are tagged
   `legacy_directional_calibration_only`, are never returned as current paper
   promotions, and cannot authorize paper selection or execution.
3. Calibrated paper rank/place declines until a strategy-attributed net-trade
   promotion exists. Explicit `explore` mode remains an evidence-generation
   path under the existing execution gates.
4. Position-ledger read keeps the gross receipt projection distinct from the
   optional account-scoped Alpaca paper history. It may expose realized trade
   P&L after supported fees only when fill and fee history reconciles. That
   number still omits full account equity, open-position mark-to-market,
   strategy/forecast attribution, and benchmark comparison. The receipt
   contract accepts typed source-decision references and the read tool reports
   coverage; malformed references are refused before adapter dispatch. Both
   daily-cycle and intraday producer call sites now supply references. The
   current daily-cycle review candidate key is
   `[runAuthorizationId, signalAnchor, instrument,
action].join(":")`; the intraday review candidate key is `signalId`. The
   daily intent `conclusionId` (`daily_cycle:${signalAnchor}:${instrument}`)
   is a different, coarser identity and must not silently replace the review
   candidate key in execution lineage. Receipts without references remain
   incomplete lineage; references remain optional for legacy/manual receipts.
   The Flow Graph checks source-level wiring, but it does not prove live receipt
   coverage; a fresh normal-cycle receipt from each path is still needed. These
   references do not yet identify a stable strategy, version, trial, or forecast
   cohort.
5. Central Harness feedback is read-only and includes scheduler process and
   Paper-policy status, day/night receipts, current readiness, and bounded bar
   and position-store facts. It reports that the execution-promotion contract
   is unavailable, plus the next evidence task. The Harness has no execution
   authority and does not restart the scheduler or refresh market providers.
   The strategy-rule and bar snapshots now use existing-database read-only
   connections and skip directory creation, permission changes, and schema
   migrations; writers retain the migration path.
6. Flow Graph checks source-level handoffs, including the separation between
   forecast calibration and execution economics. A green structural check does
   not prove runtime loading, a completed paper cycle, an order, or profitability.

## Implemented lifecycle slice

The research owner now validates committee-produced, evidence-grounded inputs
for only the selected producer-backed modules, dispatches the existing module
DAG, and places real producer/inspect receipts before final quality review. The
operator CLI exposes this explicitly, and scheduled day research requests it.

Night now projects settlement, positions, executions/refusals, active rules and
intraday decisions from the canonical state root into bounded controller
evidence. When automatic research is configured, the same source/module/
committee/quality owner performs the news and reflection review and persists its
normal research receipt; no separate night model caller exists.

The night scheduler dispatches forecast calibration only when settlement
reports newly appended scored outcomes. The lifecycle records a versioned
proposal and exposes its scope to Central Harness feedback; it does not write a
paper-execution promotion. The separate position and broker-history owners feed
gross and fee-adjusted trade diagnostics into the position read tool. The
intent/receipt contract now accepts explicit source-decision references and the
read tool reports their coverage. Daily and intraday producers pass references,
and Flow Graph checks that source path; runtime receipt coverage still needs a
fresh normal cycle. These references do not yet name a stable strategy, version,
trial, or full forecast cohort. Promotion remains blocked until those economics
can be joined to strategy decisions and evaluated against a benchmark and
out-of-sample evidence.

Do not add another night-only model caller, module catalog, portfolio engine,
execution path, state root, or fixed strategy threshold in the scheduler.
