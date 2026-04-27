# Technical Daily Asset Normalization

- date: 2026-03-27
- status: live-hardened
- dev-fixed: yes
- live-fixed: no

## Exact Failure Mode

`technical_daily` was still returning raw title/news fragments even after the worst markdown pollution was removed.

Most visible failures:

- `SPY` used a generic comparison sentence with no technical-daily framing
- `QQQ` fell back to `technical context unavailable`
- `TLT` / `GLD` still read like copied news sentences instead of clean operator-facing snapshots

## Why Dangerous

This is a branch-stability problem, not a cosmetic problem.

The branch was running and passing seam checks, but the user-facing content was still too brittle to trust.

## Smallest Safe Patch

Live-only bounded patch in `Projects/openclaw/scripts/run_technical_daily_direct.py`:

- add asset-aware normalization for selected snippets
- add low-fidelity fallback synthesis for weak `QQQ` source coverage
- keep direct runner structure unchanged
- do not reopen routing or retrieval architecture

## Live Files Changed

- `scripts/run_technical_daily_direct.py`
- `scripts/test_technical_daily_asset_extraction.py`

## Behavior Change

Current `技术日报` snapshots now render as:

- `SPY`: broad market steady, momentum softened by AI-capex worries
- `QQQ`: explicit low-fidelity growth / risk-appetite read instead of empty unavailable
- `IWM`: small-cap rotation bid
- `TLT`: rates-driven with 10-year yield anchor
- `GLD`: safe-haven / hedge framing

## Proof Tests

- `python3 -m py_compile scripts/run_technical_daily_direct.py scripts/test_technical_daily_asset_extraction.py`
- `python3 scripts/test_technical_daily_asset_extraction.py`
- `python3 scripts/run_technical_daily_direct.py`
- `bash lobster_command_v2.sh 技术日报`
- `python3 scripts/feishu_branch_smoke.py`

## What Is Now Prevented

- dirty title/news fragments being returned as ETF snapshots
- `QQQ` defaulting to `technical context unavailable` when weak but still directional source evidence exists
- branch seam success masking low-quality user-facing output

## What Remains Out Of Scope

- this is not yet `live-fixed`
- source retrieval quality is still uneven
- low-fidelity handling for `QQQ` is honest and cleaner, but still weaker than a true clean direct signal
- broader technical-daily quality scoring still needs more rounds before branch stability can be called complete
