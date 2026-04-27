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

It also writes a weekly cumulative `learning-long-term-catalog` note that keeps all
captured learning topics visible for later retrieval without promoting every topic into
top-level working memory by default.

It also writes a weekly cumulative `learning-durable-skills` note that keeps math,
quant, and coding lessons in reusable form so they can be applied again instead of
being remembered only as one-off study traces.

It also writes a weekly cumulative `learning-trigger-map` note that turns those
skills into reusable trigger cues for later tasks.

It also writes a weekly cumulative `learning-rehearsal-queue` note that keeps the
highest-priority repetition plan visible so learned methods get reused instead of
only archived.

It also writes a weekly cumulative `learning-transfer-bridges` note that keeps the
best cross-domain reuse routes visible so learned methods can transfer into later
research and system work.

It also writes a weekly cumulative `learning-relevance-gate` note that ranks which
learned skills should be pulled strongly, weakly, or only as reference in later work.
