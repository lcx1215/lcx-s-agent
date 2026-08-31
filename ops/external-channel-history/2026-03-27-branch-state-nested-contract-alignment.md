# 2026-03-27 Branch State Nested Contract Alignment

## Exact failure mode

`branches/_system/branch_state.json` still had a split contract:

- top-level `fundamental_research_branch`
  - had `risk_handoff_path` and `risk_audit_path`
- nested `branches.fundamental_research_branch`
  - was missing those paths

That meant different live readers were seeing different realities depending on whether they read the top-level row or the nested row.

## Why dangerous

- It is a shared-state consistency bug.
- Runtime sanity and branch-control surfaces can disagree even when the underlying branch run is healthy.
- It makes L4 hardening look less complete than it is.

## Smallest safe patch

Do not rewrite the fundamental branch.
Do not change artifact format broadly.

Only tighten `scripts/sync_branch_status.py` so the nested row preserves key live fields from the top-level branch row, including:

- `risk_handoff_path`
- `risk_audit_path`
- `queue_size`
- `topics_hint`
- `brain_trace_summary`

## Live files changed

- `scripts/sync_branch_status.py`

## Proof tests

- `python3 -m py_compile scripts/sync_branch_status.py`
- `python3 scripts/sync_branch_status.py`
- `python3 scripts/lobster_runtime_state_sanity.py`

## Real live evidence

After rerunning `scripts/sync_branch_status.py`:

- `branches/_system/branch_state.json`
  - nested `branches.fundamental_research_branch`
    now includes:
    - `risk_handoff_path`
    - `risk_audit_path`

`python3 scripts/lobster_runtime_state_sanity.py` now returns:

- `[ok] _system state files exist`
- `[ok] fundamental branch artifacts exist`
- `[ok] workflow risk audit paths point to real files`
- `[ok] fundamental branch and workflow timestamps are in a sane order`

## Status

- `dev-fixed: yes`
- `live-fixed: yes`

## Out of scope

- Old root-level `branch_state.json` still exists as legacy history.
- This patch only aligns the active `_system` nested contract.
