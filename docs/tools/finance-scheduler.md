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

## Research-only network routing

Set `LCX_FINANCE_RESEARCH_HTTP_PROXY` in the scheduler's service environment to
an explicitly authorized HTTP(S) proxy URL when research sources need a separate
route. The scheduler maps it to `LCX_FINANCE_HTTP_PROXY` only in the day research
preflight and night research review child processes. Trading, reconciliation,
and other cycle processes retain their original environment. Embedded proxy
credentials are rejected. An empty value explicitly selects direct research
access; omitting it preserves the existing route.

This setting does not change source quotas, credentials, freshness requirements,
source coverage, or execution authority. Verify source records and the final
research receipt after changing it; a successful proxy request alone does not
prove an accepted portfolio plan. Research children emit a compact scheduler
summary while retaining full evidence in the referenced durable receipt.

Scheduled research enables the existing public-source adapters alongside configured
sources. Day allocation collection declares a 160-call source reservation ceiling:
the current eight-instrument composition can plan 37 jobs, reserving up to four
HTTP calls each. Model calls, model deadlines, source verification and trading risk
limits are unchanged. This is a per-run ceiling, not a guarantee that all sources
will succeed; oversized or unavailable evidence remains a failed gate.

Portfolio-context research selects only instruments from the exact declared active
strategy IDs in the controller ledger. A missing or retired strategy blocks the
run before provider calls. Ordinary broad research continues to use the discovered
universe and must be separately bounded; an allocation ask does not turn into an
implicit full-universe scan.

### Bounded research recovery

One research workflow shares its model availability across producer and review
phases. After an authentication, payment-required (HTTP 402), or rate-limit response, that adapter is rejected
before dispatch for the remainder of the run; eligible configured fallbacks must
still satisfy model separation and author affinity. Skips retain rejection
receipts and consume no additional provider calls. A new scheduled run creates a
fresh workflow. Payment failures also establish a 15-minute account cooldown at
the configured transport seam, shared by finance and central-brain callers and
retained across restarts under the existing state root. The identity covers the
provider, endpoint and credential, so changing a configured credential or endpoint
does not inherit another account's cooldown. Blocked attempts consume no call
budget and do not extend the cooldown; expiry permits a fresh attempt. Requests
already in flight when payment failure is first observed remain governed by their
existing concurrency, timeout and call limits.

Cooldown files contain only an opaque account hash and an expiry, never a
credential, prompt or provider error body. A malformed or unreadable file blocks
transport. If saving the failure is impossible, the current process still blocks
the account, but restart persistence cannot be claimed until storage is repaired.
This does not change credentials, provider configuration or quotas.

An automatic portfolio run skips further quality calls when mandatory producer or
module preparation has already failed; its failed gate remains explicit. Ordinary
partial research can still be reviewed. A failed final check may reuse only completed, side-effect-free preparation with
no evidence gaps or critical findings. Drafting and substantive review still run
again within the original attempt, call and time limits. Controller allocation
contracts are transmitted separately from clipped general context. Deadline and
cancellation failures emit a failed machine summary pointing to the durable
checkpoint; they never advertise an accepted portfolio plan.

## Lifecycle and execution boundaries

- `--cycle-timeout-ms N` bounds each cycle; the default is 900000 (15 minutes).
  Timeout or SIGINT/SIGTERM terminates the owned child process tree, escalating
  after a grace period. The scheduler waits for child closure before releasing
  ownership. Process output retained in each receipt is capped at 1,048,576
  JavaScript UTF-16 code units per stream, with an explicit truncation flag.
- `--once` exits nonzero on failure, cancellation or timeout. The loop records a
  cycle failure and continues to other due slots. A day preflight failure may retry
  once after 10 minutes, only between 15:30 and 16:00 ET, when the persisted record
  explicitly proves execution was never dispatched. The controller writes attempt
  1/2 before dispatch; old untagged, running and uncertain records cannot retry.
  Execution failures never automatically replay. SIGINT and SIGTERM exit with 130
  and 143 respectively.
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

