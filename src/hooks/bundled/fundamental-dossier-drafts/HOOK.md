---
name: fundamental-dossier-drafts
description: "Materialize research-only dossier drafts from dossier-ready fundamental target packets"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-dossier-drafts
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

# Fundamental Dossier Drafts Hook

Consumes dossier-ready local `fundamental-target-packets` artifacts and writes first-pass dossier drafts.

## What It Does

When you run `/new` or `/reset`, this hook:

1. reads local `bank/fundamental/target-packets/*.json`
2. ignores blocked or collection-only targets
3. writes dossier draft Markdown only for dossier-ready targets
4. keeps the output research-only and non-execution

## Output

Writes these files:

- `<workspace>/bank/fundamental/dossier-drafts/<manifest-id>.json`
- `<workspace>/bank/fundamental/drafts/<manifest-id>/*.md`
- `<workspace>/memory/YYYY-MM-DD-fundamental-dossier-drafts-<manifest-id>.md`

## Guardrail

This hook does not finalize research conclusions, change approvals, or trigger execution. It only turns dossier-ready packets into concrete writing starters.
