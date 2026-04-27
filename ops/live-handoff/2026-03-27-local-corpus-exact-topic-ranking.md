# Local Corpus Exact Topic Ranking

## Summary

- target: `Projects/openclaw`
- scope: bounded live hardening for local corpus retrieval ranking
- intent: make direct topic-memory cards outrank older broad-market reports when the query directly matches the topic

## Exact failure mode

- After generic topic-memory cleanup, `market_regime` was clean and available.
- But `scripts/local_corpus_search.py` could still rank:
  - `knowledge/technical_daily/*.md`
  - `knowledge/fundamental_research/*.md`
  above the exact `knowledge/topic_memory/market_regime.md` card.
- The reason was that alias expansion and broad-market keyword overlap still outweighed direct topic-card identity.

## Why this was dangerous

- The memory system could hold the right distilled topic card, yet retrieval would still prefer broader older reports.
- That weakens the practical value of durable topic memory and makes recall feel less like default learned skill reuse.

## Smallest safe patch

- added a narrow `exact_topic_rank(...)` bonus in `scripts/local_corpus_search.py`
- the bonus uses:
  - stopword-trimmed query focus tokens
  - exact topic-stem / topic-header matching
  - a small topic-memory-file preference
- no architecture rewrite, no cache layer change, no new retrieval provider

## Live files changed

- `scripts/local_corpus_search.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Validation

- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/local_corpus_search.py 'market regime drivers'`
- `corepack pnpm exec oxlint scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`

## Result

- `market_regime.md` now ranks above older broad-market reports for `market regime drivers`
- lane-specific topic cards still outrank global cards when `LOBSTER_LANE_KEY` is set

## Status

- `dev-fixed: yes`
- `live-fixed: yes`

## Residuals

- this improves exact-topic ranking, not the whole retrieval quality stack
- broader semantic ranking issues may still exist for fuzzier or multi-topic queries
