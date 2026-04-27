# Topic Memory Symbol And Acceptance Honesty

## Summary

Harden two live learning-memory seams:

1. topic cards should not stamp every topic with `symbol: SPY`
2. learning acceptance should not count recall commands as learn-task execution success

## Exact Failure Modes

### 1. Topic card symbol lie

- `scripts/topic_memory.py` was writing `symbol: SPY` for all topic cards.
- This affected:
  - `QQQ`
  - `TLT`
  - `IWM`
  - generic topics like `market regime`

### 2. Acceptance false-positive

- `scripts/learning_acceptance_probe.py` was only checking for:
  - matching lane
  - matching topic text
- so later commands like:
  - `学习记忆`
  - `topic卡片 market regime`
  could be misread as evidence that `learn_topic market regime` executed successfully.

## Why Dangerous

- Topic cards are supposed to be reusable memory artifacts. Wrong identity metadata makes them less trustworthy and harder to audit.
- Acceptance false-positives inflate confidence and can cause premature `live-fixed` claims.

## Smallest Safe Patch

- In `scripts/topic_memory.py`:
  - infer `symbol` from bucket
  - render generic topics as `symbol: N/A`
- In `scripts/learning_acceptance_probe.py`:
  - require actual learner-success evidence:
    - `learn task completed for topic: ...`
    - or learner JSON with `"branch": "learn_branch"`
  - still verify lane topic-memory artifacts in addition to report artifacts

## Files Changed

- live:
  - `scripts/topic_memory.py`
  - `scripts/test_topic_memory_lane_scope.py`
  - `scripts/learning_acceptance_probe.py`
  - `scripts/test_learning_acceptance_probe.py`

## Proof Tests

- `python3 scripts/test_topic_memory_lane_scope.py`
- `python3 scripts/test_learning_acceptance_probe.py`
- `python3 -m py_compile scripts/topic_memory.py scripts/test_topic_memory_lane_scope.py scripts/learning_acceptance_probe.py scripts/test_learning_acceptance_probe.py`
- `python3 scripts/topic_memory.py rebuild`
- `python3 scripts/learning_acceptance_probe.py`

## Observed Behavior Change

- Global topic cards now render honest symbols:
  - `QQQ`
  - `TLT`
  - generic topics as `N/A`
- `learning_acceptance_probe.py` now verifies:
  - lane-separated reports
  - refreshed lane topic-memory artifacts
  - actual learner execution evidence
- It no longer treats recall-only commands as sufficient evidence of learning execution.

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Remaining Out Of Scope

- This does not make the whole learning seam `live-fixed`.
- It does not replace the need for final real Feishu multi-window acceptance.
- It does not solve source freshness or full lane workspace isolation.
