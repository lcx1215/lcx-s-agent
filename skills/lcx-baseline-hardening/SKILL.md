---
name: lcx-baseline-hardening
description: "Repair a verified LCX failure family through the existing owner, with a minimal coherent change and risk-matched regression evidence."
metadata: { "openclaw": { "emoji": "🧩" } }
---

# LCX Baseline Hardening

Read the [runtime contract](../_shared/lcx-runtime-contract.md). Use for a verified repeated failure, silent failure, or shared recovery/status contract.

1. Identify the failure family, existing owner, previous repairs and exact affected paths. Use `scripts/operator/lcx-change-impact-plan.ts --json` when selecting verification lanes.
2. Before creating anything new, check whether a similar mechanism exists. Reuse, merge, or extend it. Repair the failure family with the smallest coherent system upgrade over a symptom-only patch; preserve unrelated work.
3. Record the original example, abstracted failure family, adjacent non-identical scenario, shared contract and regression proof when behavior changed.
4. Run focused owner tests and the risk-required type/lint check, then review the scoped diff and `git diff --check`.
5. Verify the actual entry or natural receipt when the claim concerns runtime behavior; unit tests do not replace deployment or execution proof.

Provider configuration, protected memory, training, external sends and trading execution retain their separate authorities. A passing test does not erase a stale or failed owner receipt.
