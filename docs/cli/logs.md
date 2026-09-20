---
summary: "CLI reference for `lcx logs` (tail gateway logs via RPC)"
read_when:
  - You need to tail Gateway logs remotely (without SSH)
  - You want JSON log lines for tooling
title: "logs"
---

# `lcx logs`

Tail Gateway file logs over RPC (works in remote mode).

Related:

- Logging overview: [Logging](/logging)

## Examples

```bash
lcx logs
lcx logs --follow
lcx logs --json
lcx logs --limit 500
lcx logs --local-time
lcx logs --follow --local-time
```

Use `--local-time` to render timestamps in your local timezone.
