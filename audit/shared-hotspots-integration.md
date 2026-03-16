# Shared Hotspots Integration Audit

Date: 2026-03-16
Branch: `main`
Compared against: `upstream/main`

This audit focuses only on the shared hotspots that exist both locally and upstream.

## Status

The first shared-hotspot integration pass is complete:

- `session-memory` has been reconciled onto the shared helper substrate and the workspace-bound session-key behavior has been restored locally.
- `system-prompt` now keeps Lobster memory recall rules while re-absorbing current generic upstream guardrails that still match the local tool surface.
- `subagent-announce` has completed a first bounded integration pass across prompt guidance, retry/timeout policy, and delivery provenance/internal-classification.
- `src/hooks/bundled/README.md` now documents Lobster-specific hook coverage as explicit overlay rather than implicitly blending it into upstream-owned bundled-hook documentation.

## Scope

- `src/hooks/bundled/session-memory/handler.ts`
- `src/hooks/bundled/session-memory/handler.test.ts`
- `src/agents/system-prompt.ts`
- `src/agents/system-prompt.test.ts`
- `src/agents/subagent-announce.ts`
- `src/hooks/bundled/README.md`

## 1. session-memory

### Current local position

Local `session-memory` has been refactored to sit on the shared artifact substrate rather than maintaining its own transcript/session-file recovery stack.

The local version explicitly keeps these behaviors:

- configurable `messages` limit
- configurable `llmSlug` opt-out
- reset fallback transcript loading
- filtered session-turn formatting through shared helpers
- timestamp fallback slug when LLM slugging is unavailable

Relevant local markers:

- `src/hooks/bundled/session-memory/handler.ts`
  - `resolveMemorySessionContext(...)`
  - `loadSessionTurnsWithResetFallback(...)`
  - `generateArtifactSlug(...)`
  - hook config fields `messages` and `llmSlug`

### Integration judgment

This hotspot is mostly an implementation seam, not a product-policy seam.

That means:

- the local refactor should be preserved
- future upstream behavior changes should be ported onto the shared helper version instead of reverting to upstream's older in-file implementation

### Must retain locally

- shared helper usage from `artifact-memory`
- config compatibility for `messages`
- config compatibility for `llmSlug`
- reset fallback behavior
- filtering-before-slicing semantics already covered by local tests

### Good candidates to absorb from upstream later

- any upstream bugfixes around session metadata extraction
- any upstream changes to how command source is typed or normalized
- any upstream fixes in note rendering or transcript filtering, if they are behavior fixes rather than pure duplication

### Priority

Highest shared hotspot.

This is the first file to review when doing any bounded upstream refresh because it is both:

- shared with upstream
- already structurally customized locally

## 2. system-prompt

### Current local position

Local `system-prompt` carries important Lobster-specific memory-recall guidance that upstream does not know about.

Those local additions are the memory recall rules for:

- learning review and learning-upgrade recall
- frontier review and frontier-upgrade recall
- fundamental intake/readiness/snapshot/scoring-gate recall
- operating-loop artifacts such as unified risk view and daily/weekly review artifacts

Relevant local markers:

- `src/agents/system-prompt.ts`
  - the four Lobster-specific lines in `buildMemorySection(...)`

### Integration judgment

This hotspot is a mixed file:

- some local content is product-critical and must stay
- some upstream prompt guidance is newer and should eventually be re-absorbed

From the current diff, local is behind upstream on some general-purpose guidance, including:

- one skills-section line about rate-limited external writes
- approval-pending exec guidance
- newer `config.schema` wording replacing older config guidance shape

### Must retain locally

- the Lobster memory recall guidance lines in `buildMemorySection(...)`
- matching tests that assert those memory recall lines exist

### Good candidates to absorb from upstream later

- generic, non-Lobster prompt guardrails
- updated approval and tool-usage guidance
- newer generic config guidance that does not conflict with Lobster memory behavior

### Priority

Second highest shared hotspot.

This file likely wants a manual merge policy:

- keep Lobster recall additions
- periodically re-import generic upstream prompt improvements

## 3. bundled README

### Current local position

Local `src/hooks/bundled/README.md` documents the full Lobster hook layer, including:

- learning review
- frontier research
- fundamental intake/readiness/snapshot/scoring-gate
- bootstrap and weekly review hooks

Upstream does not contain these sections.

### Integration judgment

This file is shared by path but behaves like documentation overlay.

That means:

- the local additions are valid overlay
- upstream structural or formatting changes may still need to be mirrored manually
- content ownership should stay local for Lobster-specific hooks

### Must retain locally

- all Lobster hook descriptions
- the documented output artifacts for the local memory/fundamental pipeline

### Good candidates to absorb from upstream later

- upstream README structure changes
- upstream wording/style changes for common bundled-hook sections
- upstream additions for non-Lobster hooks, if they touch the same document structure

### Priority

Lower than `session-memory` and `system-prompt`, but still a recurring manual merge point.

## 4. subagent-announce

### Current local position

`src/agents/subagent-announce.ts` is a shared runtime file with substantial upstream drift, but it is not part of the Lobster overlay itself.

The current local file still differs in real runtime behavior, including:

- announce timeout defaults
- completion delivery message shaping
- completion origin / direct-delivery resolution details
- direct vs queued completion delivery semantics

The first bounded integration pass has already absorbed:

- prompt-only orchestration guardrails in `buildSubagentSystemPrompt(...)`
- `gateway timeout` no-retry handling for completion direct send
- delivery provenance and cron internal-requester classification

### Integration judgment

This is a real shared hotspot, and it is not a low-risk doc-only seam.

It should be treated as a bounded runtime-policy seam:

- too large for casual "while we're here" refreshes
- worth auditing explicitly when future upstream session-routing or announce behavior matters
- not something to merge opportunistically alongside Lobster memory/fundamental work

At the same time, it no longer needs immediate follow-up work for the first pass.

### Must retain locally

- any behavior that current Lobster runtime depends on for subagent completion routing
- any local fixes already embedded in the current announce flow

### Good candidates to absorb from upstream later

- generic robustness fixes in announce retry and routing
- queue/delivery correctness fixes that do not conflict with Lobster-specific runtime assumptions
- new tests or extracted seams if upstream later isolates this file better

### Priority

First bounded pass complete.

Only reopen for a second-round semantics audit when there is a concrete upstream/runtime reason.

## Practical integration order

When doing the first bounded upstream integration pass, use this order:

1. `src/hooks/bundled/session-memory/handler.ts`
2. `src/agents/system-prompt.ts`
3. `src/agents/subagent-announce.ts`
4. `src/hooks/bundled/README.md`

That first pass is now complete to bounded scope.

## Summary

The shared hotspots are not equal:

- `session-memory` is mostly a helper-boundary integration problem
- `system-prompt` is a policy-overlay plus upstream-guardrail integration problem
- `subagent-announce` is a runtime-policy seam with substantial upstream drift
- `bundled/README` is mostly a documentation-overlay integration problem

That means future upstream refresh work should not treat them as one class of conflict.

For `subagent-announce`, the correct current status is:

- first bounded integration pass complete
- remaining work deferred intentionally
- do not keep extending that seam while higher-value Lobster product work is waiting
