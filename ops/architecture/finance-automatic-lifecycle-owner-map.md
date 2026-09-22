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
  -> execution and position receipts
  -> night settlement, reflection and news review
  -> scored outcomes
  -> tuning proposal
  -> deterministic paper-promotion decision
  -> promoted paper calibration consumed by paper rank / intent compiler
  -> next observation cycle
```

An arrow exists only when the downstream owner consumes an upstream durable
receipt. A Flow Graph edge, imported module, configured connector, tool name,
or successful model call is not proof of that handoff.

## Canonical owners

| Concern                                        | Canonical owner                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Resident timing, phase deduplication, recovery | `scripts/operator/lcx-finance-scheduler.ts`                                                                 |
| Day allocation and rebalance                   | `scripts/operator/lcx-finance-daily-cycle.ts`, `src/agents/finance-daily-cycle.ts`                          |
| Intraday observation and paper action          | `src/agents/finance-intraday-monitor.ts`, `src/agents/finance-intraday-execution.ts`                        |
| Research source batch                          | `src/agents/finance-research-batch.ts`, `src/agents/finance-research-batch-runner.ts`                       |
| Finance-module selection and DAG               | `src/agents/finance-brain-orchestration.ts`, `src/agents/finance-module-composition.ts`                     |
| Module tool dispatch and receipts              | `src/agents/finance-module-execution.ts`                                                                    |
| Model committee and quality review             | `src/agents/finance-agent-committee.ts`, `src/agents/quality-harness.ts`                                    |
| Research run and visible candidate gate        | `src/agents/finance-research-runner.ts`                                                                     |
| Strategy budget proposal compilation           | `src/agents/finance-research-portfolio-plan.ts`, `src/agents/finance-portfolio-composition.ts`              |
| Strategy lifecycle                             | `src/agents/finance-strategy-rule-ledger.ts`                                                                |
| Readiness                                      | `src/agents/finance-rule-readiness-state.ts`                                                                |
| Execution authority and safety                 | `src/agents/finance-intent-compiler.ts`, `src/agents/finance-execution-safety.ts`, execution adapter owners |
| Positions and broker reconciliation            | `src/agents/finance-position-ledger.ts`, Alpaca history/reconciliation owners                               |
| Night outcome settlement                       | `scripts/operator/lcx-finance-daily-cycle.ts`, `src/agents/finance-outcome-backfill.ts`                     |
| Reflection                                     | `src/agents/finance-reflection.ts`                                                                          |
| Tuning proposal                                | `src/agents/finance-tuning-proposal.ts`                                                                     |
| Deterministic paper calibration promotion      | `src/agents/finance-paper-promotion.ts`, `src/agents/finance-tuning-lifecycle.ts`                           |
| Central Harness finance feedback               | `src/agents/finance-automatic-lifecycle-feedback.ts`                                                        |
| Structural wrong-flow detection                | `scripts/operator/lcx-flow-graph.ts`                                                                        |

## Soft and hard responsibilities

Models may select analytical lenses, interpret sourced evidence, build causal
hypotheses and scenarios, summarize news, challenge a thesis, and propose
bounded strategy budgets or tuning candidates. Model output remains evidence or
a candidate.

TypeScript owns source timestamps and provenance, schemas, actual module-tool
dispatch receipts, DAG dependency failure, stage and mode compatibility,
readiness, portfolio bounds, execution mandate, quote freshness, reconciliation,
deduplication, recovery, venue binding, order safety, ledger writes, and
promotion. Numeric limits are controller-declared policy/state and may be
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

## Closed orchestration handoffs (2026-09-23 source)

1. A successful night settlement with newly appended scored outcomes dispatches
   the canonical tuning lifecycle. The proposal owner does not invent an extra
   total-sample threshold unless one is explicitly declared.
2. Every fresh proposal is re-derived from the same scored ledger by the
   deterministic paper-promotion owner. Its append-only receipt has
   `authority: paper_only`; the paper rank consumer reads only the promoted floor.
3. Every Central Agent Harness perception receives a bounded, read-only finance
   lifecycle projection containing scheduler, scored-outcome, tuning, promotion,
   and active-rule state. The harness still has no execution authority.
4. Flow Graph checks the concrete scheduler, promotion, and harness handoffs.
   Structural green is still not proof that a scheduled cycle has produced a new
   score or that a venue order was executed.

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

The night scheduler dispatches tuning only when settlement reports newly
appended scored outcomes. The tuning lifecycle records the proposal, re-derives
it, writes the paper-only promotion receipt, and exposes the bounded state to
the Central Harness. Promotion remains separate from model output and from
strategy-rule lifecycle state.

Do not add another night-only model caller, module catalog, portfolio engine,
execution path, state root, or fixed strategy threshold in the scheduler.
