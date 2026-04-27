# Technical Daily Canonical Snapshot Hardening

- date: 2026-03-27
- status: live-hardened
- dev-fixed: yes
- live-fixed: no

## Exact Failure Mode

`technical_daily` same-day `sources.json` files were recursively nesting prior `stable_direct` payloads inside `base_source_snapshot`.

That meant repeated runs could create a self-referential artifact chain:

- top-level `SPY/QQQ/...`
- nested `base_source_snapshot`
- inside that, another `mode/generated_at/base_source_snapshot`
- and so on

## Why Dangerous

- source artifacts become harder to inspect and reason about
- provenance gets noisier over time
- repeated runs accumulate packaging noise instead of preserving one clean asset snapshot

## Smallest Safe Patch

Live-only bounded patch in:

- `scripts/run_technical_daily_direct.py`
- `scripts/test_technical_daily_asset_extraction.py`

Changes:

- add `canonical_asset_snapshot()` helper
- normalize loaded snapshots to asset-only `SPY/QQQ/IWM/TLT/GLD`
- write `base_source_snapshot` as canonical asset-only content, not recursive full payload

## Proof Tests

- `python3 -m py_compile scripts/run_technical_daily_direct.py scripts/test_technical_daily_asset_extraction.py`
- `python3 scripts/test_technical_daily_asset_extraction.py`
- `python3 scripts/run_technical_daily_direct.py`
- inspect `knowledge/technical_daily/2026-03-27_technical_daily.sources.json`
  - `base_source_snapshot` contains only ETF keys
  - no nested `mode`
  - no nested `base_source_snapshot`
- `bash lobster_command_v2.sh 技术日报`
- `python3 scripts/feishu_branch_smoke.py`

## What Is Now Prevented

- repeated direct runs recursively nesting `stable_direct` payloads
- source artifacts growing noisier and less inspectable over time

## What Remains Out Of Scope

- this does not improve upstream source freshness
- `technical_daily` still remains `live-hardened`, not `live-fixed`
