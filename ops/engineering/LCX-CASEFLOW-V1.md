# LCX Caseflow V1: frozen run persistence

## Delivered slice

`finance-caseflow.ts` wraps the existing finance research runner. One JSON
artifact contains a ResearchCase revision, a CaseRun snapshot and a DecisionPacket.
It creates no alternate DAG, provider or workflow authority.

- The caller supplies a stable Case ID. The case revision hashes the question,
  observation date, horizon, targets, decision mode and API budget. Changed
  definitions coexist under the same ID rather than overwriting earlier runs.
- Every execution has a UUID. The run records configuration, the source hashes
  explicitly listed by the operator, raw committee evidence and the full runner
  receipt. Separate hashes cover definition, execution, evidence and receipt.
- Packet claims retain the model's original status but are classified as
  inference candidates. References are checked against frozen evidence IDs.
  Missing references prevent adoption; reference validity does not prove
  semantic entailment. Failed gates and source gaps remain explicit.
- Three/six-month calendar dates are calculated from the observation date with
  month-end clamping. Their state is `not_scheduled`.
- The content hash is the artifact reference. Same-directory temporary-file
  publication prevents partial readers or overwriting an existing reference.
  Files use mode 0600 and new directories 0700. Repeated/concurrent saves of the
  same run converge on one artifact; altered contents fail integrity checks.
  Hashes detect alteration relative to a retained reference, not adversarial
  provenance forgery or trusted signatures. Filesystem backups remain separate.

## Existing operator interface

```sh
pnpm lcx:finance:research --case-dir ./caseflow-data --case-id crypto-us-sentiment \
  --ask 'Review crypto and US equity sentiment over six months' \
  --as-of 2026-09-08T00:00:00Z

pnpm lcx:finance:research --case-dir ./caseflow-data --read-run RUN_REF

pnpm lcx:finance:research --case-dir ./caseflow-data \
  --read-run BEFORE_REF --compare-run AFTER_REF
```

The creation response includes `savedCaseRun` with the reference, path, revision
and run ID. Existing callers without case flags retain their receipt format.
Read/compare do not fetch sources or invoke models, and cannot be combined with
live research. To generate a new live run, use the existing explicit
`--live --model MODEL_ID --adapter ADAPTER_PATH` interface with the same Case ID.
Keep generated data outside source control.

Comparison reports definition/configuration changes, exact evidence snapshot
changes, claim additions/removals/changes and gate gaps. Evidence comparison
includes transport metadata, so it is not a semantic market-change detector.
Code hashes cover the explicitly recorded files, not the entire dependency
closure. Model/adapter bytes are not fingerprinted by this slice; existing
attestation remains in the receipt and is not a model-quality certification.

## Validation

39 focused tests pass: six persistence tests, nine runner tests, twenty batch
tests and four operator tests. They cover concurrent/idempotent publication,
read-back, alteration detection, reference traversal rejection, case separation,
revision changes, month-end follow-ups and unresolved claim references.
Full runtime type checking and an additional operator-inclusive type check pass.
Changed files pass lint, formatting and diff checks.

The first product question was saved twice as a local dry-plan example with
observation dates September 8 and September 9. Reading and comparing those
artifacts identified a definition change, distinct Run IDs, no evidence change,
and `planned` status for both. This is persistence proof, not market analysis.

## Next contract

This slice saves completed runner receipts, including blocked/review receipts.
It does not checkpoint an in-flight or crashed run, resume nodes, restore spent
budget, rerun a model against frozen inputs, schedule follow-ups or record
actual outcomes. Frozen-result reading must not be described as model replay.

Next add persistent run/node checkpoints and budget reservations to the existing
runner, with restart and duplicate-dispatch tests. Then add explicit historical
coverage contracts and an append-only Outcome Ledger tied to the original
packet. Preserve the v0 `historical_window_coverage_unverified` review gate until
coverage has evidence. Broker execution and external sending remain outside
Caseflow authority.
