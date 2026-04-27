# Learning Brain-Trace Artifact Propagation

## Summary

Live learning artifacts no longer stop at `provider_used.retrieval = cheap_retrieval_router` or `local_corpus_hard_gated`.

The learner and night batch now preserve bounded `brain_trace_summary` metadata so downstream state and artifacts can tell which installed brain seam actually drove retrieval.

## Exact failure mode

- `scripts/cheap_retrieval_router.py` already exposed:
  - `brain_trace.intent`
  - `brain_trace.expanded_tokens`
  - per-item `brain_type`
- but `scripts/run_local_batch_learner.py` dropped that metadata when writing:
  - `knowledge/learn/*.sources.json`
  - `branches/learn/learn_state.json`
  - `branches/learn/lanes/*/learn_state.json`
- and `scripts/run_nightly_learning_batch.py` still only recorded:
  - `provider_used.retrieval = cheap_retrieval_router`
    without durable brain-trace rollup.

This meant:

- the system was using the brain,
- but durable learning artifacts still looked like ordinary local retrieval.

## Patch

### Live files changed

- `scripts/run_local_batch_learner.py`
- `scripts/run_nightly_learning_batch.py`
- `scripts/test_learning_bookkeeping.py`
- `scripts/test_nightly_learning_batch_brain_trace.py`

### Behavior change

`run_local_batch_learner.py` now writes:

- per-query item `brain_type`
- per-query `brain_trace`
  - `intent`
  - `expanded_tokens`
  - `item_brain_types`
- top-level `brain_trace_summary`
  into:
  - `knowledge/learn/*.sources.json`
  - `branches/learn/learn_state.json`
  - `branches/learn/lanes/*/learn_state.json`

`run_nightly_learning_batch.py` now:

- reads each completed learn run’s `brain_trace_summary`
- propagates it into:
  - `knowledge/learn_batch/*.sources.json`
  - `branches/learn/night_batch_state.json`

## Proof tests

- `python3 /Users/liuchengxu/Projects/openclaw/scripts/test_learning_bookkeeping.py`
- `python3 /Users/liuchengxu/Projects/openclaw/scripts/test_nightly_learning_batch_brain_trace.py`
- `python3 -m py_compile /Users/liuchengxu/Projects/openclaw/scripts/run_local_batch_learner.py /Users/liuchengxu/Projects/openclaw/scripts/run_nightly_learning_batch.py /Users/liuchengxu/Projects/openclaw/scripts/test_learning_bookkeeping.py /Users/liuchengxu/Projects/openclaw/scripts/test_nightly_learning_batch_brain_trace.py`
- `corepack pnpm exec oxlint /Users/liuchengxu/Projects/openclaw/scripts/run_local_batch_learner.py /Users/liuchengxu/Projects/openclaw/scripts/run_nightly_learning_batch.py /Users/liuchengxu/Projects/openclaw/scripts/test_learning_bookkeeping.py /Users/liuchengxu/Projects/openclaw/scripts/test_nightly_learning_batch_brain_trace.py`
- `python3 /Users/liuchengxu/Projects/openclaw/scripts/run_local_batch_learner.py 'market regime'`
- `python3 /Users/liuchengxu/Projects/openclaw/scripts/run_nightly_learning_batch.py 1`

## Current live evidence

- `knowledge/learn/2026-03-28_market_regime__lane_global.sources.json`
  now contains:
  - per-item `brain_type`
  - per-query `brain_trace`
  - top-level `brain_trace_summary`
- `branches/learn/learn_state.json`
  now contains:
  - `brain_trace_summary`
- `knowledge/learn_batch/2026-03-27_night_batch.sources.json`
  now contains:
  - per-run `brain_trace_summary`
  - top-level batch `brain_trace_summary`
- `branches/learn/night_batch_state.json`
  now contains:
  - batch `brain_trace_summary`

## Status

- `dev-fixed: yes`
- `live-fixed: yes`

## Why this matters

This is the first durable artifact propagation step where:

- the installed brain is not only used at retrieval time,
- but also leaves a persistent trace inside learning artifacts and learning state.

That makes it possible for later branches and audits to consume:

- what kind of memory route was used,
- what kind of memory surface won,
- and whether a learning run was semantic, procedural, episodic, or runtime-heavy in practice.
