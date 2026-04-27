---
title: "Finance Learning Pipeline Runbook"
summary: "Run the bounded finance learning pipeline from safe local, manual, or export inputs using reproducible demo fixtures"
read_when:
  - Running the finance learning pipeline in dev
  - Verifying source intake, extraction, attachment, and evidence-gated retention end to end
---

# Finance Learning Pipeline Runbook

This runbook is for the existing bounded finance learning pipeline in dev.
It does not add crawling, remote fetch, WeChat scraping, bypass logic, trading, execution, auto-promotion, or doctrine mutation.

Pipeline:

1. `finance_external_source_adapter` or `finance_research_source_workbench`
2. `finance_article_extract_capability_input`
3. `finance_learning_capability_attach`
4. evidence-gated retained candidate validation
5. `finance_learning_capability_inspect`

Allowed action authority stays bounded to:

- `research_only`
- `watch_only`
- `candidate_for_review`
- `no_action`

## Demo Fixtures

Safe demo fixtures live under `test/fixtures/finance-learning-pipeline/`.

- `valid-finance-article.md`
- `valid-rss-export.xml`
- `invalid-generic-article.md`
- `blocked-bypass-request.json`
- `metadata-only-web-reference.json`

## Smoke Command

Run the bounded smoke path with:

```bash
pnpm exec tsx scripts/dev/finance-learning-pipeline-smoke.ts
```

Run a single case with:

```bash
pnpm exec tsx scripts/dev/finance-learning-pipeline-smoke.ts --case local-file
```

Supported smoke cases:

- `manual-paste`
- `local-file`
- `lark-market-capability-intake`
- `lark-market-capability-missing-source`
- `capability-apply`
- `capability-apply-unmatched`
- `external-rss`
- `generic`
- `blocked`
- `metadata-reference`
- `all`

## Lark Language Bridge Smoke

The `lark-market-capability-intake` case verifies the boundary between the Lark language system and the finance learning system without touching live Lark.

It checks:

- Lark utterance understanding returns `market_capability_learning_intake`
- the target surface is `learning_command`
- the handoff exposes `finance_learning_pipeline_orchestrator`
- the backend contract requires a safe local or manual source
- the finance pipeline creates a normalized research source
- retrieval-first learning writes both `retrievalReceiptPath` and `retrievalReviewPath`

Run it with:

```bash
pnpm exec tsx scripts/dev/finance-learning-pipeline-smoke.ts --case lark-market-capability-intake
```

This smoke does not promote language corpus samples. Lark language routing candidates stay under the language-routing review path, while finance learning artifacts stay under the finance learning source, capability, receipt, and review paths.

The `lark-market-capability-missing-source` case verifies the fail-closed side of the same bridge: Lark may understand the learning intent and expose the backend contract, but the finance learning pipeline must not execute until a safe local or manual source is available.

## Manual Pasted Article Flow

Use the orchestrator directly with pasted article content:

```json
{
  "sourceName": "Manual Finance Note",
  "sourceType": "manual_article_source",
  "pastedText": "<contents of test/fixtures/finance-learning-pipeline/valid-finance-article.md>",
  "title": "ETF event triage workflow",
  "publishDate": "2026-04-17",
  "retrievalNotes": "Operator provided a bounded finance research source with explicit provenance, concrete method notes, evidence-bearing cognition, and no remote fetch request in this orchestration step.",
  "allowedActionAuthority": "research_only"
}
```

Expected output shape:

- one local research artifact path under `memory/research-sources/`
- one extraction payload from `finance_article_extract_capability_input`
- one retained capability candidate in `memory/local-memory/finance-learning-capability-candidates.md`
- explicit `evidenceCategories`
- one `finance_learning_capability_inspect` target keyed by `sourceArticlePath`

## Local File Article Flow

Copy `test/fixtures/finance-learning-pipeline/valid-finance-article.md` into a workspace path such as `memory/demo/valid-finance-article.md`, then run:

```json
{
  "sourceName": "Local Finance Fixture",
  "sourceType": "manual_article_source",
  "localFilePath": "memory/demo/valid-finance-article.md",
  "title": "ETF event triage workflow",
  "retrievalNotes": "Operator provided a bounded finance research source with explicit provenance, concrete method notes, evidence-bearing cognition, and no remote fetch request in this orchestration step."
}
```

Expected output shape:

- `normalizedArticleArtifactPaths` contains one local research artifact path
- `extractionResults` shows one extracted candidate
- `retainedCandidateCount` is `1`
- `inspectTool` is `finance_learning_capability_inspect`

## External Export Flow

