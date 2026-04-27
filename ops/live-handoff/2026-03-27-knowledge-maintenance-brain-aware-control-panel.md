# Knowledge Maintenance Brain-Aware Control Panel

## Summary

The knowledge-maintenance branch no longer emits a stale generic L3-style placeholder report.

It now snapshots the current installed Lobster brain state from:

- `scripts/nightly_learning_status.py`
- `scripts/topic_memory_status.py`

and surfaces that in both the maintenance report and maintenance sources.

## Exact failure mode

- `scripts/run_knowledge_maintenance_branch.py` was still writing a very old generic maintenance report:
  - command layer operational
  - safe-mode compatible
  - external providers may be disabled
- that report did not reflect:
  - current learn queue state
  - bookkeeping state
  - current learn brain intents
  - current night batch brain intents
  - current topic-memory counts
  - current active lanes

This made the maintenance branch artifact drift behind the real L4 system state.

## Patch

### Live files changed

- `scripts/run_knowledge_maintenance_branch.py`
- `scripts/test_knowledge_maintenance_brain_snapshot.py`

### Behavior change

The maintenance report now includes:

- learn queue snapshot
- bookkeeping pending count
- latest global learn summary
- current learn brain intents
- current night-batch brain intents
- topic-memory counts:
  - topic count
  - episode count
  - semantic / procedural / episodic split
- active lanes preview

The maintenance sources now include:

- `learning_status_snapshot`
- `topic_memory_snapshot`

The branch state row now also includes:

- `brain_trace_summary.learn_intents`
- `brain_trace_summary.night_batch_intents`

## Proof tests

- `python3 /Users/liuchengxu/Projects/openclaw/scripts/test_knowledge_maintenance_brain_snapshot.py`
- `python3 -m py_compile /Users/liuchengxu/Projects/openclaw/scripts/run_knowledge_maintenance_branch.py /Users/liuchengxu/Projects/openclaw/scripts/test_knowledge_maintenance_brain_snapshot.py`
- `corepack pnpm exec oxlint /Users/liuchengxu/Projects/openclaw/scripts/run_knowledge_maintenance_branch.py /Users/liuchengxu/Projects/openclaw/scripts/test_knowledge_maintenance_brain_snapshot.py`
- `python3 /Users/liuchengxu/Projects/openclaw/scripts/run_knowledge_maintenance_entry.py`

## Real live verification

Fresh live Feishu entry:

- `知识维护`

Acceptance:

- `python3 /Users/liuchengxu/Projects/openclaw/scripts/branch_acceptance_probe.py knowledge_maintenance_branch --phrase 知识维护`
  returned:
  - `accepted: true`

## Status

- `dev-fixed: yes`
- `live-fixed: yes`

## Why this matters

This closes an L4 artifact-integrity gap:

- the installed brain is no longer only visible in learning-only surfaces,
- it is now reflected in the system’s own maintenance/control-panel artifact,
- so the maintenance branch stops under-reporting Lobster’s actual current operating state.
