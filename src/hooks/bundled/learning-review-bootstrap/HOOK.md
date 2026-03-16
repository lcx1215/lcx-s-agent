---
name: learning-review-bootstrap
description: "Inject recent learning review notes into bootstrap context for future study sessions"
homepage: https://docs.openclaw.ai/automation/hooks#learning-review-bootstrap
metadata:
  {
    "openclaw":
      {
        "emoji": "🧩",
        "events": ["agent:bootstrap"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Learning Review Bootstrap Hook

Injects recent learning review notes into the agent bootstrap context.

## What It Does

During `agent:bootstrap`, this hook:

1. scans `memory/` for the latest `learning-upgrade` prompt, latest weekly summary, and recent raw review notes
2. puts the short upgrade prompt first so the highest-value learning cue is seen earliest
3. composes everything into a compact synthetic context block
4. injects that block into bootstrap context

This helps later study sessions start with recent mistake patterns, core principles, weekly focus, and follow-up drills already in view.

## Output

No files are written.

The hook adds a synthetic bootstrap context entry equivalent to a temporary `memory.md` note.

## Intended Use

Enable this when you want:

- math practice to remember recent weak spots
- proofs/derivations to reuse prior review notes
- repeated learning sessions to compound rather than restart from zero
