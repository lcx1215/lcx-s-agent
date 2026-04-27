# Technical Daily Source Loading And Smoke Hardening

- date: 2026-03-27
- status: live-hardened
- dev-fixed: yes
- live-fixed: no

## Exact Failure Mode

Two regressions still threatened `technical_daily` quality:

1. `load_latest_sources()` only recognized top-level raw asset snapshots, so repeated runs could stay pinned to the oldest raw source file and ignore newer nested `base_source_snapshot` payloads.
2. Branch smoke still allowed several old raw output forms that had already been cleaned up in live content hardening.

## Why Dangerous

This creates a false sense of quality progress:

- the branch can look stable while still anchoring to stale source snapshots
- smoke can stay green even if ETF snapshots regress back to raw title/news fragments

## Smallest Safe Patch

Live-only bounded patch in:

- `scripts/run_technical_daily_direct.py`
- `scripts/test_technical_daily_asset_extraction.py`
- `scripts/feishu_branch_smoke.py`

Changes:

- teach `load_latest_sources()` to unwrap newer nested `base_source_snapshot` payloads
- add a regression test proving nested snapshots beat older raw files
- extend `technical_daily` smoke forbidden strings to catch old raw output phrases

## Proof Tests

- `python3 -m py_compile scripts/run_technical_daily_direct.py scripts/test_technical_daily_asset_extraction.py`
- `python3 scripts/test_technical_daily_asset_extraction.py`
- `python3 scripts/run_technical_daily_direct.py`
- `bash lobster_command_v2.sh 技术日报`
- `python3 scripts/feishu_branch_smoke.py`

## What Is Now Prevented

- repeated direct runs silently staying anchored to the oldest raw asset snapshot
- smoke missing regressions where ETF summaries fall back to old title/news wording

## What Remains Out Of Scope

- this does not make source freshness good by itself; it only prevents nested snapshot loading from regressing
- `technical_daily` remains `live-hardened`, not `live-fixed`
