# paper-loop

A trading analysis the system runs itself, not a script someone runs by hand.

```
data -> signal -> size -> paper fill -> P&L -> benchmark -> liquidation -> verdict -> artifact
```

Six files. No imports from the research/governance layer, because the point is
to close the loop and produce a verdict, not to justify a decision.

| file             | role                                                            |
| ---------------- | --------------------------------------------------------------- |
| `loop.ts`        | trend loop: SMA trend + ATR trailing stop, long-only, paper     |
| `carry.ts`       | funding-rate carry: delta-neutral, market-neutral, paper        |
| `liquidation.ts` | margin model: does the short leg survive the adverse move?      |
| `costs.ts`       | spot-leg leverage, collateral moves, hedge rebalancing          |
| `report.ts`      | runs every analysis, writes the artifact, states the conclusion |
| `cache.ts`       | caches upstream responses so routine runs are cheap             |

## Run it

```bash
pnpm lcx:paper:report          # full history, writes the artifact
pnpm lcx:paper:report:quick    # shorter window, faster
pnpm lcx:paper:trend           # just the trend loop
pnpm lcx:paper:carry           # just the carry analysis
pnpm lcx:paper:analysis-cycle  # the scheduler lane: envelope on stdout

node --import tsx paper-loop/report.ts --json            # machine-readable stdout
node --import tsx paper-loop/report.ts --spot-leverage 2 # every carry row, levered spot leg
node --import tsx paper-loop/carry.ts --spot-leverage 2  # one venue, same knob
```

If `pnpm` is not on PATH, `corepack pnpm lcx:paper:report` is equivalent.

## The artifact

`branches/_system/paper-loop/report.json`

Every run writes it. It contains each analysis with its own verdict
(`EDGE` / `NO_EDGE`), the numbers behind it, and the caveats that apply. An agent
reads this file instead of parsing console output. Failures are recorded in the
artifact too — a venue that could not be reached is reported, not hidden.

`ledger.json` holds the trend loop's last state. `cache/` holds raw upstream
responses (34 MB, 503 entries for full history), which is what makes a routine
run cheap enough to repeat.

## The only score

A configuration gets `EDGE` only if it **makes money AND beats the benchmark**.

- Trend loop benchmark: equal-weight buy & hold. It also reports `capture` =
  `return / (benchmark x avg exposure)`, so a strategy that is barely invested
  cannot look good by accident.
- Carry benchmark: **cash at 0%**. A market-neutral book has no excuse for
  losing money, and it must beat doing nothing.

A strategy that merely loses less than a falling market is still losing. The
tool says so out loud rather than reporting it as an edge.

`EDGE` is a statement about return only. It does not mean the trade is safe —
see the liquidation section, which disqualifies all four carry rows below for
any book that cannot post the spot leg's gains as perp margin.

## Measured results

### Trend loop — no edge

8 crypto majors, equal weight, 2021-11-08 → 2026-09-15, 1773 daily bars.

| config                       | return     | benchmark | max drawdown | trades | verdict |
| ---------------------------- | ---------- | --------- | ------------ | ------ | ------- |
| as shipped (risk 1%, stop 2) | **−0.65%** | −37.4%    | 8.7%         | 142    | NO EDGE |
| risk 100%, stop 2            | −17.1%     | −37.5%    | 72.0%        | 142    | NO EDGE |
| risk 100%, stop 10           | +21.9%     | −37.4%    | **82.9%**    | 134    | EDGE    |

What the numbers say:

1. The shipped config is **flat, not profitable** — 4.8 years, −0.65%, and its
   real defect is that it is almost never invested (**average exposure 1.8%**).
2. **Raising risk does not create return.** 1% → 100% moved the result from
   −0.65% to −17.1%: exposure scaled the loss.
3. **Stop width is the dominant parameter, and it is a trap.** Tight stops die by
   a thousand cuts (stop 2 loses **20.2%** across 8 assets). Wide stops stop
   trading and just hold, inheriting the market's drawdown.
4. The one `EDGE` row is **a single point picked out of a grid**, earns ~4%/year,
   and requires surviving an **82.9% drawdown**. It is not deployable.

Conclusion: there is no timing edge in this signal family on daily crypto.
Either you trade and pay for it, or you hold and take the drawdown.

### Carry — an edge, but venue-dependent

Delta-neutral: long spot + short perpetual, same notional. Price moves cancel,
so the return is funding minus costs.

| venue / instrument    | window            | mean funding | net per year | max drawdown¹ | verdict |
| --------------------- | ----------------- | ------------ | ------------ | ------------- | ------- |
| Hyperliquid BTC       | 2023-05 → 2026-09 | 14.28% APR   | **8.94%**    | 0.75%         | EDGE    |
| Hyperliquid ETH       | 2023-05 → 2026-09 | 14.43% APR   | **8.66%**    | 0.74%         | EDGE    |
| Hyperliquid SOL       | 2023-05 → 2026-09 | 12.37% APR   | **8.90%**    | 0.81%         | EDGE    |
| Deribit BTC-PERPETUAL | 2021-11 → 2026-09 | 4.56% APR    | **3.06%**    | 0.31%         | EDGE    |

