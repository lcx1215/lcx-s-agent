# Dev Full Loop Acceptance Receipt

- automation: `dev-full-loop-acceptance`
- run_time_utc: `2026-05-05T15:04:30Z`
- scope: dev-only local brain acceptance
- live_lark_touched: false
- live_sender_touched: false
- provider_config_touched: false
- protected_memory_touched: false
- language_corpus_touched: false
- finance_doctrine_touched: false

## Prompt

User will watch US equities, China A-shares, global indices, and crypto; asks to use local memory and learned rules, decompose internal modules, provide research-only output, and avoid trade advice.

## Result

PASS for the dev hardened planner path.

The focused provider probe returned `task_family: cross_market_finance_research_planning`.

Activated primary modules:

- `macro_rates_inflation`
- `credit_liquidity`
- `cross_asset_liquidity`
- `fx_currency_liquidity`
- `us_equity_market_structure`
- `china_a_share_policy_flow`
- `global_index_regime`
- `crypto_market_structure`
- `quant_math`
- `portfolio_risk_gates`

Activated supporting modules:

- `causal_map`
- `finance_learning_memory`
- `source_registry`
- `review_panel`
- `control_room_summary`

Missing inputs surfaced:

- `memory_recall_scope_or_relevant_receipts`
- `fresh_market_data_snapshot`
- `us_equity_breadth_earnings_and_valuation_inputs`
- `china_a_share_policy_liquidity_and_northbound_inputs`
- `index_constituents_weights_and_technical_regime_inputs`
- `crypto_liquidity_volatility_custody_and_regulatory_inputs`
- `fx_dollar_yuan_and_global_liquidity_inputs`
- `position_weights_and_return_series`
- `portfolio_weights_and_risk_limits`

Risk boundaries:

- `research_only`
- `no_execution_authority`
- `evidence_required`
- `no_model_math_guessing`
- `no_high_leverage_crypto`
- `no_unverified_cross_market_claims`
- `risk_gate_before_action_language`

## Plain-Language Surface Check

`pnpm openclaw capabilities language-brain-loop-smoke --json` passed:

- `visibleReply.startsWithPlainSummary: true`
- `visibleReply.hidesInternalLabels: true`
- `visibleReply.includesResearchBoundary: true`
- `visibleReply.includesProofPath: true`

Temporary receipts from that smoke run:

- `/var/folders/zy/6w275vd95jvg3g_6vb8qpg500000gn/T/openclaw-language-brain-loop-smoke-msMftQ/memory/agent-loop-receipts/2026-05-05/2026-05-05T15-01-55-558Z__language-brain-analysis-memory.json`
- `/var/folders/zy/6w275vd95jvg3g_6vb8qpg500000gn/T/openclaw-language-brain-loop-smoke-msMftQ/memory/review-panel-receipts/2026-05-05/2026-05-05T15-01-55-560Z__review-panel.json`

## Verification Commands

```bash
node --import tsx scripts/dev/local-brain-distill-eval.ts --adapter "$HOME/.openclaw/local-brain-trainer/adapters/thought-flow-v1-qwen3-0.6b-taxonomy-v3" --hardened --summary-only --json --timeout-ms 240000
```

Result: 11/11 passed, passRate 1, `promotionReady: true`, boundary `local_auxiliary_thought_flow_only`.

```bash
node --import tsx scripts/dev/local-brain-open-eval-provider.ts "$PROMPT" | jq '{task_family, primary_modules, supporting_modules, required_tools, missing_data, risk_boundaries, next_step}'
```

Result: cross-market planning contract passed with the modules, tools, missing inputs, and boundaries listed above.

```bash
pnpm exec vitest run test/local-brain-contracts.test.ts
```

Result: 1 file passed, 2 tests passed.

```bash
pnpm openclaw capabilities language-brain-loop-smoke --json
```

Result: passed; final visible surface starts with a plain-language summary and hides internal JSON labels.
