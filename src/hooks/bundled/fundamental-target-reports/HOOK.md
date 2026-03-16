---
name: fundamental-target-reports
description: "Materialize research-only target reports from dossier-ready fundamental target packets"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-target-reports
metadata:
  {
    "openclaw":
      {
        "emoji": "📄",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Target Reports Hook

Consumes dossier-ready local `fundamental-target-packets` artifacts and writes more formal target reports.

## What It Does

When you run `/new` or `/reset`, this hook:

1. reads local `bank/fundamental/target-packets/*.json`
2. ignores blocked or collection-only targets
3. writes report Markdown only for dossier-ready targets
4. keeps the output research-only and non-execution

## Output

Writes these files:

- `<workspace>/bank/fundamental/target-reports/<manifest-id>.json`
- `<workspace>/bank/fundamental/reports/<manifest-id>/*.md`
- `<workspace>/memory/YYYY-MM-DD-fundamental-target-reports-<manifest-id>.md`

## Guardrail

This hook does not finalize approvals, ratings, or execution state. It only turns dossier-ready packets into concrete research reports.
