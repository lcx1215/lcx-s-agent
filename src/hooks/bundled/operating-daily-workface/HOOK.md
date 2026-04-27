---
name: operating-daily-workface
description: "Write one daily Lobster workface dashboard artifact with yesterday's learning, corrections, anomalies, scorecard context, and token usage"
homepage: https://docs.openclaw.ai/automation/hooks#operating-daily-workface
metadata:
  {
    "openclaw":
      {
        "emoji": "🦞",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Operating Daily Workface Hook

Writes one compact daily dashboard-style artifact that shows what Lobster learned yesterday, what it corrected, what drifted, and how much model usage it consumed.

## What It Does

When you run `/new` or `/reset`, this hook:

1. scans yesterday's learning reviews and learning-council artifacts
2. scans yesterday's correction notes and watchtower anomalies
3. pulls the latest portfolio-answer scorecard when present
4. aggregates yesterday's token usage plus a short 7-day token trend
5. writes one compact daily workface dashboard note to `memory/`

## Output

Creates:

- `<workspace>/memory/YYYY-MM-DD-lobster-workface.md`

## Guardrails

- This is a supervision and operating artifact, not an execution artifact.
- It does not rewrite doctrine, memory ranking, or production behavior.
- It exists to make Lobster easier to use, easier to supervise, and easier to improve over time.
