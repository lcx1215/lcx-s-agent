---
name: fundamental-target-packets
description: "Materialize target-level dossier and collection packets from local fundamental review workbenches"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-target-packets
metadata:
  {
    "openclaw":
      {
        "emoji": "🧾",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Target Packets Hook

Consumes existing local `fundamental-review-workbench` artifacts and emits target-level dossier packets, follow-up collection packets, and blocked hold packets.

## What It Does

When you run `/new` or `/reset`, this hook:

1. reads local `bank/fundamental/review-workbenches/*.json`
2. falls back to `review-plan`, `review-brief`, `review-queue`, and `risk-handoff` artifacts when a workbench has not been persisted yet
3. writes deeper-review dossier packets, follow-up collection packets, and blocked hold packets for each target
4. keeps the output non-execution and non-approval

## Output

Writes these files:

- `<workspace>/bank/fundamental/target-packets/<manifest-id>.json`
- `<workspace>/memory/YYYY-MM-DD-fundamental-target-packets-<manifest-id>.md`

## Guardrail

This hook does not create approvals, vetoes, or execution instructions. It only turns research workbench state into concrete human research packets.
