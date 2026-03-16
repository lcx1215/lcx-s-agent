---
name: fundamental-snapshot-bridge
description: "Generate minimal fundamental snapshot-input artifacts from local manifest and readiness state"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-snapshot-bridge
metadata:
  {
    "openclaw":
      {
        "emoji": "📦",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Snapshot Bridge Hook

Consumes local fundamental manifest and readiness artifacts and emits the smallest possible snapshot-input object for downstream fundamental snapshot work.

## What It Does

When you run `/new` or `/reset`, this hook:

1. reads local `bank/fundamental/manifests/*.json`
2. reads local `bank/fundamental/readiness/*.json`
3. determines which named targets satisfy the minimum snapshot-entry conditions
4. writes a snapshot-input sidecar plus a memory note with ready vs blocked targets

## Output

Writes these files:

- `<workspace>/bank/fundamental/snapshot-inputs/<manifest-id>.json`
- `<workspace>/memory/YYYY-MM-DD-fundamental-snapshot-bridge-<manifest-id>.md`

## Guardrail

This hook does not extract evidence, build scores, fetch documents, or pretend risk review is complete. It only declares whether a target is eligible to enter the controlled fundamental snapshot stage.
