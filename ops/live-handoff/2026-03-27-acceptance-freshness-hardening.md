# Acceptance Freshness Hardening

## Summary

- Scope: bounded live hardening for acceptance honesty.
- Objective: stop stale Feishu messages plus later manual reruns from being counted as fresh live acceptance.

## Exact Failure Mode

- `scripts/learning_acceptance_probe.py` and `scripts/branch_acceptance_probe.py` previously accepted when:
  - a matching Feishu message existed in history
  - but the current artifact/state had only been refreshed later by manual runs
- That mixed:
  - real-entry validation
  - later backend repair activity

## Why Dangerous

- It overstates `live-fixed`.
- It lets old Feishu evidence mask the fact that no new real-entry validation has occurred.
- That directly weakens the dev/live boundary the system is trying to enforce.

## Smallest Safe Patch

- Add a narrow acceptance freshness window to both probes.
- Require execution/state/artifact updates to land within that window after the matched Feishu message.
- Keep older messages visible for audit, but do not let them count as fresh acceptance.

## Live Files Changed

- `scripts/learning_acceptance_probe.py`
- `scripts/test_learning_acceptance_probe.py`
- `scripts/branch_acceptance_probe.py`
- `scripts/test_branch_acceptance_probe.py`

## Proof Tests

- `python3 scripts/test_learning_acceptance_probe.py`
- `python3 scripts/test_branch_acceptance_probe.py`
- `python3 scripts/learning_acceptance_probe.py`
- `python3 scripts/branch_acceptance_probe.py technical_daily_branch --phrase 技术日报`
- `python3 scripts/branch_acceptance_probe.py knowledge_maintenance_branch --phrase 知识维护`

## Current Outcome

- learning acceptance now correctly drops back to `accepted: false` until a new real Feishu learn turn happens inside the freshness window.
- `technical_daily_branch` also drops back to `accepted: false` because its current artifact update is too far from the last matched Feishu phrase.
- `knowledge_maintenance_branch` still returns `accepted: true`, which indicates its current artifact timing still falls inside the acceptance window.

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Remaining Out Of Scope

- This does not create new Feishu validations.
- It only makes the probes honest about which validations are still fresh enough to count.
