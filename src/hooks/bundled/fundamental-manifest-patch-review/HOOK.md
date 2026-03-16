---
name: fundamental-manifest-patch-review
description: "Review proposal-only fundamental manifest patches before any manual collection work"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-manifest-patch-review
metadata:
  {
    "openclaw":
      {
        "emoji": "🧾",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Manifest Patch Review Hook

Consumes proposal-only collection manifest patches and writes a research-side review artifact.

## What It Does

When you run `/new` or `/reset`, this hook:

1. finds collection patch proposals from local fundamental target packets
2. checks whether target directories exist and whether metadata sidecars remain required
3. classifies each patch into collection-first, metadata-repair-first, or manual-review-first
4. writes a review JSON plus a memory note

## Output

Writes these files:

- `<workspace>/bank/fundamental/manifest-patch-reviews/<manifest-id>.json`
- `<workspace>/memory/YYYY-MM-DD-fundamental-manifest-patch-review-<manifest-id>.md`

## Guardrail

This hook does not apply patches or update manifests. It only reviews proposal-only patch objects.
