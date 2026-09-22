# Finance cycle scheduler

The standalone scheduler invokes the existing day/night finance operator without
requiring a Gateway or model call. It schedules weekdays at 15:30 and 17:30 in
`America/New_York`; DST follows the runtime's time-zone database. It is not an
exchange holiday calendar. Research model planning and module selection remain
separate capabilities; this scheduler does not replace either.

```sh
node --import tsx scripts/operator/lcx-finance-scheduler.ts --status --dir /path/to/book
node --import tsx scripts/operator/lcx-finance-scheduler.ts --once day --dir /path/to/book
node --import tsx scripts/operator/lcx-finance-scheduler.ts --loop --dir /path/to/book
node --import tsx scripts/operator/lcx-finance-scheduler.ts --detach --dir /path/to/book
```

`--dir` is resolved once and forwarded as an absolute path to the detached loop
and every cycle. Without it, config/environment/workspace resolution uses the
same finance-state resolver as the agent tools. A config read failure blocks
execution rather than selecting an uncertain book; `--status` remains available.

## Lifecycle and execution boundaries

- `--cycle-timeout-ms N` bounds each cycle; the default is 900000 (15 minutes).
  Timeout or SIGINT/SIGTERM terminates the owned child process tree, escalating
  after a grace period. The scheduler waits for child closure before releasing
  ownership. Process output retained in each receipt is capped at 64 Ki characters
  per stream, with an explicit truncation flag.
- `--once` exits nonzero on failure, cancellation or timeout. The loop records a
  cycle failure and continues to other due slots without retrying the failed slot
  on the same market date. SIGINT and SIGTERM exit with 130 and 143 respectively.
- One scheduler writer may own a book at a time, including manual `--once` runs.
  `--status` is read-only. A live legacy PID also prevents a new writer.
- `--detach` reports readiness only after the child has acquired ownership and
  read its state. Startup output goes to `daily-cycle-scheduler.log`. Readiness
  does not prove that a cycle has completed or that a login supervisor exists.
- `--place`, `--venue`, `--equity-from-venue` and risk caps retain the daily-cycle
  operator's semantics. Scheduling does not add permission to place orders.
  Invalid flags or numeric caps are rejected before a process starts. Alpaca
  placement also requires `--execution-policy`, `--execution-quote-feed` and
  `--execution-max-age-ms` (at most 120000) before ownership or detachment. This
  structural check does not validate credentials, policy contents or broker
  readiness; those remain controller checks. Status and night-only settlement
  remain independent of daytime execution configuration.

## Receipts and interrupted runs

`daily-cycle-scheduler.json` keeps `lastFired` for compatibility: it means an
attempt was durably marked **before** starting the child, not that it succeeded.
`lastSucceeded` records successful process completion separately. Per-slot
`lastStatus` preserves a later failure even if that slot succeeded earlier on the
same date and the other slot subsequently succeeds. `lastRun`
records a run ID, resolved book, start time, timeout, duration, exit/signal and
status (`running`, `succeeded`, `failed`, `timed_out`, `cancelled`, `spawn_error`).
Final receipts are appended to `daily-cycle-runs.jsonl`.

An exit-zero process result does not prove profitable decisions, a venue fill,
model learning or external delivery. The underlying cycle receipts own those
claims. The finance link-health check requires explicit success records for both
slots; legacy attempt-only state is reported as unverified.

Corrupt state is an error, not an empty execution history. Graceful shutdown
removes the scheduler's PID and lock. After a hard crash the lock deliberately
remains: an orphaned cycle or venue request may still be running. Inspect the
lock's `owner.json`, recorded attempt, child processes and venue effects before
an authorized recovery removes that exact stale lock. Never delete a lock merely
because it is old, and never replay an uncertain attempt automatically.

This lock coordinates scheduler invocations only. Direct daily-cycle invocations
and other finance writers still require their existing execution/idempotency
controls. A detached process is terminal-independent; installation under a login
supervisor and live service migration are separate operational actions.

### Read-only cutover observation

Use `--status --json --dir <book-directory>` to inspect the exact book before
and after an authorized service change. This command does not acquire a lock,
create the book, dispatch a cycle, or reconcile historical attempts.

Each slot reports `not_due`, `outside_schedule`, `due_unattempted`, or the
recorded outcome for today's attempt. A legacy attempt without an outcome is
`attempted_outcome_unknown`, never inferred success. A later failure remains
visible even if an earlier attempt succeeded on the same date. Due status uses
the scheduler's existing New York weekday/time rules, not an exchange calendar.

`legacy_or_unlocked_process` means a recorded PID is present without the new
lock. Even `process_and_lock_present` is only an observation, not process identity
or execution-health proof. `executionHealthVerified` therefore remains false.
Corrupt state still fails inspection rather than authorizing a replay. Historical
run logs may corroborate earlier work, but do not prove that the current process
has executed successfully.

