---
name: fundamental-snapshot
description: "Materialize a minimal fundamental snapshot from local manifest, readiness, and snapshot-input artifacts"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-snapshot
metadata:
  {
    "openclaw":
      {
        "emoji": "🪪",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Snapshot Hook

Consumes the existing fundamental manifest, readiness, and snapshot-input artifacts and emits a minimal, structured `fundamental_snapshot`.

## What It Does

When you run `/new` or `/reset`, this hook:

1. reads local manifest, readiness, and snapshot-input artifacts
2. summarizes target-level document coverage and source coverage
3. marks evidence readiness level and scoring gate state
4. writes a minimal `fundamental_snapshot` JSON plus a memory note

## Output

Writes these files:

- `<workspace>/bank/fundamental/snapshots/<manifest-id>.json`
- `<workspace>/memory/YYYY-MM-DD-fundamental-snapshot-<manifest-id>.md`

## Guardrail

This hook does not build scores, extract claims from documents, or pretend research is finished. It only creates the smallest structured snapshot needed for downstream consumers to decide whether scoring is blocked, partial, or allowed.
