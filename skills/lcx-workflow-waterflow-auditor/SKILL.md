---
name: lcx-workflow-waterflow-auditor
description: "Audit current LCX workflow and Harness closure, feedback, recovery and evidence owners; a healthy graph does not prove trading, learning or channel delivery."
metadata: { "openclaw": { "emoji": "🧩" } }
---

# Workflow Waterflow Auditor

Use the [repository contract](../../AGENTS.md) and finance
[owner map](../../ops/architecture/finance-automatic-lifecycle-owner-map.md).

1. Bind entry, original owner, full requested scope and useful outcome. Classify gaps:
   **behavior failure / evidence gap / natural-run dependency**. Record impact,
   needed proof and next action; absent proof is not a proven fault.
   Before treating behavior as a failure, check the exact owner's contract or
   runbook, relevant test invariants and targeted Git history for its purpose.
   Record expected versus observed behavior and practical impact. Classify it as
   **confirmed defect / intended blocking or tradeoff / obsolete design /
   external condition / unresolved intent**. A slow or blocked path alone is not
   a defect; missing rationale does not prove intentional design. History and
   passing tests do not override current requirements. Optimize obsolete designs
   with equivalent invariant checks; reclassify provisional findings as needed.
2. Prioritize decision availability, correct inputs, consumption and feedback.
   Follow one original call; retrieve precise evidence for concrete doubts.
   Avoid forced stages or new owners.
3. Trace input → process → consumer → judgment → outcome. Preserve identities and
   chronology. Same-field aliases, copied metadata, diagnostics and spliced attempts
   cannot prove consumption; valid hashes cannot prove adoption or source truth.
4. Reuse passed checks for unchanged source and retained evidence. Repeat only for
   relevant changes, failures or unresolved risks; avoid habitual inventories.
5. If successive edits only refine audits/metadata, reassess business value. Repair
   a verified consumer fault or obtain original proof; otherwise retain the gap.
   Never shrink scope or force external runs for green counts.
6. Separate structure, handoff, normal blocking and unobserved work. Distinguish
   local repair, runtime loading, natural adoption and economic results.
   Paper needs order/fill, reconciliation and book evidence.
