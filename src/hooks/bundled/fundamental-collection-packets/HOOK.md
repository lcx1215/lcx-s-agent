---
name: fundamental-collection-packets
description: "Materialize proposal-only collection work packets from fundamental manifest patch proposals"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-collection-packets
metadata:
  {
    "openclaw":
      {
        "emoji": "📥",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Collection Packets Hook

Consumes proposal-only collection manifest patches and turns them into concrete collection work packets.

## What It Does

When you run `/new` or `/reset`, this hook:

1. finds collection patch proposals from local fundamental target packets
2. turns each patch into a concrete collection packet with destination, naming rule, manual checks, and next steps
3. writes a per-manifest collection packet JSON plus per-target Markdown work packets
4. keeps all output proposal-only and research-only

## Output

Writes these files:

- `<workspace>/bank/fundamental/collection-packets/<manifest-id>.json`
- `<workspace>/bank/fundamental/collection-work/<manifest-id>/*.md`
- `<workspace>/memory/YYYY-MM-DD-fundamental-collection-packets-<manifest-id>.md`

## Guardrail

This hook does not apply manifest patches or trigger collection automatically. It only prepares concrete human collection packets.
