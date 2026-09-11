# Trader strategy method kit

This is the runtime-facing extraction from the full `trader-strategy-lab`
package. The sibling [full Skill](../../trader-strategy-lab/SKILL.md) remains
the detailed source for practitioner profiles, source records, and longer
evidence notes. Every finance entry point receives the complete 12-method and
28-direction catalog; the task only changes which methods are foregrounded in
the answer. Nothing here reconstructs a private manager's signal or grants
execution authority.

## M01: scientific baseline

- Freeze universe, horizon, information cutoff, baseline, rule version, and
  costs before looking at the result.
- Keep source facts, current observations, and inference separate. Attach a
  source and timestamp to every current number.
- Use non-overlapping validation periods and preserve failed trials. A local
  receipt, plausible explanation, or one answer is not model learning or alpha.

## M02: medium-term trend

- Use a fixed, transparent rule first: prior completed close versus a 200-session
  moving average; apply it on the next session.
- Compare with same-universe buy-and-hold and cash under the same entry, exit,
  turnover, spread, and slippage assumptions.
- Report net CAGR, volatility, maximum drawdown, turnover, worst day, and at
  least three non-overlapping periods. Stress cost and lookback ranges.

## M12: common exposure and crowding

- Count breadth and shared factors before calling several assets diversified.
- Surface concentration, liquidity, financing, borrow, gap, and exit-day limits.
- A breadth gate can reduce drawdown while missing rebounds; describe that
  trade-off instead of calling it a hedge.

## Required answer fields

Analytical conclusions should carry the applicable fields: thesis, counter-thesis, catalyst or
follow-up, invalidation, source/timestamp coverage, net-cost comparison to a
simple baseline when testing a strategy, uncertainties, and the research-only/no-execution boundary.

The reproducible real-data check is:

```sh
node --import tsx scripts/operator/finance-strategy-method-benchmark.ts \
  --as-of 2026-09-10T23:59:00Z
```

The stress check reuses one fetched sample and evaluates 48 frozen combinations
of lookback, cost, and breadth:

```sh
pnpm lcx:finance:strategy-stress -- \
  --as-of 2026-09-10T23:59:00Z \
  --from-date 2021-09-10 \
  --to-date 2026-09-09 \
  --out .artifacts/finance-strategy/stress-matrix.json
```

The benchmark uses Yahoo public end-of-day records for SPY, QQQ, IWM, AAPL,
MSFT, and NVDA over the preceding three years. It is a method application and
data-quality receipt; it does not prove profitability, live execution, or model
weight learning.

The complete method-surface check is kept separately so a task that foregrounds
one method cannot silently imply that the other eleven were tested:

```sh
pnpm lcx:finance:strategy-all-methods -- \
  --out .artifacts/finance-strategy/all-methods-20260910.json
```

That receipt covers M01–M12 with real Yahoo, Cboe, and S&P Global observations
or an explicit missing-evidence gate. A diagnostic blocked on point-in-time
holdings, issuer terms, historical option marks, or execution data remains
`research_only`.

The runtime v2 contract selects M01 for every task, M02 for trend or backtest
requests, and M12 for exposure, breadth, portfolio risk or backtest requests,
while retaining all other methods and directions in the shared catalog for
retrieval and cross-checking. Factual extraction does not require an invented
forecast, thesis, or cost test. The committee and quality stages share the same
full catalog and selected contract. Its content is part of model checkpoint
identity, so changed methods cannot reuse old outputs.
