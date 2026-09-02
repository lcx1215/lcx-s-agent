# Branch Acceptance Probe

## Status

- dev-fixed: n/a
- live-fixed: no

## Patch

- commit: local live-repo patch only
- files:
  - `scripts/branch_acceptance_probe.py`

## Live sync

- migrated to `Projects/openclaw`: yes
- live build passed: n/a
- gateway restarted: no
- proxy restarted: no
- `openclaw channels status --probe` passed: n/a
- real Feishu verified: no
- Feishu acceptance phrases used:
  - `给我今天的 technical daily。`
  - `给我今天的 knowledge maintenance。`
- Feishu acceptance result:
  - probe currently reports `no matching Feishu phrase found`

## Scope

- failure mode:
  - branch acceptance existed only as a written checklist, not as a repeatable live verification tool
- smallest safe patch:
  - add a read-only acceptance probe that checks recent gateway logs for a fixed Feishu phrase and compares it to branch state/artifact freshness
- bounded live equivalent seam:
  - `gateway.log`
  - `branch_state.json`
  - branch report paths

## Notes

- what changed:
  - there is now a live script that can answer whether a fixed Feishu acceptance phrase actually hit a branch and produced fresh branch output
- proof tests:
  - `python3 -m py_compile scripts/branch_acceptance_probe.py`
  - `python3 scripts/branch_acceptance_probe.py technical_daily_branch`
  - `python3 scripts/branch_acceptance_probe.py knowledge_maintenance_branch`
- current result:
  - both branch probes are honest `accepted=false`
  - branch artifacts exist, but no matching real Feishu acceptance phrase has been observed yet
- what is intentionally out of scope:
  - no branch routing change
  - no automatic Feishu message injection
  - no fake acceptance
- risks still pending:
  - branch stability still needs real Feishu turns, not just script execution
