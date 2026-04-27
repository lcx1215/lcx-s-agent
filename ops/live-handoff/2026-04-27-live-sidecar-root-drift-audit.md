# Live Sidecar Root Drift Audit

Date: 2026-04-27

## Failure Mode

The main OpenClaw gateway is now running from the clean `lcx-s-openclaw`
checkout, but several macOS LaunchAgent sidecars still run from the older
`Desktop/openclaw` checkout.

This is dangerous because live status can otherwise look synced while unattended
learning, watchdog alerts, and Feishu/Lark proxy behavior still depend on
untracked live-only Python scripts outside the clean GitHub root.

## Current Sidecars

| LaunchAgent                         | Current program                                                       | Current cwd/root                     | Role                                                                         | Migration status              |
| ----------------------------------- | --------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------- |
| `ai.openclaw.lobster.scheduler`     | `/Users/liuchengxu/Desktop/openclaw/daily_learning_runner.py`         | `/Users/liuchengxu/Desktop/openclaw` | Runs `lobster_orchestrator.py cycle` and writes `scheduler_heartbeat.json`   | live-only, do not repoint yet |
| `ai.openclaw.lobster.host_watchdog` | `/Users/liuchengxu/Desktop/openclaw/scripts/lobster_host_watchdog.py` | `/Users/liuchengxu/Desktop/openclaw` | Checks scheduler heartbeat, branch freshness, Feishu alert, Codex escalation | live-only, do not repoint yet |
| `ai.openclaw.feishu.proxy`          | `/Users/liuchengxu/Desktop/openclaw/feishu_event_proxy.py`            | `/Users/liuchengxu/Desktop/openclaw` | Feishu/Lark event proxy and legacy command bridge                            | highest-risk, migrate last    |

## Evidence

The current dev status path now surfaces root drift directly:

```text
root-drift: expected /Users/liuchengxu/Desktop/lcx-s-openclaw, observed /Users/liuchengxu/Desktop/openclaw
```

The live-only scheduler/watchdog files are not tracked in the old checkout:

```text
?? daily_learning_runner.py
?? scripts/branch_freshness.py
?? scripts/codex_escalation.py
?? scripts/lobster_host_watchdog.py
?? scripts/lobster_paths.py
?? send_feishu_alert.py
```

The sidecar state is stored under the old checkout:

```text
/Users/liuchengxu/Desktop/openclaw/branches/_system/scheduler_heartbeat.json
/Users/liuchengxu/Desktop/openclaw/branches/_system/host_watchdog_state.json
/Users/liuchengxu/Desktop/openclaw/branches/_system/branch_state.json
/Users/liuchengxu/Desktop/openclaw/branches/_system/branch_scheduler.json
```

## Boundary

Do not remove or repoint these sidecars just because they are root-drifted.

They are not generic stale services. They currently carry unattended learning
automation and alerting. A direct plist root change would break imports such as
`lobster_paths`, `branch_freshness`, `codex_escalation`, and the old
`lobster_orchestrator.py` runtime contract.

## Smallest Safe Next Migration

Start with `ai.openclaw.lobster.scheduler`, not Feishu proxy.

1. Copy or port only the scheduler dependency chain into the clean repo:
   `daily_learning_runner.py`, `scripts/lobster_paths.py`, and the minimum
   orchestrator entrypoint it calls.
2. Add a dry-run or smoke command that reads the old state but writes no live
   Feishu/Lark message.
3. Only after smoke passes, install a new scheduler LaunchAgent pointing at
   `lcx-s-openclaw`.
4. Leave `ai.openclaw.feishu.proxy` unchanged until scheduler and watchdog have
   a clean-root replacement.

## Scheduler Migration Progress

Current dev/GitHub status:

```text
schedulerDryRun=migration_ready
mode=dry_run_no_launchagent_change_no_lark_send
launchAgent.pointsAtLegacyRoot=true
```

The clean repo now has tracked scheduler compatibility entrypoints:

```text
daily_learning_runner.py
lobster_orchestrator.py
scripts/lobster_paths.py
```

Important boundary: this does not mean the live scheduler has been migrated.
The live LaunchAgent still points at `/Users/liuchengxu/Desktop/openclaw`. The
clean-root scheduler entrypoint is intentionally fail-closed for live `cycle`
unless `OPENCLAW_SCHEDULER_ENABLE_CYCLE=1` is explicitly set during an approved
live migration.

Verified smoke:

```text
python3 daily_learning_runner.py --dry-run
status: cycle_blocked_fail_closed
```

## Host Watchdog Migration Progress

Current dev/GitHub status:

```text
hostWatchdogDryRun=migration_ready
mode=dry_run_no_launchagent_change_no_lark_send
launchAgent.pointsAtLegacyRoot=true
```

The clean repo now has tracked host-watchdog compatibility entrypoints:

```text
scripts/lobster_host_watchdog.py
scripts/branch_freshness.py
scripts/lobster_paths.py
```

