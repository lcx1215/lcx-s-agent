# Technical Daily Asset Richness Hardening

- date: 2026-03-27
- status: live-hardened
- dev-fixed: yes
- live-fixed: no

## Exact Failure Mode

After honesty hardening, `technical_daily` had become clean and explicit, but the ETF snapshot lines still felt too uniform and generic.

The branch was no longer wrong, but it still was not distinctive enough to feel like an actual ETF technical daily.

## Why Dangerous

- the report can become safe but low-value
- all five ETF slots start sounding interchangeable
- quality work stalls at "not wrong" instead of becoming more decision-useful

## Smallest Safe Patch

Live-only bounded patch in:

- `scripts/run_technical_daily_direct.py`
- `scripts/test_technical_daily_asset_extraction.py`

Changes:

- tighten asset-specific phrasing for each ETF
- keep the `Low-fidelity read:` honesty contract
- make the phrasing more distinct:
  - `SPY`: steady index tape / large-cap momentum
  - `QQQ`: fragile growth leadership / futures pressure
  - `IWM`: small-cap rotation / cyclical inflows
  - `TLT`: duration trade / yield sensitivity
  - `GLD`: hedge / safe-haven bid

## Proof Tests

- `python3 scripts/test_technical_daily_asset_extraction.py`
- `bash lobster_command_v2.sh 技术日报`
- `python3 scripts/feishu_branch_smoke.py`

## What Is Now Prevented

- all ETF snapshot lines collapsing into one generic low-fidelity tone
- branch quality plateauing at "clean but bland"

## What Remains Out Of Scope

- this still does not improve upstream freshness
- `technical_daily` remains `live-hardened`, not `live-fixed`
