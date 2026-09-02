---
name: lcx-baseline-hardening
description: Repair a verified LCX failure family with the smallest coherent system upgrade, shared proof, and explicit boundaries.
metadata: { "openclaw": { "emoji": "🛡️" } }
---

# LCX Baseline Hardening

Use this for scoped stability work, silent-failure elimination, recovery/status
contracts, or repeated regressions.

## Workflow

1. Name the exact failure family and inspect prior work before editing.
2. Reuse, merge, or extend the existing owner path; repair the failure family
   with the smallest coherent system upgrade over a tiny symptom patch.
3. Add the narrowest regression proof that covers the original example and an
   adjacent non-identical case.
4. Run `pnpm check`, `git diff --check`, and the owner-specific test/CLI.

## Boundaries

- Keep provider, protected-memory, language-corpus, training, and external
  sender boundaries unchanged unless separately authorized.
- A passing unit test does not erase a stale receipt or a failed owner gate.
