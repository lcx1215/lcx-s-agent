---
name: lark-understanding
description: Improve Feishu/Lark control-room language understanding by adding semantic-family routing, real utterance corpora, regression tests, and dev-vs-live truth boundaries instead of one-off phrase patches.
metadata: { "openclaw": { "emoji": "🧭" } }
---

# lark-understanding

Use this skill when improving how Lobster understands natural-language requests in the Feishu/Lark control room.

The goal is not to make the bot sound smarter. The goal is to reliably classify a real user utterance into the right semantic family, decide the right work surface or truth surface, and keep the reply honest about what is dev-fixed versus live-fixed.

## Core Rule

Work by semantic family, not by individual sentence.

Every change should answer four questions:

1. What family of user intent is this?
2. Which existing surface, role, command, or tool path should own it?
3. What real utterance examples prove the family boundary?
4. What regression test prevents the family from drifting next time?

## Default Workflow

1. Collect at least three representative utterances for the family.
2. Name the family in plain English and map it to one target surface:
   - `control_room`
   - `learning_command`
   - `technical_daily`
   - `fundamental_research`
   - `knowledge_maintenance`
   - `ops_audit`
   - a protocol truth family in `src/auto-reply/reply/commands-protocol-families.ts`
3. Add or refine matcher logic only after the family boundary is clear.
4. Add regression coverage in `extensions/feishu/src/real-utterances-regression.test.ts`.
5. If the family is a truth-surface question, add content coverage in `src/auto-reply/reply/commands-protocol-info.test.ts`.
6. State the fixed Feishu/Lark acceptance phrase for live verification.

## Use Semantic Routing When Regex Slows Down

Regex and phrase lists are acceptable as a deterministic fallback, but they should not remain the only growth path once a family has many paraphrases.

When phrase expansion starts to repeat, prefer this next shape:

- keep a canonical utterance corpus per family
- run current deterministic matchers first
- use embedding or nearest-neighbor semantic routing as a candidate family selector
- require thresholds and fallback-to-unknown behavior
- keep all accepted classifications under regression tests

Good inspiration from the public ecosystem:

- Anthropic-style Agent Skills: reusable folders of instructions, scripts, and resources.
- Semantic Router: fast vector-based intent routing before tool or agent selection.
- Promptfoo-style evals: prompt and output regression tests, including similarity and rubric checks.
- OpenAI Agents SDK and LangGraph: useful later for explicit handoffs, guardrails, traces, and specialist orchestration.

Do not import a large orchestration framework just to classify Lark language. First build the corpus and eval loop.

## Required Boundaries

- Do not claim a live Lark behavior is fixed until build, restart, probe, and a real Lark entry are verified.
- Do not turn a dev truth surface into a fake live proof.
- Do not create a new command when an existing status, context, help, protocol, or surface route can answer the request.
- Do not promote speculative finance or market claims into durable memory from a language-routing change.
- Do not touch protected summaries such as `memory/current-research-line.md` or `memory/unified-risk-view.md` for this skill.

## Acceptance Format

After a patch, report:

- semantic family added or tightened
- representative utterances covered
- target surface or protocol family
- tests run
- live acceptance phrase still needed
