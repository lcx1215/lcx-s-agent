# Memory Type, Intent Routing, and Freshness Gate

## Summary

- target: `Projects/openclaw`
- scope: bounded live hardening for the learning-memory retrieval seam
- intent: make Lobster retrieval feel less like a flat archive and more like layered recall

## Exact failure mode

The live retrieval seam was still missing three practical cognition layers:

1. memory-type split
   - topic-memory cards existed, but retrieval did not distinguish semantic vs procedural memory

2. intent-trigger routing
   - retrieval did not explicitly distinguish:
     - semantic recall
     - procedural transfer
     - runtime market read
     - fresh runtime market read

3. runtime freshness gate
   - a query like `今天大盘如何` could still prefer durable topic memory over the newest runtime market artifact

## Smallest safe patch

### topic memory

- `scripts/topic_memory.py`
  - added `memory_type`
    - `semantic` for generic/global concept cards
    - `procedural` for ETF/risk method cards
  - included `memory_type` in rendered topic cards

- `scripts/topic_memory_status.py`
  - added `memory_type_counts`

### retrieval

- `scripts/local_corpus_search.py`
  - added query-intent classification:
    - `semantic_recall`
    - `procedural_transfer`
    - `runtime_market`
    - `runtime_market_fresh`
  - added source typing:
    - topic-memory cards => semantic or procedural
    - technical/fundamental/maintenance reports => episodic/runtime
  - added freshness scoring for dated runtime artifacts
  - added Chinese market/query hints and direct-topic hints

## Live files changed

- `scripts/topic_memory.py`
- `scripts/topic_memory_status.py`
- `scripts/local_corpus_search.py`
- `scripts/test_topic_memory_lane_scope.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Validation

- `python3 scripts/test_topic_memory_lane_scope.py`
- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/topic_memory.py rebuild`
- `python3 scripts/topic_memory_status.py`
- `python3 scripts/local_corpus_search.py 'market regime drivers'`
- `python3 scripts/local_corpus_search.py '市场状态'`
- `python3 scripts/local_corpus_search.py '今天大盘如何'`
- `python3 scripts/local_corpus_search.py '纳指和久期风险'`
- `python3 scripts/local_corpus_search.py '这个方法怎么复用到量化'`
- `corepack pnpm exec oxlint scripts/topic_memory.py scripts/topic_memory_status.py scripts/local_corpus_search.py scripts/test_topic_memory_lane_scope.py scripts/test_local_corpus_search_lane_preference.py`

## Result

- `市场状态`
  - now returns `knowledge/topic_memory/market_regime.md` first
- `今天大盘如何`
  - now returns the freshest runtime market artifact:
    - `knowledge/technical_daily/2026-03-27_technical_daily.md`
- `纳指和久期风险`
  - now routes to procedural market cards first:
    - `qqq_ai_capex_and_duration_sensitivity`
    - `tlt_inflation_surprise_and_term_premium`
- topic-memory status now exposes semantic vs procedural counts

## Status

- `dev-fixed: yes`
- `live-fixed: yes`

## Residuals

- retrieval still is not a full semantic language-understanding subsystem
- some legacy JSON artifacts under `knowledge/topic_memory/` can still appear lower in search results if the query directly overlaps them
- that is a separate retrieval-hygiene debt, not a failure of the three new routing layers
