# Study Bootstrap Natural Prompts

## Status

- `dev-fixed`: yes
- `live-fixed`: yes

## Exact failure mode

- live retrieval already supported:
  - `study_bootstrap`
  - `procedural_transfer`
  - `rehearsal_recall`
- but more natural study/evaluation prompts like:
  - `这篇论文该抓什么`
  - `这个架构值不值得学`
  - `这个财报重点看什么`
  - `这个方法值不值得继续练`
    were still falling back to older intent surfaces
- this meant the brain still felt smart only when the operator used cleaner prompt forms like:
  - `怎么学`
  - `怎么看`

## Why this was dangerous

- it kept the bottom-layer brain contract too narrow
- default study/research recall should not depend on operator prompt hygiene this much
- without this hardening, Lobster still felt more like:
  - a retrieval tool with narrow incantations
    rather than:
  - a research brain that can catch natural study/evaluation prompts

## Smallest safe patch

- keep existing memory types and ranking layers unchanged
- do not add a new memory type
- only widen the current natural-language intent hints for:
  - `study_bootstrap`
  - `rehearsal_recall`
- add bounded phrase support for:
  - `重点看什么`
  - `该抓什么`
  - `值不值得学`
  - `值不值得继续练`
- add one abstract-study anchor so:
  - `论文 / research / 架构 / agent`
    default back to the generic method card instead of drifting into whichever procedural card happens to be highest-weight

## Live files changed

- `scripts/local_corpus_search.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Proof tests

- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 -m py_compile scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `corepack pnpm exec oxlint scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/local_corpus_search.py '这篇论文该抓什么'`
- `python3 scripts/local_corpus_search.py '这个架构值不值得学'`
- `python3 scripts/local_corpus_search.py '这个财报重点看什么'`
- `python3 scripts/local_corpus_search.py '这个方法值不值得继续练'`

## Live evidence

- `这篇论文该抓什么`
  - intent:
    - `study_bootstrap`
  - top result:
    - `knowledge/topic_memory/market_regime.md`
- `这个架构值不值得学`
  - intent:
    - `study_bootstrap`
  - top result:
    - `knowledge/topic_memory/market_regime.md`
- `这个财报重点看什么`
  - intent:
    - `study_bootstrap`
  - top result:
    - `knowledge/topic_memory/iwm_rotation_exhaustion_risk.md`
- `这个方法值不值得继续练`
  - intent:
    - `rehearsal_recall`
  - top result:
    - `knowledge/topic_memory/market_regime.md`

## What is now prevented

- natural study/evaluation prompts falling back to older, narrower intent surfaces
- abstract study questions like `论文怎么学 / 这篇论文该抓什么` drifting into arbitrary market-side procedural cards
- practice-worthiness questions continuing to look like generic method transfer

## Residual

- this is still bounded retrieval hardening, not a full autonomous study planner or reinforcement scheduler
- domain specificity still depends on current topic-card quality
