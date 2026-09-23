# Trader strategy method kit

This is an LCX-repository runtime-facing extraction from the full
`trader-strategy-lab` package. The sibling [full Skill](../../trader-strategy-lab/SKILL.md)
remains the detailed source for practitioner profiles, source records, and
longer evidence notes. The local 12-method/28-direction catalog is an extensible
retrieval aid, not a universally complete taxonomy; foreground only methods
relevant to the task and evidence. Nothing here reconstructs a private manager's
signal or grants execution authority.

Commands and providers below document this repository's reproducibility checks,
not required tools for other installations. The explicit `2026-09-10` dates are
historical frozen-snapshot examples, not current market evidence. For a current
decision, use a new information cutoff and verify the source's current coverage
and timestamp; retain the historical command only when reproducing that exact
run.

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

## Strategy-specific evidence

Use the deliverable fields in the parent [Finance Learning Researcher Skill](../SKILL.md).
Backtests also need net-cost comparisons with a simple baseline across
non-overlapping periods.

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

This repository benchmark uses Yahoo public end-of-day records for SPY, QQQ,
IWM, AAPL, MSFT, and NVDA over the preceding three years. It is a method
application and data-quality receipt; it does not prove profitability, live
execution, or model weight learning.

The complete method-surface check is an explicit catalog audit, not a routine
research step. Run it only when the task asks for full method coverage:

```sh
pnpm lcx:finance:strategy-all-methods -- \
  --out .artifacts/finance-strategy/all-methods-20260910.json
```

That receipt covers M01–M12 with the repository's configured Yahoo, Cboe, and
S&P Global observations or an explicit missing-evidence gate. A diagnostic
blocked on point-in-time holdings, issuer terms, historical option marks, or
execution data remains `research_only`.

The executable selector foregrounds methods relevant to the request. Unselected
methods and directions are not evidence that they were analyzed; factual
extraction does not require a forecast, thesis, backtest, or catalog audit.
