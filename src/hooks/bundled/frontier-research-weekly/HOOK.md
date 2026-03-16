---
name: frontier-research-weekly
description: "Aggregate recent frontier research cards into a weekly methods review"
homepage: https://docs.openclaw.ai/automation/hooks#frontier-research-weekly
metadata:
  {
    "openclaw":
      {
        "emoji": "📚",
        "events": ["command:new", "command:reset"],
        "install": [{ "id": "bundled", "kind": "bundled" }],
      },
  }
---

# Frontier Research Weekly

Builds a weekly methods review from recent frontier research cards so later sessions
can reuse verdicts, recurring risks, and replication candidates rather than starting fresh.
