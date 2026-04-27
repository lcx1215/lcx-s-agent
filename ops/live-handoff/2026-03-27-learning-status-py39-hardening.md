# Learning Status Py3.9 Hardening

- date: 2026-03-27
- scope: live learning status / queue compatibility and bookkeeping visibility
- status: live-hardened

## Exact failure mode

- `scripts/nightly_learning_status.py` called `scripts/learn_queue.py summary`
- on the live script chain, that call could run under Python 3.9
- `learn_queue.py` used `str | None` annotations, which raise `TypeError` on Python 3.9
- result:
  - learning status looked present
  - queue summary was actually broken

## Why dangerous

- operator-facing learning status becomes false-green
- queue health becomes invisible exactly when learning is supposed to self-maintain
- this blocks trustworthy self-learning operations

## Smallest safe live patch

- live files changed:
  - `scripts/learn_queue.py`
  - `scripts/feishu_nlu_parser.py`
  - `scripts/nightly_learning_status.py`
  - `scripts/branch_acceptance_probe.py`
  - `scripts/learning_acceptance_probe.py`

- changes:
  - replaced runtime-sensitive `| None` annotations in the live learning/acceptance chain with `Optional[...]`
  - surfaced:
    - `learn_state`
    - `bookkeeping.pending_count`
    - `bookkeeping.pending_topics`
    - `bookkeeping.last_anomaly`
    inside `nightly_learning_status.py`

## Proof tests

- `python3 scripts/learn_queue.py summary`
- `python3 scripts/nightly_learning_status.py`
- `python3 scripts/test_learning_bookkeeping.py`
- `python3 -m py_compile scripts/learn_queue.py scripts/feishu_nlu_parser.py scripts/nightly_learning_status.py scripts/branch_acceptance_probe.py scripts/learning_acceptance_probe.py`

## Result

- live learning status is readable again
- queue summary no longer crashes
- bookkeeping visibility is now operator-visible instead of hidden inside learner output only
