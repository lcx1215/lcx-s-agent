# Live-Port Ticket: lane workspace propagation

## Problem

The development repo already propagates the current specialist lane workspace into `learning_command` real learning council runs.

The live repo does not currently expose the same `learning-council` seam, so learning artifacts cannot yet be guaranteed to land in the current lane workspace.

One bounded live hardening has now landed:

- live learning script paths now preserve `lane_key` metadata end-to-end
- same-topic requests from different Feishu chats no longer collapse into one queue row by default

But that still falls short of true lane workspace propagation.

## Why it matters

- lane-bound learning can silently write into the wrong workspace
- artifact recall can look stale or misplaced
- "each line remembers its own work" becomes false in practice

## Evidence

- development repo contains explicit `learning-council` runtime flow
- live repo does not currently contain `extensions/feishu/src/learning-council.ts`
- live repo learning currently routes through:
  - `scripts/feishu_nlu_router.py`
  - `scripts/run_nlu_action_router.py`
  - `scripts/run_nightly_learning_batch.py`
  - `scripts/run_local_batch_learner.py`
- those live learning paths currently write against repo-root knowledge/branch paths such as:
  - `knowledge/learn`
  - `knowledge/learn_batch`
  - `branches/learn/*.json`
- current live learning is therefore global/root-scoped, not lane-workspace-scoped
- current live hardening now adds:
  - `LOBSTER_LANE_KEY=feishu:<chat_id>` from the Feishu proxy command path
  - queue rows keyed by `lane_key + topic`
  - lane metadata in learner reports, learner state, and nightly status
- one related live seam has now been hardened:
  - `scripts/learning_task_contract.py` no longer hardcodes `~/Projects/openclaw`
  - `scripts/learning_task_contract.py` now runs on Python 3.9 via `timezone.utc`
- those hardenings improve reliability and traceability, but do not complete lane workspace propagation

## Smallest safe scope

1. define the intended live learning workspace boundary
2. keep the new lane metadata path stable
3. map lane identity to an actual live workspace boundary instead of only metadata
4. add one more targeted regression test when the workspace seam is chosen

## Out of scope

- no broad Feishu refactor
- no memory architecture rewrite
- no new learning architecture
- no fake "default workspace is good enough" fallback

## Suggested owner

- Codex

## Acceptance

- lane-bound learning artifacts land in the intended live workspace
- no fallback to default workspace for lane-bound learning runs
- real Feishu acceptance proves lane continuity
