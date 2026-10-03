---
name: finance-learning-researcher
description: Run source-aware, provider-neutral finance research and capability-learning workflows across markets, instruments, and business-finance contexts; default to research-only.
metadata: { "openclaw": { "emoji": "📈" } }
---

# Finance Learning Researcher

Use this Skill for finance research, evidence packets, strategy learning, and
finance-domain capability review. It is not an accounting-posting, order-entry,
or account-operation Skill.

## Context contract

Before collecting or comparing data, state the applicable context:

- Objective and scope: entity, instrument, portfolio, accounting perimeter, or
  financial question.
- Market, venue, jurisdiction, reporting framework, and local calendar when
  relevant; do not assume A-shares, US markets, a currency, or a standard.
- Observation period, horizon, information cutoff, units, currency, denominator,
  and adjustment basis.
- Evidence source, source timestamp, observed-as-of time, coverage, freshness,
  and missing or conflicting fields.
- User-supplied constraints, benchmark, risk limits, and unresolved assumptions.

For LCX implementation work, the repository's [method kit](references/trader-strategy-method-kit.md) is optional supporting guidance; it is not portable runtime or training proof.

## Workflow

1. Freeze the question, observation unit, period, denominator, and decision
   boundary before looking for confirming evidence.
2. Inspect the data sources and tools actually available in this run. Use a
   configured gateway or source registry when present; otherwise use suitable
   primary sources or user-supplied records. Never assume a connector, vendor,
   credential, or endpoint exists because another Skill mentions it.
3. Keep sourced facts, calculations, research inferences, assumptions, and
   unavailable data distinct. Timestamp current values; reconcile conflicts or
   leave them unresolved rather than selecting the thesis-friendly value.
4. For strategy questions, select only the relevant methods from the sibling
   [trader-strategy-lab](../trader-strategy-lab/SKILL.md). Freeze a simple
   baseline, point-in-time inputs, realistic costs, and invalidation criteria
   before interpreting a backtest. Do not imply that an untested catalog item
   was evaluated.
5. Deliver the conclusion, thesis and counter-thesis, catalyst or follow-up,
   invalidation, portfolio/business impact, confidence, coverage limits, and
   the next safe check.
6. Treat learning as staged evidence: a stored document or receipt alone does
   not prove retrieval, application, model absorption, promotion, or user-visible
   capability. Route proposed learning through its owning review/evaluation
   process.

## Boundaries

- Default to research-only. This Skill does not authorize personalized trades,
  position sizing, orders, transfers, credential access, or accounting-system
  writes.
- If another explicitly authorized workflow permits a strategy candidate or
  paper execution, keep that authority separate and retain its own evidence,
  funding, shared-gate, deduplication, and reconciliation checks.
- Unverified current values remain unknown; historical examples are not current
  evidence.
