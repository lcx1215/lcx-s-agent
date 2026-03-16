---
name: fundamental-review-workbench
description: "Materialize target-level research work packets from local fundamental review plans"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-review-workbench
metadata:
  {
    "openclaw":
      {
        "emoji": "🗃️",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Review Workbench Hook

Consumes existing local `fundamental-review-plan` artifacts and emits target-level work packets for deeper review, follow-up collection, and blocked monitoring.

## What It Does

When you run `/new` or `/reset`, this hook:

1. reads local `bank/fundamental/review-plans/*.json`
2. falls back to `review-brief`, `review-queue`, and `risk-handoff` artifacts when a plan has not been persisted yet
3. writes actionable target-level deeper-review scaffolds, follow-up collection plans, and blocked monitoring checklists
4. keeps the output non-execution and non-approval

## Output

Writes these files:

- `<workspace>/bank/fundamental/review-workbenches/<manifest-id>.json`
- `<workspace>/memory/YYYY-MM-DD-fundamental-review-workbench-<manifest-id>.md`

## Guardrail

This hook does not create approvals, vetoes, or execution instructions. It only turns review plans into concrete human research work packets.
