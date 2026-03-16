---
name: fundamental-scoring-gate
description: "Materialize a minimal scoring-gate input from local fundamental snapshots"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-scoring-gate
metadata:
  {
    "openclaw":
      {
        "emoji": "🚧",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Scoring Gate Hook

Consumes the existing local `fundamental_snapshot` artifacts and emits a minimal scoring-gate input for downstream controlled consumers.

## What It Does

When you run `/new` or `/reset`, this hook:

1. reads local `bank/fundamental/snapshots/*.json`
2. converts snapshot target states into explicit scoring decisions
3. preserves missing-input and fallback-exposure reasons
4. writes a structured scoring-gate JSON plus a memory note

## Output

Writes these files:

- `<workspace>/bank/fundamental/scoring-gates/<manifest-id>.json`
- `<workspace>/memory/YYYY-MM-DD-fundamental-scoring-gate-<manifest-id>.md`

## Guardrail

This hook does not compute scores, infer evidence from raw documents, or clear risk review. It only produces the smallest structured gate that says which targets are blocked, partial, or allowed to enter later scoring consumers.