`--place` is the scheduler's single order-placement master switch. With
`--intraday-monitor`, it also permits the scheduler to consider intraday orders
for the active, paper-eligible strategy and its declared instruments. The
strategy contract, system-universe match, Alpaca Paper controller, quote
freshness, order caps, shared execution gate, deduplication and reconciliation
remain required. Monitoring without `--place` stays read-only. The old
`--intraday-place` argument is accepted only for compatibility, requires
`--place`, and grants no additional authority; new invocations should omit it.

## 24-hour resident operation

Use one operating-system supervisor, one `--loop` scheduler process, one
canonical finance state directory, and one scheduler lock per book. The
supervisor owns process lifetime (`RunAtLoad`/`KeepAlive` on macOS or an
equivalent service policy); the scheduler owns minute-level ticks, strategy
cadence, receipts, and the book lock. Do not start a second detached scheduler
for the same book under that supervisor.

The process can stay resident outside market sessions, while strategy and
market-session gates decide when to read market data or consider orders. This
does not mean markets or feeds are available 24 hours a day, and it does not
authorize orders outside the declared strategy, instrument, quote-freshness,
cap, and shared execution gates. Without `--place`, the resident process remains
monitor-only.

With Alpaca history synchronization enabled, the existing four-minute idle
reconciliation slot first uses the available Paper controller to query pending
execution claims and deliver confirmed receipts into the canonical position
ledger. This runs before position exits and new-entry monitoring, including
when no new trade signal exists. Without that controller, the slot retains its
history-sync fallback. It does not resubmit an order. A missing, active or
mismatched broker order remains unresolved; a sell requiring restoration of
reserved protection stays with the existing protection-recovery owner. Failed
reconciliation is recorded and the resident loop continues. Pending claims
still allow broker account and position snapshots to refresh; they never grant
placement authority. Placement requires its own fresh account and execution
checks.

A recovered partial sell receipt also feeds the existing strategy-owned position
projection. When inventory remains, a matching account-bound receipt lets the
monitor reconsider its exit on a later closed bar, even if the original signal's
audit outcome was uncertain. The original intent is not replayed and that audit
record is retained. Missing receipts or another account's receipts cannot unlock
the position.

The read-only status includes `progress.intraday.lastTick`, a bounded observation
of the last monitored instrument: its time, monitor status, available action and
reference time, and execution result when dispatch was attempted. `outcomeStatus`
retains the known `placed`, `refused` or `uncertain` ledger outcome separately
from a function result such as `already_terminal`; an existing record need not
be a confirmed fill. A fresh
`no_signal` / `hold` observation explains a completed monitoring pass without
adding a trading decision to the ledger. Legacy, invalid or stale observations
are reported as `null`. This observation does not certify all monitored
instruments, broker health, fills, or uninterrupted 24-hour uptime.

On macOS, a user LaunchAgent can restart an exited process while its login
session and host are available; sleep, shutdown, logout, power, or network loss
can still interrupt monitoring. Uninterrupted 24-hour host availability needs
an always-on host and persistent state storage. A successful supervisor start
or a present PID alone is not a health proof: reconcile the supervisor's target
and process arguments with fresh scheduler progress and the latest cycle and
execution receipts. Installing or reloading a service is a separate operational
change from editing this scheduler.

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

### Controller evidence at the research boundary

A research run with `--portfolio-context` reads active rule bodies and historical
closes from the same finance state directory as the controller. Generic research
method examples must not replace the declared rule parameters. The bounded
history projection reports its date window, omitted rows, repeated-close
collapse and divergent observations. Stored closes are not current execution
quotes or independent verification of adjusted total returns.

Controller evidence is supplied first to the existing multi-pass review. Global
review roles receive the cross-batch extraction outputs, while batch audits
retain their own raw evidence. Evidence IDs, content coverage, quality gates and
portfolio-plan validation still apply; connecting inputs does not imply an
accepted plan or permission to place an order.

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
funded rules execute their declared lookbacks; their market bars are collected once.
A reviewed zero budget withholds capital from one strategy, requires supported evidence,
and creates no liquidation target or stance conflict. Funded strategies still require a
current candidate. All-zero research proposals use the explicit `no_allocation` outcome.
The daily operator defers budgets for declared intraday rules to their resident controller;
it does not invent their candidates or renormalize the remaining budget fractions. This
projection grants no intraday execution authority: that controller retains its own Paper
policy and shared execution gates. Missing funded inputs do not redistribute capital.
Each target is multiplied by its sleeve budget; unused equity remains cash. Existing
holdings outside the target set and positions held because of conflict remain part of
the funding check.

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

