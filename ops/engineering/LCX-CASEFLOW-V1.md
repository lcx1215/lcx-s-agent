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

## Source-node checkpoints and budget continuation

Add `--checkpoint-run RUN_KEY` to an explicit live case command. The operator
uses `source-checkpoints.sqlite` under `--case-dir`, namespaced by Case ID and
RUN_KEY. Omit the flag to keep the existing non-persistent collection behavior.
Planning and frozen-read modes reject checkpoint mutation.

```sh
pnpm lcx:finance:research --case-dir ./caseflow-data --case-id crypto-us-sentiment \
  --checkpoint-run observation-1 --ask 'Review six months of sentiment' \
  --as-of 2026-09-08T00:00:00Z --live --model MODEL_ID --adapter ADAPTER_PATH
```

Repeat the same command to continue source collection. A new observation date,
plan, budget, source selection, retry policy or caller execution fingerprint
requires a new RUN_KEY; a mismatch fails before dispatch. Library callers must
change `executionFingerprint` when changing custom adapter code/configuration.
The operator supplies its recorded code/config fingerprint; its scope remains
the explicitly listed files, not the entire dependency or credential closure.

SQLite commits the worst-case source-attempt reservation before dispatch.
Reservations and result publication are atomic across processes, and reopening
the run retains charged budget. Completed results, including failed/cancelled
ones, are reused. Undispatched nodes can run with the remaining budget. There
is no automatic refund or retry of a completed failed node.

A reserved node without a durable result may have sent a request before a crash,
or may still belong to a live process. It becomes `needs_review` with
`checkpoint_dispatch_outcome_unknown`, retains its reservation, and is never
automatically sent again in that checkpoint run. This prevents duplicate source
dispatch; it does not promise recovery of an externally executed result. A new
RUN_KEY is an intentional new collection and gets a separate budget.

Receipts expose `checkpoint.scope = source_nodes_only`, `reusedJobIds` and
`uncertainJobIds`. Preserved node receipts retain their original correlation
IDs. Aggregate call counts describe the included known receipts, including
reused ones; they are not counts of new calls during the resume invocation.
Worst-case reservations can exceed observed calls and are never reconstructed
from successful calls alone. Total invocation timeout restarts on resume; it
is not a persisted lifetime deadline. Rate-limit/circuit state is not restored.

Checkpoint storage failures stop further worker dispatch and drain in-flight
workers before closing the database. A result-write failure leaves the prior
reservation intact, so restart cannot silently repeat that node. The current
store has no automatic uncertain-node reset or destructive cleanup command.

69 focused tests pass across storage, batch/resume, runner, Caseflow, API
contract and operator suites. Evidence includes abrupt child-process exit,
two-process reservation contention, result persistence failure, completed-node
reuse, cancellation continuation, budget exhaustion across reopen and changed
input rejection. Runtime and operator-inclusive type checks pass. These are
local synthetic-source tests, not a fresh market or model-quality evaluation.

## Model-stage checkpoints and inference budget

The existing `--checkpoint-run` live interface now enables both source and
model checkpoints. `--max-model-calls 48` sets an independent persistent model
invocation limit (48 by default). This is a call-count limit, not a token,
monetary or lifetime wall-clock budget. Every routed adapter attempt and legacy
invoker dispatch reserves one call before invoking the implementation. Failed,
timed-out and interrupted calls retain their reservation; already-aborted
requests are not dispatched or charged.

Committee and quality are two stage checkpoints around the existing owners.
A completed stage reuses its full original receipt, including unsuccessful
quality outcomes, model-call timestamps and attestation records. No model
invocation occurs for that stage on resume. `modelCheckpoint` reports
`newModelCalls`, `reservedModelCalls`, `reusedStages` and
`attestationScope: original_execution_receipts`. A cached attestation is not
new inference or a new quality assessment.

Cached committee results retain their exact original evidence context,
including the coverage summary. New invocation transport accounting remains in
the batch budget metadata. Source results, question/date/mode, caller code/config
identity, routing policy and model budget must match. A changed input requires
a new checkpoint key; it cannot silently reuse previous model conclusions.
The model ledger is separately namespaced in the same SQLite database.

An unfinished stage is `needs_review` with `model_stage_outcome_unknown` and is
not restarted automatically. This includes uncertainty after a crash or failed
stage-result publication. Stage granularity is intentional: individual roles
inside an interrupted committee or quality stage are not resumed. Existing
in-memory DAG behavior remains owned by the pool; there is no replacement DAG.

