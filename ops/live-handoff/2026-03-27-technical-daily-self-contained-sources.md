# Technical Daily Self-Contained Sources

- date: 2026-03-27
- status: live-hardened
- dev-fixed: yes
- live-fixed: no

## Exact Failure Mode

`technical_daily` wrote same-day `sources.json` files with only:

- `mode`
- `generated_at`
- `base_source_snapshot`

That meant the artifact itself was not self-contained. Later validation and repeated runs had to rely on loader-specific nested-snapshot handling instead of reading the current day's file directly.

## Why Dangerous

- source artifacts were harder to inspect and validate
- repeated runs depended on loader special cases instead of a stable artifact shape
- quality regressions could hide behind "it still runs" even when source state was awkward to reason about

## Smallest Safe Patch

Live-only bounded patch in:

- `scripts/run_technical_daily_direct.py`
- `scripts/test_technical_daily_asset_extraction.py`

Changes:

- add `build_sources_payload(src)` helper
- keep `base_source_snapshot` for compatibility
- also write top-level `SPY/QQQ/IWM/TLT/GLD` snapshots into the same-day artifact

## Proof Tests

- `python3 -m py_compile scripts/run_technical_daily_direct.py scripts/test_technical_daily_asset_extraction.py`
- `python3 scripts/test_technical_daily_asset_extraction.py`
- `python3 scripts/run_technical_daily_direct.py`
- inspect `knowledge/technical_daily/2026-03-27_technical_daily.sources.json` for top-level asset keys
- `bash lobster_command_v2.sh 技术日报`
- `python3 scripts/feishu_branch_smoke.py`

## What Is Now Prevented

- same-day `sources.json` artifacts that require nested-loader knowledge to be useful
- repeated direct runs depending on awkward artifact shape instead of a self-contained source snapshot

## What Remains Out Of Scope

- this does not improve raw upstream source freshness
- `technical_daily` remains `live-hardened`, not `live-fixed`
