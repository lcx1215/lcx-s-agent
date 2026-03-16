---
name: fundamental-review-brief
description: "Materialize a research-only review brief from local fundamental review queues"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-review-brief
metadata:
  {
    "openclaw":
      {
        "emoji": "📝",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Review Brief Hook

Consumes existing local `fundamental-review-queue` artifacts and emits a compact research brief for deeper review and follow-up work.

## What It Does

When you run `/new` or `/reset`, this hook:

1. reads local `bank/fundamental/review-queues/*.json`
2. joins review-queue targets with risk-handoff evidence context
3. writes a structured research brief for deeper review, follow-up, and blocked targets
4. keeps the output non-execution and non-approval

## Output

Writes these files:

- `<workspace>/bank/fundamental/review-briefs/<manifest-id>.json`
- `<workspace>/memory/YYYY-MM-DD-fundamental-review-brief-<manifest-id>.md`

## Guardrail

This hook does not create approvals, vetoes, or execution instructions. It only turns the review queue into a compact brief for human research follow-up.