The finance link-health report reuses the scheduler's shared progress reader in
`scheduler_execution_loop`. It distinguishes responsive preview mode, placement
enabled, stale or missing progress, and unreadable ownership independently of
whether a cycle is due. A responsive placement loop still does not prove a broker
fill. Offline research books and legacy processes retain a visible warning rather
than being mistaken for a verified autonomous trading service.

Progress publishes the configured policy-file expiry, re-read each tick, and
separately publishes `intradayControllerPolicyExpiresAt`, the policy snapshot
loaded into the resident intraday controller. Rewriting the file does not refresh
that in-memory controller; restart it to load the new policy. The status fields
`executionPolicyStatus` and `intradayControllerPolicyStatus` describe those two
different expiries. Missing, malformed, expired or legacy-unknown metadata cannot
report execution readiness. These are diagnostic expiry checks; the account
controller still validates the full policy at execution. They never renew a
policy or change its risk limits automatically.

`--core-weight N` is forwarded unchanged to the daily operator, including the
endpoints 0 and 1. Values must be finite and between 0 and 1. Omitting it retains
the daily operator's default; scheduling does not choose a different allocation.

### Replaceable model routing and bounded contract repair

Provider implementations remain optional adapters. Select configured models through
`agents.defaults.model.primary`, `fallbacks`, and the model allowlist; changing the
current selection does not retire the provider implementation. Finance draft and
review must use distinct models, while formatting stays with the draft author.
Two models from one provider are model separation, not vendor independence.

The learning council accepts `OPENCLAW_LEARNING_COUNCIL_KIMI_MODEL` and
`OPENCLAW_LEARNING_COUNCIL_DEEPSEEK_MODEL` overrides (including config `env.vars`).
These are compatibility role keys, not restrictions to those vendors. The acceleration
operator respects the configured selection. Receipts name the actual requested and
observed models. A replacement needs a supported adapter, authentication, required
capabilities and successful runtime verification; a configured name alone is insufficient.
Search is a separate capability: a chat-completions endpoint does not substitute for
a search adapter. An unavailable search adapter can stay disabled until configured.

Draft, formatting and final-precheck output contract failures receive at most one
same-model repair before normal fallback. It consumes the existing call budget and
deadline and preserves model-separation and author-affinity checks. Semantic review
failures are not converted into approvals. Producer schema diagnostics identify fixed
field names without echoing untrusted model values.

With `--intraday-active-rule`, each resident tick re-resolves the active rule before
new entry candidates. A missing, retired, ambiguous or incompatible rule disables
entry monitoring and placement; a later valid rule can recover without restarting
the service. Changed bindings rebuild the scoped controller, and controller assembly
failure disables placement until a later successful refresh. Unchanged bindings reuse
the controller. Existing retired-position exits remain on their independent path.
This does not activate strategies, alter CLI strategy parameters or grant placement.

Before discretionary intraday review, the resident executor runs the same pure
order compiler used by the venue path. A breached stop, invalid target, or zero
entry headroom refuses before a model call. This preflight makes no safety claim
and grants no execution authority; the venue path recompiles with the final quote
and retains account, reconciliation, risk, deduplication and reservation checks.
Typed controller failures during initial account reads retain their fixed category
and provider diagnostic stage in the intraday outcome; raw exception text stays private.

Failures after claim reservation also retain a bounded `attempt` diagnostic in the
claim journal and intraday outcome. It distinguishes a call that did not start,
a typed venue rejection, and an unresolved execution or receipt write. A venue
rejection requires a received non-ambiguous HTTP 4xx response; only the numeric
HTTP status and broker code are retained. Free-form errors, response bodies and
credentials are excluded. Receipt-stage failures remain unresolved even if the
exception resembles a dispatch rejection.

