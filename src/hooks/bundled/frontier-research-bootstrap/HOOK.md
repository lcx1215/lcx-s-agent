---
name: frontier-research-bootstrap
description: "Inject recent frontier research cards and weekly methods reviews into bootstrap context"
homepage: https://docs.openclaw.ai/automation/hooks#frontier-research-bootstrap
metadata:
  {
    "openclaw":
      {
        "emoji": "🗂️",
        "events": ["agent:bootstrap"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Frontier Research Bootstrap Hook

Injects recent frontier research memory into agent bootstrap context.

## What It Does

During `agent:bootstrap`, this hook:

1. scans `memory/` for the latest weekly methods review
2. loads the newest frontier research cards
3. composes them into a compact synthetic context block
4. injects that block into bootstrap context

This helps later paper or methods sessions begin with recent verdicts, leakage warnings,
and replication candidates already in view.
