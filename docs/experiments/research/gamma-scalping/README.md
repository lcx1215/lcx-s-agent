# Gamma Scalping: corrected M11 research method

Captured: 2026-10-04. Stage: repository method integration and synthetic replay.
Execution authority: none. No market backtest or model-weight learning claimed.

## Source and retained hypothesis

User supplied the article “5张图拆解对冲基金底牌：普通人也能看懂的Gamma
Scalping波动收割机（附代码）” as pasted text. Author, original URL and publication
date were not supplied. Text SHA-256:
`94890bd361d23f4f950c01b6fa845047150d92ecb9359c6b01e792fcf8e8f456`.
The pasted indentation is broken; its numeric examples are not accepted results.

Retain the testable hypothesis: a long-gamma position, dynamically hedged against
delta, may earn enough from realized movement to cover option time decay and
implementation costs. A matched-horizon, gamma-weighted variance advantage is a
research requirement, not a promise of profit or an entry signal. Freeze the
forecast method, hedge band, lot rounding, inventory, horizon, baseline and
cost assumptions before observing results.

Primary cross-checks read on 2026-10-04:

- [Artur Sepp, Practical and Theoretical Aspects of Volatility Modelling and Trading](https://www2.math.ethz.ch/t3/fileadmin/math/ndb/00266/09559/Artur_Sepp___Volatility.pdf),
  pp. 11–13: continuous hedging and realized-versus-implied variance; the short
  option sign in the lecture is reversed for a long option position here.
- [Fidelity, Long Straddle](https://www.fidelity.com/learning-center/investment-products/options/options-strategy-guide/long-straddle):
  option time erosion, volatility sensitivity and the two-leg position.

## Corrections before absorption

| Article claim or code issue                                        | System interpretation                                                                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Continuous hedging makes gamma profit zero                         | Delta cancellation removes the first-order directional term, not the second-order variance exposure.                                             |
| ATM straddle is exactly delta zero; gamma peaks exactly at strike  | Compute Greeks at the actual rates, dividends, volatility and maturity. ATM is usually approximate; initial hedging can be required.             |
| Daily P&L is gamma plus theta                                      | Theta needs a time increment with matching units. Add residual delta, vega changes, financing, borrowing, trading costs and approximation error. |
| Hedge account P&L is gamma income                                  | Reconcile option value, hedge inventory and cash together; stock-hedge P&L alone is not gamma attribution.                                       |
| Trend losses on the short hedge imply strategy losses              | Evaluate the long options and hedge together. A trend can generate variance too; jumps and discrete exposure still matter.                       |
| Low IV, or realized volatility greater than IV, guarantees an edge | Use matching horizon, point-in-time forecasts, gamma weights and full costs; IV decline can destroy mark-to-market value.                        |
| Python has a safe expiry clamp                                     | The computed `tau` is unused by the pricing calls. The extraction settles expiry at intrinsic value instead.                                     |
| Synthetic plots show attainable profits                            | Broken indentation, omitted costs and artificial paths cannot prove executable returns.                                                          |

For a long option portfolio with delta hedge, locally:

```text
gross P&L ≈ residualDelta × ΔS + ½Γ(ΔS)² + ΘΔt + Vega × ΔIV
net P&L = exact option mark change + hedge P&L − option costs
          − hedge costs − funding costs − short-borrow costs
```

With zero rates/dividends, fixed IV and the diffusion approximation:
`gross P&L ≈ ½ΓS²(realized variance − implied variance)Δt`.
The existing Black–Scholes function returns theta per calendar day and vega per
one percentage-point change in IV. Do not multiply theta by years or vega by a
decimal IV change without converting units. Greeks are a local approximation;
large moves and mixed spot/IV changes appear in the attribution residual.

## Existing system consumer

This extends M11, without a new method ID or ontology state:

1. `src/agents/finance-strategy-method-kit.ts` recognizes Gamma Scalping,
   long straddle, delta hedging and Chinese names.
2. The M11 operational contract in `finance-strategy-method-catalog.ts` retains
   quote, Greek, cost, stress, baseline and inventory requirements.
3. The existing research runner and `buildFinanceConclusionPrompt` already
   consume the method kit. Focused tests verify the corrected rules reach this
   original consumer with its source requirements and `executionAuthority=none`.
4. `src/agents/finance-gamma-scalping-replay.ts` reuses the existing
   `calculateBlackScholes` function and reconciles a synthetic self-financing
   ledger. It is an offline experiment, not a registered order capability.

## Reproduce the bounded experiment

```sh
node --import tsx scripts/operator/finance-gamma-scalping-replay.ts \
  --input docs/experiments/research/gamma-scalping/synthetic-input.json
```

The fixture is deliberately artificial and all costs are explicit assumptions.
The CLI emits hedged and unhedged results for the same long straddle and costs.
The final observation closes both hedge and options; at expiry the options
settle intrinsically instead of incurring an assumed early-sale spread.
Rows before exit report mark-to-market, not liquidation value including future
exit costs. Hedge lot rounding can leave residual delta. An inventory violation
invalidates the replay rather than assuming a clipped fill.

The model is European, non-dividend, with zero discount rate. Positive cash
earns zero; negative cash and short stock incur explicit simple annual fees
on prior-observation balances. It excludes margin, tax, American exercise,
assignment, order-book impact and real quotes. Even a gap fixture is only an
endpoint price shock, not a calibrated jump or executable-fill model.

Verification covers flat/theta loss, oscillation, trend, IV crush, expiry,
share rounding/bands, exact costs, no lookahead, inventory refusal and malformed
inputs. Accounting reconciliation is separate from approximate Greek attribution.

## Conditions for any later market evaluation

Require sourced, synchronous option bid/ask, underlying quotes, IV history,
contract style/expiry/multiplier, hedge liquidity, available borrow, funding and
margin budgets. Use point-in-time forecasts and predeclared out-of-sample
windows; preserve failed paths and cost/threshold sensitivity. Compare the
same-cost unhedged straddle and cash; report net P&L, drawdown, turnover,
residual exposure and worst stress loss.

If any of these are absent, retain `research_only`. Existing stock Paper
permission does not establish permission or adapter support for options and
short hedges. Deployment, real model selection/application, model training and
profitability each require their own evidence.
