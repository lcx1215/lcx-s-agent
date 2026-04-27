# Learning Council Runtime Contract And Feishu Runbook

## Exact failure mode

- `extensions/feishu/src/learning-council.ts` wrote raw JSON artifacts under `bank/knowledge/learning-councils/`.
- `src/hooks/bundled/operating-daily-workface/handler.ts` still read those raw JSON artifacts ad hoc.
- at the same time, the dev repo still had no single repo-grounded runbook for dev -> live -> Feishu acceptance, even though the real scripts existed in `~/Projects/openclaw`.

## Why dangerous

- Feishu learning and operating control could silently disagree about the same learning-council artifact.
- future contributors could keep relying on chat memory instead of a repo-grounded migration/acceptance path.

## Smallest safe patch

- add one shared learning-council runtime artifact builder/parser to:
  - `src/hooks/bundled/lobster-brain-registry.ts`
- route the writer through it:
  - `extensions/feishu/src/learning-council.ts`
- route the current dev-side raw-artifact reader through it:
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
- add one repo-grounded runbook:
  - `ops/dev-to-live-feishu-acceptance-runbook.md`

## Files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `extensions/feishu/src/learning-council.ts`
- `extensions/feishu/src/learning-council.test.ts`
- `src/hooks/bundled/operating-daily-workface/handler.ts`
- `src/hooks/bundled/operating-daily-workface/handler.test.ts`
- `ops/dev-to-live-feishu-acceptance-runbook.md`
- `memory/current_state.md`
- `ops/codex_handoff.md`
- `ops/live-handoff/2026-03-27-workspace-role-runbook.md`

## Behavior change

- raw learning-council JSON artifacts are now written and read through one shared contract
- the dev repo now has one explicit runbook for:
  - bounded live port
  - live build
  - live restart / probe
  - real-entry Feishu acceptance

## Proof tests

- `corepack pnpm exec vitest run extensions/feishu/src/learning-council.test.ts src/hooks/bundled/operating-daily-workface/handler.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts extensions/feishu/src/learning-council.ts extensions/feishu/src/learning-council.test.ts src/hooks/bundled/operating-daily-workface/handler.ts src/hooks/bundled/operating-daily-workface/handler.test.ts`
- `git diff --check`

## Status

- `dev-fixed: yes`
- `live-fixed: no`
