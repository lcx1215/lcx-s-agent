# Future Exploratory Capability: Strategy Audit / Backtest Skepticism

- date: 2026-03-27
- status: future-only
- promotion: not current mainline

## Positioning

This is a future research-support capability, not a current L4.5 -> L5 mainline priority and not a profit-promise module.

Its purpose is to:

- evaluate whether a strong backtest is likely to be robust or overfit
- audit attractive strategy results before they are trusted downstream
- reduce false confidence from smooth equity curves, high Sharpe, or aggressive parameter tuning

This capability should be treated as:

- research-only
- skepticism-first
- used to reject weak or overfit edges before they are elevated
- not an autonomous execution approval layer
- not a marketing layer for high-return claims

## Primary focus

- out-of-sample validation
- walk-forward / rolling validation
- parameter sensitivity and fragility checks
- cross-validation / combinatorial cross-validation where appropriate
- probability of backtest overfitting
- turnover, cost, liquidity, and market-structure sanity checks
- regime dependence and time-slice stability review

## Guardrails

- do not treat high Sharpe, high CAGR, or smooth equity curves as sufficient evidence
- do not present in-sample performance as proof of robustness
- do not ignore survivorship bias, leakage, cost assumptions, or capacity limits
- do not let LLM narrative override numerical audit results
- prefer falsification over promotion
- do not let this capability compete with current live-discipline, bookkeeping, or branch-stability work

## Suggested evolution

1. basic OOS / walk-forward review templates
2. parameter fragility and stress-test summaries
3. probability-of-backtest-overfitting estimation
4. structured strategy audit memos and rejection reasons
5. only later integrate with branch-level research and risk handoff

## Short Chinese doctrine line

> 未来增加一个 strategy audit / backtest skepticism 能力，优先审计漂亮回测是否存在 OOS 失效、参数脆弱、PBO 偏高、成本与流动性失真等问题；该能力以否定伪 edge 为先，不作为高收益宣传模块。
