---
summary: "Run the daemon-free in-process HTTP agent service"
read_when:
  - Running the agent service without the Gateway daemon
  - Deploying the agent service to a container or cloud host
  - Calling the agent over HTTP
title: "serve"
---

# `openclaw serve`

Run a minimal in-process HTTP agent service. It exposes the same embedded agent
loop as `agent --local`, but as a long-lived HTTP endpoint instead of a
one-shot CLI call.

This is the daemon-free counterpart to `gateway`. It carries no WebSocket
control plane, no channel adapters, no canvas host, and no node or pairing
state, so it starts anywhere a Node process or container runs.

## Usage

```bash
lcx serve [--port <port>] [--bind <mode>] [--token <token>] [--detach]
lcx serve stop
lcx serve install [--port <port>] [--bind <mode>] [--token <token>] [--node <path>]
lcx serve uninstall
lcx serve status
```

The bare command runs in the foreground. The four lifecycle subcommands make the
service self-running — see [Self-running](#self-running).

## Running without a full build

`lcx.mjs` loads `dist/entry.js`, so `lcx serve` requires a complete tsdown build
first. That build needs a large heap (a 16 GB host is recommended), so on
smaller machines run the same command straight from source:

```bash
node --import tsx src/cli/serve-standalone.ts --bind loopback --port 8788
# or
npm run serve:local -- --bind loopback --port 8788
```

Both routes share the same command definition, so the options and the
fail-closed bind/token contract are identical.

## Options

- `--port <port>`: Port to listen on. Default `8788`. Env: `LCX_SERVE_PORT`.
- `--bind <mode>`: `loopback` or `lan`. Default `loopback`. Env: `LCX_SERVE_BIND`.
- `--token <token>`: Bearer token required for `POST /agent`. Env: `LCX_SERVE_TOKEN`.
- `--agent <id>`: Default agent id for runs. Env: `LCX_SERVE_AGENT`.
- `--session <key>`: Default session key. Default `agent:main:serve`. Env: `LCX_SERVE_SESSION`.
- `--detach`: Spawn the service in the background, detached from the launching terminal.

## Self-running

`serve` is a resident process, so something has to start it and keep it alive.
Without that, the agent only runs while a human holds a terminal open — exactly
the dependency a daemon-free deployment is supposed to remove. Two mechanisms
cover this; they are independent and can be used together.

### Detached process

```bash
lcx serve --detach --port 8788   # returns immediately; the child is reparented
lcx serve status                 # reports the detached pid, if any
lcx serve stop                   # SIGTERM, waits for exit, clears the pidfile
```

The child is spawned with `detached: true` and `unref()`, so it survives the
launcher and is reparented to `launchd`. Configuration travels through the
environment (`LCX_SERVE_BIND`, `LCX_SERVE_PORT`, `LCX_SERVE_TOKEN`, …) rather
than argv, so a bearer token never appears in the process list. The service
writes its own pidfile only after the socket is accepting connections:

```
<state>/serve/serve.pid
<state>/serve/serve.out.log
<state>/serve/serve.err.log
```

`--detach` does not survive a logout or a reboot.

### LaunchAgent (macOS)

```bash
lcx serve install --port 8788             # loopback, no token
lcx serve install --bind lan --token <v>  # non-loopback requires a token
lcx serve uninstall
lcx serve status
```

`install` writes `~/Library/LaunchAgents/ai.openclaw.serve.plist` (mode `0600`,
since it may carry a token) with `RunAtLoad` + `KeepAlive`, then bootstraps it.
The service starts at login and restarts after a crash.

It runs from source (`<node> --import tsx src/index.ts serve …`), not from
`dist/`, so the resident agent matches the working tree and no bundle build is
required. Pass `--node <path>` to pin a specific interpreter.

`install` refuses a non-loopback bind without a token: under `KeepAlive` a
fail-closed process would restart in a loop.

Installing a LaunchAgent requires a launchd domain the caller may write to.
Some restricted shells cannot bootstrap one (`launchctl bootstrap` returns
`Input/output error`); running the command from a normal terminal works.

## Endpoints

### `GET /healthz`

Returns service status. Never touches a model provider.

```json
{
  "ok": true,
  "service": "lcx-agent-serve",
  "status": "ok",
  "bind": "loopback",
  "port": 8788,
  "tokenRequired": false
}
```

### `POST /agent`

Runs one agent turn in-process and returns the reply payloads.

```bash
curl -s http://127.0.0.1:8788/agent \
  -H 'content-type: application/json' \
  -d '{"message":"Summarize today'\''s notes","sessionKey":"agent:main:serve"}'
```

```json
{ "ok": true, "runId": "…", "status": "ok", "summary": "completed", "payloads": [{ "text": "…" }] }
```

Accepted body fields: `message` (required), `agentId`, `sessionKey`, `model`,
`thinking`, `lane`, `extraSystemPrompt`, `timeoutSeconds`.

Request bodies are capped at 1 MiB. Delivery is always disabled because this
service owns no channel adapters.

## Scheduling (cron)

The agent's `cron` tool normally reaches the Gateway over WebSocket RPC
(`cron.status|list|add|update|remove|run|runs`, `wake`). With no daemon running
those calls would fail, so `serve` installs an in-process cron stack instead:

- the **same store file** as the Gateway (`CONFIG_DIR/cron/jobs.json`), so jobs
  persist across runs and are visible to either entry point;
- the same `CronService` scheduler and isolated-agent runner;
- the Gateway's own cron RPC handlers, reused verbatim, so parameter validation,
  pagination, and run-history semantics match exactly.

Only the Gateway-specific delivery surfaces are absent: cron events are not
broadcast over a WebSocket, and cron failure alerts (webhook or channel announce)
are not sent. Run history still lands in the per-job run log and is readable
through the `runs` action.

Because both entry points share one store file, do not run the `serve` and
`gateway` schedulers against it simultaneously — the same constraint that
applies to two Gateways.

Scheduling is disabled by `OPENCLAW_SKIP_CRON=1` or `cron.enabled: false`. The
service still starts and reports `enabled: false`; it never fails to boot
because of the scheduler.

Verified end to end with no daemon and no human in the loop: an `isolated`
`agentTurn` job created through the agent's own `cron` tool fired repeatedly,
each run making a real provider call, writing its artifact, and rescheduling
itself. Run history landed in `<state>/cron/runs/<jobId>.jsonl` with `status`,
`durationMs`, `model`, `provider`, `usage`, and `nextRunAtMs`.

## Tool surface

Tools that talk to the Gateway over RPC and have no daemon-free equivalent
(for example `sessions_list`, `nodes`, `canvas`, `browser`) still attempt the
Gateway and return its connection error to the model. This degrades the tool,
it does not fail the run: the agent receives the error text, reports it, and
continues. Verified behaviour — a turn that calls such a tool still returns
HTTP 200 with `status: "ok"`.

`cron` is the exception: it is served in-process (see above), so scheduling
works with no daemon.

## Security

The service fails closed: binding a non-loopback address without a token is
refused at startup.

```bash
# Local only, no token needed.
lcx serve

# Reachable from other hosts, token required.
LCX_SERVE_TOKEN=<value> lcx serve --bind lan --port 8788
```

When a token is configured, `POST /agent` requires
`Authorization: Bearer <token>`. Token comparison is constant-time.
`GET /healthz` stays unauthenticated so container health checks work.

Because the process already enforced the bind and token contract at startup,
requests that pass authentication run with owner-level tool authorization.

## Relationship to other entrypoints

- `lcx agent --local -m "…"`: one-shot embedded turn, exits when done.
- `lcx serve`: long-lived HTTP service around the same embedded loop.
- `lcx gateway`: full daemon with channels, canvas, and node pairing.

Use `serve` when you want the agent reachable over HTTP without the daemon
surface. Use `gateway` when you need channel adapters or multi-client control.

Unlike `gateway`, `serve` has no channel adapters, canvas host, or node pairing.
It does provide agent-side scheduling (see [Scheduling (cron)](#scheduling-cron)),
so cron-driven work runs in either mode.
