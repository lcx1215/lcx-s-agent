# 2026-03-28 learning council minimax override

## Exact failure mode

`extensions/feishu/src/learning-council.ts` hardcoded the MiniMax council lane to:

- `minimax/MiniMax-M2.5`

That meant any future official MiniMax model bump still required code edits.

## Why it was dangerous

- unnecessary code surgery for a model-version change
- operational drift risk if the council lane needed a verified new MiniMax model while the operator kept training

## Smallest safe patch

- keep the verified default:
  - `minimax/MiniMax-M2.5`
- add bounded env override:
  - `OPENCLAW_LEARNING_COUNCIL_MINIMAX_MODEL`

## Files changed

- `extensions/feishu/src/learning-council.ts`
- `extensions/feishu/src/learning-council.test.ts`

## Proof tests

- `corepack pnpm exec vitest run extensions/feishu/src/learning-council.test.ts`
- `corepack pnpm exec oxlint extensions/feishu/src/learning-council.ts extensions/feishu/src/learning-council.test.ts`

## Notes

- Official MiniMax docs were checked before changing this seam.
- No verified official `MiniMax 2.7` model was found in those docs at the time of this patch.
- So this change intentionally does **not** fake a `2.7` upgrade.

## Explicit status

- `dev-fixed: yes`
- `live-fixed: no`
