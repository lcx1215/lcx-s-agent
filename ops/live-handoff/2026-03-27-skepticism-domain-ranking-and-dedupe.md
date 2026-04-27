# Skepticism Domain Ranking And Dedupe

## Status

- `dev-fixed`: yes
- `live-fixed`: yes

## Exact failure mode

- `skepticism_eval` already existed in live retrieval
- but:
  - `回测 / 过拟合 / 策略审计`
    still depended too much on whichever procedural card happened to carry the strongest generic:
    - `common_failure`
    - `invalidation`
    - `fragile`
      wording
- and once an audit-flavored family won, retrieval could still return several near-duplicate `IWM` cards in the same result set

## Why this was dangerous

- this made skepticism look more accidental than systematic
- a skepticism seam that cannot rank audit-style domains or suppress same-family duplicates is still too much like generic retrieval
- for a skepticism-first brain, the operator should see:
  - one best audit-oriented card
  - not a pile of near-identical family variants

## Smallest safe patch

- keep `skepticism_eval` as the current bounded seam
- do not add a new memory type
- add bounded skepticism-specific domain weighting for:
  - `回测`
  - `过拟合`
  - `策略审计`
- prefer cards whose retained skill memory already carries:
  - `audit`
  - `review`
  - `common_failure`
  - `discipline`
- reuse method-family dedupe for `skepticism_eval`, so same-family procedural cards do not all survive ranking

## Live files changed

- `scripts/local_corpus_search.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Proof tests

- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 -m py_compile scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `corepack pnpm exec oxlint scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/local_corpus_search.py '回测是不是过拟合'`
- `python3 scripts/local_corpus_search.py '策略审计靠谱吗'`
- `python3 scripts/local_corpus_search.py '这个回测靠谱吗'`

## Live evidence

- `回测是不是过拟合`
  - intent:
    - `skepticism_eval`
  - top result:
    - `knowledge/topic_memory/iwm_rotation_exhaustion_risk.md`
- `策略审计靠谱吗`
  - intent:
    - `skepticism_eval`
  - top result:
    - `knowledge/topic_memory/iwm_rotation_exhaustion_risk.md`
  - same-family near-duplicates are now suppressed
- `这个回测靠谱吗`
  - intent:
    - `skepticism_eval`
  - broad query still defaults to the generic method card first, while keeping the best audit-style procedural card next

## What is now prevented

- `skepticism_eval` depending mostly on generic fragility wording
- audit / overfit / strategy-audit prompts drifting back toward arbitrary procedural winners
- same-family `IWM` audit cards flooding a single skepticism result set

## Residual

- this is still bounded skepticism routing, not a full strategy-audit branch
- broad trust questions like `这个策略靠谱吗` still intentionally anchor to the generic method card first when the query is underspecified