¹ Funding-only drawdown. It does **not** include the price move against the
short leg, which is what actually threatens the position. See below.

What the numbers say:

1. **The venue matters more than the signal.** The same trade returns ~3× more on
   Hyperliquid than on Deribit. Choosing the venue is the actual decision.
2. **The entry signal is worthless where funding is highest, and marginal
   elsewhere.** Gating costs 0.58 pp/yr on BTC (8.94% vs 9.52% always-on) and
   0.94 pp/yr on ETH (8.66% vs 9.60%) — funding is positive in 87% of hours, so
   gating just burns fees. It is worth +0.67 pp on SOL and +0.04 pp on Deribit.
   There is no forecast worth building.
3. **~9%/year is a real, market-neutral return** — the only configuration
   measured here that beats cash without taking directional price risk.

### Liquidation — the constraint that actually binds

A delta-neutral book is still a leveraged short perpetual. The margin has to
absorb the adverse move, and what that move is depends entirely on one
structural question: **can the spot leg's unrealised gain be posted as perp
margin?**

- **Cross-margin (yes):** the spot gain offsets the price move, so the margin
  only has to survive the **basis**, not the price.
- **Isolated margin (no):** the margin has to survive the **outright rise of the
  perpetual**, with nothing offsetting it.

With a 50% margin ratio and a 0.5% maintenance rate, the margin absorbs
**49.5%** before liquidation.

| venue / instrument    | worst perp rise | over      | isolated margin | worst basis move | over    | cross-margin |
| --------------------- | --------------- | --------- | --------------- | ---------------- | ------- | ------------ |
| Hyperliquid BTC       | **365.76%**     | 1222 days | **LIQUIDATED**  | 0.62%            | 28763 h | survives     |
| Hyperliquid ETH       | **167.57%**     | 1222 days | **LIQUIDATED**  | 0.46%            | 28763 h | survives     |
| Hyperliquid SOL       | **1154.79%**    | 1222 days | **LIQUIDATED**  | 0.41%            | 28763 h | survives     |
| Deribit BTC-PERPETUAL | **89.00%**      | 1772 days | **LIQUIDATED**  | 6.42% ²          | 42470 h | survives     |

² Deribit publishes no basis field, so this is derived by differencing two
series that are not sampled at the same instant. It is known to overstate basis
badly and should not be trusted; the Hyperliquid rows use the venue's own
`premium` field and are sound.

What the numbers say:

1. **Every profitable carry configuration is liquidated under isolated margin.**
   The worst perp rise is 89%–1155%, and the margin absorbs 49.5%. A book that
   cannot post spot gains as margin is not running a 9%/year trade — it is
   running a position that is guaranteed to be liquidated.
2. **The trade is only viable as a cross-margin book.** There, the binding
   number is the basis, which is 0.41%–0.62% on the trustworthy rows — an order
   of magnitude inside the 49.5% the margin absorbs.
3. **The 0.75% drawdown figure is funding-only and understates the risk.** The
   real risk is the margin buffer, and it is consumed by the perp move, not by
   the funding stream.
4. The isolated verdict is decided on the **full daily window** (1222–1772 days),
   not the 208-day hourly window: a short leg that never came close over 7 months
   can still be wiped out by a multi-year rally. The hourly path is used for the
   cross-margin check and for locating the first liquidation, and it did catch a
   real one on Deribit at 2024-12-17.

### The remaining cost paths

Three paths are modelled next to liquidation, each with its own options:

| path                | what it models                                                       | measured result                         |
| ------------------- | -------------------------------------------------------------------- | --------------------------------------- |
| spot-leg leverage   | the second liquidation path: a price _fall_ kills a levered spot leg | max survivable leverage **1.29x–1.87x** |
| collateral movement | each top-up of the perp margin as the buffer drains                  | 0 moves on the surviving rows           |
| hedge rebalancing   | drift out of delta-neutral, paid at the spread                       | 0–4 rebalances, ≤0.20%                  |

**The spot leg is the sharpest finding.** The base model assumes the spot leg is
fully paid. Lever it and the book gains a second way to die — and that path binds
early. Even the mildest window measured (Hyperliquid BTC, which excludes the 2022
bear) tolerates only **1.87x**. Solana tolerates **1.30x**. "Boost the yield by
levering the spot leg" is therefore not available: anything above roughly 1.3x is
a liquidation waiting for a drawdown.

