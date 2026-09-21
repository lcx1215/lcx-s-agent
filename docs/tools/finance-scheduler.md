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
  Invalid flags or numeric caps are rejected before a process starts.

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
