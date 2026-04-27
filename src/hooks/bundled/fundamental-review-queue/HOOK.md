---
name: fundamental-review-queue
description: "Materialize a non-execution research decision queue from local fundamental risk handoffs"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-review-queue
metadata:
  {
    "openclaw":
      {
        "emoji": "🧭",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Review Queue Hook

Consumes existing local `fundamental-risk-handoff` artifacts and emits a lightweight research decision layer for deeper review, blocked items, and follow-up material collection.

## What It Does

When you run `/new` or `/reset`, this hook:

1. reads local `bank/fundamental/risk-handoffs/*.json`
2. converts handoff decisions into review-queue actions and priorities
3. separates watchlist candidates, blocked targets, follow-up items, and missing-document requests
4. writes a structured review-queue JSON plus a memory note

## Semantic Contract

This hook is the root interpreter for manifest-level `artifact_error` blocking and
recovery across the current fundamental review chain:

- `fundamental-review-queue`
- `fundamental-review-brief`
- `fundamental-review-plan`
- `fundamental-review-workbench`

The enforced contract is:

- blocking and recovery are always scoped to the same `manifestId`
- recovery only clears blocking when the recovery artifact `generatedAt` is
  strictly newer than the latest artifact error `lastSeenAt`
- equal timestamps remain ambiguous and must stay blocked
- file existence alone must never clear blocking

Seam-by-seam tests were not sufficient on their own. An end-to-end integration
test exposed a real bug where the queue materializer rebuilt entries from
`risk-handoff` plus ad-hoc blocked rows instead of reusing the same fallback
semantics that downstream consumers rely on. That let a false happy path slip
through even though the per-seam helpers were already correct.

Future contributors must not reintroduce a separate queue materialization path.
`review-queue` must reuse the same fallback/materialization semantics that the
rest of the chain consumes, otherwise blocked/recovered state can diverge across
the persisted artifacts.

## Output

Writes these files:

- `<workspace>/bank/fundamental/review-queues/<manifest-id>.json`
- `<workspace>/memory/YYYY-MM-DD-fundamental-review-queue-<manifest-id>.md`

## Guardrail

This hook is not an execution consumer and not an asset approval engine. It only drives downstream research decisions such as deeper review, missing-material follow-up, and blocked-item visibility.
