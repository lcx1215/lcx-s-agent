---
name: semantic-routing
description: Design or improve semantic intent routing for agents, Lark/Feishu messages, tool selection, specialist handoffs, or utterance-family classification. Use this before adding many regex phrases or one-off natural-language matchers.
metadata: { "openclaw": { "emoji": "🧭" } }
---

# semantic-routing

Use this skill when a user phrase can be paraphrased many ways and the system needs to choose a route, tool, specialist, or truth surface.

## Goal

Turn brittle phrase matching into a small routing contract:

- canonical intent families
- representative utterances
- deterministic fallbacks
- optional embedding or nearest-neighbor candidate routing
- thresholds and `unknown` behavior
- regression coverage

## Workflow

1. Inventory the current deterministic route:
   - matcher function
   - target surface or tool
   - tests that already cover it
2. Define the semantic family:
   - one family name
   - three to eight positive utterances
   - two near-miss utterances that must not match
3. Keep existing exact/regex matchers as the first pass when they are precise.
4. Add a semantic candidate layer only when phrase growth is repetitive:
   - compare against canonical utterances
   - require a confidence threshold
   - return `unknown` below threshold
   - never silently route low-confidence finance or live-operation requests
5. Add regression tests for both positive and near-miss utterances.

## Routing Contract

For every family, write down:

- `family`
- `target`
- `positive_utterances`
- `near_misses`
- `fallback`
- `proof_test`
- `live_acceptance_phrase` if Feishu/Lark-visible

## Guardrails

- Do not replace clear deterministic routing with an opaque model call.
- Do not let semantic similarity override protected truth boundaries.
- Do not route financial research, live operations, or memory writes on low confidence.
- Prefer a visible `unknown` or clarification path over a confident wrong route.

## Public Patterns Reviewed

- `aurelio-labs/semantic-router`: route by semantic meaning before tool or agent selection.
- OpenAI Agents SDK handoffs and guardrails: useful later for explicit specialist delegation.
- LangGraph supervisor/swarm patterns: useful later for multi-agent orchestration, not required for first-pass routing.
