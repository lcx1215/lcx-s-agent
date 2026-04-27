# Learning Acceptance Probe

## Status

- dev-fixed: n/a
- live-fixed: no

## Patch

- commit: local live-repo patch only
- files:
  - `scripts/learning_acceptance_probe.py`

## Live sync

- migrated to `Projects/openclaw`: yes
- live build passed: n/a
- gateway restarted: no
- proxy restarted: no
- `openclaw channels status --probe` passed: n/a
- real Feishu verified: synthetic inbound yes, human-typed no
- Feishu acceptance phrases used:
  - `learn_topic market regime`
  - send the same phrase again from a second Feishu chat
- Feishu acceptance result:
  - synthetic inbound probe now reports `accepted=true`

## Scope

- failure mode:
  - live learning acceptance still depended on manual interpretation of queue/report evidence
- smallest safe patch:
  - add a read-only probe that checks recent gateway log matches, then verifies lane-separated queue rows and lane-suffixed reports for the expected topic
- bounded live equivalent seam:
  - `gateway.log`
  - `branches/learn/learn_queue.json`
  - `knowledge/learn/*.md`

## Notes

- what changed:
  - there is now a repeatable way to verify whether two real Feishu chats produced distinct lane-separated learning artifacts
- proof tests:
  - `python3 -m py_compile scripts/learning_acceptance_probe.py`
  - `python3 scripts/learning_acceptance_probe.py`
- current result:
  - two chat-scoped synthetic inbound events produced:
    - distinct `lane_key` evidence in proxy logs
    - distinct lane-suffixed reports in `knowledge/learn/`
    - `accepted=true` in `scripts/learning_acceptance_probe.py`
- what is intentionally out of scope:
  - no natural-language learning router rewrite
  - no full workspace directory isolation claim
- risks still pending:
  - current acceptance phrase targets the hardened lane-metadata seam, not the broader NLU seam
