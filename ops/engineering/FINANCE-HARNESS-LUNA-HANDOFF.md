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
  by mentioning a ticker. A bounded verifier also blocks supported,
  instrument-specific numeric buy/sell-fill claims when the cited broker-profit
  record is account-level and no structured same-instrument count/side matches.
  It covers zero/no wording in English and Chinese. Context/contradiction
  citations cannot establish instrument support. Actual semantic support still
  needs review.
- After a draft/format execution failure, the same run can reuse its three clean
  core preparation outputs and complete auxiliary-batch extraction outputs. Any
  extraction/classification gap disables that reuse. Draft-dependent reviews
  run again. `reusedStageIds` identifies reuse; it is not a new model invocation
  or cross-run cache.

## Continuation checkpoint (2026-09-28)

- The scoped fill-attribution guard is integrated locally on `main` at base
  `47fb122f07`. This continuation added evidence-coverage enforcement and now
  adds bounded multi-pass review. The shared primary checkout contains local,
  uncommitted finance-harness edits; no push was made.
- The guard matches structured instrument fill evidence to the claim's side and
  count. Empty arrays, wrong-side rows, and mismatched counts do not qualify.
  A narrow fee-loss guard also requires same-instrument structured fee data with
  explicit allocation when cited evidence says fees are unallocated.
- Verification on the primary checkout: 66 focused tests passed across
  `finance-research-evidence.test.ts` and `finance-research-runner.test.ts`;
  `pnpm tsgo`, `oxfmt --check` on the four changed files, and `git diff --check`
  passed.
- Historical latency profile from `quality.json`: the first formatting attempt
  failed its output contract after 53.006 s. The retry repeated
  `financial_extraction` (39.904 s) and `news_classification` (38.988 s), which
  started 1 ms apart. The reuse test covers all three clean preparation stages
  and disables reuse when extraction has a gap. Avoiding the repeated calls
  could save about 39.9 s of wall time in this case; that is a receipt-based
  estimate, not a measured before/after run.
- Prompt coverage review: `local-text-model-adapter.test.ts` covers 20/20
  quality evidence items, a 48-item pack with clipping/truncation and an
  included-only evidence-ID list, plus 24/12 coverage in the local role-shadow
  prompt. The prompts report provided/included counts and prohibit claims about
  omitted evidence. Those prompt statements were advisory and did not bind the
  verifier to what was actually sent.
- Coverage gate: the Finance runner records the original committee evidence IDs,
  its bounded selection, runner-side clipping, and omissions. The canonical
  prompt builder records the IDs included, IDs omitted or clipped by its own
  budget, and a SHA-256 digest of the exact prompt. The configured adapter
  observer carries that record through model-call receipts. When any evidence
  was omitted/clipped, the actual request boundary is unknown, or an adapter
  uses a custom prompt without coverage observation, Quality Harness stops
  before deterministic verification and cannot produce `verified` output or
  adopt it. The candidate artifact and coverage issues remain in the receipt.
- The updated Finance runner regression now places a contradictory item at
  position 49, verifies it reaches the fourth post-draft final-artifact audit,
  and verifies the scripted auditor flags it so the candidate is not adopted.
  The prompt-coverage gate itself passes, separating inclusion from review
  quality.
- On the primary checkout, nine focused suites passed (235 tests); `pnpm tsgo`,
  formatting checks, and `git diff --check` passed. No external Finance
  model/service, scheduler, ledger, account, order, Paper or Live action was
  used for this continuation.
- Bounded multi-pass implementation: the Finance runner selects at most 64
  evidence items. The quality adapter partitions by its canonical prompt
  builder, capped at 16 items per batch and four batches total. Each batch gets
  an exact-prompt coverage receipt and a final-artifact review that must emit an
  ID-prefixed note for every supplied item. Non-primary batches also get a
  pre-draft extraction whose notes are passed to the draft. The final precheck
  receives and compares all batch review outputs. The plan has at most 17 model
  stages per attempt and still uses the existing shared workflow call budget;
  over-budget packets fail before quality-model invocation. Same-run clean batch
  extraction may be reused after draft/format transport failure, with reuse
  listed in the attempt receipt.
- The initial multi-pass implementation pass ran `pnpm tsgo`, `oxfmt --check`
  on the five touched TypeScript files, and `git diff --check`; all passed. At
  that point the new behavior had not been test-run or exercised against a real
  model. It provides bounded prompt and per-item note coverage, not proof of
  semantic entailment or a successful finance adoption.
- These deterministic patterns close the saved account-fill counterexamples;
  they do not establish general semantic entailment, prove causality from a
  `supports` label, or infer account completeness.
- Regression follow-up: `pnpm exec vitest run src/agents/quality-harness.test.ts
src/agents/finance-research-runner.test.ts` passed both suites (107/107).
  The added Harness cases verify that a missing per-ID audit note blocks
  deterministic verification and that 65 selected items exceed the four-batch
  cap before model invocation. `oxfmt --check` on both test files and
  `git diff --check` passed. All model calls in these tests are fixture-backed;
  no external model was invoked.
