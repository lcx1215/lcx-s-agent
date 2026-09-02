# Live-Port Ticket: workface publish dedupe

## Problem

The development repo already uses a stronger dedupe key for workface / scorecard / validation-style publishes.

The live repo does not currently expose the same workface/validation publish seam, so same-name artifact rewrites may still be suppressed or the seam may not exist yet.

## Why it matters

- updated operator panels can be hidden behind stale dedupe state
- real content changes may never reach Feishu
- supervision artifacts can appear frozen even when the backend changed

## Evidence

- development repo has explicit workface / scorecard / validation publish logic
- live repo search did not reveal:
  - workface publish logic
  - scorecard publish logic
  - validation weekly publish logic
  - a matching Feishu-side panel/summary seam
- current live repo appears to be branch/report oriented, not workface/panel oriented
- no safe one-to-one live patch target has been verified yet

## Smallest safe scope

1. first determine whether a real live panel/summary seam exists
2. if it exists, find the dedupe key actually used there
3. upgrade it to include content-aware fingerprinting
4. add one targeted regression test
5. if it does not exist, close this as "development-only seam; no direct live port"

## Out of scope

- no broad dashboard refactor
- no generalized dedupe rewrite across unrelated channels
- no fake port of development-only logic

## Suggested owner

- Codex

## Acceptance

- same-day artifact rewrites with changed content are no longer suppressed
- unchanged payloads still dedupe normally
- live build + probe still pass
