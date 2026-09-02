# Learning Task Contract Lane Alignment

## Summary

- Scope: bounded live hardening for the learning task contract surface.
- Objective: keep the declared learner outputs aligned with the current lane-aware bookkeeping behavior.

## Live Files Changed

- `scripts/learning_task_contract.py`
- `scripts/test_learning_task_contract.py`

## Exact Failure Mode

- `learning_task_contract.py` still declared:
  - `outputs.state_path = branches/learn/learn_state.json`
- for lane-scoped tasks.
- But lane runs no longer write global `learn_state.json`.

## Why Dangerous

- It makes validation and automation believe a lane task updates global state when it does not.
- That recreates the same `dev-fixed but semantics stale` problem at the contract layer.

## Smallest Safe Patch

- Add a small `build_task(topic, lane_key)` helper.
- For global tasks:
  - keep `outputs.state_path`
- For lane tasks:
  - set `outputs.state_path` to an empty string
  - emit `outputs.lane_state_path` instead

## Proof Tests

- `python3 scripts/test_learning_task_contract.py`
- `LOBSTER_LANE_KEY='feishu:chat-alpha' python3 scripts/learning_task_contract.py 'market regime'`
- `python3 -m py_compile scripts/learning_task_contract.py scripts/test_learning_task_contract.py`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Notes

- This is contract alignment only.
- It does not change learner routing, queueing, or provider behavior.
