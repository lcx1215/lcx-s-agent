# Finance Harness: remaining bounded work

## Scope and completed repairs

This is a handoff for the observed finance research / module / quality / decision
context path, not a claim that the whole repository has been audited.

- Preparation has two roles, not a two-module limit; selected producers still
  receive separate inputs and post-module review retains all ten roles.
- Missing optional retained methods no longer block independent required modules.
- Module analysis, risk and invalidation precede verbose call metadata.
- Counted broker fills are not treated as new trading instructions.
- Account-level broker-profit evidence does not acquire instrument scope merely
  by mentioning a ticker. Context/contradiction citations cannot establish
  instrument support. Actual semantic support still needs review.
- After a draft/format execution failure, the same run can reuse its three clean
  preparation outputs. Any extraction/classification gap disables that reuse.
  Evidence, risk, exposure, draft and final reviews run again. `reusedStageIds`
  identifies reuse; it is not a new model invocation or cross-run cache.

## Evidence and economical verification

Local diagnostic receipts (ignored runtime state):

- `state/finance/receipts/20260928-harness-closure/quality.json`: real model review
  failures and deadline, including account fills incorrectly attributed to SPY.
- `state/finance/receipts/20260928-harness-closure/module-handoff-replay.json`:
  actual saved producer inputs, real local tools and prompt serialization.
- `state/finance/receipts/20260928-harness-closure/decision-readback.json`:
  read-only decision-context projection, with no active thesis at observation.
- `state/finance/receipts/20260928-luna-handoff/verification.json`: this repair's
  local checks and scheduler deployment observation.

Start with local tests; do not repeat 14-minute model runs simply to seek a pass:

```sh
pnpm exec vitest run src/agents/quality-harness.test.ts src/agents/finance-research-evidence.test.ts src/agents/finance-night-review-context.test.ts src/agents/finance-research-runner.test.ts
```

## Remaining work, in order

1. Inspect actual rejected claims and citation relations. Instrument presence and
   a `supports` label do not prove that a source supports the number or causal
   statement. Extend precise counterexamples before changing admission rules.
2. Profile repair latency using saved call timestamps. This patch saves only
   clean preparation work; it does not implement arbitrary DAG checkpoint reuse.
   Do not reuse draft-dependent reviewers after an artifact changes.
3. Check prompt coverage for larger module/evidence sets. The current semantic
   handoff regression covers one and sixteen evidence items; clipping is still
   explicit and does not establish full review of omitted content.
4. Verify one bounded current-version research cycle only when it will resolve a
   concrete remaining question. Use an isolated workspace and finance directory.
   Distinguish source fetching, module production, quality acceptance, eligible
   thesis persistence and decision consumption. A profit-attribution audit may
   correctly produce no investment thesis: do not fabricate one for the test.
5. Recheck current source/API health and canonical ledger state before making
   runtime claims. Prior receipts are historical, not current account truth.

## Boundaries

Paper authority and existing execution gates remain unchanged. Do not alter Live
credentials, providers, authorization, risk caps, strategy activation or protected
memory. Do not place diagnostic orders. No remote push/PR is authorized by this
handoff. Use the owned worktree and inspect current Git/runtime state before edits;
local integration and a scheduler restart are separate evidence layers.
