---
name: operating-loop
description: "Write daily operating artifacts, a weekly learning loop, and a unified methods-only risk view from current memory notes"
homepage: https://docs.openclaw.ai/automation/hooks#operating-loop
metadata:
  {
    "openclaw":
      {
        "emoji": "📒",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Operating Loop Hook

Creates lightweight daily and weekly operating artifacts on top of the existing memory pipeline.

## What It Does

When you run `/new` or `/reset`, this hook:

1. reads the current transcript
2. merges it with current `session-memory`, `learning-review`, and `frontier-research` notes
3. writes daily operating logs, a weekly learning loop, and a stable unified risk view

## Output

Writes these files under `<workspace>/memory/`:

- `YYYY-MM-DD-intake-log.md`
- `YYYY-MM-DD-fetch-log.md`
- `YYYY-MM-DD-review-log.md`
- `YYYY-MM-DD-branch-summary.md`
- `YYYY-MM-DD-risk-audit-snapshot.md`
- `YYYY-Www-weekly-learning-loop.md`
- `unified-risk-view.md`

## Guardrail

The unified risk view is intentionally methods-only. It does not invent asset approvals, vetoes, or execution-level risk state when those inputs do not exist in the repo.
