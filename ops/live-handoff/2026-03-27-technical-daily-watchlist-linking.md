# Technical Daily Watchlist Linking

- date: 2026-03-27
- status: live-hardened
- dev-fixed: yes
- live-fixed: no

## Exact Failure Mode

`technical_daily` main ETF snapshot lines had become cleaner and more asset-specific, but the `ETF Watchlist Observations` section was still static boilerplate.

That meant section 2 did not actually respond to the current snapshot being shown in section 1.

## Why Dangerous

- the report can feel stale even when the main snapshot improved
- section 2 becomes dead template text instead of a useful continuation of the current read
- quality stalls at "clean output" instead of becoming a more coherent operator report

## Smallest Safe Patch

Live-only bounded patch in:

- `scripts/run_technical_daily_direct.py`
- `scripts/test_technical_daily_asset_extraction.py`

Changes:

- add `build_watch_observation(asset_label, summary)`
- derive ETF watchlist bullets from the current asset-specific snapshot line
- keep the current honesty contract and branch structure unchanged

## Proof Tests

- `python3 scripts/test_technical_daily_asset_extraction.py`
- `bash lobster_command_v2.sh 技术日报`
- `python3 scripts/feishu_branch_smoke.py`

## What Is Now Prevented

- section 2 staying generic even when section 1 became more informative
- the report reading like a stitched template instead of a connected daily note

## What Remains Out Of Scope

- this still does not improve upstream freshness
- `technical_daily` remains `live-hardened`, not `live-fixed`
