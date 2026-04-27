# Intent-Aware Alias Expansion

## Status

- `dev-fixed`: yes
- `live-fixed`: yes

## Exact failure mode

- `local_corpus_search.py` used the same alias expansion policy for every query intent
- this meant semantic / episodic recall queries like:
  - `上次 market regime 教训`
  - `last time market regime lesson`
  could still expand into broad asset aliases such as:
  - `spy`
  - `death cross`
  - `broad market`
- top-1 could be correct, but the retrieval surface still looked more like broad search than topic recall

## Why this was dangerous

- it weakens the feeling of a brain-like recall path
- instead of "recall this topic / this lesson", the system still behaved like "search this market family"
- this adds cross-topic noise even after semantic / episodic cards are already in place

## Smallest safe patch

- keep alias expansion for:
  - `procedural_transfer`
  - `runtime_market`
  - `runtime_market_fresh`
- disable broad alias expansion for:
  - `semantic_recall`
  - `episodic_recall`
- still keep direct CJK hints such as:
  - `市场状态`
  - `纳指`
  - `久期`

## Live files changed

- `scripts/local_corpus_search.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Proof tests

- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/local_corpus_search.py '上次 market regime 教训'`
- `python3 scripts/local_corpus_search.py 'last time market regime lesson'`
- `python3 scripts/local_corpus_search.py '市场状态'`
- `python3 -m py_compile scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `corepack pnpm exec oxlint scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`

## Live evidence

- `上次 market regime 教训`
  - `intent: episodic_recall`
  - `expanded_tokens: ["market", "regime"]`
- `last time market regime lesson`
  - `intent: episodic_recall`
  - `expanded_tokens: ["last", "time", "market", "regime", "lesson"]`
- `市场状态`
  - still keeps the expected semantic topic path

## What is now prevented

- semantic / episodic recall being inflated into broad alias search
- correct top-1 recall with noisy cross-topic expansion underneath it

## Residual

- this does not eliminate every lower-ranked cross-topic result
- it only makes recall intent use a narrower, more brain-like token surface
