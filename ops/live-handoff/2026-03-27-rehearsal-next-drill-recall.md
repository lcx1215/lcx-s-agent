# Rehearsal Next-Drill Recall

## Status

- `dev-fixed`: yes
- `live-fixed`: yes

## Exact failure mode

- topic cards already carried:
  - `next_drill`
- but live retrieval still treated questions like:
  - `接下来怎么练`
  - `下次该怎么练`
  - `下一步该练什么`
  as ordinary:
  - semantic recall
  - or runtime market queries
- this meant the system could store reinforcement cues without having a dedicated way to recall them

## Why this was dangerous

- it left the reinforcement layer half-built:
  - the memory data existed
  - but the retrieval semantics did not
- that keeps Lobster closer to a memory cabinet than a brain that can say:
  - "this is what to practice next"

## Smallest safe patch

- keep the current memory layers
- do not add a new file format or new memory type
- only add a bounded new retrieval intent:
  - `rehearsal_recall`
- route rehearsal-style questions to prefer cards carrying:
  - `next_drill`
  - `default_method`
- also add one generic rehearsal anchor:
  - when the query has no topic tokens at all, use the most general reusable card
  - currently:
    - `market_regime.md`

## Live files changed

- `scripts/local_corpus_search.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Proof tests

- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 -m py_compile scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `corepack pnpm exec oxlint scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/local_corpus_search.py 'market regime 接下来怎么练'`
- `python3 scripts/local_corpus_search.py 'qqq 下次该怎么练'`
- `python3 scripts/local_corpus_search.py '这个主题下一步该练什么'`

## Live evidence

- `market regime 接下来怎么练`
  - intent:
    - `rehearsal_recall`
  - top result:
    - `knowledge/topic_memory/market_regime.md`
- `qqq 下次该怎么练`
  - intent:
    - `rehearsal_recall`
  - top result:
    - `knowledge/topic_memory/qqq_ai_capex_and_duration_sensitivity.md`
- `这个主题下一步该练什么`
  - intent:
    - `rehearsal_recall`
  - top result:
    - `knowledge/topic_memory/market_regime.md`

## What is now prevented

- `next_drill` existing in cards without a dedicated recall path
- reinforcement-style questions falling back to ordinary recall semantics
- generic rehearsal questions drifting to arbitrary high-weight procedural cards

## Residual

- this is bounded retrieval support for reinforcement cues
- it is not yet a full spaced-repetition or reinforcement scheduler
