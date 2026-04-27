# Lane Duplicate Suppression

## Status

- `dev-fixed`: yes
- `live-fixed`: yes

## Exact failure mode

- lane-aware retrieval already preferred the current lane memory card
- but the same-topic global copy could still appear immediately after it
- this showed up for both:
  - semantic recall
  - episodic recall

Typical example:

- lane query:
  - `market regime drivers`
  - or `上次 market regime 教训`
- first result was correct
- second result was often the global copy of the same topic and same memory type

## Why this was dangerous

- it makes current-line recall feel less scoped than it really is
- instead of "recall the current lane's memory", the system still looked like it was flipping both current-lane and global copies at once

## Smallest safe patch

- keep the current ranking model
- add one post-sort dedupe pass:
  - dedupe by `(memory_type, normalized_topic)`
  - keep the highest-ranked copy
- this preserves:
  - lane-first preference
  - semantic vs episodic separation
- while removing same-topic duplicates of the same memory type

## Live files changed

- `scripts/local_corpus_search.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Proof tests

- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `LOBSTER_LANE_KEY='feishu:oc_3b1f572ef84301a8076b4d9a4555e05f' python3 scripts/local_corpus_search.py 'market regime drivers'`
- `LOBSTER_LANE_KEY='feishu:oc_3b1f572ef84301a8076b4d9a4555e05f' python3 scripts/local_corpus_search.py '上次 market regime 教训'`
- `python3 -m py_compile scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `corepack pnpm exec oxlint scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`

## Live evidence

- lane semantic recall now keeps:
  - lane semantic card
- and no longer shows:
  - global semantic duplicate of the same topic

- lane episodic recall now keeps:
  - lane episodic card
- and no longer shows:
  - global episodic duplicate of the same topic

## What is now prevented

- current-lane recall surfacing the same-topic global copy right after the correct lane result
- scoped recall looking more global than it really is

## Residual

- this only removes same-topic same-memory-type duplicates
- it does not suppress other nearby related topics, which may still appear lower in the result set
