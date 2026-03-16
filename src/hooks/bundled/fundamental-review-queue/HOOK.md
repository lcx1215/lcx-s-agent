---
name: fundamental-review-queue
description: "Materialize a non-execution research decision queue from local fundamental risk handoffs"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-review-queue
metadata:
  {
    "openclaw":
      {
        "emoji": "🧭",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Review Queue Hook

Consumes existing local `fundamental-risk-handoff` artifacts and emits a lightweight research decision layer for deeper review, blocked items, and follow-up material collection.

## What It Does

When you run `/new` or `/reset`, this hook:

1. reads local `bank/fundamental/risk-handoffs/*.json`
2. converts handoff decisions into review-queue actions and priorities
3. separates watchlist candidates, blocked targets, follow-up items, and missing-document requests
4. writes a structured review-queue JSON plus a memory note

## Output

Writes these files:

- `<workspace>/bank/fundamental/review-queues/<manifest-id>.json`
- `<workspace>/memory/YYYY-MM-DD-fundamental-review-queue-<manifest-id>.md`

## Guardrail

This hook is not an execution consumer and not an asset approval engine. It only drives downstream research decisions such as deeper review, missing-material follow-up, and blocked-item visibility.
