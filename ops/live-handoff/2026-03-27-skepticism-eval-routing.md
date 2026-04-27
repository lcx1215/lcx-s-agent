# Skepticism Eval Routing

## Status

- `dev-fixed`: yes
- `live-fixed`: yes

## Exact failure mode

- live retrieval already supported:
  - `study_bootstrap`
  - `procedural_transfer`
  - `counterfactual_recall`
  - `rehearsal_recall`
- but natural evaluation prompts like:
  - `这个策略靠谱吗`
  - `这个回测靠谱吗`
  - `回测是不是过拟合`
  were still being treated like generic transfer or generic search
- this meant Lobster still recalled methods, but did not have a dedicated skepticism-first seam for "should I trust/adopt this?"

## Why this was dangerous

- it kept the brain too promotion-friendly
- the user’s doctrine is explicitly skepticism-first:
  - red-team
  - falsify
  - reject weak or overfit edges before promotion
- without a dedicated skepticism seam, natural evaluation prompts still felt like ordinary retrieval instead of:
  - "first check fragility, failure mode, and trustworthiness"

## Smallest safe patch

- keep existing memory layers unchanged
- do not add a new memory type
- only add one bounded retrieval intent:
  - `skepticism_eval`
- route natural skepticism prompts to prefer:
  - procedural cards with `common_failure`
  - invalidation-bearing cards
  - episodic lesson cards
  - and the generic method card when the question is broad and under-specified
- keep existing:
  - `study_bootstrap`
  - `counterfactual_recall`
  - `rehearsal_recall`
  intact

## Live files changed

- `scripts/local_corpus_search.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Proof tests

- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 -m py_compile scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `corepack pnpm exec oxlint scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/local_corpus_search.py '这个策略靠谱吗'`
- `python3 scripts/local_corpus_search.py '这个回测靠谱吗'`
- `python3 scripts/local_corpus_search.py '回测是不是过拟合'`

## Live evidence

- `这个策略靠谱吗`
  - intent:
    - `skepticism_eval`
  - top result:
    - `knowledge/topic_memory/market_regime.md`
- `这个回测靠谱吗`
  - intent:
    - `skepticism_eval`
  - top result:
    - `knowledge/topic_memory/market_regime.md`
- `回测是不是过拟合`
  - intent:
    - `skepticism_eval`
  - live top result currently lands on an invalidation-heavy procedural card rather than falling back to generic search

## What is now prevented

- natural trust / fragility / overfit questions being treated like ordinary method-transfer lookups
- bottom-layer recall sounding like it knows how to apply a method without first asking whether the method is trustworthy enough to adopt

## Residual

- this is bounded skepticism routing, not a full strategy-audit engine
- `回测 / 过拟合` ranking still depends on current card quality and existing invalidation/common-failure wording
