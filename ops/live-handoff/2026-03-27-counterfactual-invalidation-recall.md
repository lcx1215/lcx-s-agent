# Counterfactual Invalidation Recall

## Status

- `dev-fixed`: yes
- `live-fixed`: yes

## Exact failure mode

- live retrieval already supported:
  - semantic recall
  - episodic recall
  - procedural transfer
  - runtime freshness
- but it still had no dedicated seam for:
  - `如果错了`
  - `什么会证伪`
  - `什么时候失效`
- so falsification-style questions were still being treated like ordinary recall instead of "how would this be wrong?" recall

## Why this was dangerous

- without this seam, Lobster still looked more like a memory-backed answerer than a red-team research brain
- it could recall conclusions, but not preferentially recall:
  - failure patterns
  - invalidation conditions
  - what would falsify the current read

## Smallest safe patch

- keep the current memory layers:
  - semantic
  - procedural
  - episodic
- do not add a new memory type
- only add a bounded new retrieval intent:
  - `counterfactual_recall`
- route falsification-style queries to prefer:
  - episodic cards with `Failure To Avoid`
  - procedural cards with `common_failure`
  - procedural cards that already carry invalidation-style guidance

## Live files changed

- `scripts/local_corpus_search.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Proof tests

- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 -m py_compile scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `corepack pnpm exec oxlint scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/local_corpus_search.py 'market regime 什么会证伪这个结论'`
- `python3 scripts/local_corpus_search.py 'spy death cross risk 什么会证伪'`
- `python3 scripts/local_corpus_search.py 'qqq 这个读法什么时候失效'`

## Live evidence

- `market regime 什么会证伪这个结论`
  - intent:
    - `counterfactual_recall`
  - top result:
    - `knowledge/topic_memory/episodes/market_regime.md`
- `spy death cross risk 什么会证伪`
  - intent:
    - `counterfactual_recall`
  - top result:
    - `knowledge/topic_memory/spy_death_cross_risk.md`
- `qqq 这个读法什么时候失效`
  - intent:
    - `counterfactual_recall`
  - top result:
    - `knowledge/topic_memory/qqq_ai_capex_and_duration_sensitivity.md`

## What is now prevented

- falsification / invalidation questions falling back to generic memory recall
- live answers remembering the thesis but not preferentially remembering how it could fail

## Residual

- this is a bounded recall seam, not a full correction-engine
- it still depends on existing `episode` and `common_failure` content quality
