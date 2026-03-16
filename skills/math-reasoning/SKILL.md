---
name: math-reasoning
description: Structured math reasoning and learning-review workflow for proofs, derivations, probability, algebra, calculus, and quantitative sanity checks. Use when the user asks to solve, verify, explain, or review math-heavy reasoning.
metadata: { "openclaw": { "emoji": "∑" } }
---

# math-reasoning

Use this skill when the task is math-heavy and correctness matters more than speed:

- solving equations or symbolic manipulations
- proofs or proof sketches
- probability / statistics reasoning
- calculus / linear algebra / optimization
- quantitative finance reasoning that depends on formulas, not only narrative intuition
- reviewing where a prior solution went wrong

## Goal

Produce answers that are:

- stepwise
- checkable
- explicit about assumptions
- sanity-checked at the end

If the user wants learning or review, also turn the solution into a compact “what to remember next time” note.

## Core workflow

1. Restate the problem precisely.
2. List givens, unknowns, constraints, and notation.
3. Choose the method before calculating.
4. Solve in small steps with enough algebra shown to audit the jumps.
5. Verify the result:
   - substitute back if possible
   - check units, signs, ranges, monotonicity, or edge cases
   - compare against an intuitive estimate
6. End with the final answer in one compact block.

Do not jump straight from problem statement to final answer when the intermediate logic matters.

## Reasoning style

- Prefer exact symbolic reasoning before approximation.
- State approximation assumptions explicitly.
- If there are multiple valid methods, pick one and briefly name the alternative.
- If the result depends on a theorem or identity, name it.
- If you are not certain, say exactly which step is uncertain instead of bluffing.

## Learning / review mode

When the user is studying, practicing, or asks for复盘/查漏补缺/错因分析, append a short review note with these fields:

- `mistake_pattern`: what typically goes wrong here
- `core_principle`: the one principle to remember
- `micro_drill`: one tiny follow-up exercise
- `transfer_hint`: where else this pattern shows up

Keep this review note compact and concrete.

## Memory-aware behavior

If the user refers to earlier attempts, prior mistakes, or “what I got wrong last time”, first use memory tools if available:

- search memory for prior math notes or review notes
- pull only the relevant snippet
- then compare the current problem against the prior mistake pattern

If memory tools are not available, say that briefly and continue with the current problem.

## Output templates

### Standard solve

```text
Problem
- ...

Setup
- Givens: ...
- Unknown: ...
- Method: ...

Solution
1. ...
2. ...
3. ...

Checks
- ...
- ...

Final answer
- ...
```

### Study / review

```text
Result
- ...

Why this works
- ...

Review note
- mistake_pattern: ...
- core_principle: ...
- micro_drill: ...
- transfer_hint: ...
```

## Guardrails

- Do not fabricate theorem names, identities, or citations.
- Do not hide a failed derivation behind polished prose.
- Do not over-round intermediate values when precision affects the conclusion.
- For probability/statistics, define the random variable or event before computing.
- For proofs, distinguish assumptions from derived statements.

## Companion template

If you want a reusable note skeleton for a session summary or spaced review, use:

- `skills/math-reasoning/templates/review-note.md`
