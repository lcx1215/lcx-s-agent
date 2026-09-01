# Episodic Memory Quality Gate

## Status

- `dev-fixed`: yes
- `live-fixed`: yes

## Exact failure mode

- the new episodic layer was live and queryable
- but several real episode cards were still learning the wrong thing:
  - `Fundamental Research Report - 2026-03-14 ## 1.`
  - `2026-03-13_technical_daily.sources.json**`
  - serialized JSON/news payload fragments
- this meant Lobster could "recall a past case" but not recall a useful lesson from it

## Why this was dangerous

- it weakens the value of episodic recall exactly where the layer is supposed to matter:
  - prior lesson
  - prior mistake
  - prior case
- it would turn "brain-like case recall" into noisy wrapper recall

## Smallest safe patch

- keep the episodic layer
- do not redesign learning
- only harden episode extraction:
  - reject report-title wrapper lines
  - reject source-path / file-name lines
  - reject serialized JSON/news payload blobs
  - if no clean lesson survives, fall back to a clean anchor instead of keeping garbage

## Live files changed

- `scripts/topic_memory.py`
- `scripts/test_topic_memory_lane_scope.py`

## Proof tests

- `python3 scripts/test_topic_memory_lane_scope.py`
- `python3 -m py_compile scripts/topic_memory.py scripts/test_topic_memory_lane_scope.py`
- `python3 scripts/topic_memory.py rebuild`
- `python3 scripts/local_corpus_search.py '上次 iwm rotation exhaustion risk 教训'`
- `python3 scripts/local_corpus_search.py '上次 qqq ai capex duration 教训'`
- `python3 scripts/local_corpus_search.py '上次 tlt inflation surprise term premium 教训'`
- `corepack pnpm exec oxlint scripts/topic_memory.py scripts/test_topic_memory_lane_scope.py`

## Live evidence

- `上次 iwm rotation exhaustion risk 教训`
  - episode lesson now resolves to:
    - `institutional flows`
- `上次 qqq ai capex duration 教训`
  - episode lesson now resolves to:
    - `duration sensitivity`
- `上次 tlt inflation surprise term premium 教训`
  - no longer leaks a serialized JSON/source blob
  - now falls back to the clean anchor:
    - `TLT is dominated by inflation surprises and term-premium repricing.`

## What is now prevented

- episode cards recalling report wrapper titles instead of lessons
- episode cards leaking file-name/source-path noise
- episode cards leaking serialized JSON/news snippets into recall

## Residual

- some old `knowledge/topic_memory/*.json` legacy files can still appear in low-ranked retrieval results
- that is now a lower-priority retrieval-hygiene debt, not an episodic-memory extraction failure