Important boundary: this does not mean the live host watchdog has been
migrated. The live LaunchAgent still points at
`/Users/liuchengxu/Desktop/openclaw`. The clean-root watchdog defaults to
`dry_run_no_alert`, so it can inspect scheduler heartbeat / branch freshness
without sending Feishu/Lark alerts or triggering Codex escalation.

Verified smoke:

```text
python3 scripts/lobster_host_watchdog.py --dry-run
hostWatchdog=ok
mode=dry_run_no_alert
noFeishuLarkSend=True
```

## LaunchAgent Candidate Plan

Current dev/GitHub status:

```text
launchAgentPlan=generated_no_live_change
scheduler.safetyMode=dry_run_write_receipt
host_watchdog.safetyMode=dry_run_write_receipt
```

Generated candidate files:

```text
ops/live-handoff/launchagent-candidates/ai.openclaw.lobster.scheduler.smoke.plist
ops/live-handoff/launchagent-candidates/ai.openclaw.lobster.host_watchdog.smoke.plist
ops/live-handoff/launchagent-candidates/live-sidecar-launchagent-plan.json
```

These are smoke candidates, not production live replacements. Both candidates
run with `--dry-run --write-receipt`, write to `.smoke.*.log` paths, and keep the
same labels only so the exact migration target is auditable before any real
operator-approved LaunchAgent change.

Verified plist syntax:

```text
plutil -lint ops/live-handoff/launchagent-candidates/*.plist
status: OK
```

## Install Preflight

Current dev/GitHub status:

```text
installPreflight=ready_for_manual_install
noLiveLaunchAgentChange=true
scheduler_root_drift_gate=pass
host_watchdog_root_drift_gate=pass
plist_lint:scheduler=pass
plist_lint:host_watchdog=pass
```

This preflight is a gate, not an installer. It proves the tracked clean-root
entrypoints, candidate plist syntax, dry-run sidecar commands, current plist
backup source hashes, and root-drift gates line up. It does not copy files into
`~/Library/LaunchAgents`, does not call `launchctl bootstrap`, and does not
change live sidecar state.

## Install Dry-Run Receipt

Current dev/GitHub status:

```text
installDryRun=ready_receipt_generated
noLiveLaunchAgentChange=true
scheduler.changed=true
host_watchdog.changed=true
```

Generated receipt:

```text
ops/live-handoff/launchagent-candidates/live-sidecar-install-dry-run-receipt.json
```

This receipt records the exact `cp`, backup, `launchctl bootout`, `launchctl
bootstrap`, and rollback commands that would be used in a later live migration.
It also records the current live plist hashes and expected candidate hashes.

Important boundary: this step still does not copy either plist, does not create
backup files, and does not run `launchctl`. A direct read of the live plists
after the dry-run still shows both sidecars pointing at
`/Users/liuchengxu/Desktop/openclaw`.

## Smoke Install Attempt And Rollback

Current live status:

```text
smoke install attempted: yes
smoke install result: rolled back
live-fixed: no
```

The smoke-mode install copied the clean-root smoke plist candidates and
successfully reloaded both LaunchAgents, but the actual LaunchAgent process
failed to open Python files under the Desktop checkout:

```text
/Library/Developer/CommandLineTools/usr/bin/python3: can't open file '/Users/liuchengxu/Desktop/lcx-s-openclaw/scripts/lobster_host_watchdog.py': [Errno 1] Operation not permitted
```

The rollback commands from the smoke receipt were applied immediately. A direct
read of the live plists after rollback shows both sidecars are back on the old
`/Users/liuchengxu/Desktop/openclaw` paths.

Rollback receipt:

```text
ops/live-handoff/launchagent-candidates/live-sidecar-install-smoke-rollback-receipt.json
```

The smoke installer now blocks Desktop targets by default and records a blocked
receipt without live changes unless an explicit override is passed:

```text
ops/live-handoff/launchagent-candidates/live-sidecar-install-smoke-receipt.json
liveLaunchAgentChanged=false
```

Important updated migration constraint: do not point LaunchAgents directly at
Desktop checkouts. The next safe patch is to generate a non-Desktop runtime
bundle under `~/.openclaw/live-sidecars` and point smoke LaunchAgents at that
bundle.

## Non-Desktop Runtime Bundle And Smoke Install

Current live status:

```text
runtimeBundle=ready
targetRoot=/Users/liuchengxu/.openclaw/live-sidecars/lcx-s-openclaw
installSmoke=applied
smokeModeOnly=true
host_watchdog.last_exit_code=0
scheduler.last_exit_code=0
live-smoke-fixed=yes
production-live-fixed=no
production-cycle-enabled=false
```

The migration now has a bounded non-Desktop runtime bundle:

