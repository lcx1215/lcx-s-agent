# Finance waterflow v0 acceptance

## Scope and integration

The integration baseline is `afdacb1c14` on `lcx/multi-agent-api-hardening`.
It already combines role-aware model receipts, governed API collection,
finance intent routing, batch evidence and committee/quality gates. This
acceptance candidate builds on that baseline; the original source branches
and unrelated canonical-worktree edits are preserved. No remote delivery or
runtime migration is implied.

## Operator entrypoint

Run from the candidate checkout:

```sh
pnpm lcx:finance:research --ask 'Review six months of crypto and US equity sentiment, rally explanations and post-election scenarios' --as-of 2026-09-08T00:00:00Z
```

The default is planning only. The acceptance question produces seven targets
and twelve source jobs, without source fetching or model execution. The JSON
receipt contains the fixed observation date, requested windows and gates.

Explicit collection and local inference require `--live --model MODEL_ID
--adapter ADAPTER_PATH`; optional `--python PYTHON_PATH` selects the local
runtime. `--max-api-calls 64` bounds source calls, with one transport attempt.
The local model adapter disables model downloads. Missing model selection is
rejected before collection. The existing model router owns model execution.
Exit 0 means planned/candidate, 2 means needs_review/blocked, and 1 means invalid
input or execution error; consumers must inspect receipt gates and adoption.
This is an operator entrypoint, not a chat-tool or external-channel binding.

## Acceptance evidence

- 153 tests across eleven focused source/model/committee/quality suites pass.
- Three operator tests pass: planning, unconfigured-live rejection, invalid budget.
- Added failure-path coverage: HTTP 403, committee failure, quality-model failure,
  unknown evidence citation, and fresh records with unverified historical coverage.
- The dry operator command returns `planned`, no batch or committee, and
  `adopted: false`.
- Full `pnpm exec tsgo --noEmit` passes after linking existing workspace dependencies.
- Changed TypeScript files pass formatting and targeted lint.

Historical row freshness cannot establish window completeness. Until an
adapter coverage contract exists, every `eod_history` job carries
`historical_window_coverage_unverified` and cannot pass adoption. This is a
conservative review requirement even when a provider actually returned a full
window; it does not assert that the provider's data is missing.

## Remaining boundaries and Caseflow handoff

This proves a local fixture-driven waterflow and operator planning path. It
contains no fresh market/model-quality evaluation, external-channel proof,
push, PR, CI, merge, or deployment. Adapter attestation remains separate from
semantic quality. Existing quality verification checks references and decision
policy, and does not prove that a cited source entails a claim.

The broader context-recovery exam reports 8/13 passing: flow-graph, universe
inventory, operator freshness/surface alignment, and fresh training-plan
visibility remain unresolved. The radar also encountered `spawn EPERM` for a
training owner. These diagnostics must not be interpreted as a finance test
failure or an all-system readiness claim.

Next implement `LCX-CASEFLOW-V1` around this runner: stable ResearchCase identity,
immutable CaseRun evidence/version fingerprints, persistent budget/checkpoints,
and a DecisionPacket that binds claims to evidence fields. Add explicit
historical coverage contracts before clearing the v0 review requirement.
Separate frozen-input replay from fresh collection, and append three/six-month
outcomes against the original packet. Current quarter labels are output plans;
they are not persisted follow-ups or scheduled jobs.
