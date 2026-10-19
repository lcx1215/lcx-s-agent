---
name: l5-regression-batterer
description: "Run LCX's bounded local routing, Skill, doctrine and recovery contract battery after relevant changes; no universal model or finance evaluation."
metadata: { "openclaw": { "emoji": "🧪" } }
---

# L5 Regression Batterer

Read the [runtime contract](../_shared/lcx-runtime-contract.md). The name is retained for existing routing; this is a deterministic contract battery.

1. Use for shared routing/doctrine/Skill/status changes or an explicit L5 battery request. Check the affected lane and avoid duplicating an already running identical battery.
2. Resolve the wrapper from this loaded Skill directory, inspect its actual test targets, then run `scripts/l5-regression-batterer.sh --local` from the selected checkout.
3. The wrapper runs doctrine consistency, context recovery, Skill autocue/loading and contract tests. It starts no training or live-channel action.
4. Report failed prerequisites, optional-profile gaps and test results separately. Choose targeted tests instead when the change does not touch this battery's contracts.

This battery does not prove current market strategy, model-weight learning, promotion, order safety, deployment or visible delivery. Preserve the active scheduler/account and existing execution gates.