These diagnostics do not release a claim or grant retry authority. The existing
`unknown` claim and `uncertain` intraday state retain their conservative recovery
semantics; inspect `executionSafetyFailure.attempt` for the failure classification.
The displayed reasons distinguish `execution_dispatch_not_started`,
`execution_venue_rejected`, and `execution_outcome_unresolved` without changing
that recovery state.
Legacy claims without diagnostics remain readable and unresolved. A client-order
lookup returning 404 or an empty bounded order list is insufficient to clear one.

Cycle progress identifies `research_preflight`, `execution`, `universe_selection`
and `night_review`. Each bounded child refreshes the progress timestamp on entry,
so time spent in completed stages cannot make the next healthy stage appear stalled.
The existing child timeout and two-tick grace remain unchanged. A fresh stage marker
is liveness evidence only; completion, accepted plans and fills require their receipts.

During resident research preflight, universe selection and night review, the same
trading tick continues at the normal interval. Only one trading tick may be in
flight; slow ticks skip intervening timer firings. This covers reconciliation,
retired-position exits and active-rule monitoring without starting another daily
cycle. Before handing off from the child stage, the scheduler clears its timer and
joins the in-flight trading tick, including on failure or cancellation. Daily
execution therefore cannot overlap the tick's venue actions. Shutdown retains the
process lock until this work has settled. Manual `--once` behavior is unchanged.
Execution, model review, freshness and deduplication gates still apply to every
candidate; overlapping research does not approve its plan or authorize a trade.

The role task timeout includes the opted-in single structural repair as well as
configured fallbacks; the whole research deadline and call budget remain the cap.
When external EOD history is unavailable, the quant module can consume the supplied
controller close-history projection. It keeps the instrument and evidence reference,
rejects conflicting, repeated, invalid or future observations, and labels results as
stored close history rather than adjusted total returns or execution quotes.

Live research with `--write` and an explicit `--finance-state-dir` reuses macro
series through the existing fundamental store. A snapshot must match the one
eligible source, series, provider and request shape, and have been captured no
later than the requested `asOf`. Its capture age is capped at one hour and the
job freshness limit. Stored evidence keeps its original capture and source-period
timestamps, source URL and freshness warnings; the receipt labels the reuse and
records no new API calls. It does not supply an execution quote, bypass source
comparison, replace a frozen checkpoint, or replenish provider quotas.

Night research uses its actual post-settlement start as its as-of cutoff, so a
universe refreshed earlier in the same cycle is not incorrectly future-dated.
Its explicit `--controller-research-scope` binds targets to nonzero position-ledger
holdings and active strategy instruments in a unique controller-evidence entry.
The research CLI verifies the same cutoff against those ledgers before model calls.
The scope retains supported equity/crypto identities, rejects empty or unsupported
scopes and more than 14 instruments, and never substitutes a broad universe.
Night positions exclude both fills and receipts recorded after that cutoff.
This is a local-ledger research scope, not proof of current broker holdings.
Night source collection uses the same 160-call batch cap as day research; provider
quotas and the 48-call, 14-minute model limits remain unchanged.

Aggregate cycle failures report a nonzero exit code even when settlement succeeded;
`cycleExitCode` retains the cycle child's original code, and nested research results
retain their own process results. Failure does not authorize an order replay.

The research runner's shared quality-review entry can review an already captured
packet without source collection or module execution. Historical validation must
retain its original as-of and isolate any plan or thesis outputs from live state.
Final artifact audits receive the full formatted artifact, including tail claims;
prompt limits still fail closed rather than silently clipping the review object.

A reviewed portfolio abstention uses the explicit research proposal
`{decision: "no_allocation", reason, evidenceIds}`. The reason and supported-claim
citations must pass the same source, committee, quality, and module gates; missing,
all-zero allocation, malformed, or unsupported proposals remain failures. This result may
persist independently validated theses through the existing thesis ledger, but it
never creates a portfolio plan or an order. The scheduler records
`execution.outcome=not_run` with `research_no_allocation`, requires the current
preflight timestamp and passed gates, and skips the execution child even if an older
plan file exists. A successful abstention is a completed research decision, not a
fill or proof of profitability; independent position monitoring remains active.
