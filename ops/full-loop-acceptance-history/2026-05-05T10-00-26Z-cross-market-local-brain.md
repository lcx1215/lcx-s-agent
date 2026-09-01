# Dev Full Loop Acceptance Receipt

- automation: `dev-full-loop-acceptance`
- run_time_utc: `2026-05-05T10:00:26Z`
- scope: dev-only local brain acceptance
- live_lark_touched: false
- live_sender_touched: false
- provider_config_touched: false
- protected_memory_touched: false
- language_corpus_touched: false
- finance_doctrine_touched: false

## Prompt

User will watch US equities, China A-shares, global indices, and crypto. Use local memory and learned rules first, decompose internal modules, produce research-only output, avoid trade advice, and identify missing inputs before conclusion.

## Observed Failure Before Patch

The first dev provider run incorrectly routed the prompt to `external_source_learning_missing_source` because generic words like `learned rules` and `missing inputs` satisfied the missing-source learning gate.

Danger: this hid the actual cross-market finance modules and replaced missing market inputs with a fake `source_url_or_local_source_path` blocker.

## Patch

The missing-source detector now requires a source object plus source-specific absence language, so generic missing market inputs no longer trigger the source gate.

The cross-market detector also accepts English planning terms such as `decompose`, `analysis`, and `research`.

## Acceptance Result

The dev provider now returns `task_family: cross_market_finance_research_planning`.

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

Boundaries:

- `research_only`
- `no_execution_authority`
- `evidence_required`
- `no_model_math_guessing`
- `no_high_leverage_crypto`
- `no_unverified_cross_market_claims`
- `risk_gate_before_action_language`

## Plain-Language Surface Check

`pnpm openclaw capabilities language-brain-loop-smoke --json` passed and reported:

- `visibleReply.startsWithPlainSummary: true`
- `visibleReply.hidesInternalLabels: true`
- `visibleReply.includesResearchBoundary: true`
- `visibleReply.includesProofPath: true`

The smoke command wrote a temporary receipt at:

- `/var/folders/zy/6w275vd95jvg3g_6vb8qpg500000gn/T/openclaw-language-brain-loop-smoke-THxLtQ/memory/agent-loop-receipts/2026-05-05/2026-05-05T10-00-09-174Z__language-brain-analysis-memory.json`
- `/var/folders/zy/6w275vd95jvg3g_6vb8qpg500000gn/T/openclaw-language-brain-loop-smoke-THxLtQ/memory/review-panel-receipts/2026-05-05/2026-05-05T10-00-09-175Z__review-panel.json`

## Verification Commands

```bash
pnpm exec vitest run test/local-brain-contracts.test.ts
```

Result: 1 file passed, 2 tests passed.

```bash
node --import tsx scripts/dev/local-brain-open-eval-provider.ts "$PROMPT" | jq '{task_family, primary_modules, supporting_modules, missing_data, risk_boundaries, required_tools, next_step}'
```

Result: cross-market planning contract passed with the modules and missing inputs listed above.

```bash
pnpm openclaw capabilities language-brain-loop-smoke --json
```

Result: passed; final visible surface starts with plain Chinese summary and hides internal JSON labels.