```text
/Users/liuchengxu/.openclaw/live-sidecars/lcx-s-openclaw/daily_learning_runner.py
/Users/liuchengxu/.openclaw/live-sidecars/lcx-s-openclaw/lobster_orchestrator.py
/Users/liuchengxu/.openclaw/live-sidecars/lcx-s-openclaw/scripts/lobster_paths.py
/Users/liuchengxu/.openclaw/live-sidecars/lcx-s-openclaw/scripts/branch_freshness.py
/Users/liuchengxu/.openclaw/live-sidecars/lcx-s-openclaw/scripts/lobster_host_watchdog.py
```

Generated receipt:

```text
ops/live-handoff/launchagent-candidates/live-sidecar-runtime-bundle-receipt.json
```

The live LaunchAgents now point at the non-Desktop runtime bundle, but only in
smoke mode:

```text
ProgramArguments include --dry-run --write-receipt
WorkingDirectory=/Users/liuchengxu/.openclaw/live-sidecars/lcx-s-openclaw
```

Post-install kickstart proof:

```text
ai.openclaw.lobster.host_watchdog: runs=2, last exit code=0
ai.openclaw.lobster.scheduler: runs=1, last exit code=0
```

Runtime smoke receipts confirm the boundary:

```text
hostWatchdog=ok
mode=dry_run_no_alert
noFeishuLarkSend=True

scheduler status=cycle_blocked_fail_closed
cycleEnabled=false
noFeishuLarkSend=true
noRemoteFetch=true
noTradingExecution=true
```

Important boundary: this is a successful live smoke migration for the scheduler
and watchdog sidecar labels. It is not a production live fix or production
learning-cycle enablement. The scheduler remains fail-closed unless
`OPENCLAW_SCHEDULER_ENABLE_CYCLE=1` is explicitly set during a separate approved
live migration.

## Scheduler Controlled Cycle Install

Current live status:

```text
schedulerCycleInstall=applied
targetRoot=/Users/liuchengxu/.openclaw/live-sidecars/lcx-s-openclaw
OPENCLAW_SCHEDULER_ENABLE_CYCLE=1
OPENCLAW_SCHEDULER_CYCLE_COMMAND=pnpm exec tsx scripts/dev/agent-system-loop-smoke.ts
scheduler.runs=1
scheduler.last_exit_code=0
host_watchdog.runs=3
host_watchdog.last_exit_code=0
```

Generated receipt:

```text
ops/live-handoff/launchagent-candidates/live-sidecar-scheduler-cycle-install-receipt.json
```

The scheduler LaunchAgent now runs a controlled cycle from the non-Desktop
runtime bundle. The cycle is not a trading loop and does not send Lark messages.
It runs the full local agent-system gate and writes a bounded scheduler receipt:

```text
status=cycle_completed
cycleMode=live_guarded
cycleResult.scope=dev_full_system_language_brain_analysis_memory_loop
cycleResult.checkCount=5
cycleResult.liveTouched=false
cycleResult.providerConfigTouched=false
cycleResult.protectedMemoryTouched=false
cycleResult.remoteFetchOccurred=false
cycleResult.executionAuthorityGranted=false
```

The five checks covered by the controlled cycle are:

```text
finance-pipeline-all
finance-multi-candidate
finance-event-review
lark-brain-language-loop
lark-routing-and-distillation-tests
```

Runtime receipt path:

```text
/Users/liuchengxu/.openclaw/live-sidecars/lcx-s-openclaw/branches/_system/scheduler_cycle_report.json
```

Important boundary: this makes the scheduler sidecar live for a bounded
language/brain/analysis/memory eval cycle. It still does not migrate the
Feishu/Lark proxy, does not grant execution authority, and does not turn the
system into an autonomous trading agent.

## Watchdog Cycle Health Gate

Current live status:

```text
host_watchdog.runs=4
host_watchdog.last_exit_code=0
scheduler_cycle.status=fresh
scheduler_cycle.check_count=5
scheduler_cycle.boundary_ok=true
```

The host watchdog now checks more than scheduler process heartbeat. It reads the
latest scheduler cycle report and treats the scheduler as unhealthy if the
bounded cycle is missing, stale, failed, incomplete, or violates the safety
boundary.

Checked report fields:

```text
status=cycle_completed
cycleResult.checkCount >= 5
cycleResult.liveTouched=false
cycleResult.providerConfigTouched=false
cycleResult.protectedMemoryTouched=false
cycleResult.remoteFetchOccurred=false
cycleResult.executionAuthorityGranted=false
```

Runtime watchdog receipt:

```text
/Users/liuchengxu/.openclaw/live-sidecars/lcx-s-openclaw/branches/_system/host_watchdog_state.json
```

This prevents a false-green state where the LaunchAgent exits successfully but
the language/brain/analysis/memory loop failed or crossed a protected boundary.

## Out Of Scope

- No deletion of old `Desktop/openclaw`.
- No migration of Feishu proxy yet.
- No Feishu/Lark proxy restart in this audit step.
