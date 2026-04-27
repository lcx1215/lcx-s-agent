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

## Out Of Scope

- No plist changes in this audit step.
- No deletion of old `Desktop/openclaw`.
- No migration of Feishu proxy yet.
- No live scheduler restart in this audit step.
