---
name: memory-hygiene-weekly
description: "Write one weekly memory-hygiene report with provisional, rejected, anti-pattern, and trash ledgers, then prune only safe expired operating artifacts"
homepage: https://docs.openclaw.ai/automation/hooks#memory-hygiene-weekly
metadata:
  {
    "openclaw":
      {
        "emoji": "🧹",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Memory Hygiene Weekly Hook

Adds one disciplined storage-and-deletion pass so Lobster can remember useful things, quarantine weak things, and forget regenerable noise on purpose.

## What It Does

When you run `/new` or `/reset`, this hook:

1. scans recent provisional memory candidates such as correction notes and learning-council notes
2. scans recent rejected or failed-validation notes
3. extracts repeated bad patterns into anti-pattern records
4. writes one trash manifest with TTL metadata for safe-to-delete generated operating artifacts
5. prunes only expired low-value operating artifacts such as old daily workface notes

## Output

Creates:

- `<workspace>/memory/YYYY-Www-memory-hygiene-weekly.md`
- `<workspace>/memory/provisional/YYYY-Www-provisional-ledger.md`
- `<workspace>/memory/rejected/YYYY-Www-rejected-ledger.md`
- `<workspace>/memory/anti-patterns/YYYY-Www-anti-patterns.md`
- `<workspace>/bank/trash/YYYY-Www-trash-candidates.json`

## Guardrails

- Verified memory stays separate and is not rewritten here.
- Provisional or rejected material must not be treated as primary answer memory by default.
- Pruning is limited to regenerable operating artifacts with explicit TTL metadata.
- This hook does not introduce a new database or broad memory refactor.
