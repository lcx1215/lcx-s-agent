---
name: fundamental-target-workfiles
description: "Materialize per-target dossier, collection, and hold workfiles from local fundamental target packets"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-target-workfiles
metadata:
  {
    "openclaw":
      {
        "emoji": "🗂️",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Target Workfiles Hook

Consumes existing local `fundamental-target-packets` artifacts and writes per-target dossier, collection, and hold workfiles.

## What It Does

When you run `/new` or `/reset`, this hook:

1. reads local `bank/fundamental/target-packets/*.json`
2. falls back to upstream fundamental review artifacts when packets have not been persisted yet
3. writes per-target Markdown workfiles for deeper review dossiers, follow-up collection, and blocked holds
4. keeps the output non-execution and non-approval

## Output

Writes these files:

- `<workspace>/bank/fundamental/target-workfiles/<manifest-id>.json`
- `<workspace>/bank/fundamental/workfiles/<manifest-id>/**/*.md`
- `<workspace>/memory/YYYY-MM-DD-fundamental-target-workfiles-<manifest-id>.md`

## Guardrail

This hook does not create approvals, vetoes, or execution instructions. It only turns target packets into concrete human research workfiles.
