# Procedural Transfer Specificity

## Status

- `dev-fixed`: yes
- `live-fixed`: yes

## Exact failure mode

- `procedural_transfer` was already able to separate broad method-like queries from:
  - semantic recall
  - episodic recall
  - runtime market reads
- but queries like:
  - `这个方法怎么复用到量化`
  - `这个方法怎么复用到风险控制`
  - `这个方法怎么复用到代码系统`
    were still too coarse
- before this patch, the live result surface could flatten into near-ties across multiple procedural cards
- this made method transfer feel more like a generic skill search than a targeted reuse path

## Why this was dangerous

- it weakens the new "brain-like" path exactly where transfer is supposed to matter
- the system could look like it knows how to reuse a method, while still returning whichever procedural card happened to tie highest
- that is good enough to demo, but not good enough to trust as a stable transfer seam

## Smallest safe patch

- keep the existing:
  - memory-type split
  - intent routing
  - freshness gate
  - lane dedupe
- only tighten `procedural_transfer` ranking
- add weighted target-domain hints for:
  - `量化` / `quant`
  - `风险控制` / `风控` / `risk control`
  - `代码系统` / `code system`
- keep the patch bounded to ranking and regression coverage

## Live files changed

- `scripts/local_corpus_search.py`
- `scripts/test_local_corpus_search_lane_preference.py`

## Proof tests

- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 -m py_compile scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `corepack pnpm exec oxlint scripts/local_corpus_search.py scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/local_corpus_search.py '这个方法怎么复用到量化'`
- `python3 scripts/local_corpus_search.py '这个方法怎么复用到风险控制'`
- `python3 scripts/local_corpus_search.py '这个方法怎么复用到代码系统'`

## Live evidence

- `这个方法怎么复用到量化`
  - top result:
    - `knowledge/topic_memory/tlt_inflation_surprise_and_term_premium.md`
- `这个方法怎么复用到风险控制`
  - top result:
    - `knowledge/topic_memory/spy_death_cross_risk.md`
- `这个方法怎么复用到代码系统`
  - top result:
    - `knowledge/topic_memory/spy_death_cross_risk.md`

## What is now prevented

- procedural-transfer recall collapsing into broad near-ties across unrelated method cards
- transfer queries feeling like generic memory search instead of scoped method reuse

## Residual

- this improves target-domain specificity
- it does not yet make procedural transfer fully semantic
- more ambiguous method-transfer questions may still need future curation if the user wants finer distinctions than:
  - quant
  - risk control
  - code-system reuse
