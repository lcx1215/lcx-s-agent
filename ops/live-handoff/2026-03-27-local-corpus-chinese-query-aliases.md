# Local Corpus Chinese Query Aliases

## Summary

- target: `Projects/openclaw`
- scope: bounded live hardening for natural Chinese retrieval queries
- intent: make Chinese control-room style questions hit the right topic-memory cards instead of falling back to arbitrary high-weight cards

## Exact failure mode

- `scripts/local_corpus_search.py` tokenized only ASCII query terms.
- Queries like:
  - `市场状态`
  - `大盘怎么看`
  - `纳指和久期风险`
  produced either:
  - no expanded tokens
  - or weak broad-market matches
- That caused retrieval to fall back to whichever topic card already had the highest file/metadata weight.

## Why this was dangerous

- Chinese natural-language control-room usage would feel much dumber than the English path.
- The memory system could already hold the right learned topic cards, but retrieval still failed to surface them.

## Smallest safe patch

- added a narrow Chinese phrase hint layer in `scripts/local_corpus_search.py`
- added direct-topic hints for phrases like:
  - `市场状态`
  - `市场节奏`
  - `市场结构`
- no retrieval architecture rewrite, no cache changes, no provider changes

## Live files changed

- `scripts/local_corpus_search.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Validation

- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/local_corpus_search.py '市场状态'`
- `python3 scripts/local_corpus_search.py '大盘怎么看'`
- `python3 scripts/local_corpus_search.py '纳指和久期风险'`
- `corepack pnpm exec oxlint scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`

## Result

- `市场状态` now returns `knowledge/topic_memory/market_regime.md` first
- `大盘怎么看` now returns `knowledge/topic_memory/spy_death_cross_risk.md` first
- `纳指和久期风险` now returns:
  - `knowledge/topic_memory/qqq_ai_capex_and_duration_sensitivity.md`
  - `knowledge/topic_memory/tlt_inflation_surprise_and_term_premium.md`
  ahead of older broad-market reports

## Status

- `dev-fixed: yes`
- `live-fixed: yes`

## Residuals

- this improves the Chinese alias layer for a narrow set of high-value market queries
- broader Chinese semantic retrieval still is not a full language-understanding subsystem
