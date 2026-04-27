# Technical Daily Source Provenance Honesty

- date: 2026-03-27
- status: live-hardened
- dev-fixed: yes
- live-fixed: no

## Exact Failure Mode

`technical_daily` was presenting current ETF snapshots in a clean operator-facing style, but it still did not clearly say that the direct runner was deriving from the latest saved technical snapshot rather than a fresh retrieval pass.

That meant the wording could look fresher than the actual sourcing path.

## Why Dangerous

- a clean answer can still mislead if source provenance is implied rather than explicit
- repeat runs can look like fresh daily retrieval when they are actually prior-derived
- this weakens the system's low-fidelity honesty discipline

## Smallest Safe Patch

Live-only bounded patch in:

- `scripts/run_technical_daily_direct.py`
- `scripts/test_technical_daily_asset_extraction.py`

Changes:

- add `load_latest_sources_bundle()` metadata path
- keep `load_latest_sources()` compatibility behavior
- add `describe_source_provenance()` and surface it in `Execution Risk Notes`
- keep the report content path unchanged apart from provenance honesty

## Proof Tests

- `python3 -m py_compile scripts/run_technical_daily_direct.py scripts/test_technical_daily_asset_extraction.py`
- `python3 scripts/test_technical_daily_asset_extraction.py`
- `python3 scripts/run_technical_daily_direct.py`
- `bash lobster_command_v2.sh 技术日报`
- `python3 scripts/feishu_branch_smoke.py`

## What Is Now Prevented

- `technical_daily` sounding fresh while actually using prior-derived snapshot sourcing
- future quality work accidentally treating direct-runner output as fully fresh retrieval output

## What Remains Out Of Scope

- this does not solve upstream freshness
- it only makes provenance honest
- `technical_daily` remains `live-hardened`, not `live-fixed`