Copy `test/fixtures/finance-learning-pipeline/valid-rss-export.xml` into a workspace path such as `memory/demo/valid-rss-export.xml`, then run:

```json
{
  "adapterName": "public-feed-adapter",
  "adapterType": "rss_atom_json_feed",
  "inputPath": "memory/demo/valid-rss-export.xml",
  "feedUrl": "https://example.com/feed.xml",
  "sourceFamily": "public_feed",
  "sourceName": "Public Finance Feed",
  "collectionMethod": "rss_or_public_feed_if_available",
  "retrievalNotes": "Operator provided a bounded finance research source with explicit provenance, concrete method notes, evidence-bearing cognition, and no remote fetch request in this orchestration step.",
  "complianceNotes": "Use only public feeds, local exports, normal browser-visible access, or manual operator capture with no bypasses.",
  "isPubliclyAccessible": true
}
```

Expected output shape:

- intake path is `finance_external_source_adapter`
- local research artifact preserves adapter metadata for audit
- extraction succeeds without remote fetch
- inspect target is returned for the retained candidate

## Metadata-only Web Reference Flow

Use `test/fixtures/finance-learning-pipeline/metadata-only-web-reference.json` as the request body:

```json
{
  "sourceName": "Google search reference",
  "sourceType": "public_web_source",
  "userProvidedUrl": "https://www.google.com/search?q=site%3Asec.gov+liquidity+funding+stress+10-k",
  "title": "Google reference for SEC liquidity work",
  "retrievalNotes": "Operator recorded a web discovery reference only as metadata for later manual source capture, with no remote fetch in this step."
}
```

Expected output shape:

- `extractionSkipped` is `true`
- `extractionSkippedReason` is `metadata_only_reference_source`
- no remote fetch occurs
- no retained candidate is created

## Fail-closed Fixtures

`invalid-generic-article.md` should fail closed because it does not contain evidence-bearing finance cognition.

`blocked-bypass-request.json` should fail closed at intake because it asks for blocked collection behavior.

These fixtures exist to verify that the pipeline rejects:

- generic filler
- bypass language
- fake cognition without method/evidence/risk discipline

## Expected Retained Outputs

When a valid article or export completes the pipeline, expect:

- local research artifact path:
  `memory/research-sources/<date>-<source-family>-<slug>.md`
- extraction output:
  one attach-ready payload returned by `finance_article_extract_capability_input`
- capability candidate:
  one retained entry in `memory/local-memory/finance-learning-capability-candidates.md`
- evidence categories:
  preserved under `evidenceCategories`
- inspect target:
  `finance_learning_capability_inspect` with `sourceArticlePath`

Use the smoke script first when checking whether the pipeline still works as one bounded path.

## Retrieval Reuse Contract

`finance_learning_capability_inspect` returns `reuseGuidance` on each retained candidate.

That guidance is the stable application contract for later agent answers:

- `applicationBoundary` keeps the capability research-only, watch-only, candidate-for-review, or no-action
- `attachmentPoint` says where the capability belongs in the finance framework
- `useFor` summarizes the valid research use case
- `requiredInputs` lists what data must be checked before reuse
- `requiredEvidenceCategories` preserves the evidence basis
- `causalCheck` keeps the causal mechanism visible
- `riskChecks` carries failure modes and overfitting/spurious-risk checks forward
- `implementationCheck` states what must exist before practical use
- `doNotUseFor` blocks execution approval, doctrine mutation, or standalone prediction

This means learning is not considered internalized merely because a candidate exists. It is useful only when later retrieval can surface the candidate together with its reuse boundary, required inputs, causal check, and risk checks.

## Applying Learned Capabilities

Use `finance_learning_capability_apply` when a later finance research question should use retained learning.

The apply tool is read-only. It calls the inspect layer, requires retrievable capability cards, and returns:

- `answerSkeleton` for a bounded research answer
- `appliedCapabilities` with each card's reuse guidance
- `requiredNextChecks` before drawing conclusions
- causal checks and risk checks that must be carried into the answer
- a no-action boundary that blocks trading advice, execution approval, auto-promotion, and doctrine mutation

If no retained capability matches the query, the tool fails closed with `no_retrievable_finance_capability`. In that state, do not improvise a learned answer; run the learning pipeline on a safe source or refine the query against existing capability tags.

Smoke coverage:

- `capability-apply` seeds one valid local finance capability, applies it to a bounded research question, and checks that the no-action boundary is preserved.
- `capability-apply-unmatched` seeds the same capability, asks an unrelated repository-governance question, and verifies the apply layer fails closed instead of inventing a learned finance answer.
