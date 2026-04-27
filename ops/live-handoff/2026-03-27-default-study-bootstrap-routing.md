# Default Study Bootstrap Routing

## Status

- `dev-fixed`: yes
- `live-fixed`: yes

## Exact failure mode

- live retrieval already knew how to respond when the operator explicitly asked for:
  - method transfer
  - episodic lesson recall
  - counterfactual recall
  - rehearsal recall
- but more natural research questions like:
  - `财报怎么看`
  - `系统架构怎么学`
  - `论文怎么学`
  - `AI智能体架构怎么学`
    still had no dedicated default-study seam
- this meant the brain only became active when the operator used a more explicit recall frame

## Why this was dangerous

- it kept Lobster closer to:
  - a memory surface you must interrogate correctly
- instead of:
  - a research brain that brings the right memory scaffold in by default when the task is clearly a study / reading / architecture-learning task
- this is exactly the kind of gap that makes the system feel smart only after prompting discipline, not by default

## Smallest safe patch

- keep existing memory layers unchanged:
  - `semantic`
  - `procedural`
  - `episodic`
  - runtime fresh artifacts
- do not add a new memory type
- only add one bounded new retrieval intent:
  - `study_bootstrap`
- route natural study-style queries to prefer:
  - procedural cards with `trigger_surface`, `default_method`, and `transfer_surface`
  - generic semantic method cards when the question is broad and architecture-like
- keep market freshness routing untouched

## Live files changed

- `scripts/local_corpus_search.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Proof tests

- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 -m py_compile scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `corepack pnpm exec oxlint scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/local_corpus_search.py '财报怎么看'`
- `python3 scripts/local_corpus_search.py '系统架构怎么学'`
- `python3 scripts/local_corpus_search.py '论文怎么学'`
- `python3 scripts/local_corpus_search.py 'AI智能体架构怎么学'`

## Live evidence

- `财报怎么看`
  - intent:
    - `study_bootstrap`
  - top result:
    - `knowledge/topic_memory/iwm_rotation_exhaustion_risk.md`
- `系统架构怎么学`
  - intent:
    - `study_bootstrap`
  - top result:
    - `knowledge/topic_memory/market_regime.md`
- `论文怎么学`
  - intent:
    - `study_bootstrap`
  - top result:
    - `knowledge/topic_memory/market_regime.md`
- `AI智能体架构怎么学`
  - intent:
    - `study_bootstrap`
  - top result:
    - `knowledge/topic_memory/market_regime.md`

## What is now prevented

- natural study / reading / architecture-learning questions falling back to generic search behavior
- a brain that only feels active when the user explicitly asks for:
  - transfer
  - lesson
  - invalidation
  - rehearsal
- system-learning queries being forced into explicit method-transfer phrasing just to get the right memory scaffold

## Residual

- this is a bounded default-call seam, not a full autonomous study planner
- it still depends on current topic-card quality and transfer-surface quality
