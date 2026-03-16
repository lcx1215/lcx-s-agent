---
name: fundamental-review-plan
description: "Materialize an action-oriented research plan from local fundamental review briefs"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-review-plan
metadata:
  {
    "openclaw":
      {
        "emoji": "📋",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Review Plan Hook

Consumes existing local `fundamental-review-brief` artifacts and emits a structured research work plan for deeper review, follow-up collection, and blocked monitoring.

## What It Does

When you run `/new` or `/reset`, this hook:

1. reads local `bank/fundamental/review-briefs/*.json`
2. falls back to `review-queue` and `risk-handoff` artifacts when a brief has not been persisted yet
3. writes a research-only work plan with target-level review goals, research questions, collection tasks, and blocker checks
4. keeps the output non-execution and non-approval

## Output

Writes these files:

- `<workspace>/bank/fundamental/review-plans/<manifest-id>.json`
- `<workspace>/memory/YYYY-MM-DD-fundamental-review-plan-<manifest-id>.md`

## Guardrail

This hook does not create approvals, vetoes, or execution instructions. It only turns review briefs into structured research work items for human follow-up.
