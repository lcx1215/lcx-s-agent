# Learning Lane Retrieval Preference Hardening

## Summary

- Scope: bounded live hardening for the learning retrieval seam.
- Objective: move the live learner from lane-aware memory only toward lane-aware retrieval, without opening self-feedback from `knowledge/learn`.

## Exact Failure Mode

- `scripts/local_corpus_search.py` previously ignored `LOBSTER_LANE_KEY`.
- A lane-scoped learner run searched the same global corpus as a global run.
- Result:
  - lane report
  - lane state
  - lane topic-memory
    could all be separated, while retrieval still behaved as if every lane shared one workspace.

## Why Dangerous

- It overstates how far lane workspace propagation has progressed.
- The system can appear to have independent specialist lines while still sourcing evidence from a single undifferentiated retrieval pool.
- That makes later acceptance and operator reasoning too optimistic.

## Smallest Safe Patch

- Keep `knowledge/learn` and `knowledge/learn_batch` blocked from retrieval.
- For non-global lanes, prefer the current lane's `branches/learn/lanes/*/topic_memory` mirror first.
- Fall back to the existing global knowledge search after that.
- Do not change queue logic, learner orchestration, or memory architecture.

## Live Files Changed

- `scripts/local_corpus_search.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Proof Tests

- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/local_corpus_search.py 'market regime drivers'`
- `LOBSTER_LANE_KEY='feishu:oc_3b1f572ef84301a8076b4d9a4555e05f' python3 scripts/local_corpus_search.py 'market regime drivers'`
- `python3 scripts/learning_acceptance_probe.py`

## Current Outcome

- Global retrieval still leads with:
  - `knowledge/technical_daily/2026-03-13_technical_daily.md`
- The real Feishu lane now leads with:
  - `branches/learn/lanes/feishu-oc-3b1f572ef84301a8076b4d9a4555e05f/topic_memory/market_regime.md`
- `scripts/learning_acceptance_probe.py` remains green after the retrieval change.

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Remaining Out Of Scope

- This is still not full per-lane workspace isolation.
- Global knowledge remains part of the fallback retrieval pool.
- This does not change source freshness or provider behavior.
