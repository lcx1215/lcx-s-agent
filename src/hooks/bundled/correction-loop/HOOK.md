---
name: correction-loop
description: "Save operator corrections as structured notes and escalate repeated issues into repair tickets"
homepage: https://docs.openclaw.ai/automation/hooks#correction-loop
metadata:
  {
    "openclaw":
      {
        "emoji": "🩺",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Correction Loop Hook

Turns operator feedback sessions into durable correction notes, and escalates repeated failures into a repair-ticket candidate without rewriting doctrine or silently overwriting history.

## What It Does

When you run `/new` or `/reset`, this hook:

1. inspects the recent session transcript
2. detects user turns prefixed with `反馈：`, `复盘：`, or `纠正：`
3. writes a structured correction note to `memory/`
4. checks whether the same issue has already been corrected before
5. if repeated, writes or updates a repair-ticket candidate under `bank/watchtower/repair-tickets/`

## Output

Creates:

- `<workspace>/memory/YYYY-MM-DD-correction-note-<issue>.md`
- `<workspace>/bank/watchtower/repair-tickets/<issue>.md` when the same issue repeats

## Guardrails

- Correction notes are evidence-bearing memory artifacts, not direct production doctrine.
- Repeated issues escalate into repair tickets for human review; the hook does not auto-edit the system.
- Weak or one-off operator impressions should stay provisional and should not silently overwrite verified memory.
