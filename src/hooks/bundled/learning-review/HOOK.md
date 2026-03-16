---
name: learning-review
description: "Save a structured learning review note to memory when a study-heavy session resets"
homepage: https://docs.openclaw.ai/automation/hooks#learning-review
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Learning Review Hook

Automatically turns study-heavy sessions into structured review notes in your workspace memory.

## What It Does

When you run `/new` or `/reset` after a learning-heavy session:

1. Finds the prior transcript
2. Detects whether the session looks like study/review/math work
3. Extracts the current topic and the latest working answer
4. Writes a compact review note to `memory/`

The goal is to make repeated study sessions accumulate into searchable memory, so future sessions can recall:

- what kind of problem you were working on
- what principle mattered
- what mistake pattern to watch for
- what tiny follow-up drill to do next

## Output

Creates a file like:

```text
<workspace>/memory/YYYY-MM-DD-review-<slug>.md
```

## Intended Use

This hook is especially useful for:

- math reasoning
- proofs
- probability/statistics
- derivations
- “复盘 / 查漏补缺 / where did I go wrong” sessions

If the session is not study-like, the hook does nothing.
