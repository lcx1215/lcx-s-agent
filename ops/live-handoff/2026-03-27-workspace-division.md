# Workspace Division

## Canonical roles

### `lcx-s-openclaw`

- role: development repo
- purpose:
  - implement bounded patches
  - run targeted tests
  - run lint
  - prepare handoff artifacts
- what "done" means here:
  - code is fixed in the development repo
  - tests/lint passed in the development repo
- what it does **not** mean:
  - Feishu is live-fixed
  - the gateway is already using the patch

### `Projects/openclaw`

- role: live runtime repo
- purpose:
  - produce the `dist/` actually used by the gateway
  - host the runtime currently connected to Feishu
  - receive only bounded live ports
- what "done" means here:
  - the live repo contains the intended patch
  - `pnpm build` passed in the live repo
  - the gateway restarted from the live repo build
  - `openclaw channels status --probe` passed

## Live runtime fact

- current gateway program:
  - `/Users/liuchengxu/Projects/openclaw/dist/index.js`
- therefore:
  - Feishu behavior changes only after `Projects/openclaw` is updated, built, and restarted

## Feishu interface authorship split

- editable Feishu interface source in the development repo lives under:
  - `lcx-s-openclaw/extensions/feishu/src/*`
- but the Feishu behavior the operator actually sees is determined by the live runtime repo build:
  - `Projects/openclaw/dist/*`
- therefore:
  - a Feishu fix can be **development-complete** here
  - and still be **live-inactive** until port/build/restart/probe/acceptance happen there

## Default workflow

1. patch in `lcx-s-openclaw`
2. verify in `lcx-s-openclaw`
3. decide whether there is a safe live equivalent seam
4. port only the bounded live equivalent into `Projects/openclaw`
5. build in `Projects/openclaw`
6. restart gateway
7. verify with:
   - `openclaw channels status --probe`
   - real Feishu behavior

## Shipping rules

- development fixed != live fixed
- live source patched != live running
- only report "live fixed" after:
  1. live repo patched
  2. live build passed
  3. gateway restarted
  4. probe verified

## Truth-source rule

- `ops/live-handoff/*.md` is handoff memory, not automatic runtime proof for this development repo
- current dev-repo facts must be supported by:
  - code present in `lcx-s-openclaw`
  - tests/build run in `lcx-s-openclaw`
- current live facts must be supported by:
  - migrated code in `Projects/openclaw`
  - build/restart/probe/Feishu acceptance there

## Practical rule of thumb

- if the question is:
  - "where should Codex edit first?"
  - answer: `lcx-s-openclaw`
- if the question is:
  - "what code is Feishu using right now?"
  - answer: `Projects/openclaw/dist`
- if the question is:
  - "why didn't Feishu change yet?"
  - answer: the patch is still only in the development repo or has not been rebuilt/restarted in the live repo

## Safety rule

- do not blindly copy every development patch into `Projects/openclaw`
- only port a patch when:
  - the live repo has a verified equivalent seam
  - the patch is bounded
  - the patch will not break the running gateway
