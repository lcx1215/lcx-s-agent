---
name: learning-review-weekly
description: "Aggregates recent learning review notes into a weekly study summary and a short upgrade prompt."
homepage: https://docs.openclaw.ai/automation/hooks#learning-review-weekly
metadata:
  {
    "openclaw":
      {
        "emoji": "🗓️",
        "events": ["command:new", "command:reset"],
        "install": [{ "id": "bundled", "kind": "bundled" }],
      },
  }
---
# Learning Review Weekly

Builds a weekly study summary from recent `learning-review` notes so future sessions
can reuse higher-level patterns instead of only per-session traces.

It also writes a shorter weekly `learning-upgrade` prompt that distills the top failure
to avoid, the method to default to, the next topic to reinforce, and the next micro-drill.
