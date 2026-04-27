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

## Out Of Scope

- No plist changes in this audit step.
- No deletion of old `Desktop/openclaw`.
- No migration of Feishu proxy yet.
- No live scheduler restart in this audit step.
