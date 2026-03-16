# Subagent Announce Runtime Seam Audit

Date: 2026-03-16
Branch: `main`
Compared against: `upstream/main`

This audit treats `src/agents/subagent-announce.ts` as a bounded runtime-policy seam.

## Why This File Is Special

Unlike the Lobster memory/fundamental overlay, this file is a shared OpenClaw runtime path that exists both locally and upstream.

It is also high blast-radius:

- there is no single standalone shared hotspot test file for it upstream
- many local tests and runtime paths depend on it indirectly
- changes here can affect subagent completion routing, cron completion delivery, retry behavior, and subagent prompt instructions

Observed local dependency surface includes:

- `src/agents/subagent-announce.timeout.test.ts`
- `src/agents/subagent-announce.format.e2e.test.ts`
- `src/agents/subagent-announce-dispatch.test.ts`
- `src/agents/subagent-registry*.test.ts`
- `src/cron/isolated-agent*.test.ts`
- `src/agents/system-prompt.test.ts` through `buildSubagentSystemPrompt(...)`

## Main Drift Areas

## 1. Completion delivery message shaping

Local adds explicit completion-message shaping through:

- `buildCompletionDeliveryMessage(...)`

This changes user-visible completion output behavior for:

- normal subagent runs
- session-mode runs
- cron completions
- timeout/error header wording

Judgment:

- this is runtime policy, not cleanup
- do not merge casually

## 2. Completion output stabilization

Local adds:

- `waitForSubagentOutputChange(...)`

This means local behavior waits briefly for reply text to change before using a stale baseline reply in nested/subagent contexts.

Judgment:

- likely a real correctness fix
- worth preserving unless upstream has a stronger replacement

## 3. Retry and timeout policy

Local changes include:

- default announce timeout from `90_000` to `60_000`
- removal of special `gateway timeout` no-retry bypass
- retry classification now treats gateway timeout like other transient errors

Judgment:

- this is a true policy seam
- changing it can alter latency, retry pressure, and failure semantics
- should be reviewed together with dependent timeout/announce tests

## 4. Completion origin and delivery semantics

Local changes in:

- `resolveSubagentCompletionOrigin(...)`
- `deliverSubagentAnnouncement(...)`
- `runSubagentAnnounceFlow(...)`

Observed semantic drift includes:

- explicit `routeMode` classification (`bound | fallback | hook`)
- deterministic idempotency-key comments/usage around dedup
- different handling of direct vs queued/steered completion delivery
- cron delivery only counts as delivered on confirmed direct path

Judgment:

- highest-risk part of the seam
- directly tied to actual user-visible delivery correctness
- not suitable for opportunistic alignment during unrelated work

## 5. Internal requester classification and source metadata

Upstream still contains logic around:

- `isCronSessionKey(...)`
- `INTERNAL_MESSAGE_CHANNEL`
- source session/channel/tool metadata passed into delivery

Local currently differs here.

Judgment:

- likely meaningful routing-policy drift, not dead code drift
- must be validated against current registry/cron behavior before any merge

## 6. Subagent prompt instructions

This file also owns:

- `buildSubagentSystemPrompt(...)`

Current local vs upstream differences surfaced indirectly in `src/agents/system-prompt.test.ts`, including whether the subagent prompt explicitly includes lines such as:

- do not call polling tools after spawning
- wait for all expected child completion events
- reply only with `NO_REPLY` after late child completions

Judgment:

- prompt guidance here is runtime-policy, not just wording
- changes affect orchestrator behavior expectations
- should be audited separately from the announce-delivery mechanics, even though they live in the same file

## What Is Safe To Do Later

Possible bounded future slices inside this seam:

### Slice A. Prompt-only guidance audit

Scope:

- `buildSubagentSystemPrompt(...)`
- related assertions in `src/agents/system-prompt.test.ts`

Goal:

- decide which upstream orchestration guardrails should be re-absorbed without changing delivery mechanics

### Slice B. Retry/timeout policy audit

Scope:

- timeout constants
- retry helpers
- timeout-specific tests

Goal:

- decide whether local timeout/retry policy is deliberate or accidental drift

### Slice C. Completion routing audit

Scope:

- completion origin resolution
- direct/queued/steered semantics
- cron completion delivery
- registry interaction points

Goal:

- treat delivery correctness as the primary outcome
- this is the highest-value and highest-risk slice

## What Should Not Be Done Casually

Do not:

- port upstream wholesale into this file
- mix prompt-only updates with delivery-routing changes in one pass
- change this file without running the dependent announce/registry/cron test cluster
- treat it like a documentation hotspot

## Current Recommendation

When this seam is worked on next, use this order:

1. prompt-only guidance audit
2. retry/timeout policy audit
3. completion routing audit

That order keeps the lowest-risk behavioral surface first and the highest-risk routing logic last.

## Summary

`src/agents/subagent-announce.ts` is now confirmed as a real shared runtime-policy seam.

It should be handled as:

- bounded
- test-driven
- split into sub-slices

and not as a casual follow-up to Lobster overlay work.
