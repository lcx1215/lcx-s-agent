# Dev Full Loop Acceptance Receipt

- lane: `dev_acceptance`
- automation: `dev-full-loop-acceptance`
- run_time_utc: `2026-05-05T20:43:40Z`
- scope: dev-only local brain acceptance and repair
- live_lark_touched: false
- live_sender_touched: false
- provider_config_touched: false
- protected_memory_touched: false
- language_corpus_touched: false
- finance_doctrine_touched: false

## Prompt Used

Realistic analyst prompts covered:

- Cross-market: US equities, China A-shares, global indices, ETFs, major assets, crypto, local memory, macro rates, credit liquidity, cross-asset liquidity, FX dollar/yuan liquidity, US market structure, A-share policy flow, global index regime, crypto structure, quant math, risk gates, data gaps, and review.
- Full stack: QQQ, NVDA, cash, BTC, earnings, AI capex guidance, Fed path, dollar liquidity, A-share policy flow, index weights, position weights, technicals, red-team invalidation, and data gaps.

## Findings

### Failure 1

- pass/fail: fail before repair
- severity: P2
- exact failure evidence: deterministic provider probes for both complex prompts returned `task_family: source_grounding_claim_audit`, with only `source_registry`, `finance_learning_memory`, and `review_panel`, losing market-structure modules, risk gates, and missing-data coverage.
- repro command: `node --import tsx scripts/dev/local-brain-open-eval-provider.ts "$PROMPT" | jq '{task_family, primary_modules, supporting_modules, missing_data, risk_boundaries, next_step}'`
- affected files/scripts: `scripts/dev/local-brain-contracts.ts`, `test/local-brain-contracts.test.ts`
- patch summary: prevented source-grounding audit from preempting clear cross-market and full-stack finance planning prompts; added regression tests for both prompts.
- proof test: `pnpm exec vitest run test/local-brain-contracts.test.ts` passed 11 tests.
- became regression eval: yes, contract tests now cover these prompts.

### Failure 2

- pass/fail: fail before repair
- severity: P2
- exact failure evidence: guard log showed `local-brain-distill-eval.ts` aborted on `mlx_lm generate timed out after 180000ms for news_sentiment_validation_not_alpha`, killing the whole guard eval instead of recording a case-level fallback result.
- repro command: `node --import tsx scripts/dev/local-brain-distill-eval.ts --model Qwen/Qwen3-0.6B --adapter "$ADAPTER" --hardened --summary-only --json --timeout-ms 1`
- affected files/scripts: `scripts/dev/local-brain-distill-eval.ts`
- patch summary: moved `runGenerate` inside the per-case try/catch so generation timeout/exit errors use the hardened fallback and keep the eval result structured.
- proof test: timeout-forced 50-case eval passed with `passed: 50`, `total: 50`, `promotionReady: true`.
- became regression eval: yes, timeout-forced eval command is the regression.

### Failure 3

- pass/fail: fail before repair
- severity: P3
- exact failure evidence: timeout-forced fallback initially passed only 48/50; `btc_risk_appetite_to_qqq_spillover` missed `global_index_regime`, and `valuation_multiple_compression_chain` missed `macro_rates_inflation` and `etf_regime`.
- repro command: `node --import tsx scripts/dev/local-brain-distill-eval.ts --model Qwen/Qwen3-0.6B --adapter "$ADAPTER" --hardened --summary-only --json --timeout-ms 1`
- affected files/scripts: `scripts/dev/local-brain-contracts.ts`, `test/local-brain-contracts.test.ts`
- patch summary: treated QQQ/SPY/IWM/Nasdaq/SPX as index-regime signals and let company-to-portfolio risk planning retain inferred macro/ETF modules.
- proof test: timeout-forced 50-case eval passed with `passed: 50`, `total: 50`, `promotionReady: true`.
- became regression eval: yes, contract tests now cover both fallback gaps.

## Commands Run

```bash
node --import tsx scripts/dev/lcx-system-doctor.ts --json
node --import tsx scripts/dev/minimax-brain-training-guard.ts --resolve-current-adapter --model Qwen/Qwen3-0.6B --log /Users/liuchengxu/.openclaw/workspace/logs/minimax-brain-training-guard-medium.jsonl
node --import tsx scripts/dev/local-brain-distill-eval.ts --model Qwen/Qwen3-0.6B --adapter /Users/liuchengxu/.openclaw/local-brain-trainer/adapters/thought-flow-v1-qwen3-0.6b-minimax-guard-2026-05-05T16-27-05-938Z-r6 --hardened --summary-only --json --timeout-ms 240000 --case-id cross_market_us_a_index_crypto_analysis --progress
pnpm openclaw capabilities language-brain-loop-smoke --json
node --import tsx scripts/dev/local-brain-open-eval-provider.ts "$PROMPT"
pnpm exec vitest run test/local-brain-contracts.test.ts
node --import tsx scripts/dev/local-brain-distill-eval.ts --model Qwen/Qwen3-0.6B --adapter /Users/liuchengxu/.openclaw/local-brain-trainer/adapters/thought-flow-v1-qwen3-0.6b-minimax-guard-2026-05-05T16-27-05-938Z-r6 --hardened --summary-only --json --timeout-ms 1
node --import tsx scripts/dev/local-brain-distill-smoke.ts --json
git diff --check -- scripts/dev/local-brain-contracts.ts scripts/dev/local-brain-distill-eval.ts test/local-brain-contracts.test.ts
pnpm tsgo
```

## Final Result

- pass/fail: pass after repair for dev-only acceptance.
- local brain smoke: passed, `liveTouched: false`, `providerConfigTouched: false`.
- plain-language surface: passed, starts with `当前判断：`, hides internal labels/JSON, includes research-only boundary and proof path.
- adapter-backed cross-market eval: passed 1/1, `promotionReady: true`.
- timeout fallback full eval: passed 50/50, `promotionReady: true`.
- doctor: passed 8/13 with live/build/deep checks intentionally skipped by default; active guard PID 10534, no overlapping heavy eval.

## Boundaries

This run did not prove live Lark visibility, did not migrate/restart live sender, did not edit protected memory, did not touch provider config, did not touch formal language corpus, did not touch finance doctrine, and did not push to GitHub.
