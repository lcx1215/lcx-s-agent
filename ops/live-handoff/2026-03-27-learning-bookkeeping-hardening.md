# Learning Bookkeeping Hardening

- date: 2026-03-27
- scope: live learning seam hardening
- status: live-hardened, not live-fixed

## Exact failure mode

- `run_local_batch_learner.py` treated report/sources/state writes as an implicit all-or-nothing success.
- A learning run could complete its task logic while leaving no structured bookkeeping trace when a write failed.
- This blocked clean separation between:
  - task result
  - bookkeeping result

## Why dangerous

- learning could look complete while memory/bookkeeping silently degraded
- later runs could appear forgetful with no retry trace
- night batch had no way to distinguish:
  - learner succeeded and recorded cleanly
  - learner succeeded but bookkeeping is pending retry

## Smallest safe live patch

- live files changed:
  - `scripts/run_local_batch_learner.py`
  - `scripts/run_nightly_learning_batch.py`
  - `scripts/test_learning_bookkeeping.py`

- added to `run_local_batch_learner.py`:
  - `task_result`
  - `bookkeeping_result`
  - per-write result records
  - pending ledger: `branches/learn/learn_bookkeeping_pending.json`
  - anomaly trace: `branches/learn/learn_bookkeeping_anomalies.jsonl`
  - automatic pending cleanup after a later successful bookkeeping pass

- added to `run_nightly_learning_batch.py`:
  - partial bookkeeping awareness
  - `partial` topic-run status in batch report
  - queue failure signaling when bookkeeping is pending retry

## Proof tests

- `python3 scripts/test_learning_bookkeeping.py`
- `python3 -m py_compile scripts/run_local_batch_learner.py scripts/run_nightly_learning_batch.py scripts/test_learning_bookkeeping.py`
- `python3 scripts/run_local_batch_learner.py 'market regime'`

## Current interpretation

- `task result` and `bookkeeping result` are now explicitly separated in the live learner output
- bookkeeping failure now leaves:
  - pending retry trace
  - anomaly trace
- this is a real step toward L5 bookkeeping discipline
- it is not yet full memory/bookkeeping hardening across every branch
