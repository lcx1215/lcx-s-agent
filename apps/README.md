# Apps

Deployable app surfaces that sit alongside the OpenClaw runtime.

## web/lcx-agent-farm

LCX read-only browser control room. It is a static page served by the operator
harness:

```bash
node --import tsx scripts/operator/lcx-farm-web-server.ts --port 4788
```

The supported client surfaces for this tree are the CLI (`lcx.mjs`), the
control UI in `ui/`, the channel adapters under `src/channels/` and
`extensions/`, and this control room.
