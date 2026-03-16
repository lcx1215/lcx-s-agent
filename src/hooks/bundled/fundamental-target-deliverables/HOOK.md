---
name: fundamental-target-deliverables
description: "Materialize terminal dossier skeletons, manifest patch proposals, and hold memos from local fundamental target packets"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-target-deliverables
metadata:
  {
    "openclaw":
      {
        "emoji": "📚",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Target Deliverables Hook

Consumes local `fundamental-target-packets` artifacts and writes first-pass terminal deliverables for research work.

## What It Does

When you run `/new` or `/reset`, this hook:

1. reads local `bank/fundamental/target-packets/*.json`
2. falls back to upstream fundamental review artifacts when packets have not been persisted yet
3. writes dossier skeletons for dossier-ready targets
4. writes proposal-only manifest patch JSON for follow-up collection targets
5. writes blocked hold memos for targets that still cannot advance

## Output

Writes these files:

- `<workspace>/bank/fundamental/target-deliverables/<manifest-id>.json`
- `<workspace>/bank/fundamental/deliverables/<manifest-id>/dossiers/*.md`
- `<workspace>/bank/fundamental/deliverables/<manifest-id>/manifest-patches/*.json`
- `<workspace>/bank/fundamental/deliverables/<manifest-id>/holds/*.md`
- `<workspace>/memory/YYYY-MM-DD-fundamental-target-deliverables-<manifest-id>.md`

## Guardrail

This hook does not apply manifest patches, create approvals, or trigger execution. It only turns target packets into concrete research deliverables and proposal-only collection artifacts.
