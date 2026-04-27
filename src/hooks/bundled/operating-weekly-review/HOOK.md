---
name: operating-weekly-review
description: "Write one weekly Lobster operating review that summarizes learning, correction, and repair priorities"
homepage: https://docs.openclaw.ai/automation/hooks#operating-weekly-review
metadata:
  {
    "openclaw":
      {
        "emoji": "📆",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Operating Weekly Review Hook

Writes one compact weekly artifact that helps a human operator see whether Lobster is learning, drifting, or repeatedly breaking in the same places.

## What It Does

When you run `/new` or `/reset`, this hook:

1. scans recent correction notes
2. scans active repair-ticket candidates
3. links the current learning and frontier weekly reviews when present
4. writes one compact weekly operating review to `memory/`

## Output

Creates:

- `<workspace>/memory/YYYY-Www-lobster-weekly-review.md`

## Guardrails

- This is a supervision artifact, not an execution artifact.
- It does not rewrite memory, doctrine, or production behavior.
- It exists to make Lobster easier to supervise, easier to repair, and easier to improve over time.
