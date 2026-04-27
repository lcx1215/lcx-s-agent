# Learning Note Distillation Quality Hardening

## Summary

Harden live learner note distillation so local learning reports stop copying wrapper residue into retrieved notes and current conclusions.

## Exact Failure Mode

- `scripts/run_local_batch_learner.py` was still letting wrapper-ish lines survive note distillation:
  - `Fundamental Research Report - ...`
  - `Topic Card - ...`
  - `Snapshot - topic_id: ...`
  - generic asset label lines like `SPY: Mixed regime.`
- As a result, `knowledge/learn/*` reports could look lane-safe and bookkeeping-safe while still learning low-value wrapper text.

## Why Dangerous

- This weakens the "open self-learning" path at the content layer.
- Topic memory and later recall can inherit wrapper residue instead of reusable judgments.
- It creates the illusion of self-learning while actually preserving low-value scaffolding.

## Smallest Safe Patch

- Tighten `clean_note_line(...)` and `is_bad_note_line(...)` in the live learner only.
- Strip known section wrappers like `Drivers -`, `Risk Flags -`, and `Current Conclusion -` while keeping the useful sentence body.
- Reject known metadata/path wrappers like:
  - report titles
  - dated topic-card titles
  - `Snapshot - topic_id: ...`
  - `Evidence Links - ...`
  - `Key Points - ...`
  - generic asset tag lines like `SPY: Mixed regime.`
- Keep queue / bookkeeping / lane-state / topic-memory architecture unchanged.

## Files Changed

- live:
  - `scripts/run_local_batch_learner.py`
  - `scripts/test_learning_note_distillation.py`

## Proof Tests

- `python3 scripts/test_learning_note_distillation.py`
- `python3 -m py_compile scripts/run_local_batch_learner.py scripts/test_learning_note_distillation.py`
- `LOBSTER_LANE_KEY='global' python3 scripts/run_local_batch_learner.py 'market regime'`

## Observed Behavior Change

After the patch, the global learning report for `market regime` now anchors on real lines such as:

- `Short-term broken with price below 200-day MA, though 50-day MA remains above 200-day.`
- `Long-term uptrend intact (+21% YoY) but facing slight dip in 2026 on AI capex concerns...`
- `AI capex cycle - cloud/software margins - duration sensitivity - domestic growth - credit conditions - term premium`

and no longer anchors the current conclusion on:

- `SPY: Mixed regime.`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Remaining Out Of Scope

- This does not make the learning system fully autonomous.
- This does not finish full lane workspace propagation.
- This does not solve source freshness or retrieval quality.
- This is a bounded content-quality hardening inside the current live learner seam.
