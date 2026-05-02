---
name: ml-research-loop
description: Adapt Hugging Face ml-intern style ML research loops into safe local research plans, experiment briefs, evaluation receipts, and report handoffs without running third-party code.
metadata: { "openclaw": { "emoji": "🧪" } }
---

# ml-research-loop

Use this skill when the user asks LCX Agent to learn or reproduce a machine-learning method, post-training idea, model-evaluation workflow, or research-engineering pattern.

This is a local adaptation inspired by Hugging Face `ml-intern`. It is not a vendored copy, runtime integration, or permission to install and execute that project.

## Goal

Turn an ML research task into a bounded, auditable loop:

1. define the research question
2. collect safe source material
3. extract the method and assumptions
4. design a small experiment or evaluation plan
5. state required data, compute, and tools
6. record expected artifacts and acceptance criteria
7. write a report handoff with limitations and next steps

The output should improve LCX Agent's research judgment. It should not silently start GPU jobs, install packages, clone-run repositories, or mutate production Lark/Feishu behavior.

## When To Use

Use this skill for requests like:

- "learn this ML paper and tell me how to reproduce the method"
- "study a post-training workflow and make it useful for our agent"
- "turn this Hugging Face / arXiv / GitHub ML project into a safe experiment plan"
- "compare a model-evaluation technique and decide whether it belongs in our learning brain"
- "produce a research handoff from papers, datasets, code structure, and results"

Do not use it for ordinary Lark language routing, daily finance summaries, or direct trading recommendations.

## Safe Intake

Before planning work, classify the source:

| Source type                      | Allowed intake                                                       | Not allowed                                        |
| -------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| Paper / blog                     | summarize method, assumptions, metrics, limitations                  | invent missing results                             |
| GitHub repo                      | read README-level summary or selected files when explicitly reviewed | clone-run untrusted code by default                |
| Hugging Face Space/model/dataset | describe public metadata and intended workflow                       | download large models or datasets without approval |
| Local file                       | extract method and produce plan                                      | overwrite source or protected memory               |

If source material is incomplete, mark fields as low-confidence instead of filling gaps.

## Research Loop Contract

Produce these sections for a durable handoff:

- `objective`: what the user wants to learn or reproduce
- `source_material`: URLs, local files, or pasted excerpts used
- `method_summary`: method in plain language
- `assumptions`: data, model, compute, environment, and evaluation assumptions
- `experiment_plan`: smallest safe reproduction or evaluation step
- `artifacts_expected`: files, tables, plots, receipts, or notes that should exist if successful
- `acceptance_criteria`: what would count as `application_ready` versus `needs_more_evidence`
- `risk_review`: leakage, overfitting, benchmark mismatch, compute cost, dependency risk
- `handoff`: what LCX Agent should remember, downrank, or follow up on

## Output Status

End every run with one status:

- `application_ready`: the method is understood well enough to apply as a bounded LCX research pattern
- `experiment_ready`: the method needs a local experiment before application
- `source_insufficient`: the source is too thin or ambiguous
- `blocked_safety`: the request requires unsafe install, clone-run, secret use, or external execution
- `not_relevant`: the method does not improve LCX Agent's research or learning loop

## Boundaries

- Do not claim live Lark/Feishu verification from this skill.
- Do not claim a model was trained unless a real local or approved remote run produced a receipt.
- Do not install dependencies, clone-run repos, start GPU jobs, or call paid APIs without explicit operator approval.
- Do not write to `memory/current-research-line.md` or `memory/unified-risk-view.md`.
- Do not turn ML benchmark results into finance/trading claims.
- Do not confuse a research plan with a completed experiment.

## Relation To Existing LCX Skills

- Use `frontier-research` for paper-method review.
- Use this skill when paper review must become an experiment or report handoff.
- Use `external-skills-registry` to audit, list, or remove this skill.
- Use finance-learning tools only after the method is translated into a finance-safe local source or capability candidate.

## Validation

The skill is intentionally instruction-only. Validate with:

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/ml-research-loop
```

Uninstall with:

```bash
rm -rf skills/ml-research-loop
```
