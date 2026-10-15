---
name: lcx-promotion-and-adapter-truth-operator
description: "Audit LCX model/adapter selection and promotion for the active profile; distinguish configured, latest-passing, promoted and runtime-loaded evidence."
metadata: { "openclaw": { "emoji": "🧩" } }
---

# LCX Promotion and Adapter Truth Operator

Read the [runtime contract](../_shared/lcx-runtime-contract.md).

1. Resolve the model, adapter, evaluation owner and entry currently selected. Distinguish configured, latest-passing, promoted and runtime-loaded state.
2. If the profile uses the local-brain adapter lane, inspect the current training-plan owner, then use `scripts/operator/local-brain-promotion-audit.ts` with the exact documented `--model`, worktree and guard-log inputs. Its old default is not an active-model detector.
3. For another model/provider or a lane without adapters, use its existing selection/quality owner or report not-applicable/unsupported. Do not substitute a legacy local-model audit.
4. Report raw-clean versus parseRecovered output, challenger readiness and the evidence age; a latest-passing resolver is not promotion.

No manual promotion, training, process termination, provider configuration or external-channel binding follows from an audit. Promotion does not itself establish deployment, actual execution or user-visible success.
