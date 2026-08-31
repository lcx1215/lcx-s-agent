# External-Channel Feishu Acceptance Runbook

> Canonical neutral runbook path. This runbook no longer models two
> repositories: the local system has one canonical repository and linked Git
> worktrees; any sidecar path below is a deployment artifact only.

## Purpose

Use this runbook when a bounded canonical-repository change needs fresh
external-channel and user-visible verification.

This document is intentionally narrow:

- it describes the canonical `lcx-s-openclaw` repository and its optional
  external-channel deployment sidecar
- it uses only repo-grounded scripts and commands
- it does **not** count as user-visible proof by itself

## Truth Boundary

- canonical repository:
  - `lcx-s-openclaw`
- local isolation:
  - linked Git worktrees only
- optional external-channel deployment artifact:
  - `~/.openclaw/external-channel-runtime/lcx-s-openclaw`

`core-verified` becomes `user-visible-observed` only after:

1. bounded external-channel binding
2. verification against the selected canonical-repository snapshot
3. channel build
4. channel restart / probe
5. real-entry Feishu acceptance

## Step 1: Verify The Core Change First

In `lcx-s-openclaw`:

1. run targeted tests for the bounded seam
2. run `oxlint` on touched files
3. run `git diff --check`
4. update:
   - `memory/current_state.md`
   - `ops/codex_handoff.md`

Do not bind an external channel while the canonical-repository seam is ambiguous.

## Step 2: Confirm The External-Channel Seam Exists

In `~/.openclaw/external-channel-runtime/lcx-s-openclaw`, confirm the deployment artifact
references the equivalent canonical seam before binding it.

Current observed external-channel acceptance scripts include:

- `scripts/branch_acceptance_probe.py`
- `scripts/learning_acceptance_probe.py`
- `scripts/feishu_branch_smoke.py`
- `scripts/feishu_nlu_router.py`
- `scripts/run_nlu_action_router.py`
- `lobster_command_v2.sh`
- `feishu_event_proxy.py`

If the deployment artifact does not have the equivalent seam, stop and write a
bounded external-channel binding plan first.

## Step 3: Bind Only The Bounded External-Channel Equivalent

In `~/.openclaw/external-channel-runtime/lcx-s-openclaw`:

1. inspect `git status --short`
2. bind only the equivalent seam from the canonical repository
3. do not mix unrelated cleanup
4. do not widen scope during channel binding

## Step 4: Run Seam-Local External-Channel Checks

Use only the checks that match the seam you touched.

Examples already present in the deployment artifact:

- `python3 scripts/test_branch_acceptance_probe.py`
- `python3 scripts/test_learning_acceptance_probe.py`
- `python3 scripts/test_feishu_nlu_router.py`
- `python3 scripts/test_run_nlu_action_router.py`
- `python3 scripts/test_local_corpus_search_lane_preference.py`

## Step 5: Build And Restart The Channel

In `~/.openclaw/external-channel-runtime/lcx-s-openclaw`:

1. run `corepack pnpm build`
2. restart the external-channel runtime by the current operator-owned path

Current repo-grounded restart/probe paths include:

- `./scripts/restart-mac.sh`
- `curl -s http://127.0.0.1:3011/healthz`
- `openclaw channels status --probe`

If the patch only touches the Feishu proxy seam, also verify:

- `feishu_event_proxy.py` health on `http://127.0.0.1:3011/healthz`

## Step 6: Run Real Feishu Acceptance

Use one exact phrase per seam. Then verify with fresh channel probes instead of chat memory.

Current repo-grounded examples:

### Branch acceptance

- send phrase:
  - `知识维护`
- verify:
  - `python3 scripts/branch_acceptance_probe.py knowledge_maintenance_branch --phrase '知识维护'`

### Learning acceptance

- send phrase:
  - `learn_topic market regime`
- verify:
  - `python3 scripts/learning_acceptance_probe.py --phrase 'learn_topic market regime' --topic 'market regime'`

### Feishu branch smoke

- run:
  - `python3 scripts/feishu_branch_smoke.py`

### Command / NLU seam checks

- `bash lobster_command_v2.sh --classify '系统怎么改造自己'`
- `python3 scripts/feishu_nlu_router.py '系统怎么改造自己'`
- `python3 scripts/run_nlu_action_router.py '系统怎么改造自己'`

## Reporting Rule

Only report `user-visible-observed: yes` after all five are true:

1. canonical repository seam verified
2. external-channel seam-local checks passed
3. channel build passed
4. restart / probe passed
5. real-entry Feishu acceptance passed

If any one of those is missing, report:

- `core-verified: yes`
- `user-visible-observed: no`
