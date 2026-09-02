# Workflow-Style Natural Routing

## Status

- `dev-fixed`: yes
- `live-fixed`: yes

## Exact failure mode

- live retrieval had already learned several natural single-sentence seams:
  - `study_bootstrap`
  - `skepticism_eval`
  - `rehearsal_recall`
- but more realistic control-room task phrasing still fell back to older intents:
  - `读这篇论文给我重点和风险`
  - `先看这个财报，给我重点和风险`
  - `帮我判断这个策略值不值得继续跟`
  - `帮我看这个架构值不值得继续学`
- that meant the brain was still strongest on clean one-line prompts, not on task-like natural language

## Why this was dangerous

- real operators speak in task frames, not only in idealized prompts
- if Lobster only feels smart when the sentence is perfectly shaped, the bottom-layer brain contract is still too narrow
- this is exactly the kind of gap that makes a memory system look good in demos but weaker in daily use

## Smallest safe patch

- keep the current memory layers unchanged
- do not add a new memory type
- only widen natural-language routing hints for existing seams:
  - `study_bootstrap`
  - `skepticism_eval`
- add bounded coverage for workflow-style phrases such as:
  - `先看`
  - `先读`
  - `重点和风险`
  - `值不值得继续跟`
  - `值不值得继续学`
- keep ranking behavior unchanged beyond intent selection

## Live files changed

- `scripts/local_corpus_search.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Proof tests

- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 -m py_compile scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `corepack pnpm exec oxlint scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/local_corpus_search.py '读这篇论文给我重点和风险'`
- `python3 scripts/local_corpus_search.py '先看这个财报，给我重点和风险'`
- `python3 scripts/local_corpus_search.py '帮我判断这个策略值不值得继续跟'`
- `python3 scripts/local_corpus_search.py '帮我看这个架构值不值得继续学'`

## Live evidence

- `读这篇论文给我重点和风险`
  - intent:
    - `study_bootstrap`
  - top result:
    - `knowledge/topic_memory/market_regime.md`
- `先看这个财报，给我重点和风险`
  - intent:
    - `study_bootstrap`
  - top result:
    - `knowledge/topic_memory/iwm_rotation_exhaustion_risk.md`
- `帮我判断这个策略值不值得继续跟`
  - intent:
    - `skepticism_eval`
  - top result:
    - `knowledge/topic_memory/market_regime.md`
- `帮我看这个架构值不值得继续学`
  - intent:
    - `study_bootstrap`
  - top result:
    - `knowledge/topic_memory/market_regime.md`

## What is now prevented

- task-like natural prompts falling back to older generic intent paths
- a bottom-layer brain that only works well on cleaner operator phrasing

## Residual

- this still does not make Lobster a full autonomous planner
- it only widens the natural-language entry surface for the current bounded study / skepticism seams
