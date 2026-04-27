# Technical Daily Momentum And Risk Smoke Hardening

## Summary

- Scope: bounded live hardening for `technical_daily` only.
- Objective: keep the newly linked `Momentum / Trend / Volatility Notes` and `Risk Flags` from silently regressing back to static boilerplate.

## Live Files Changed

- `scripts/test_technical_daily_asset_extraction.py`
- `scripts/feishu_branch_smoke.py`

## Exact Failure Mode

- `technical_daily` already linked sections 3 and 5 to the current ETF summaries, but that linkage was not guarded by proof tests.
- A later edit could quietly revert those sections to static template copy while the branch still appeared healthy.

## Why Dangerous

- User-visible quality would drift backward without any routing failure.
- `technical_daily` would look "stable" in smoke runs while the middle of the report had already gone dead again.

## Smallest Safe Patch

- Add direct assertions for:
  - `build_momentum_notes(...)`
  - `build_risk_flags(...)`
- Tighten `feishu_branch_smoke.py` so `技术日报` must still include:
  - linked momentum language
  - linked risk flags
  - the existing prior-snapshot honesty note

## Proof Tests

- `python3 scripts/test_technical_daily_asset_extraction.py`
- `bash lobster_command_v2.sh 技术日报`
- `python3 scripts/feishu_branch_smoke.py`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Notes

- This is a regression-bar hardening pass, not a freshness upgrade.
- `technical_daily` remains `live-hardened`, not `live-fixed`.