69 focused tests pass across model storage, end-to-end runner restoration,
source checkpoints, Caseflow, model routing, quality and operator suites.
End-to-end tests verify no new model calls after restart, exact original evidence
and quality receipts, budget exhaustion remaining blocked, and unchanged raw
source evidence. Additional tests cover charged failures, cancelled dispatch,
unknown stage outcomes and changed evidence. Runtime and operator-inclusive
type checks, lint, formatting and diff checks pass.

## Remaining contract

The implemented recovery boundary is source nodes plus whole model stages.
It is not arbitrary per-role full-DAG Resume or model replay. A changed code
fingerprint (including upgrading to this implementation) requires a new key;
prior source-only checkpoint keys are preserved rather than migrated silently.
Each returned invocation may still produce a distinct frozen CaseRun.

## Outcome Ledger

The original frozen packet reference owns every outcome record. The ledger
stores original claim text, timestamped/field-level observations, an explicit
finding (`supported`, `contradicted`, `inconclusive`), deviation notes and
invalidation conditions. Findings remain caller assessments with status
`recorded_for_review`; they are not machine-verified prediction scores.
A packet with no claims cannot acquire invented claims through this interface.

```sh
pnpm lcx:finance:research --case-dir ./caseflow-data --packet-ref RUN_REF \
  --outcome-file ./observation.json

pnpm lcx:finance:research --case-dir ./caseflow-data --packet-ref RUN_REF \
  --list-outcomes
```

Example input structure (use actual claim IDs, evidence and observed dates):

```json
{
  "recordId": "quarter-1-review",
  "checkpointMonths": 3,
  "observedAt": "2025-04-01T00:00:00Z",
  "evidence": [
    {
      "id": "closing-price",
      "source": "artifact://audited-observation",
      "sourceTimestamp": "2025-03-31T00:00:00Z",
      "field": "close",
      "value": 120,
      "unit": "USD"
    }
  ],
  "assessments": [
    {
      "claimId": "original-claim-id",
      "finding": "inconclusive",
      "evidenceIds": ["closing-price"],
      "deviation": "The original claim did not declare a numerical target.",
      "invalidationConditions": ["The original causal premise no longer holds."]
    }
  ]
}
```

Only three/six-month checkpoints present in the original packet are accepted.
Observation dates must be between the case date and the present; source dates
cannot exceed the observation date. Early records are labelled `interim`.
Sources are retained as supplied, not fetched or certified by this interface;
freshness and semantic support remain review responsibilities. The historical-data gate separately checks completed date coverage against the supported calendar.

`outcome-ledger.sqlite` uses transactional append, a per-packet hash chain and
unique record IDs. Repeating identical input is idempotent. A changed payload
with the same record ID is rejected. Corrections use a new `recordId`, the prior
record's hash in `supersedes`, and a `correctionReason`; they must reference an
unsuperseded entry in the same packet/checkpoint. Reads retain all history.
SQL triggers reject UPDATE/DELETE through the ordinary database interface.
Hashes detect changed content relative to retained references; they are not
signatures and do not defend against an administrator replacing the entire
ledger or removing its tail without an external anchor. The original packet
file is never modified.

30 focused tests pass across ledger, Caseflow, runner and operator. Coverage
includes record/read, unchanged original packet, duplicate submissions,
correction history, unknown references, future dates, interim classification,
append-only triggers, tamper detection and operator-mode separation. Runtime
and operator-inclusive type checks, lint, formatting and diff checks pass.
The fixtures are synthetic historical cases, not fabricated future outcomes
for the current research question.

## Next delivery boundary

The lifecycle now has frozen cases/runs/packets, bounded recovery and appended
outcome records. Quarterly scheduling uses the existing Gateway Cron service through explicit registration.
Numeric calibration uses frozen event definitions; live binding and source provenance still require their own receipts.
The integrated local candidate has now been exercised through the lifecycle command below. Historical coverage and semantic-quality gaps still block live research promotion. Broker execution and external sending remain
outside Caseflow authority.

## Integrated lifecycle entrypoints

Discover saved cases without remembering content hashes:

```sh
pnpm lcx:finance:research --case-dir ./caseflow-data --list-cases
```

This inventory is derived from verified artifacts and includes case/revision,
Run reference, observation date, packet state, claim count and follow-up dates.
It does not introduce a second registry.

