# Live Sync Status

## Current state

- Development repo: `lcx-s-openclaw`
- Live runtime repo: `Projects/openclaw`
- Live gateway runtime: `Projects/openclaw/dist/index.js`

## Synced to live

### Feishu display normalization hardening

- Status: live
- Scope:
  - `extensions/feishu/src/display-text.ts`
  - `extensions/feishu/src/send.ts`
  - `extensions/feishu/src/reply-dispatcher.ts`
  - reply-dispatcher/send fallback tests
- Behavior now live:
  - all user-visible Feishu sends pass through the same display normalization layer
  - side-path sends no longer bypass normalization
- Live proof:
  - targeted live tests passed
  - `pnpm build` passed in `Projects/openclaw`
  - `openclaw channels status --probe` returned `Gateway reachable` and `Feishu ... works`

## Not yet synced to live

### 1. lane workspace propagation for learning council

- Status: pending live-port review
- Reason:
  - the development repo has a `learning-council` runtime seam
  - the live repo does not currently expose the same seam
- Rule:
  - do not claim this is live until the live repo has a verified equivalent patch

### 2. stronger dedupe for workface / scorecard / validation weekly

- Status: pending live-port review
- Reason:
  - the development repo has explicit workface / scorecard / validation publish paths
  - the live repo does not currently expose the same artifact path or dedupe seam
- Rule:
  - do not claim this is live until the live repo has a verified equivalent patch

## Honesty rule

- `development fixed` is not `live fixed`
- `live source patched` is not `live running`
- only report `live fixed` after:
  1. bounded live patch
  2. live build
  3. gateway restart
  4. probe verification
