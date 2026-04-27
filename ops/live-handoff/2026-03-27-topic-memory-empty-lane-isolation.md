# Topic Memory Empty-Lane Isolation

## Summary

- Scope: bounded live hardening for `topic_memory` read isolation.
- Objective: stop empty Feishu lanes from silently falling back to global learning memory.

## Live Files Changed

- `scripts/topic_memory.py`
- `scripts/test_topic_memory_lane_scope.py`

## Exact Failure Mode

- When a non-global lane had no lane-local topic memory index yet, `load_scope_index()` fell back to the global branch index.
- Result: `学习记忆` in a brand-new lane could display global learning memory as if it belonged to the current lane.

## Why Dangerous

- It breaks lane isolation at the user-visible recall layer.
- A fresh lane appears to "remember" topics it has never learned.
- That makes learning continuity look stronger than it really is and hides real lane emptiness.

## Smallest Safe Patch

- For non-global lanes, `load_scope_index()` now returns lane scope even when the lane index is empty.
- `summary_short()` now responds explicitly with:
  - `当前 lane 暂无学习记忆。`
- Global fallback remains only for true global reads.

## Proof Tests

- `python3 scripts/test_topic_memory_lane_scope.py`
- `LOBSTER_LANE_KEY='feishu:new-empty-lane' ./lobster_command_v2.sh '学习记忆'`
- `python3 -m py_compile scripts/topic_memory.py scripts/test_topic_memory_lane_scope.py`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Notes

- This is lane-read isolation hardening, not a broader memory architecture rewrite.
- The goal is honesty: an empty lane should look empty, not quietly inherit global memory.