Before a cutover, identify the candidate revision, current process, exact book,
original invocation flags and rollback revision. Reconcile any running attempt
before stopping its owner. Preserve the book and attempt history; never clear
state or add `--place` to make a restart appear healthy. Restarting remains an
explicitly authorized operation. Afterward, verify ownership and the next
scheduled run's receipt independently; a successful start is not a successful
financial cycle.

### Strategy identity at the daily executor

The daily operator binds one active `cross_asset_trend` version `1` rule emitting
`target_weights`, with New York month-end signal timing. It passes the declared
`body.frozenRule.lookbackMonths` (1–120) to the existing trend engine and reports
`strategyExecution` in the result. Available history can still be insufficient;
the engine reports missing evidence instead of substituting a different month.
Direct legacy engine callers retain the 12-month default.

Other forms remain valid strategy declarations but need their own executor.
Multiple active strategies require an explicit portfolio-composition contract;
the daily operator no longer unions their instruments and labels a single trend
calculation as execution of all of them. This binding covers the implemented
trend signal and inverse-volatility engine, not arbitrary natural-language body
instructions, an exchange calendar, or general multi-strategy execution. Night
settlement reads recorded samples independently of active strategy declarations.

## Reviewed value research and portfolio composition

The stock research entry defaults to `business_value`. It reuses the registered annual
income, cash-flow and balance-sheet adapters, joins matching fiscal periods and
currencies, and rejects unpublished or missing observations. Analyst targets and price
statistics do not substitute for operating facts. `--research-basis market_structure`
explicitly selects price research; `--horizon-days` sets the intended holding period
(default 730 for business value, 30 for market structure). Neither selects execution
authority.

The value path runs the existing logical-agent pool's `research_draft` and
`adversarial_challenge` roles. The first proposes bear/base/bull assumptions; TypeScript
computes their values and the annual cash-flow growth implied by the current price.
The second reviews the facts, assumptions and calculated results. Missing evidence,
invalid arithmetic, failed/cancelled review or unresolved material objections withhold
the valuation. The final directional conclusion must cite operating evidence and the
current `valueAssessmentId`. `--write` retains the assessment and role receipts through
the existing research record. Separate role calls do not prove independent models or
correct forecasts.

The first implemented method is five explicit years plus terminal value using CFO less
capex as an equity cash-flow proxy, with constant debt and share count assumptions.
It requires positive cash flow and explicit growth, discount and terminal assumptions.
Cash and debt inform the review; they are not added/subtracted again as if this were an
enterprise-value calculation. This method is not suitable for every company and is not
an ETF, bank, loss-making company or crypto valuation engine. Inapplicable methods
withhold a value conclusion instead of substituting chart direction.

A controller may request a research `portfolioTarget` (strategy ID and sleeve target
weight). Only a passing value assessment and mandate produce `portfolioCandidate`.
The candidate includes the assessment receipt, not just a claim that review passed.
The controller supplies account budgets separately; the model cannot allocate them.

The daily operator accepts `--portfolio-plan PATH`, a bounded run input with:

- `asOf`, `validUntil`, `venue`, `accountId`, and explicit `conflictPolicy`;
- `allocations`: unique strategy IDs and equity budget fractions totaling at most one;
- `candidates`: reviewed research targets, each with its evidence receipt and sleeve weights.

Active declared trend rules still come from the existing strategy ledger. With a plan,
each rule executes its own declared lookback; their market bars are collected once.
Each active rule and supplied candidate needs exactly one budget. Missing inputs do not
redistribute another strategy's capital. Each target is multiplied by its sleeve budget;
unused equity remains cash. Existing holdings outside the target set and positions held
because of conflict remain part of the funding check.

`block` freezes a symbol when an accumulation thesis conflicts with a reduction thesis;
it does not turn a blocked buy into a sell. `budget_weighted` explicitly permits weighted
composition, while retaining each contribution and the disagreement in the receipt.
The composed targets enter the existing drift, order-cap and execution-safety path.
A target weight is not an order quantity or an execution authorization. Alpaca portfolio
placement remains blocked until that path receives an account-bound controller;
`accountId` in a plan is a scope label, not proof of access to that account. The current
extension supports stock targets and does not silently normalize crypto identifiers.

### Broker economics and protected reductions

Configured Alpaca history synchronization also reads explicit `CFEE`/`FEE`
activities and persists an account-scoped reconciliation in the existing broker
history table. Fill quantities, cash movements, asset-denominated fees and cash
fees are projected separately. Duplicate activity IDs do not duplicate holdings;
conflicting revisions, unsupported corporate actions, incomplete history and
unexplained balances remain unresolved. A quantity difference is never promoted
to a fee merely because it resembles a published fee rate. The link-health
report checks reconciliation freshness. Placement following an explicitly
requested history sync requires a reconciled result; research may inspect gaps.

