---
name: frontier-research
description: Structured research-methods workflow for frontier finance, quant, and AI papers. Use when the user asks to analyze a paper, whitepaper, research note, or method and turn it into a research card, verdict, and replication-oriented notes.
metadata: { "openclaw": { "emoji": "🧪" } }
---

# frontier-research

Use this skill when the task is about studying methods rather than making direct trading calls:

- frontier finance / quant / AI papers
- whitepapers or technical research notes
- model or factor proposals that need structured review
- deciding whether a method is worth archiving, monitoring, or reproducing
- producing a weekly methods review from several papers

## Goal

Convert method-heavy material into durable research artifacts that are easy to audit later:

- a `research_card`
- a verdict
- a list of adoptable ideas
- a list of replication and leakage risks
- optionally a `weekly_methods_review`

This skill is for **research and method evaluation**, not for direct trading decisions.

## Core operating model

Treat this work as a separate research board:

- `fundamental_research_branch` studies company and issuer evidence
- `market_research_branch` studies prices, microstructure, and technical state
- `macro_event_branch` studies macro and event evidence
- `frontier_research_branch` studies methods, papers, and experimental designs

Do not mix these axes:

- **research domain** = what question is being studied
- **source layer** = where evidence comes from

Premium financial databases are source adapters, not a higher-order research branch.

## Workflow

1. Identify the material type:
   - paper
   - whitepaper
   - technical blog
   - working notes
2. Restate the claimed problem and contribution in plain language.
3. Extract the method shape:
   - target
   - data setup
   - evaluation protocol
   - claimed results
4. Audit for fragility:
   - leakage
   - overfitting
   - proxy-target mismatch
   - non-stationarity
   - hidden implementation cost
5. Decide the verdict:
   - `archive_for_knowledge`
   - `watch_for_followup`
   - `worth_reproducing`
   - `ignore`
6. End with adoptable ideas that can transfer into Lobster without copying the paper blindly.

## Output contracts

### Research card

Use this structure:

- `title`
- `material_type`
- `problem_statement`
- `method_summary`
- `claimed_contribution`
- `data_setup`
- `evaluation_protocol`
- `key_results`
- `possible_leakage_points`
- `overfitting_risks`
- `replication_cost`
- `relevance_to_lobster`
- `adoptable_ideas`
- `do_not_copy_blindly`
- `verdict`

### Weekly methods review

Use this structure:

- `window`
- `papers_reviewed`
- `worth_reproducing`
- `watch_for_followup`
- `archive_for_knowledge`
- `ignore`
- `cross_paper_patterns`
- `methods_to_transfer`
- `replication_backlog`
- `open_questions`

## Research style

- Prefer precise, skeptical summaries over hype.
- Separate what the paper claims from what you infer.
- If the input is incomplete, say which fields are low-confidence.
- If numerical claims are missing, do not invent them.
- Highlight where a prediction target and a trading objective may be mismatched.
- Convert interesting ideas into small transferable principles instead of “ship the whole paper”.

## Guardrails

- Do not output trading decisions from this skill alone.
- Do not treat paper novelty as evidence of production readiness.
- Do not mix premium financial source evidence with paper-method evidence.
- Do not recommend replication without noting data needs, cost, and leakage risk.
- Do not hide uncertainty behind polished prose.

## Templates

Use these templates when you need durable artifacts:

- `skills/frontier-research/templates/research-card.md`
- `skills/frontier-research/templates/weekly-methods-review.md`
