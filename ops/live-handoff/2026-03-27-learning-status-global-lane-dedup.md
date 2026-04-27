# Learning Status Global/Lane Dedup

## Summary

- Scope: bounded live hardening for the learning status panel.
- Objective: stop `学习状态` from reporting the same global learn run twice: once as `learn_state` and again as a `lane_states` entry.

## Live Files Changed

- `scripts/nightly_learning_status.py`
- `scripts/test_nightly_learning_status.py`

## Exact Failure Mode

- After the global learner repair run, live now keeps:
  - `branches/learn/learn_state.json`
  - `branches/learn/lanes/global/learn_state.json`
- `nightly_learning_status.py` previously surfaced both, which made the operator panel show:
  - clean global state
  - plus an extra pseudo-lane with `lane_key=global`

## Why Dangerous

- It blurs the distinction between system-global state and real lane mirrors.
- That undermines the lane/global separation we just hardened.

## Smallest Safe Patch

- Add `collect_lane_states(...)`.
- Exclude:
  - `lane_key == "global"`
  - path under `lanes/global`
- Keep true non-global lane mirrors visible.

## Proof Tests

- `python3 scripts/test_nightly_learning_status.py`
- `python3 scripts/nightly_learning_status.py`
- `./lobster_command_v2.sh '学习状态'`
- `python3 -m py_compile scripts/nightly_learning_status.py scripts/test_nightly_learning_status.py`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Notes

- This is status-surface cleanup, not a learning pipeline rewrite.
- After the preceding global repair run, the panel now shows:
  - one clean `learn_state`
  - only true non-global `lane_states`
