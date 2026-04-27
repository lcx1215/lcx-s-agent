# Episodic Memory Seed Layer

## Status

- `dev-fixed`: yes
- `live-fixed`: yes

## Exact failure mode

- live retrieval could already split:
  - `semantic`
  - `procedural`
  - `runtime fresh`
- but it still could not recall:
  - last lesson
  - prior case
  - what failed before
- queries like:
  - `上次 market regime 错在哪`
  - `之前的 market regime 教训`
  - `last time market regime lesson`
  still collapsed back into semantic topic-memory.

## Why this was dangerous

- the system could remember conclusions, but not recall concrete prior episodes
- that keeps Lobster closer to a structured file cabinet than a brain-like research workspace
- it also weakens correction / case-based reuse, because "lesson recall" and "topic recall" stayed mixed together

## Smallest safe patch

- add a bounded episodic memory seed layer on top of existing topic-memory
- do not redesign the learning architecture
- do not add a new provider or large routing layer
- only:
  - extract one compact episode per latest learning report
  - store it under `topic_memory/episodes`
  - add `episodic_recall` query intent
  - route "last time / lesson / failure / 教训 / 错在哪" queries toward episodes first

## Live files changed

- `scripts/topic_memory.py`
- `scripts/topic_memory_status.py`
- `scripts/local_corpus_search.py`
- `scripts/test_topic_memory_lane_scope.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Behavior change

- rebuild now creates:
  - global episodic cards under `knowledge/topic_memory/episodes/*.md`
  - lane episodic cards under `branches/learn/lanes/*/topic_memory/episodes/*.md`
  - global episodic index:
    - `branches/learn/episodic_memory_index.json`
  - lane episodic indexes:
    - `branches/learn/lanes/*/topic_memory/episodic_memory_index.json`
- `topic_memory_status.py` now reports:
  - `episode_count`
  - `memory_type_counts.episodic`
  - per-lane `episode_count`
- `local_corpus_search.py` now classifies:
  - `episodic_recall`
- `episodic_recall` now prefers episode cards over semantic cards

## Proof tests

- `python3 scripts/test_topic_memory_lane_scope.py`
- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 -m py_compile scripts/topic_memory.py scripts/topic_memory_status.py scripts/local_corpus_search.py scripts/test_topic_memory_lane_scope.py scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/topic_memory.py rebuild`
- `python3 scripts/topic_memory_status.py`
- `python3 scripts/local_corpus_search.py '上次 market regime 错在哪'`
- `python3 scripts/local_corpus_search.py '之前的 market regime 教训'`
- `python3 scripts/local_corpus_search.py 'last time market regime lesson'`
- `corepack pnpm exec oxlint scripts/topic_memory.py scripts/topic_memory_status.py scripts/local_corpus_search.py scripts/test_topic_memory_lane_scope.py scripts/test_local_corpus_search_lane_preference.py`

## Live evidence

- `上次 market regime 错在哪`
  - `intent: episodic_recall`
  - first result:
    - `knowledge/topic_memory/episodes/market_regime.md`
- `之前的 market regime 教训`
  - `intent: episodic_recall`
  - first result:
    - `knowledge/topic_memory/episodes/market_regime.md`
- `last time market regime lesson`
  - `intent: episodic_recall`
  - first result:
    - `knowledge/topic_memory/episodes/market_regime.md`

## What is now prevented

- "上次 / 之前 / 教训 / 错在哪" queries silently collapsing back into semantic recall
- topic-memory keeping only conclusions, without retaining compact prior-case recall
- live status underreporting the new episodic layer

## Residual

- this is still a seed episodic layer, not a full correction-history engine
- episode extraction is currently one compact lesson per latest report, not full multi-episode clustering
- full lane workspace propagation is still not finished
