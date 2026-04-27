# Procedural Transfer Real-Domain Hints

## Status

- `dev-fixed`: yes
- `live-fixed`: yes

## Exact failure mode

- live `procedural_transfer` had already become stable for:
  - `量化`
  - `风险控制`
  - `代码系统`
- but more realistic operator queries were still falling back to generic procedural ranking:
  - `这个方法怎么复用到财报阅读`
  - `这个方法怎么复用到策略审计`
  - `这个方法怎么复用到系统架构`
  - `回测是不是过拟合`
- this was especially wrong for `回测 / 过拟合`, which used to fall back to broad semantic recall like `market_regime`

## Why this was dangerous

- it made the "brain-like" transfer path look better than it really was
- the system could appear to support method reuse, while still failing on real Chinese operator phrasing
- it also let skepticism-heavy questions like `回测是不是过拟合` drift back into generic market memory instead of skeptical procedural recall

## Smallest safe patch

- keep the current:
  - memory-type split
  - intent routing
  - freshness gate
  - lane dedupe
  - procedural-transfer weighting
- only extend:
  - `PROCEDURAL_HINTS`
  - target-domain phrases for:
    - earnings / financial-reading
    - strategy audit / backtest skepticism
    - system architecture / agent-style method transfer
- also allow semantic cards to compete in `procedural_transfer` when they expose:
  - `transfer_surface`
  - `default_method`
  and the query is clearly about system-style reuse

## Live files changed

- `scripts/local_corpus_search.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Proof tests

- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 -m py_compile scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `corepack pnpm exec oxlint scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/local_corpus_search.py '这个方法怎么复用到财报阅读'`
- `python3 scripts/local_corpus_search.py '这个方法怎么复用到策略审计'`
- `python3 scripts/local_corpus_search.py '这个方法怎么复用到系统架构'`
- `python3 scripts/local_corpus_search.py '回测是不是过拟合'`

## Live evidence

- `这个方法怎么复用到财报阅读`
  - top result:
    - `knowledge/topic_memory/iwm_rotation_exhaustion_risk.md`
- `这个方法怎么复用到策略审计`
  - top result:
    - `knowledge/topic_memory/iwm_rotation_exhaustion_risk.md`
- `这个方法怎么复用到系统架构`
  - top result:
    - `knowledge/topic_memory/market_regime.md`
- `回测是不是过拟合`
  - now classifies as:
    - `procedural_transfer`
  - top result:
    - `knowledge/topic_memory/iwm_rotation_exhaustion_risk.md`

## What is now prevented

- real Chinese operator questions for transfer and skepticism falling back into generic recall
- `回测 / 过拟合` drifting to broad semantic market memory
- system-architecture reuse questions failing to surface the more general reusable method card

## Residual

- this is still bounded retrieval guidance, not a dedicated:
  - earnings-reading branch
  - strategy-audit branch
  - architecture-learning branch
- it improves how current memory gets reused for those domains
- it does not claim those domains are fully modeled end-to-end
