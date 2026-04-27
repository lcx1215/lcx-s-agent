# System-Learning Query Decontamination

## Status

- `dev-fixed`: yes
- `live-fixed`: yes

## Exact failure mode

- system-style learning questions like:
  - `AI智能体架构怎么学`
  - `这个方法怎么复用到AI智能体`
- were being polluted by market-side `AI` matches
- the practical effect was:
  - `QQQ / AI-capex` procedural memory could outrank the more general reusable method card
- this happened even after broad alias expansion had already been tightened, because the raw `ai` token itself still rewarded the market card

## Why this was dangerous

- it made "learn other agents / architecture" queries look like market recall
- that is exactly the kind of cross-domain pollution that makes the system feel less like a brain and more like a keyword bucket

## Smallest safe patch

- keep all existing retrieval layers
- do not add new memory types
- only harden `procedural_transfer` for system-style reuse queries:
  - when the query clearly means:
    - `智能体`
    - `agent`
    - `架构`
    - `architecture`
  - do not keep the market-side `ai` token in the expanded token surface
  - add a stronger positive anchor for:
    - `system tasks`
    - `method pattern`
      inside reusable method cards

## Live files changed

- `scripts/local_corpus_search.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Proof tests

- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 -m py_compile scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `corepack pnpm exec oxlint scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/local_corpus_search.py 'AI智能体架构怎么学'`
- `python3 scripts/local_corpus_search.py '这个方法怎么复用到AI智能体'`

## Live evidence

- `AI智能体架构怎么学`
  - top result:
    - `knowledge/topic_memory/market_regime.md`
  - `expanded_tokens` no longer include market-side `qqq`
  - `expanded_tokens` no longer include bare `ai`
- `这个方法怎么复用到AI智能体`
  - top result:
    - `knowledge/topic_memory/market_regime.md`
  - no longer falls through to `qqq_ai_capex_and_duration_sensitivity.md`

## What is now prevented

- system-learning / agent-architecture questions being dragged into market `AI-capex` recall
- cross-domain memory contamination from one overloaded token: `ai`

## Residual

- this is bounded decontamination for system-style learning queries
- it does not claim the repo now has a full architecture-learning branch
