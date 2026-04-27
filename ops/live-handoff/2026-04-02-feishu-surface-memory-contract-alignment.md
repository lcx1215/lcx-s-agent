# feishu surface-memory contract alignment

## exact failure mode

- `extensions/feishu/src/bot.ts` wrote:
  - individual `feishu-surface-lines/*.md`
  - `feishu-surface-lines/index.md`
  - `feishu-surface-lines/health.md`
- the same file then re-read those artifacts with ad-hoc local parsing when rebuilding lane index/health.
- `src/hooks/bundled/operating-daily-workface/handler.ts` separately regex-read `feishu-surface-lines/index.md`.

So the Feishu surface-memory family still had duplicated content contracts even after the workface seam was cleaned.

## why dangerous

- This is a control-room topology seam.
- If surface-line, lane-panel, or lane-health markdown shape drifts, Feishu surface memory and daily workface can silently disagree about lane count and lane meter.
- That would make the operator surface look cleaner than the actual routing/load state.

## smallest safe patch

- Added shared renderer/parser contracts in `src/hooks/bundled/lobster-brain-registry.ts` for:
  - surface line artifacts
  - lane panel artifact
  - lane health artifact
- Routed Feishu bot writing and index rebuilding through the shared contracts.
- Routed `operating-daily-workface` lane-panel loading through the shared parser.

## files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `extensions/feishu/src/bot.ts`
- `src/hooks/bundled/operating-daily-workface/handler.ts`
- `memory/current_state.md`
- `ops/codex_handoff.md`

## proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/operating-daily-workface/handler.test.ts extensions/feishu/src/bot.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts src/hooks/bundled/operating-daily-workface/handler.ts extensions/feishu/src/bot.ts extensions/feishu/src/bot.test.ts`
- `corepack pnpm exec tsx -e "...renderFeishuSurfaceLineArtifact...parseFeishuSurfaceLineArtifact...renderFeishuSurfaceLanePanelArtifact...parseFeishuSurfaceLanePanelArtifact...renderFeishuSurfaceLaneHealthArtifact...parseFeishuSurfaceLaneHealthArtifact..."`
- `git diff --check`

## status

- `dev-fixed: yes`
- `live-fixed: no`
