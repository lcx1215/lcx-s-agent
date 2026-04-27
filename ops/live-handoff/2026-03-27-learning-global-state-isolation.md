# Learning Global State Isolation Hardening

## Summary

- Scope: bounded live hardening for learning shared-state isolation.
- Objective: stop lane-scoped learning artifacts from silently polluting global learning state and global topic memory.

## Live Files Changed

- `scripts/topic_memory.py`
- `scripts/run_local_batch_learner.py`
- `scripts/nightly_learning_status.py`
- `scripts/test_topic_memory_lane_scope.py`
- `scripts/test_learning_lane_metadata.py`
- `scripts/test_learning_bookkeeping.py`

## Exact Failure Modes

1. `topic_memory rebuild` used the latest report across all lanes when rebuilding the global index.
2. lane learner runs still overwrote `branches/learn/learn_state.json`.
3. `test_learning_bookkeeping.py` leaked a synthetic lane state into live runtime paths.

## Why Dangerous

- A single Feishu lane could rewrite global memory views.
- Global status surfaces could report a lane-local learn run as if it were the system-wide latest learn state.
- Tests could leave synthetic artifacts behind and distort later operator inspection.

## Smallest Safe Patch

- Restrict global `topic_memory` rebuild to reports whose lane is `global`.
- Keep lane runs writing only:
  - report
  - sources
  - lane state
  - topic memory bookkeeping
- Stop lane runs from overwriting global `learn_state.json`.
- Make `nightly_learning_status.py` surface any pre-existing lane value in the global slot as legacy state instead of treating it as clean global state.
- Isolate bookkeeping tests so lane-state writes stay inside their temp sandbox.

## Proof Tests

- `python3 scripts/test_topic_memory_lane_scope.py`
- `python3 scripts/test_learning_lane_metadata.py`
- `python3 scripts/test_learning_bookkeeping.py`
- `python3 scripts/nightly_learning_status.py`
- `python3 -m py_compile scripts/topic_memory.py scripts/run_local_batch_learner.py scripts/nightly_learning_status.py scripts/test_topic_memory_lane_scope.py scripts/test_learning_lane_metadata.py scripts/test_learning_bookkeeping.py`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Notes

- The legacy polluted `branches/learn/learn_state.json` is still preserved on disk as audit history.
- `nightly_learning_status.py` now reports it as `legacy_lane_state_in_global_slot` instead of presenting it as clean global state.
- A subsequent repair run restored the global slot to:
  - `lane_key=global`
  - `legacy_lane_state_in_global_slot = null`
- Current acceptance evidence shows lane runs keep their writes inside lane state / lane topic-memory, while the global slot stays clean.
