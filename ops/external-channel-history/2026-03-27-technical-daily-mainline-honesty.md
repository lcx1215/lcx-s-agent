# Technical Daily Mainline Honesty

- date: 2026-03-27
- status: live-hardened
- dev-fixed: yes
- live-fixed: no

## Exact Failure Mode

`technical_daily` had provenance honesty in `Execution Risk Notes`, but the main ETF snapshot lines still read like direct fresh judgments.

That meant the most visible user-facing lines could still feel fresher than the actual sourcing path.

## Why Dangerous

- users read the top snapshot lines first, not the lower provenance notes
- stale / prior-derived status stayed too hidden
- the report could still look more confident than its source path justified

## Smallest Safe Patch

Live-only bounded patch in:

- `scripts/run_technical_daily_direct.py`
- `scripts/test_technical_daily_asset_extraction.py`

Changes:

- add prior-snapshot detection for the current source bundle
- prefix main ETF snapshot lines with `Low-fidelity read:` when the direct runner is using prior saved snapshot sourcing
- avoid double-prefixing lines that are already explicitly low-fidelity

## Proof Tests

- `python3 scripts/test_technical_daily_asset_extraction.py`
- `python3 scripts/run_technical_daily_direct.py`
- `bash lobster_command_v2.sh 技术日报`
- `python3 scripts/feishu_branch_smoke.py`

## What Is Now Prevented

- provenance honesty living only in lower notes while the main snapshot still sounds fresh
- prior-derived direct-runner output being mistaken for fresh retrieval output

## What Remains Out Of Scope

- this does not improve upstream freshness
- `technical_daily` remains `live-hardened`, not `live-fixed`