Standing, unfilled GTC sell stops reserve inventory rather than blocking every
order in the account. Alpaca paper supports a reduction against one stop covering
the whole position: under the shared execution lock it cancels that exact stop,
waits for terminal cancellation, verifies unchanged holdings, executes the sell,
and restores protection for the actual remainder. The protective plan is retained
in the execution claim. A confirmed sell can resume missing protection with a
stable client order ID before its recovery is confirmed. A stop fill during
cancellation or an unknown sell outcome requires reconciliation, never another
blind sell. Explicit sell rejection restores the original protection. Multiple
stops, non-GTC protection and unsupported order structures remain blocked for
controller resolution. No real-money venue is enabled by this paper workflow.

### Progress and routing

`--portfolio-plan PATH` is forwarded to the daily operator. The scheduler resolves
it to an absolute path before detaching, so a working-directory change cannot select
a different plan. This does not enable placement.

Status includes `progress` from the current scheduler lock. Each loop records idle
progress and each child launch records cycle progress. Idle progress becomes stalled
after two tick intervals; cycle progress gets its declared timeout plus two intervals.
Missing, unreadable, invalid or absent-owner evidence never counts as responsive.
Responsiveness does not establish successful work, broker connectivity or a fill.
An interrupted earlier-day attempt is reported as `reconciliation_required`, since
it prevents subsequent runs until its effects are reconciled. No health probe steals
the lock or resubmits a possibly executed order.

A placement cycle with an unreadable position ledger stops rather than sizing from
an assumed empty portfolio. Preview data issues remain visible in its report.

Night settlement does not inherit `--place` or `--equity-from-venue` from the
scheduler's daytime configuration. A complete broker history containing unresolved
economic differences remains visible without preventing night settlement; it blocks Alpaca placement by default. An incomplete history fetch remains a reported failure.

### Account-bound paper controller

For Alpaca placement the daily operator and scheduler accept `--execution-policy PATH`
alongside the explicit quote feed, freshness window and risk caps. The local policy
uses schema `lcx_alpaca_cycle_policy_v1` and declares `accountId`, `planId`, `revision`,
`expiresAt`, `peakEquity`, `peakScope`, `unhedged: true`,
`maxPortfolioDrawdownFraction` and `maxGrossExposure`. The policy is control-layer
configuration, not strategy/model output; reading it does not enable `--place`.

The controller restores confirmed journal receipts to the existing SQLite ledger,
requires complete history and an acceptable reconciliation scope, and calculates weights from the bound
native account positions. `positionBook` identifies that source and the sizing equity.
Legacy simulator holdings are neither imported nor repriced as native positions.
Each dispatch rechecks the last terminal order, reconciliation and fresh account facts
under the shared account lock while retaining the exact native quote binding. Unknown
claims, unexplained quantities/cash, account changes and stale quotes stop execution.
Native protective orders go through the existing protected-reduction coordination.

Newly observed equity highs are appended to an account/scope-specific peak history;
recreating the controller cannot reset a recorded peak. A corrupt peak history refuses
facts. Read and write transports use the selected finance root, and the execution
adapter verifies the credential account against controller facts before submission.
This path currently trades US equities only. Held crypto remains part of account-wide
exposure and reconciliation; this controller does not add crypto execution support.

### Bounded historical quantity isolation

The default remains strict reconciliation. A local execution policy may explicitly
include `quantityDifferenceIsolation` with `instruments` and a positive
`maxUnexplainedNotional` in account currency. This only permits a bounded negative
quantity difference in an existing long holding with a positive native market value.
It does not infer a fee or mark history reconciled. Missing history, cash differences
outside tolerance, unsupported activities, positive unexplained quantities and
unresolved protective orders still block the account.

The affected instruments are quarantined from all orders. Their total unexplained
quantity is valued from native positions and rounded upward to cents as an uncertainty
reserve. The shared gate subtracts the reserve from usable cash and equity and adds
it to exposure; daily allocation uses equity after this reserve. Every dispatch checks
fresh values against the policy limit. Other instruments can proceed only through all
existing gates. Reports and safety receipts preserve the unresolved history, quarantine
and reserve separately from unmodified native account facts.

Inspect this boundary without submitting an order:

```sh
pnpm exec tsx scripts/operator/lcx-finance-daily-cycle.ts \
  --check-execution --venue alpaca --execution-policy /path/to/policy.json \
  --execution-quote-feed iex --execution-max-age-ms 30000 \
  --dir /path/to/finance-state --json
```

This diagnostic reads broker evidence and updates the local reconciliation ledger.
It reports `broker_reconciliation_readiness_only`, with `quotesVerified: false`,
`executionVerified: false` and `ordersSubmitted: 0`. It cannot be combined with
`--place`; a ready or restricted result does not prove a fresh execution quote or a
successful trade. Enabling isolation in a deployed service remains a separate policy
and deployment action.
