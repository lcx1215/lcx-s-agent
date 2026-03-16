---
name: fundamental-risk-handoff
description: "Materialize a minimal downstream risk-handoff artifact from local fundamental scoring gates"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-risk-handoff
metadata:
  {
    "openclaw":
      {
        "emoji": "🛂",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Risk Handoff Hook

Consumes the existing local `fundamental-scoring-gate` artifacts and emits a minimal downstream handoff object for later controlled risk-review consumers.

## What It Does

When you run `/new` or `/reset`, this hook:

1. reads local `bank/fundamental/scoring-gates/*.json`
2. converts scoring decisions into explicit downstream handoff decisions
3. preserves missing-input, metadata-confidence, and fallback-exposure context
4. writes a structured risk-handoff JSON plus a memory note

## Output

Writes these files:

- `<workspace>/bank/fundamental/risk-handoffs/<manifest-id>.json`
- `<workspace>/memory/YYYY-MM-DD-fundamental-risk-handoff-<manifest-id>.md`

## Guardrail

This hook does not create a true risk audit, veto/approve assets, or override blocked upstream evidence states. It only produces the smallest structured handoff summary that says which targets are ready, partial, or blocked for later controlled risk review.
