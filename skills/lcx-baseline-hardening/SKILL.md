---
name: lcx-baseline-hardening
description: Repair a verified LCX failure family with the smallest coherent system upgrade, shared proof, and explicit boundaries.
metadata: { "openclaw": { "emoji": "🛡️" } }
---

# LCX Baseline Hardening

Use this for a verified cross-cutting failure family, silent-failure
elimination, recovery/status contracts, or repeated regressions. Do not trigger
it for an unverified concern or unrelated cleanup.

## Workflow

1. Name the exact failure family and inspect prior work before editing.
2. Reuse, merge, or extend the existing owner path; repair the failure family
   with the smallest coherent system upgrade over a tiny symptom patch.
3. Add the narrowest regression proof that covers the original example and an
   adjacent non-identical case.
4. Run the owner-specific check and focused tests first. Broaden to type,
   lint, or package-wide checks only when the changed contract/risk spans those
   surfaces. Always review the scoped diff and run `git diff --check`.

## Boundaries

- Keep provider, protected-memory, language-corpus, training, and external
  sender boundaries unchanged unless separately authorized.
- A passing unit test does not erase a stale receipt or a failed owner gate.
