# Dev To Live Feishu Acceptance Runbook

## Purpose

Use this runbook when a bounded development-repo patch needs to become a real Feishu-visible live fix.

This document is intentionally narrow:

- it describes the current `lcx-s-openclaw` -> `Projects/openclaw` path
- it uses only repo-grounded scripts and commands
- it does **not** count as live proof by itself

## Truth Boundary

- development repo:
  - `lcx-s-openclaw`
- live runtime repo:
  - `~/Projects/openclaw`

`dev-fixed` becomes `live-fixed` only after:

1. bounded live port
2. live verification in `~/Projects/openclaw`
3. live build
4. live restart / probe
5. real-entry Feishu acceptance

## Step 1: Verify The Dev Patch First

In `lcx-s-openclaw`:

1. run targeted tests for the bounded seam
2. run `oxlint` on touched files
3. run `git diff --check`
4. update:
   - `memory/current_state.md`
   - `ops/codex_handoff.md`

Do not port a patch whose dev-repo seam is still ambiguous.

## Step 2: Confirm The Live Seam Exists

In `~/Projects/openclaw`, confirm the equivalent seam exists before porting.

Current observed live acceptance scripts include:

- `scripts/branch_acceptance_probe.py`
- `scripts/learning_acceptance_probe.py`
- `scripts/feishu_branch_smoke.py`
- `scripts/feishu_nlu_router.py`
- `scripts/run_nlu_action_router.py`
- `lobster_command_v2.sh`
- `feishu_event_proxy.py`

If the live repo does not have the equivalent seam, stop and write a bounded live-port plan first.

## Step 3: Port Only The Bounded Live Equivalent

In `~/Projects/openclaw`:

1. inspect `git status --short`
2. port only the equivalent seam
3. do not mix unrelated cleanup
4. do not widen scope during live migration

## Step 4: Run Seam-Local Live Checks

Use only the checks that match the seam you touched.

Examples already present in the live repo:

- `python3 scripts/test_branch_acceptance_probe.py`
- `python3 scripts/test_learning_acceptance_probe.py`
- `python3 scripts/test_feishu_nlu_router.py`
- `python3 scripts/test_run_nlu_action_router.py`
- `python3 scripts/test_local_corpus_search_lane_preference.py`

## Step 5: Build And Restart

In `~/Projects/openclaw`:

1. run `corepack pnpm build`
2. restart the live runtime by the current operator-owned path

Current repo-grounded restart/probe paths include:

- `./scripts/restart-mac.sh`
- `curl -s http://127.0.0.1:3011/healthz`
- `openclaw channels status --probe`

If the patch only touches the Feishu proxy seam, also verify:

- `feishu_event_proxy.py` health on `http://127.0.0.1:3011/healthz`

## Step 6: Run Real Feishu Acceptance

Use one exact phrase per seam. Then verify with live probes instead of chat memory.

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

Only report `live-fixed: yes` after all five are true:

1. live repo patched
2. live seam-local checks passed
3. live build passed
4. restart / probe passed
5. real-entry Feishu acceptance passed

If any one of those is missing, report:

- `dev-fixed: yes`
- `live-fixed: no`
