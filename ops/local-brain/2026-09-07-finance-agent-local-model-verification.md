# Finance-agent local-model verification

**Date:** `2026-09-07`
**Scope:** one real local Qwen/MLX execution against the existing LCX finance
evaluation owner. No training, provider change, external-channel write, or
trading action was performed.

## Command

```bash
node --import tsx scripts/operator/local-brain-distill-eval.ts \
  --no-adapter \
  --hardened \
  --summary-only \
  --json \
  --case-id full_stack_finance_stress_with_red_team \
  --timeout-ms 180000
```

## Observed result

- Process result: `ok=true`
- Model: `Qwen/Qwen3-0.6B`
- Backend: real local MLX generation, no adapter
- Requested case: `full_stack_finance_stress_with_red_team`
- Automatically included prerequisite cases: 3
- Evaluated cases: `4/4` passed the assisted hardened evaluator
- Parse errors: `0`
- Raw contract passes: `1/4`
- Model-contract-ready cases: `0`
- Hardening applied: `4/4`
- `promotionReady`: `false`
- Learning claim: `not_proven_by_contract_eval`

## Interpretation

This proves the local model backend can execute and the current finance
evaluation owner can parse and harden the result. It does **not** prove that
the model has absorbed the external finance-agent designs, that raw model
output is independently contract-clean, that an adapter is promotion-ready,
or that any external channel or trading surface is bound.

The next finance-agent implementation gate is therefore a native fixture in
the `LogicalAgentPool`: deterministic finance numbers and source receipts must
enter as evidence, the local model may classify/explain/challenge, and the
final precheck must reject missing provenance, invented numbers, and trade
authority. The same run must persist its completed prefix through the
canonical state-root checkpoint store.

## State-root boundary observed during this run

`resolveStateDir()` currently resolves to the existing compatibility root
`$LCX_STATE_DIR` on the validation host, while the target LCX root is
`$LCX_CANONICAL_STATE_DIR`. The identity migration completion marker is not yet
active. The checkpoint adapter intentionally follows `resolveStateDir()` so it
does not create a split-brain writer; when the existing migration owner proves
the canonical switch, the same adapter follows it automatically.

A separate-process demo in an isolated state root also passed: the first
process completed and wrote one checkpoint file; a second process loaded it
through a fresh store instance and returned `resumed=true` with
`status=completed`.
