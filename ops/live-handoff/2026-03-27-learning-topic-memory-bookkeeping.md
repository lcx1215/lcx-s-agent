# Learning Topic Memory Bookkeeping Hardening

## Summary

- Scope: bounded live hardening for the learner bookkeeping seam.
- Objective: make `learn_topic` update `topic_memory` as part of bookkeeping, so `学习记忆` and `topic卡片` do not stay stale after a successful learn run.

## Live Files Changed

- `scripts/run_local_batch_learner.py`
- `scripts/test_learning_bookkeeping.py`

## Exact Failure Mode

- A learn run could finish with:
  - report written
  - sources written
  - state written
- but `topic_memory` was not rebuilt automatically.
- Result:
  - `学习记忆`
  - `topic卡片`
  could remain stale until a manual rebuild happened later.

## Why Dangerous

- It breaks the “learn -> remember -> reuse” loop.
- The system appears to have learned something, but its recall layer can still answer from older memory.
- That is a real self-maintenance gap, not just a cosmetic issue.

## Smallest Safe Patch

- Add a bounded `rebuild_topic_memory()` step to `run_local_batch_learner.py`.
- Only run it after report / sources / state / lane_state all record successfully.
- Treat `topic_memory` rebuild as part of bookkeeping:
  - success => `recorded`
  - failure => `pending_retry` with anomaly trace

## Proof Tests

- `python3 scripts/test_learning_bookkeeping.py`
- `python3 -m py_compile scripts/run_local_batch_learner.py scripts/test_learning_bookkeeping.py`
- `LOBSTER_LANE_KEY='feishu:chat-gamma' python3 scripts/run_local_batch_learner.py 'market regime'`
- `LOBSTER_LANE_KEY='feishu:chat-gamma' ./lobster_command_v2.sh '学习记忆'`
- `LOBSTER_LANE_KEY='feishu:chat-gamma' ./lobster_command_v2.sh 'topic卡片 market regime'`
- `python3 scripts/topic_memory_status.py`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Notes

- This is bookkeeping hardening, not full lane workspace isolation.
- The learner is now closer to a self-maintaining system because memory visibility updates are part of the same bounded completion path.
