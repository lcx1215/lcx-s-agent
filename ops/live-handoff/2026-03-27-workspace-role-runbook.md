# Workspace Role Runbook

## Current split

- `lcx-s-openclaw` is the development repo.
- `Projects/openclaw` is the live runtime repo currently backing Feishu.
- the repo-grounded migration/acceptance checklist now also lives at:
  - `ops/dev-to-live-feishu-acceptance-runbook.md`

## What this means

- A fix completed in the development repo is **not** live yet.
- A fix is only live after:
  1. patch migration into the live repo
  2. live repo build or dist refresh
  3. gateway restart
  4. Feishu verification

## Feishu interface relation

- authoring surface:
  - `lcx-s-openclaw/extensions/feishu/src/*`
- runtime surface:
  - `Projects/openclaw/dist/*`
- consequence:
  - Feishu interface work should usually be designed and verified in the development repo first
  - but every live claim must still be re-proven in the runtime repo

## Current handoff artifact

- `ops/live-handoff/2026-03-27-feishu-workflow-hardening.patch`

This patch contains the current Feishu workflow-hardening fixes:

1. side-path Feishu sends use the same display normalization layer
2. `learning_command` real learning council receives the current lane workspace
3. workface / scorecard / validation dedupe uses content-aware fingerprinting

## Safe migration checklist

1. inspect the live repo working tree before applying any patch
2. apply only the bounded Feishu workflow patch
3. rebuild the live runtime from the live repo
4. restart only the gateway
5. verify:
   - `openclaw channels status --probe`
   - one control-room message
   - one `learning_command` message
   - one watchtower/workface publish path

## Honesty rule

- `development repo fixed` is not the same as `live fixed`
- report those states separately every time
- do not treat live handoff text as proof that the development repo itself contains matching runtime receipts
