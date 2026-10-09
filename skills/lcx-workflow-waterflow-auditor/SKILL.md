---
name: lcx-workflow-waterflow-auditor
description: "Audit current LCX workflow and Harness closure, feedback, recovery and evidence owners; a healthy graph does not prove trading, learning or channel delivery."
metadata: { "openclaw": { "emoji": "🧩" } }
---

# Workflow Waterflow Auditor

Read the current [repository contract](../../AGENTS.md) and, for finance,
the [lifecycle owner map](../../ops/architecture/finance-automatic-lifecycle-owner-map.md).

1. Resolve the request's entry and existing owner. Use `scripts/operator/lcx-problem-cluster-radar.ts --json` for relevant cross-lane clusters.
2. Select only required checks, such as `scripts/operator/lcx-mind-model.ts`, `scripts/operator/lcx-flow-graph.ts` or `scripts/operator/lcx-head-tail-consistency.ts`; avoid repeating overlapping audits.
3. Trace rule → workflow → evidence → consumer → feedback. Central Harness closure needs its actual perception/proposal/gate/action/feedback receipts. Paper closure separately needs authorized intent, broker order/fill, reconciliation and canonical book evidence.
   Follow one concrete candidate through the existing model/tool loop: supplied
   evidence → specific doubt → selected tool → consumed result → judgment → outcome.
   Do not require unrelated research stages or add a parallel orchestration path.
   Retain short reasons, source references, useful partial evidence and explicit
   gaps; retrieve full supporting fields only when needed.
4. Report a missing head rule, workflow entrypoint, proof surface, boundary flag or feedback consumer and name its owner. Do not create a second dashboard or authority.

Governance is local-only observability. A graph does not prove model-weight absorption, automatic execution, external-channel binding or user-visible behavior. Optional model/channel absence is scoped degradation, not an invented universal dependency.
