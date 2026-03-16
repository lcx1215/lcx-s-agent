---
name: fundamental-review-memo
description: "Summarize target reports and collection packets into a single research-only fundamental review memo"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-review-memo
metadata:
  {
    "openclaw":
      {
        "emoji": "🗒️",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Review Memo Hook

Consumes local `fundamental-target-reports` and `fundamental-collection-packets` outputs and turns them into one research-only memo.

## What It Does

When you run `/new` or `/reset`, this hook:

1. reads local `bank/fundamental/target-reports/*.json` and `bank/fundamental/collection-packets/*.json`
2. falls back to upstream fundamental target packet and manifest patch review artifacts when needed
3. writes a single memo that separates report-review targets, collection follow-ups, and blocked targets
4. keeps the result research-only and non-execution

## Output

Writes these files:

- `<workspace>/bank/fundamental/review-memos/<manifest-id>.json`
- `<workspace>/bank/fundamental/memos/<manifest-id>.md`
- `<workspace>/memory/YYYY-MM-DD-fundamental-review-memo-<manifest-id>.md`

## Guardrail

This hook does not create approvals, ratings, or execution instructions. It only summarizes what should be reviewed, collected, or held next.
