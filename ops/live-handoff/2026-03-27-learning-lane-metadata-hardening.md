# Learning Lane Metadata Hardening

## Status

- dev-fixed: no
- live-fixed: no

## Patch

- commit: local live-repo patch only
- files:
  - `feishu_event_proxy.py`
  - `scripts/learn_queue.py`
  - `scripts/run_local_batch_learner.py`
  - `scripts/run_nightly_learning_batch.py`
  - `scripts/nightly_learning_status.py`
  - `scripts/topic_memory.py`
  - `scripts/feishu_nlu_router.py`
  - `scripts/learn_nlu.py`
  - `scripts/run_nlu_action_router.py`
  - `scripts/learning_task_contract.py`
  - `scripts/test_learning_lane_metadata.py`

## Live sync

- migrated to `Projects/openclaw`: yes
- live build passed: n/a
- gateway restarted: no
- proxy restarted: yes
- `openclaw channels status --probe` passed: n/a
- real Feishu verified: no
- Feishu acceptance phrases used:
  - pending
- Feishu acceptance result:
  - pending

## Scope

- failure mode:
  - live learning requests from different Feishu chats collapse into one global queue/report namespace because the script chain has no lane identity
- smallest safe patch:
  - derive `LOBSTER_LANE_KEY=feishu:<chat_id>` in the proxy command path
  - persist lane metadata through queue/state/report artifacts
  - keep the existing script learning architecture
- bounded live equivalent seam:
  - current live learning script chain

## Notes

- what changed:
  - same-topic learning requests from different lanes can now coexist in `learn_queue`
  - learner reports now carry lane metadata and use lane-suffixed filenames
  - nightly batch propagates lane metadata into queue status updates and learner runs
  - `nightly_learning_status.py` now surfaces active lanes
- proof tests:
  - `python3 scripts/test_learning_lane_metadata.py`
  - `python3 scripts/learning_lane_smoke.py`
  - `python3 scripts/test_learning_task_contract.py`
  - `python3 scripts/nightly_learning_status.py`
  - `python3 -m py_compile feishu_event_proxy.py scripts/learn_queue.py scripts/run_local_batch_learner.py scripts/run_nightly_learning_batch.py scripts/nightly_learning_status.py scripts/topic_memory.py scripts/feishu_nlu_router.py scripts/learn_nlu.py scripts/run_nlu_action_router.py scripts/learning_task_contract.py scripts/test_learning_lane_metadata.py scripts/learning_lane_smoke.py`
- what is intentionally out of scope:
  - no branch/workspace directory split
  - no memory architecture rewrite
  - no claim that lane workspace propagation is fully complete
- risks still pending:
  - this is lane metadata hardening, not full lane-scoped workspace isolation
  - the live natural-language learning router still has separate intent debt; the current smoke uses a direct queue script plus the `learn_topic` command entry on purpose
  - real Feishu acceptance is still required before calling this `live-fixed`