- Semantic-support follow-up: the validator checks evidence IDs, relation
  labels, and narrow structured scope rules; it does not prove general
  entailment. The saved `quality-v14.json` receipt records a reviewer finding
  that an empty intraday decision list did not establish absence of SPY trades,
  while the cited broker aggregate had three unattributed fills. The corrected
  attempt resolved that finding, but a later attempt failed during execution,
  so the receipt is not evidence of a fully verified answer.
- Added a deterministic guard for the reproducible boundary: a supported
  instrument-level no-execution claim is rejected when it cites an empty
  intraday decision log and account-level unattributed fills without a
  same-instrument zero-fill record. Cited instrument fill counts that are
  positive are reported as conflicting evidence. Uncertain claims remain
  admissible. A regression covers the saved evidence shape and the Finance
  Runner verifier path.
- Prior local verification: `quality-harness.test.ts`,
  `finance-research-evidence.test.ts`, and `finance-research-runner.test.ts`
  passed (129/129); `pnpm tsgo`, formatting checks, and `git diff --check`
  passed. These are fixture-backed local checks; no external model or finance
  runtime action was used.
- Cross-rule scope follow-up: saved finding `e6769002...` in `quality-v14.json`
  showed that `research_only` / no-return-validation wording attached to
  `trend_risk_normalised_v1` must not migrate to
  `opening_range_breakout_long_pre_close_v2`, whose `readScope` is an input-data
  scope. The verifier now requires supported scope/return-validation claims
  citing a multi-rule ledger to name only one rule; the model may retain the
  facts by splitting them into rule-specific claims. Fixtures reject a
  combined assertion and retain ordinary multi-rule inventory claims and the
  saved corrected split-claim shape. This is an ambiguity guard, not proof of
  entailment within a single rule claim.
- Cross-rule regression follow-up: evidence and Finance Runner suites passed
  (72/72); `pnpm tsgo`, formatting checks on the three changed TypeScript
  files, and `git diff --check` passed. All model behavior was fixture-backed;
  no external model or finance runtime action was used.
- Semantic fixture work is complete for the saved no-execution, unallocated-fee
  causation, and multi-rule scope-transfer counterexamples. General causal and
  paraphrase accuracy remains unproven; add more cases only from concrete saved
  reviewer findings. Evidence inclusion, reviewer resolution, and semantic
  entailment remain separate claims.
- Pre-draft review follow-up: saved `quality-v13.json` showed the extraction
  reviewer rejecting because a final artifact did not exist before drafting.
  Extraction/classification review parsing now retains that text as a tagged
  note instead of a blocker; a reject caused only by that invalid blocker is
  downgraded to pass, while remaining evidence gaps stay revisable and other
  critical findings remain blocking. This closes only the stage-timing error;
  the saved limitation-versus-evidence-gap classification issue and general
  semantic accuracy remain open. Formatting and `git diff --check` passed;
  `pnpm tsgo` is still blocked by missing optional extension dependencies, and
  no tests or external model/runtime cycle were run for this follow-up.
- Thesis persistence boundary: the quality runner admits up to 64 selected
  evidence items, but the operator CLI had independently truncated proposal
  validation to 48. A verified proposal citing item 49 was therefore refused
  as missing evidence before persistence. The CLI now uses the shared
  `QUALITY_HARNESS_MAX_EVIDENCE_ITEMS` cap. A local, fixture-backed CLI test
  with 49 evidence items verifies persistence and subsequent thesis visibility
  in the decision-context projection. This proves neither a real model cycle
  nor adoption by a trading decision.
- Boundary verification: the CLI persistence, thesis-learning and decision
  context suites passed 11/11 tests; scoped formatting and `git diff --check`
  passed. `pnpm tsgo` remains blocked in this worktree by absent optional
  extension dependencies in the installed tree (including OpenTelemetry,
  Matrix, and Twurple packages); its reported errors were in those unrelated
  extensions, not the changed Finance files. No model or finance runtime was
  invoked.
- Next action: run a bounded current-version research cycle only to answer a
  concrete thesis-persistence or decision-consumption question, using an
  isolated workspace and finance directory. This SPY profit-attribution audit
  may correctly produce no investment thesis; do not invent one to force a
  persistence test.

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

1. General semantic support accuracy remains unproven. Deterministic guards
   cover the saved account-fill, no-execution, unallocated-fee causation, and
   multi-rule provenance counterexamples. They do not validate arbitrary causal
   claims, supported paraphrases, or semantics within a single rule claim.
2. Verify one bounded current-version research cycle only when it will resolve a
   concrete remaining question. Use an isolated workspace and finance directory.
   Distinguish source fetching, module production, quality acceptance, eligible
   thesis persistence and decision consumption. The local CLI evidence-cutoff
   mismatch is fixed; a profit-attribution audit may correctly produce no
   investment thesis, so do not fabricate one for the test.
3. Recheck current source/API health and canonical ledger state before making
   runtime claims. Prior receipts are historical, not current account truth.

## Boundaries

Paper authority and existing execution gates remain unchanged. Do not alter Live
credentials, providers, authorization, risk caps, strategy activation or protected
memory. Do not place diagnostic orders. No remote push/PR is authorized by this
handoff. Use the owned worktree and inspect current Git/runtime state before edits;
local integration and a scheduler restart are separate evidence layers.
