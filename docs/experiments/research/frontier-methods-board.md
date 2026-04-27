---
summary: "Architecture notes for a frontier-research board that studies papers and methods without acting as a trading branch"
read_when:
  - Designing Lobster research boards for finance, quant, or AI workflows
  - Separating research domains from source layers
  - Adding research cards, weekly methods reviews, or replication backlog artifacts
title: "Frontier Methods Board"
---

# Frontier Methods Board

Purpose: add a dedicated research board for frontier finance, quant, and AI methods without mixing it into execution, fundamental evidence, or premium source adapters.

## Core distinction

Do not mix these two dimensions:

- **research domain**: what problem is being studied
- **source layer**: where evidence comes from

That means:

- `fundamental_research_branch` is a research domain
- `market_research_branch` is a research domain
- `macro_event_branch` is a research domain
- `frontier_research_branch` is a research domain
- `premium_financial_source_adapter` is a source layer

Premium financial databases are not a special top-level branch. They are reusable source adapters that several research domains may consume.

## Recommended naming

If you want branch-style naming, use:

- `frontier_research_branch`

If you want to emphasize method study rather than topic coverage, use:

- `research_methods_board`

This doc uses `frontier_research_branch`, but the semantics are the same.

## What this board does

This board studies:

- frontier papers
- whitepapers
- technical research notes
- model proposals
- evaluation designs
- replication feasibility

This board does not:

- emit trading decisions
- replace fundamental, market, or macro evidence
- collapse papers and premium database evidence into one pool
- auto-promote a novel method into production

## Research domain x source layer matrix

| Research domain  | Public/Open | Local Manifest | Market API | Premium DB | Internal Knowledge | Papers |
| ---------------- | ----------- | -------------- | ---------- | ---------- | ------------------ | ------ |
| Fundamental      | yes         | yes            | no         | yes        | yes                | no     |
| Market/Technical | limited     | limited        | yes        | yes        | yes                | no     |
| Macro/Event      | yes         | yes            | limited    | yes        | yes                | no     |
| Frontier Methods | yes         | limited        | no         | no         | yes                | yes    |

Interpretation:

- branches decide what question is being answered and what artifact gets produced
- source adapters decide where evidence came from, whether it is licensed, and what evidence quality it can support

## Target artifacts

The smallest useful implementation should produce three artifacts:

1. `research_card`
2. `weekly_methods_review`
3. `replication_backlog` item

## Research card schema

Use this shape as the durable method artifact:

```json
{
  "title": "string",
  "material_type": "paper | whitepaper | technical_blog | working_notes",
  "problem_statement": "string",
  "method_summary": "string",
  "claimed_contribution": "string",
  "data_setup": ["string"],
  "evaluation_protocol": ["string"],
  "key_results": ["string"],
  "possible_leakage_points": ["string"],
  "overfitting_risks": ["string"],
  "replication_cost": {
    "data_requirements": ["string"],
    "engineering_complexity": "low | medium | high",
    "compute_cost": "low | medium | high"
  },
  "relevance_to_lobster": ["string"],
  "adoptable_ideas": ["string"],
  "do_not_copy_blindly": ["string"],
  "verdict": "archive_for_knowledge | watch_for_followup | worth_reproducing | ignore"
}
```

## Weekly methods review schema

Use this as the weekly rollup:

```json
{
  "window": "YYYY-MM-DD to YYYY-MM-DD",
  "papers_reviewed": ["string"],
  "worth_reproducing": ["string"],
  "watch_for_followup": ["string"],
  "archive_for_knowledge": ["string"],
  "ignore": ["string"],
  "cross_paper_patterns": ["string"],
  "methods_to_transfer": ["string"],
  "replication_backlog": ["string"],
  "open_questions": ["string"]
}
```

## Default verdict policy

- `archive_for_knowledge`: useful concepts, but not worth immediate follow-up
- `watch_for_followup`: interesting, but needs stronger evidence, more benchmarks, or later confirmation
- `worth_reproducing`: a small-scale reproduction is justified
- `ignore`: weak fit, weak evidence, or too fragile to matter

## Replication backlog rule

Only create a backlog item when the card can answer:

- what data is needed
- what leakage risk is most likely
- what the cheapest reproduction path is
- what success metric would justify continuing

## Integration rule

The clean integration order is:

1. produce a `research_card`
2. roll several cards into a `weekly_methods_review`
3. create a `replication_backlog` item only for cards with `worth_reproducing`
4. hand any reusable principles to other boards as methods, not as evidence

## Example

See the illustrative WaveLSFormer card at [WaveLSFormer Example Card](/experiments/research/wavelsformer-example-card).
