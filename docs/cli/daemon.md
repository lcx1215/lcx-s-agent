---
summary: "CLI reference for `lcx daemon` (legacy alias for gateway service management)"
read_when:
  - You still use `lcx daemon ...` in scripts
  - You need service lifecycle commands (install/start/stop/restart/status)
title: "daemon"
---

# `lcx daemon`

Legacy alias for Gateway service management commands.

`lcx daemon ...` maps to the same service control surface as `lcx gateway ...` service commands.

## Usage

```bash
lcx daemon status
lcx daemon install
lcx daemon start
lcx daemon stop
lcx daemon restart
lcx daemon uninstall
```

## Subcommands

- `status`: show service install state and probe Gateway health
- `install`: install service (`launchd`/`systemd`/`schtasks`)
- `uninstall`: remove service
- `start`: start service
- `stop`: stop service
- `restart`: restart service

## Common options

- `status`: `--url`, `--token`, `--password`, `--timeout`, `--no-probe`, `--deep`, `--json`
- `install`: `--port`, `--runtime <node|bun>`, `--token`, `--force`, `--json`
- lifecycle (`uninstall|start|stop|restart`): `--json`

## Prefer

Use [`lcx gateway`](/cli/gateway) for current docs and examples.
