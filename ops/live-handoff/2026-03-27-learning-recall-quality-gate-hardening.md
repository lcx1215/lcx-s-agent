# Learning Recall Quality Gate Hardening

## Summary

Tighten the live learning recall seam so acceptance no longer passes when lane topic-memory content is still dirty or placeholder-like.

## Exact Failure Modes

### 1. Generic recall still reintroduced dirty lines

- Some lane `market regime` cards still reabsorbed:
  - `SPY: Mixed regime.`
  - `# Technical Daily Report - generated ## 1.`
  - source-path lines like `2026-03-13_technical_daily.md (...)`
- This happened at the topic-memory extraction layer even after learner/report hardening.

### 2. Acceptance overclaimed success

- `scripts/learning_acceptance_probe.py` originally only required:
  - execution evidence
  - report artifact
  - topic-memory artifact existence
- That was not enough, because the topic-memory artifact could exist while recall content was still dirty or placeholder-like.

## Smallest Safe Patch

- Keep the live learning architecture unchanged.
- In `scripts/topic_memory.py`:
  - add generic recall sanitization for wrapper/title/source-path residue
  - treat weak tagged lines like `SPY: Mixed regime.` as bad recall input
  - for generic topics, prefer cleaned retrieved-note lines and cleaned conclusions
- In `scripts/learning_acceptance_probe.py`:
  - require `topic_memory_clean`
  - fail acceptance when lane recall content still contains:
    - wrapper residue
    - placeholder fallback text
    - weak label-only conclusions

## Files Changed

- live:
  - `scripts/topic_memory.py`
  - `scripts/test_topic_memory_lane_scope.py`
  - `scripts/learning_acceptance_probe.py`
  - `scripts/test_learning_acceptance_probe.py`

## Proof Tests

- `python3 scripts/test_topic_memory_lane_scope.py`
- `python3 scripts/test_learning_acceptance_probe.py`
- `python3 -m py_compile scripts/topic_memory.py scripts/test_topic_memory_lane_scope.py scripts/learning_acceptance_probe.py scripts/test_learning_acceptance_probe.py`
- `python3 scripts/topic_memory.py rebuild`
- `python3 scripts/learning_acceptance_probe.py`

## Current Observed State

- Both real Feishu lanes are now clean:
  - `feishu:oc_9d23d6438a7ab45740ede9343a09cd2e`
  - `feishu:oc_3b1f572ef84301a8076b4d9a4555e05f`
- `scripts/learning_acceptance_probe.py` now returns:
  - `accepted: true`
- The probe is still honest:
  - it requires lane-separated reports
  - refreshed lane topic-memory artifacts
  - clean recall content
  - true learner execution evidence instead of recall-command echoes

This means the learning recall quality gate is now green, even though full lane workspace propagation is still out of scope.

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Remaining Out Of Scope

- This does not complete full lane workspace propagation.
- This does not guarantee all historical lane reports are clean.
- This does not by itself promote the whole learning architecture to `live-fixed`.
