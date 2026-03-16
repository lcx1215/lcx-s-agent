---
name: fundamental-collection-follow-up-tracker
description: "Track research-only collection gaps, missing metadata, and next collection actions from fundamental review outputs"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-collection-follow-up-tracker
metadata:
  {
    "openclaw":
      {
        "emoji": "📌",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Collection Follow-Up Tracker Hook

Consumes local `fundamental-review-memo` and collection follow-up artifacts and turns them into a concise tracker for missing materials and next collection actions.

## What It Does

When you run `/new` or `/reset`, this hook:

1. reads local `bank/fundamental/review-memos/*.json` and `bank/fundamental/collection-packets/*.json`
2. falls back to target packets and manifest patch review inputs when needed
3. writes a tracker for follow-up targets and blocked targets only
4. skips manifests that are already report-ready with no collection follow-up state

## Output

Writes these files:

- `<workspace>/bank/fundamental/collection-follow-up-trackers/<manifest-id>.json`
- `<workspace>/bank/fundamental/follow-up-trackers/<manifest-id>.md`
- `<workspace>/memory/YYYY-MM-DD-fundamental-collection-follow-up-tracker-<manifest-id>.md`

## Guardrail

This hook does not approve collection, apply manifest patches, or create execution state. It only tracks research-only collection gaps and next actions.
