# Topic Memory Generic Quality Gate

## Summary

- target: `Projects/openclaw`
- scope: bounded live hardening for generic topic-memory artifacts
- intent: keep wrapper-noise generic reports out of global topic memory and out of retrieval

## Exact failure mode

- `scripts/topic_memory.py` could still distill low-value generic reports into global topic cards.
- The concrete bad example was `portable_root_smoke_topic`.
- Even after stronger generic line cleanup, rebuild could still leave historical low-quality topic cards around long enough to pollute `knowledge/topic_memory` and retrieval.

## Why this was dangerous

- It made the learning system look more knowledgeable than it really was.
- Low-value wrapper residue could survive as `reference-only` memory and still show up in retrieval.
- This weakens the trust boundary between:
  - real learned memory
  - historical artifact noise

## Smallest safe patch

- strengthened generic memory junk detection in `scripts/topic_memory.py`
- added a generic-card quality gate:
  - if a generic card has no usable conclusion, driver, or key point after cleanup, skip it
- rebuild now removes stale topic-card markdown files that are no longer present in the rebuilt index
- added a regression test covering the noisy `portable_root_smoke_topic` pattern

## Live files changed

- `scripts/topic_memory.py`
- `scripts/test_topic_memory_lane_scope.py`

## Validation

- `python3 scripts/test_topic_memory_lane_scope.py`
- `python3 -m py_compile scripts/topic_memory.py scripts/test_topic_memory_lane_scope.py`
- `python3 scripts/topic_memory.py rebuild`
- `python3 scripts/topic_memory_status.py`
- `python3 scripts/local_corpus_search.py 'portable root smoke topic'`
- `python3 scripts/local_corpus_search.py 'market regime drivers'`
- `corepack pnpm exec oxlint scripts/topic_memory.py scripts/test_topic_memory_lane_scope.py`

## Result

- `portable_root_smoke_topic` no longer appears in:
  - `knowledge/topic_memory/topic_memory_index.json`
  - `knowledge/topic_memory/*.md`
- retrieval no longer returns the deleted stale card file
- `market regime` and the stronger ETF-linked topic cards still rebuild and retrieve normally

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Why not `live-fixed`

- this closes one verified quality hole in live topic-memory hygiene
- it does not complete full lane workspace propagation
- it does not by itself complete fresh real-entry Feishu acceptance for the whole learning-memory architecture

## Residuals

- retrieval can still rank old broad-market reports ahead of generic `market regime` because the global corpus still contains older technical/fundamental reports with strong keyword overlap
- that is a separate relevance / retrieval-ranking problem, not this stale-card cleanup bug