Run the entire lifecycle with explicitly synthetic adapters:

```sh
pnpm lcx:caseflow:demo --output ./local-artifacts
```

Each invocation creates a new output subdirectory containing frozen runs,
SQLite source/model checkpoints, the Outcome Ledger, `summary.json` and a
readable `index.html`. It uses the real runner and persistence modules to
execute, freeze, resume, compare and append an outcome. Assertions stop the
command if resume dispatches new source/model work or changes frozen evidence.
The synthetic model and observations are labelled throughout; this command
never fetches live market data or performs real inference.

The integrated run observed one synthetic source call and twenty injected
model calls initially, then zero new calls on resume. Two runs were indexed,
frozen evidence compared equal, and one quarterly review record was appended.
96 focused tests plus runtime/operator type checks passed on the integrated
candidate. Remote review, merge and actual market-quality proof remain separate.

## Architecture, historical coverage and research quality

The canonical ontology maps Caseflow objects to existing task/receipt/artifact/evidence
entities. Mind-model, head-tail, flow-graph and change-impact owners supervise the
same lifecycle, including its source and model checkpoints. A new Caseflow entrypoint
must register under the existing lifecycle cluster.

Historical daily data must cover every completed date in the requested window for
each provider independently. The calendar currently covers NYSE 2026–2028 and UTC
daily crypto. Unknown equity years, missing/duplicate/invalid bars and unfinished
current dates stay in review. Calendar coverage does not certify corporate-action
adjustments or cross-provider price agreement. NYSE dates follow the
[exchange calendar](https://www.nyse.com/trade/hours-calendars).
The Binance adapter uses only the public spot daily-kline endpoint and validates
complete OHLCV bars; it exposes no account or order operations.

Attribution/election/scenario questions require structured `supportingAnalysis`:
at least two causal hypotheses with mechanisms, alternative explanations and
falsification tests; at least three conditional scenarios with evidence IDs and
probabilities summing to one. These independently checked constraints improve
reviewability. They do not establish causality or calibrate a model's probabilities.
Source and model approval alone cannot satisfy a missing assessment.

## Frozen forecasts and scoring

Pass `--forecast-file forecasts.json` when creating a saved case. Each array entry
contains `id`, `field`, `unit`, `source`, `checkpointMonths` (3 or 6), `threshold`
and `probabilityAbove` (0–1). The event is strictly `observed value > threshold`.
Forecasts participate in the case-definition hash. Changing them creates a revision.

On outcome append, matching numeric observations produce a Brier score
`(probabilityAbove - outcome)^2` and a 0.25 reference score for a constant 0.5
forecast. This is one-event scoring, not evidence of model-wide calibration.
The forecast must have been frozen before the checkpoint. Exactly one observation
must match the frozen source, field, unit and checkpoint timestamp; otherwise it
remains unscored. Its provenance remains `supplied_observation_not_independently_verified`.
Forecast-only outcomes may use an empty assessments array. Corrections remain appended.

## Quarterly scheduler binding

```sh
pnpm lcx:finance:research --case-dir ./caseflow-data --packet-ref RUN_REF --register-followups
pnpm lcx:finance:research --case-dir ./caseflow-data --packet-ref RUN_REF --followup-status
```

Registration creates two isolated one-shot jobs through the configured Gateway,
with external delivery disabled. SQLite reserves each registration before dispatch;
concurrent calls cannot create the same binding twice. Unknown dispatch or removed
bindings require reconciliation, not blind recreation. Gateway read-back determines
current binding status; the original packet keeps its immutable `not_scheduled` dates.
A scheduler receipt is not proof that a future review ran or that observations were
correct. A Gateway protocol/authentication failure blocks binding and must be fixed
in the runtime owner before retries.

For a deployed Gateway using a newer wire protocol, pass `--gateway-cli` with the
absolute JavaScript entrypoint of that runtime's installed CLI and `--followup-agent`
with the explicitly selected existing agent ID. This explicitly
uses the deployed client's `cron add/list/get` commands and declaration identity;
it does not relax protocol negotiation or change authentication. The adapter reads
back only matching Caseflow jobs. Follow-ups record the source entrypoint and its
working directory, so preserve that checkout until the jobs are migrated.
Evidence-only follow-ups of blocked cases may have no claim assessments; they must
still append at least one timestamped observation and cannot invent original claims.
