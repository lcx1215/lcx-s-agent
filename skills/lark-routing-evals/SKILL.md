---
name: lark-routing-evals
description: Build and run Feishu/Lark utterance routing regression evals. Use when improving Lark control-room understanding, adding semantic families, validating matcher changes, or checking that real user phrases route to the right surface without dev/live truth drift.
metadata: { "openclaw": { "emoji": "✅" } }
---

# lark-routing-evals

Use this skill whenever Lark language understanding changes need proof beyond a few hand-picked examples.

## Goal

Make Lark understanding measurable:

- real utterance corpus
- expected semantic family
- expected target surface
- near-miss cases
- truth-boundary checks
- regression tests that fail before behavior drifts

## Default Eval Shape

Each case should contain:

- `id`
- `utterance`
- `expected_surface`
- `expected_family`
- `must_not_route_to`
- `truth_boundary`
- `notes`

Keep the corpus small and high-signal first. Add breadth only after the family boundary is stable.

## Workflow

1. Add new utterances to the existing real-utterance regression test when possible.
2. Cover both obvious examples and messy real phrases.
3. Include near-misses that share keywords but require a different route.
4. Test the current deterministic matcher before introducing semantic routing.
5. If a prompt/eval harness is added later, keep it secondary to the repo's TypeScript regression tests.

## Useful Existing Anchors

- `extensions/feishu/src/real-utterances-regression.test.ts`
- `extensions/feishu/src/intent-matchers.ts`
- `extensions/feishu/src/surfaces.ts`
- `src/auto-reply/reply/commands-protocol-families.ts`
- `src/auto-reply/reply/commands-protocol-info.test.ts`

## Guardrails

- Do not count a dev regression pass as live Lark proof.
- Do not add a family without near-miss coverage when the route touches finance, memory, learning, or operations.
- Do not let a generic "help" route swallow specific truth-surface or learning-command requests.
- Do not create huge eval files before the classification contract is clear.

## Public Patterns Reviewed

- Promptfoo: useful model/prompt regression patterns such as exact checks, similarity checks, rubric checks, and CSV-driven tests.
- Anthropic skill-creator eval guidance: trigger tests should include should-trigger and near-miss should-not-trigger prompts.
