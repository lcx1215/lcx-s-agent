# Handoff Record: learning task contract hardening

## Status

- dev-fixed: n/a
- live-fixed: no

## Patch

- commit: uncommitted local live patch
- files:
  - `scripts/learning_task_contract.py`
  - `scripts/test_learning_task_contract.py`

## Live sync

- migrated to `Projects/openclaw`: yes
- live build passed: n/a
- gateway restarted: no
- `openclaw channels status --probe` passed: n/a
- real Feishu verified: no
- Feishu acceptance phrases used:
- Feishu acceptance result:

## Scope

- failure mode:
  - live learning contract script hardcoded the repo root as `~/Projects/openclaw`
  - the same script also imported `datetime.UTC`, which fails on this machine's Python 3.9
- smallest safe patch:
  - resolve repo root from the script location
  - replace `UTC` with `timezone.utc`
  - add a direct unittest for the script
- bounded live equivalent seam:
  - `scripts/learning_task_contract.py` is part of the current live learning script chain

## Notes

- what changed:
  - the script no longer depends on a single home-directory path assumption
  - the script now runs under Python 3.9 on this machine
- proof tests:
  - `python3 scripts/test_learning_task_contract.py`
  - `python3 scripts/learning_task_contract.py "market regime"`
- what is intentionally out of scope:
  - this does not yet solve lane-scoped learning workspaces
  - this does not yet prove real Feishu acceptance
- risks still pending:
  - learning outputs are still global/root-scoped in the live script chain
