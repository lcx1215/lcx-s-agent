# Technical Daily Origin Lineage Hardening

- date: 2026-03-27
- status: live-hardened
- dev-fixed: yes
- live-fixed: no

## Exact Failure Mode

Even after provenance honesty was added, `technical_daily` still had two lineage problems:

1. origin metadata could stay pinned to the same-day `stable_direct` file instead of tracing back to the earlier raw asset snapshot
2. when the true origin file had no `generated_at`, the report could still fall back to the current packaging time and make the lineage look fresher than it was

## Why Dangerous

- provenance can look honest while still being wrong
- repeated runs can keep washing lineage into same-day repackaging metadata
- this undermines low-fidelity honesty even if the surface wording looks careful

## Smallest Safe Patch

Live-only bounded patch in:

- `scripts/run_technical_daily_direct.py`
- `scripts/test_technical_daily_asset_extraction.py`

Changes:

- add origin inference using canonical asset-snapshot matching across prior source files
- prefer the matched earlier raw snapshot as `source_origin_file`
- when the origin file lacks `generated_at`, keep it empty and render `unknown generation time` instead of reusing current packaging time

## Proof Tests

- `python3 scripts/test_technical_daily_asset_extraction.py`
- `python3 scripts/run_technical_daily_direct.py`
- inspect `knowledge/technical_daily/2026-03-27_technical_daily.sources.json`
  - `source_origin_file == 2026-03-13_technical_daily.sources.json`
  - `source_origin_mode == asset_snapshot`
  - `source_origin_generated_at == ""`
- `bash lobster_command_v2.sh 技术日报`
- `python3 scripts/feishu_branch_smoke.py`

## What Is Now Prevented

- same-day `stable_direct` repackaging being misreported as the real source origin
- unknown origin time being replaced with current packaging time

## What Remains Out Of Scope

- this still does not improve upstream freshness
- `technical_daily` remains `live-hardened`, not `live-fixed`
