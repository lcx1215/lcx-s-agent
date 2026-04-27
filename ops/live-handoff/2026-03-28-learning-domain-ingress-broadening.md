# 2026-03-28 learning domain ingress broadening

## Exact failure mode

`learning-review` was still biased toward math / quant / code sessions.

That meant several real study categories were not reliably promoted into durable learning topics:

- papers / whitepapers / arXiv
- earnings / annual reports / quarterly reports
- macro / market structure / regime study
- strategy audit / overfitting / OOS review
- GitHub repo / agent architecture / workflow study

## Why it was dangerous

- the system could appear to "study" those domains without classifying them into the right durable topic
- multi-day training would keep accumulating notes, but the brain would stay skewed toward math-only buckets
- operator intent and actual learning promotion would drift apart

## Smallest safe patch

- broaden `LEARNING_KEYWORDS`
- broaden `inferTopic(...)`
- add bounded hints and foundation-template routing for:
  - `paper-and-method-reading`
  - `fundamental-reading-and-risk`
  - `macro-and-market-structure`
  - `strategy-audit-and-overfit`
  - `agent-architecture-and-workflows`
- keep explicit `time-series-and-volatility` precedence ahead of broader overfit/audit triggers

## Files changed

- `src/hooks/bundled/learning-review/handler.ts`
- `src/hooks/bundled/learning-review/handler.test.ts`

## Proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/learning-review/handler.test.ts src/hooks/bundled/learning-review-weekly/handler.test.ts src/hooks/bundled/learning-review-bootstrap/handler.test.ts src/agents/system-prompt.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/learning-review/handler.ts src/hooks/bundled/learning-review/handler.test.ts src/hooks/bundled/learning-review-weekly/handler.ts src/hooks/bundled/learning-review-weekly/handler.test.ts src/hooks/bundled/learning-review-bootstrap/handler.ts src/hooks/bundled/learning-review-bootstrap/handler.test.ts src/agents/system-prompt.ts src/agents/system-prompt.test.ts`

## Result

The training path is now much closer to "learn what the operator is actually teaching":

- paper reading
- earnings / fundamental reading
- macro / market-structure study
- strategy-audit skepticism
- GitHub / agent architecture / workflow study

## Explicit status

- `dev-fixed: yes`
- `live-fixed: no`
