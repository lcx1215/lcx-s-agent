# Feishu Topic Card Router Alignment

## Summary

- Scope: bounded live hardening for Feishu learning router command execution.
- Objective: keep the Feishu `topic卡片` path aligned with the live topic-memory implementation instead of pointing at a deleted script.

## Live Files Changed

- `scripts/feishu_nlu_router.py`
- `scripts/test_feishu_nlu_router.py`

## Exact Failure Mode

- `scripts/feishu_nlu_router.py` still executed:
  - `python3 ./scripts/topic_card.py ...`
- That file no longer exists in live.
- Result: Feishu `topic卡片 ...` requests failed hard, even though the main command path already worked through `scripts/topic_memory.py`.

## Why Dangerous

- It creates a split-brain command surface:
  - main command path works
  - Feishu router path fails
- User-visible failure appears only on one surface, which is easy to miss during partial testing.

## Smallest Safe Patch

- Repoint Feishu `topic卡片` execution to:
  - `python3 ./scripts/topic_memory.py show <topic>`
- Normalize the direct alias mapping in `extract_topics(...)` to canonical topic names instead of old dated pseudo-paths.
- Add a direct test that verifies Feishu router `topic卡片` requests render real topic cards.

## Proof Tests

- `python3 scripts/test_feishu_nlu_router.py`
- `python3 scripts/feishu_nlu_router.py 'topic卡片 market regime'`
- `python3 scripts/feishu_nlu_router.py 'topic卡片 spy death cross risk'`
- `python3 -m py_compile scripts/feishu_nlu_router.py scripts/test_feishu_nlu_router.py`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Notes

- This is a command-surface alignment fix, not a broader NLU redesign.
- The goal is to ensure Feishu and the main command path hit the same live topic-memory implementation.
