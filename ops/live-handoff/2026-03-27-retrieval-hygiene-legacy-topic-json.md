# Retrieval Hygiene: Legacy Topic JSON

## Status

- `dev-fixed`: yes
- `live-fixed`: yes

## Exact failure mode

- even after semantic / procedural / episodic memory layers were hardened, old legacy files under:
  - `knowledge/topic_memory/*.json`
  could still appear in live search results
- this was especially visible in:
  - episodic recall queries
  - procedural transfer queries
- the result list would still surface historical JSON artifacts that no longer represent the preferred memory layer

## Why this was dangerous

- it weakens the whole "brain-like" memory model by letting stale serialized artifacts compete with clean cards
- it also makes the system look less trustworthy:
  - the right memory card exists
  - but the retrieval surface still leaks old storage debris

## Smallest safe patch

- do not redesign retrieval
- do not delete all historical files
- only exclude topic-memory JSON artifacts from search ranking
- keep clean Markdown cards as the searchable memory surface

## Live files changed

- `scripts/local_corpus_search.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Proof tests

- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/local_corpus_search.py '上次 tlt inflation surprise term premium 教训'`
- `python3 scripts/local_corpus_search.py '上次 spy death cross risk 教训'`
- `python3 scripts/local_corpus_search.py '这个方法怎么复用到量化'`
- `python3 -m py_compile scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `corepack pnpm exec oxlint scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`

## Live evidence

- `上次 tlt inflation surprise term premium 教训`
  - no legacy `.json` result now appears in the returned top results
- `上次 spy death cross risk 教训`
  - no legacy `.json` result now appears in the returned top results

## What is now prevented

- stale topic-memory JSON artifacts competing with clean semantic / procedural / episodic cards
- retrieval surfacing storage residue instead of the intended memory interface

## Residual

- this only removes legacy topic-memory JSON from search results
- it does not delete every historical JSON file from disk
- if later we want a cleaner artifact set, that would be a separate storage-hygiene task, not a retrieval patch
