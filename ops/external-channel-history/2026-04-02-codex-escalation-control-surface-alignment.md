# 2026-04-02 Codex Escalation Control-Surface Alignment

## Exact failure mode

- The shared Codex escalation packet seam already existed.
- But current control surfaces still ignored it:
  - `operating-weekly-review`
  - `operating-daily-workface`
- That meant Lobster could emit a Codex escalation packet while the operator-facing supervision artifacts still looked unaware.

## Why dangerous

- It hides the fact that Lobster has reached an external-repair boundary.
- The operator can keep reading a normal weekly or daily brief without seeing that the system is already asking for Codex help.
- This is control-plane drift, not cosmetic missing output.

## Smallest safe patch

- Reused the existing shared `parseCodexEscalationArtifact(...)`.
- Added one bounded loader in each control consumer:
  - recent Codex escalations for weekly review
  - yesterday + 7d Codex escalations for daily workface
- Did not change escalation conditions.
- Did not change wake-command behavior.
- Did not broaden watchtower semantics.

## Files changed

- `src/hooks/bundled/operating-weekly-review/handler.ts`
- `src/hooks/bundled/operating-weekly-review/handler.test.ts`
- `src/hooks/bundled/operating-daily-workface/handler.ts`
- `src/hooks/bundled/operating-daily-workface/handler.test.ts`
- `memory/current_state.md`
- `ops/codex_handoff.md`

## Behavior change

- Weekly review now shows:
  - active Codex escalation count
  - top active escalation packets
- Daily workface now shows:
  - yesterday Codex escalation count
  - a Codex escalation section
  - 7d Codex escalation count

## Proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/operating-weekly-review/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/operating-weekly-review/handler.ts src/hooks/bundled/operating-weekly-review/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.ts src/hooks/bundled/operating-daily-workface/handler.test.ts src/hooks/bundled/lobster-brain-registry.ts`
- `git diff --check`

## Status

- `dev-fixed: yes`
- `live-fixed: no`
