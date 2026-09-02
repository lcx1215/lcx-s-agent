# Learning Note Distillation Hardening

## Status

- `dev-fixed`: yes
- `live-fixed`: yes

## Exact failure mode

- `run_local_batch_learner.py` distilled notes directly from flattened markdown summaries returned by local corpus search.
- that let learner reports keep lines like:
  - `# Technical Daily Report - generated ## 1.`
  - `Market Regime Snapshot ...`
- the branch looked alive, but the learned notes were still half markdown shell and half real signal.

## Why dangerous

- Lobster can appear to “learn” while mostly recycling report scaffolding.
- this weakens self-learning quality and pollutes future memory artifacts.

## Smallest safe patch

- only harden the learner note distillation seam.
- normalize flattened markdown summaries before sentence extraction.
- reject heading/boilerplate fragments.
- keep the rest of the learner chain unchanged.

## Live files changed

- `scripts/run_local_batch_learner.py`
- `scripts/test_learning_note_distillation.py`

## Proof tests

- `python3 -m py_compile scripts/run_local_batch_learner.py scripts/test_learning_note_distillation.py`
- `python3 scripts/test_learning_note_distillation.py`
- rerun:
  - `LOBSTER_LANE_KEY='feishu:oc_9d23d6438a7ab45740ede9343a09cd2e' python3 scripts/run_local_batch_learner.py 'market regime'`
- inspect regenerated report:
  - top notes now begin with real regime sentences instead of markdown headings

## What is now prevented

- learner notes that are mostly `Technical Daily Report` heading residue
- current conclusion lines anchored on markdown shell instead of actual market-regime sentences

## Out of scope

- this does not fully solve report-quality issues in `technical_daily`
- one residual mixed line can still appear when flattened ETF bullets are merged into a single summary line
