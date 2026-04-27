# Learning Lane State Mirror

- date: 2026-03-27
- scope: live learning state hardening
- status: live-hardened

## Exact failure mode

- live learner preserved `lane_key` in reports and queue rows
- but all runs still overwrote one global `branches/learn/learn_state.json`
- result:
  - lane trace existed
  - current learner state still collapsed into one shared file

## Why dangerous

- later learning runs from another chat could overwrite the only current state file
- operator-facing status could not inspect lane-specific current state
- this blocked true multi-line self-maintenance

## Smallest safe live patch

- live files changed:
  - `scripts/run_local_batch_learner.py`
  - `scripts/nightly_learning_status.py`
  - `scripts/test_learning_lane_metadata.py`

- changes:
  - keep global `branches/learn/learn_state.json` for compatibility
  - additionally write:
    - `branches/learn/lanes/<lane-slug>/learn_state.json`
  - surface recent lane states in `nightly_learning_status.py`

## Proof tests

- `python3 scripts/test_learning_lane_metadata.py`
- `LOBSTER_LANE_KEY='feishu:chat-alpha' python3 scripts/run_local_batch_learner.py 'market regime'`
- `python3 scripts/nightly_learning_status.py`

## Result

- live learner now has:
  - global compatibility state
  - lane-scoped current state mirror
- status output can now show lane-scoped learning state, not only one global snapshot
