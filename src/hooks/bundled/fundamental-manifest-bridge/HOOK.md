---
name: fundamental-manifest-bridge
description: "Bridge local fundamental manifest scaffolds to evidence-readiness state using only local document presence"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-manifest-bridge
metadata:
  {
    "openclaw":
      {
        "emoji": "🧱",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Manifest Bridge Hook

Consumes existing local fundamental manifests and upgrades them from scaffold-only objects into explicit readiness state.

## What It Does

When you run `/new` or `/reset`, this hook:

1. reads `bank/fundamental/manifests/*.json`
2. scans only the local document workspace referenced by each manifest
3. updates per-target and aggregate readiness state
4. writes a readiness sidecar plus a memory note

## Output

Writes these files:

- `<workspace>/bank/fundamental/readiness/<manifest-id>.json`
- `<workspace>/memory/YYYY-MM-DD-fundamental-readiness-<manifest-id>.md`

It also updates the manifest JSON in place.

## Guardrail

This hook never fetches documents, searches the web, or invents evidence. It only reflects what already exists in the local document workspace.
