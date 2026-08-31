# Topic Memory Lane-Scope Hardening

## Status

- `dev-fixed`: n/a
- `live-fixed`: no
- current state: `live-hardened`

## Exact failure mode

- live learning already preserved `lane_key` in:
  - queue rows
  - learner reports
  - learner sources
  - learner state
- but `scripts/topic_memory.py` still rebuilt topic cards from the newest report per topic globally.
- that meant two Feishu chats learning the same topic could still overwrite each other at the topic-memory layer.

## Why dangerous

- lane separation would look real in learner artifacts, but downstream memory would quietly collapse back into one shared topic card.
- `学习记忆` and `topic卡片` could surface the wrong chat's latest learning conclusion.
- this would make the system look lane-aware while still leaking state across conversations.

## Smallest safe patch

- keep the global topic-memory card/index for compatibility.
- add lane-scoped topic-memory mirrors under `branches/learn/lanes/*/topic_memory`.
- make `topic_memory.py` prefer the current lane mirror when `LOBSTER_LANE_KEY` is set and lane data exists.
- keep the patch bounded to:
  - `scripts/topic_memory.py`
  - `scripts/topic_memory_status.py`
  - one dedicated proof test

## Live files changed

- `scripts/topic_memory.py`
- `scripts/topic_memory_status.py`
- `scripts/test_topic_memory_lane_scope.py`

## Behavior change

- `topic_memory.py rebuild` now writes:
  - global topic cards and global index
  - branch-level global mirror at `branches/learn/topic_memory_index.json`
  - lane-scoped topic cards/indexes under `branches/learn/lanes/*/topic_memory`
- `学习记忆` / `topic卡片` can now read lane-scoped topic memory when `LOBSTER_LANE_KEY` is present.
- `topic_memory.py show <topic>` now works as an alias for `card`.
- `topic_memory_status.py` now exposes recent lane indexes.

## Proof tests

- `python3 -m py_compile scripts/topic_memory.py scripts/topic_memory_status.py scripts/test_topic_memory_lane_scope.py`
- `python3 scripts/test_topic_memory_lane_scope.py`
- `python3 scripts/topic_memory.py rebuild`
- `LOBSTER_LANE_KEY='feishu:chat-alpha' python3 scripts/topic_memory.py summary_short`
- `python3 scripts/topic_memory_status.py`

## What is now prevented

- two chats learning the same topic and then silently sharing one topic-memory card.
- lane-aware learner outputs being flattened back into a global topic-memory summary.
- `topic卡片` failing on the `show` alias path.

## What remains intentionally out of scope

- this is not full per-lane workspace isolation.
- local corpus retrieval still primarily indexes global knowledge paths.
- the global topic-memory card still exists and can still be the newest report across all lanes by design.
