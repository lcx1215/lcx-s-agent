# 2026-04-02 Codex Escalation Memory-Hygiene Alignment

## Exact failure mode

- The shared Codex escalation packet seam already existed.
- `operating-weekly-review` and `operating-daily-workface` now saw it.
- But `memory-hygiene-weekly` still ignored it completely.

## Why dangerous

- That leaves one supervision surface blind to the same "Lobster hit an external repair boundary" signal.
- The system can look aligned in daily/weekly operating artifacts while hygiene still undercounts the same recurring repair failure family.

## Smallest safe patch

- Reused the existing `parseCodexEscalationArtifact(...)`.
- Added bounded loading of recent Codex escalation packets in `memory-hygiene-weekly`.
- Added packet visibility to the weekly hygiene report.
- Added packet evidence into anti-pattern extraction.
- Did not change provisional/rejected ledger semantics.

## Files changed

- `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
- `src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`
- `memory/current_state.md`
- `ops/codex_handoff.md`

## Behavior change

- Memory hygiene now reports a `## Codex Escalation Queue`.
- Repeated Codex escalation packet content now contributes to anti-pattern extraction.
- The same repair-boundary signal is now visible across:
  - operating weekly review
  - operating daily workface
  - memory hygiene weekly

## Proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/memory-hygiene-weekly/handler.ts src/hooks/bundled/memory-hygiene-weekly/handler.test.ts src/hooks/bundled/lobster-brain-registry.ts`
- `git diff --check`

## Status

- `dev-fixed: yes`
- `live-fixed: no`