`maxSafeLeverage` is `1 / (worst drawdown + maintenance margin)`, computed on the
same full-window price path as the short-leg risk. The spot leg's liquidation is
derived from the perp series rather than a separate spot series — the measured
basis is a few basis points, so the two price paths are the same for this purpose.
That is an approximation and it is stated rather than hidden.

The knob is exercisable from either entry point: `report.ts --spot-leverage N`
applies it to every carry row, `carry.ts --spot-leverage N` to a single venue.
Leaving it off keeps the base model (an unlevered spot leg), so the default
report never silently assumes leverage.

The two operational costs are small on these rows (≤0.20%), because a cross-margin
book that survives does not need topping up. They are reported anyway: they are
the costs that appear once the book is large enough to need managing. Both are
banded approximations, not order-level fills, and neither models liquidity at size.

### Caveats that are emitted with every analysis

- **Venue counterparty risk.** Hyperliquid is a newer venue; that risk is real
  and unpriced here. Deribit is the older, more conservative venue.
- **Basis risk.** Now measured, and small on the rows that have a real
  measurement (0.41%–0.62%). Deribit's is derived and unreliable.
- **Regime dependence.** A bull-market funding mean will not hold in a bear
  market. Funding is a crowding signal, and crowding unwinds.
- **The spot leg's liquidation is modelled from the perp price path**, not a
  separate spot series. Defensible at a few basis points of basis; not a
  substitute for a real spot series.
- **Collateral-move and rebalance costs are banded approximations**, not
  order-level fills.
- **Liquidity at size is not modelled.** Every cost assumes the full notional can
  be traded at the quoted spread.
- **Borrow costs beyond the flat fee are not modelled**, nor is the funding of a
  levered spot position.

## Type-check surface

`paper-loop/` is included in `tsconfig.json`, so `pnpm tsgo` and
`oxlint --type-aware` check it like any other source directory. It currently has
**zero errors** under that gate.

Note that `pnpm tsgo` does not pass clean in every environment: this sandbox is
missing optional extension dependencies (`nostr-tools`, `@twurple/*`, `vite`,
`dompurify`, …), which produces pre-existing errors under `extensions/` and
`ui/`. Those are unrelated to this directory.

## Making it automatic

A launchd agent already runs `daily_learning_runner.py`, which calls
`lobster_orchestrator.py cycle`. That is the existing timer.

The analysis does **not** go through that cycle. The governance cycle is
contractually clean — `lobster_host_watchdog.py` requires
`remoteFetchOccurred === false`, because a governance cycle must not reach the
network. This analysis reads market data, so it cannot honour that contract.
Pointing `OPENCLAW_SCHEDULER_CYCLE_COMMAND` at it would either raise
`boundary_violation` on every cycle or force the receipt to lie.

So the analysis runs in its own lane with its own declared boundary:

| field                       | governance cycle              | analysis lane                    |
| --------------------------- | ----------------------------- | -------------------------------- |
| `remoteFetchOccurred`       | must be `false`               | `true` (market data only)        |
| `liveTouched`               | `false`                       | `false`                          |
| `executionAuthorityGranted` | `false`                       | `false`                          |
| receipt                     | `scheduler_cycle_report.json` | `scheduler_analysis_report.json` |

Turn it on by adding two lines to `.env.lobster` (the runner loads that file):

```bash
OPENCLAW_SCHEDULER_ENABLE_CYCLE=1
OPENCLAW_SCHEDULER_ANALYSIS_COMMAND="node --import tsx scripts/operator/paper-loop-analysis-cycle.ts --quick"
```

Then the existing timer writes `report.json` on every run, next to the governance
cycle. Both lanes stay fail-closed: without `OPENCLAW_SCHEDULER_ENABLE_CYCLE=1`
the analysis is blocked and writes nothing.

The lane is opt-in on purpose. `OPENCLAW_SCHEDULER_ANALYSIS_COMMAND` must be set
for the runner to invoke it, otherwise every governance cycle would depend on the
network and take a minute longer. Use `--skip-analysis` to force cycle-only, and
`python3 lobster_orchestrator.py analysis --dry-run` to exercise the lane without
running it.

Switching this on is a live behaviour change to the scheduler, so it is left to an
explicit operator decision rather than enabled here.

## Where this stops

The loop, the measurement, the margin model, the cost overlay and the scheduler
lane are finished and repeatable. What is **not** here:

- no order placement, no account, no key — paper only
- no real spot series: the spot leg is modelled from the perp path
- no order-level cost model; collateral and rebalance costs are banded
- no liquidity-at-size model
- no scheduler wiring enabled by default; the lane exists and is gated, but the
  operator sets the two `.env.lobster` lines to make the timer produce reports

The next work is deciding whether to trade a cross-margin carry book at ≤1.3x
spot leverage, or replacing the approximations with real spot and fill data. It
is not more parameter tuning on the trend signal, and it is not a new signal
family: carry already showed that you do not need to predict direction to get
paid.
