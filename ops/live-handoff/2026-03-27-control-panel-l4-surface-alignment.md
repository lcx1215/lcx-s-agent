# 2026-03-27 Control Panel L4 Surface Alignment

## Exact failure mode

Active live runtime surfaces were still exposing `l3_status` semantics even after the system had already been hardened into an L4 shared-brain runtime.

The bad surfaces were:

- `branches/technical_daily/technical_daily_branch.py`
  - still wrote active branch status into `l3_status.json`
- `scripts/sync_branch_status.py`
  - still printed `l3_status` as the active control-panel path
- `scripts/lobster_runtime_state_sanity.py`
  - still treated `l3_status.json` as the required runtime state file
- `lobster_orchestrator.py`
- `control_panel_summary.py`
- `make_learning_report.py`
  - all still rendered user-visible lines like:
    - `L3 completed`
    - `Current milestone`
    - `Next milestone`

That meant the current runtime could honestly be L4 in behavior while still speaking L3 in its own control plane.

## Why dangerous

- It undermines artifact integrity.
- It makes the current system stage look stale even after live hardening work has already landed.
- It causes operator-facing control surfaces to lie about the current baseline.
- It creates exactly the wrong mental model for ongoing L4 closeout work.

## Smallest safe patch

Add a bounded `control_panel_state` alias layer and move all active surfaces to it, while preserving `l3_status.json` as a compatibility mirror only.

Do not rewrite old install scripts or historical artifacts.
Do not delete legacy files.
Do not reopen architecture.

## Live files changed

- `scripts/lobster_paths.py`
- `branches/technical_daily/technical_daily_branch.py`
- `scripts/sync_branch_status.py`
- `scripts/lobster_runtime_state_sanity.py`
- `lobster_orchestrator.py`
- `control_panel_summary.py`
- `make_learning_report.py`
- `scripts/test_control_panel_l4_surfaces.py`

## Behavior change

- Active runtime now writes and reads:
  - `branches/_system/control_panel_state.json`
- `branches/_system/l3_status.json` is still written as a compatibility mirror, but active status surfaces no longer present it as the current control plane.
- Current visible wording is now:
  - `System stage: L4`
  - `Control panel status: l4_brain_hardened`
  - `Current phase: L4 baseline hardening and shared-brain runtime`
  - `Next phase: Complete branch-wide brain-aware state consumption and remove remaining legacy L3 surfaces`
- Old stale milestone text containing `L3 ...` is sanitized during normalization, so it no longer leaks back into fresh summaries.

## Proof tests

- `python3 scripts/test_control_panel_l4_surfaces.py`
- `python3 -m py_compile scripts/lobster_paths.py branches/technical_daily/technical_daily_branch.py scripts/sync_branch_status.py scripts/lobster_runtime_state_sanity.py lobster_orchestrator.py control_panel_summary.py make_learning_report.py scripts/test_control_panel_l4_surfaces.py`
- `corepack pnpm exec oxlint scripts/lobster_paths.py branches/technical_daily/technical_daily_branch.py scripts/sync_branch_status.py scripts/lobster_runtime_state_sanity.py lobster_orchestrator.py control_panel_summary.py make_learning_report.py scripts/test_control_panel_l4_surfaces.py`
- `python3 scripts/sync_branch_status.py`
- `python3 control_panel_summary.py`
- `python3 scripts/run_knowledge_maintenance_entry.py`
- `python3 scripts/branch_acceptance_probe.py knowledge_maintenance_branch --phrase 知识维护`

## Real live evidence

- `scripts/sync_branch_status.py` now prints:
  - `control_panel_state: branches/_system/control_panel_state.json`
- `control_panel_summary.py` now prints:
  - `System stage: L4`
  - not `L3 completed`
- latest `knowledge/maintenance/2026-03-28_knowledge_maintenance.md`
  - no longer contains old L3 milestone lines
- fresh Feishu acceptance for `知识维护` remains green after the patch

## Status

- `dev-fixed: yes`
- `live-fixed: yes`

## Out of scope

- Historical legacy files still exist on disk.
- Compatibility mirror `l3_status.json` still exists for old readers.
- Some unrelated historical install scripts still mention L3 and were intentionally left alone in this bounded patch.
