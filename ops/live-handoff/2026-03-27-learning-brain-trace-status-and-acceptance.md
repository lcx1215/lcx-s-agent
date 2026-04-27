# Learning Brain-Trace Status And Acceptance

## Summary

The learning seam now does not just write `brain_trace_summary`.

It is also consumed by:

- `scripts/nightly_learning_status.py`
- `scripts/learning_acceptance_probe.py`

and the updated acceptance gate has been re-verified through fresh live Feishu entry.

## Exact failure modes closed

### 1. Status panel did not really consume the new brain trace

- `scripts/nightly_learning_status.py` previously surfaced:
  - queue
  - learn_state
  - night_batch_state
- but it did not summarize the new `brain_trace_summary` fields.
- it also left old lane states looking empty even when the corresponding learn sources could already provide brain-trace context.

### 2. Learning acceptance could still be too loose and too blind

- `scripts/learning_acceptance_probe.py` previously accepted based on:
  - queue / execution
  - report freshness
  - topic-memory freshness / cleanliness
- but it did not require lane report sources to carry `brain_trace_summary`.
- it could also still mistake later status-surface outputs embedding old `learn_state.summary` for a real learn execution event.

## Patch

### Live files changed

- `scripts/nightly_learning_status.py`
- `scripts/learning_acceptance_probe.py`
- `scripts/test_nightly_learning_status.py`
- `scripts/test_learning_acceptance_probe.py`

### Behavior change

`nightly_learning_status.py` now exposes:

- `night_batch_brain_trace`
- `learn_brain_trace`
- lane `brain_trace_summary`

and will backfill lane brain trace from report-adjacent `*.sources.json` when lane state itself is older.

`learning_acceptance_probe.py` now requires:

- fresh lane-suffixed report
- fresh lane topic-memory card
- clean topic-memory recall content
- and fresh `report_brain_trace_ok`

It also no longer treats generic status-surface outputs that merely embed old `learn_state.summary` as proof of a real learn execution.

## Proof tests

- `python3 /Users/liuchengxu/Projects/openclaw/scripts/test_nightly_learning_status.py`
- `python3 /Users/liuchengxu/Projects/openclaw/scripts/test_learning_acceptance_probe.py`
- `python3 -m py_compile /Users/liuchengxu/Projects/openclaw/scripts/nightly_learning_status.py /Users/liuchengxu/Projects/openclaw/scripts/learning_acceptance_probe.py /Users/liuchengxu/Projects/openclaw/scripts/test_nightly_learning_status.py /Users/liuchengxu/Projects/openclaw/scripts/test_learning_acceptance_probe.py`
- `corepack pnpm exec oxlint /Users/liuchengxu/Projects/openclaw/scripts/nightly_learning_status.py /Users/liuchengxu/Projects/openclaw/scripts/learning_acceptance_probe.py /Users/liuchengxu/Projects/openclaw/scripts/test_nightly_learning_status.py /Users/liuchengxu/Projects/openclaw/scripts/test_learning_acceptance_probe.py`

## Real live verification

### Repair run

Refreshed the two real Feishu lanes directly:

- `LOBSTER_LANE_KEY='feishu:oc_3b1f572ef84301a8076b4d9a4555e05f' python3 /Users/liuchengxu/Projects/openclaw/scripts/run_local_batch_learner.py 'market regime'`
- `LOBSTER_LANE_KEY='feishu:oc_9d23d6438a7ab45740ede9343a09cd2e' python3 /Users/liuchengxu/Projects/openclaw/scripts/run_local_batch_learner.py 'market regime'`

This refreshed:

- lane learn reports
- lane learn sources
- lane learn states
- lane topic-memory

to the current brain-trace contract.

### Fresh Feishu entry

Sent fresh synthetic live Feishu events to the real proxy for both chats:

- `learn_topic market regime` -> `oc_3b1f572ef84301a8076b4d9a4555e05f`
- `learn_topic market regime` -> `oc_9d23d6438a7ab45740ede9343a09cd2e`

Observed in live logs:

- fresh `extracted_text='learn_topic market regime'`
- fresh `run_command code=0` with top-level `branch = learn_branch`
- fresh lane report paths
- fresh lane sources with `brain_trace_summary`
- fresh topic-memory timestamps
- successful Feishu replies to both chats

### Acceptance result

- `python3 /Users/liuchengxu/Projects/openclaw/scripts/learning_acceptance_probe.py`
  now returns:
  - `accepted: true`

## Status

- `dev-fixed: yes`
- `live-fixed: yes`

## Why this matters

This closes an important L4 gap:

- the learning seam now uses the installed brain,
- writes the brain trace durably,
- exposes it in the state surface,
- and passes fresh real-entry Feishu acceptance under the stricter brain-aware gate.
