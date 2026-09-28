# Finance research module composition

`finance_research_run` supports both rule-selected analysis and caller-proposed
module combinations. The optional choice uses the existing finance module
registry; it does not create another ontology or an execution authority.

The combination is a finite DAG when the caller needs more than a preferred
list. Each node names one registered module and its upstream node IDs. The
control layer rejects unknown modules, duplicate IDs, missing dependencies,
cycles, excessive depth, excessive edges, and more than two bounded replans.
The planner adds required causal, math, and portfolio lanes after validation;
those requirements cannot be removed by a model proposal. Retained learning is
auxiliary unless explicitly selected or the task requires a retained method.

The accepted plan also carries derived `composition.control` metadata. Required
causal, math, risk and explicitly required retained-method lanes are `hard`; analytical
lanes are `soft`. Soft lanes may be reordered or revised within the bounded
`maxSoftReplans` budget. Hard lanes keep their dependency and stop conditions:
missing evidence, a blocked risk gate, cancellation, or unresolved execution
state stops the cycle. The model cannot submit or override this control block.

Start with a planning call (`live` omitted or false). The response includes:

- `moduleCatalog`: registered module IDs, roles and declared tool dependencies.
- `orchestration`: the accepted composition, module contracts, selection trace,
  required tools, review requirements and boundaries.
- `plannedTargets`: the source targets the workflow will use.
- `gates`, `missingEvidence` and, after collection, `sourceRecovery`: feedback
  for deciding whether to revise the composition, request different evidence,
  wait, reconcile an uncertain dispatch or stop.
- `receiptPath`: the durable local receipt containing the same accepted plan.

A subsequent call can provide a different composition:

```json
{
  "ask": "Review the transmission mechanisms behind this market hypothesis",
  "asOf": "2026-09-21T12:00:00.000Z",
  "moduleSelection": {
    "moduleIds": ["credit_liquidity", "cross_asset_liquidity", "technical_timing"],
    "rationale": "Test funding pressure and cross-market transmission against observed price behavior.",
    "composition": {
      "nodes": [
        { "id": "timing", "moduleId": "technical_timing", "dependsOn": [] },
        { "id": "credit", "moduleId": "credit_liquidity", "dependsOn": ["timing"] },
        { "id": "cross_asset", "moduleId": "cross_asset_liquidity", "dependsOn": ["credit"] }
      ],
      "maxReplans": 1
    }
  },
  "live": false
}
```

The explicit list replaces rule-suggested domain lenses and preserves the
caller's preferred analytical order. Causal review, retained finance knowledge,
and required portfolio/math lanes are retained by the planner. Source evidence,
review gates, decision mode, budgets and execution authority remain separate
contracts. Unknown IDs, duplicates, empty/oversized proposals and extra override
fields are rejected before workflow dispatch. Validation proves a well-formed
composition, not that the economic hypothesis is correct.

The accepted module contracts reach both committee and quality model requests.
They are also part of the model checkpoint fingerprint: changing the composition
under an existing run ID cannot reuse the previous model-stage results. Use a
new run ID for a changed analysis while preserving the old receipt.

## Execution scope

`moduleToolsDispatched: false` is the default. This feature composes analytical
context for the existing research workflow and does not execute every tool named
in the catalog unless the caller explicitly supplies `live: true` and
`executeModules: true`. A declared tool dependency is not proof that the tool is
enabled, called or successful. Actual invocation uses the existing tool runtime,
its authorization checks and its own receipts; a requested execution with a
missing hard lane remains blocked.

Module selection does not silently change source targets. Supply `targets` when
additional instruments, collections or source restrictions are needed. `live:
true` retains its existing meaning: bounded source/model calls are allowed; it
does not authorize orders. Without it, selection remains a local plan.

The caller can inspect feedback and make another bounded call. There is no new
unattended re-planning loop or automatic retry in this feature, and changing
modules does not clear failed source or quality gates. Local fixture tests of
this path do not prove that a deployed model chose useful modules or that the
production service has adopted the change.

## Central Harness feedback

The existing `finance_research_run` capability accepts the same module proposal
through the Central Agent Harness. Its TypeScript gate validates module IDs,
rationale and allowed fields before dispatch. Existing planning-only and
no-provider-call boundaries still apply.

The tool returns a compact `composition` before larger receipt sections so it
survives the Harness's 512-byte step-outcome budget. It includes selection source,
the first four primary modules, an explicit omitted count, and
`moduleToolsDispatched: false`. When module execution was requested, it also
includes `replanStatus`, `nextAction`, hard/soft failure counts and
`remainingSoftReplans`. `blocked_hard` always stops; `replan_soft` permits only
a bounded revision of soft lanes. The full orchestration remains in the durable
research receipt. The next Harness cycle can use its existing backlog to revise
a proposal; no second scheduler or decision loop is introduced.

The integration test runs two real Harness cycles and the real research tool in
an isolated workspace, with an injected decision fixture. This proves feedback
transport and revised planning, not real-model autonomy or live execution.

## Discovery before proposal

The central brain prompt now includes the registered module IDs and roles,
derived from the same finance registry, plus the planning argument contract.
This trusted static catalog has a separate 8 KiB ceiling; growing beyond the
ceiling fails explicitly instead of silently hiding modules. It does not consume
or expand the existing volatile perception budget.

Rule routing remains available by omitting `moduleSelection`. Catalog visibility
is not evidence of model competence: the integration fixture discovers an ID
from the actual prompt and proposes it through the real gate, but no deployment
or comparative model-quality claim follows from that test.

## Comparing a proposal with rule routing

`evaluateFinanceRouting` in `src/agents/central-harness/finance-routing-eval.ts`
accepts one labeled task, an existing `CentralBrain`, and an isolated output
workspace. It runs the real Harness and planning capability with one-action
scope. The evaluator pins the question and timestamp and blocks additional
arguments or owners. Required/allowed module labels are withheld from perception.

The result compares missing and unnecessary modules against the rule plan,
reports elapsed time and extra proposals, and preserves the Harness receipt.
A proposal only wins when neither module error count increases and at least one
decreases. Mixed changes stay `mixed`; failures and multiple-action proposals
stay `not_assessable`. Choosing the same route as rules is `equal`, including
when the model explicitly chooses those modules. An omitted proposal is recorded
as rule routing, not autonomous module selection.

These labels assess module selection, not investment correctness, answer quality,
or realized returns. Mandatory planner lanes are exempt from unnecessary-module
counts. Elapsed time covers the candidate cycle, not a controlled latency
benchmark. `evidenceKind` is supplied by the caller and must be backed by the
provider/model receipt and retained invocation evidence before claiming a real
model run. Current tests use fixtures. Evaluation never promotes a model or
changes production routing.

## Synthetic tool-feedback evaluation

`evaluateFinanceFeedback` exercises up to three existing Harness cycles against
an isolated synthetic position ledger. The task declares a primary and backup
source. A scoped registry permits only those two exact paths and read-only
ledger arguments. The evaluator retains real tool observations, passes compact
numeric evidence into the next perception, and checks source recovery, exact
answer fields, stopping, duplicate reads and rejected or excess proposals.
A guessed correct answer without tool evidence does not pass. The deterministic
baseline follows the same tool and evidence path.

This scenario tests a specific Harness protocol, not general financial judgment.
Zero tool calls from a failed model are noncompletion, not efficiency. Compare
local models using the existing MLX adapter with network disabled and serialized
inference. Keep raw-contract normalization, runtime identity, model/adapter path,
case labels and failures visible; never infer deployment or role qualification
from cache presence or an old promotion receipt. Prompt/protocol mismatch can
also cause failures and must be distinguished from a model's reasoning limits.

## Applying AutoScientist-Quant to LCX

[AutoScientist-Quant](https://arxiv.org/abs/2608.28632) contributes a bounded
research-control pattern: use one proposal protocol to choose among improving a
candidate, combining candidates, pivoting to a new hypothesis, or stopping; keep
parentage and failed trials; spend an explicit evaluation budget; and keep the
final holdout outside the search loop. LCX can reuse that control pattern without
turning the paper's objective, candidate types, or execution assumptions into
LCX policy.

The shared part is the **decision and evidence protocol**, not one score or one
owner for all three research phases:

| Paper phase             | Nearest LCX analogues                                                                                                                                                 | What transfers                                                                                                                                                       | What it does not establish                                                                                                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alpha discovery         | `finance-research-runner.ts`, `finance-research-execution-bridge.ts`, and the scheduled day research path                                                             | Use the source-bound research receipt as the evidence root; any iterative search must add explicit candidate IDs and parent links.                                   | A model-generated hypothesis or code change is not a validated alpha. The existing research path does not become an unrestricted code-evolution runner.                                                                                                                                                                   |
| Alpha-library filtering | `finance-strategy-rule-ledger.ts`, `finance-rule-readiness-state.ts`, `finance-research-portfolio-plan.ts`, and the portfolio composition/execution gates             | Keep candidate lifecycle, readiness, allocation, and execution eligibility as distinct steps, each rechecking its own inputs.                                        | An active rule, a readiness result, or a paper allocation is not proof of positive net returns or independent diversification.                                                                                                                                                                                            |
| Model search            | `scripts/operator/local-brain-training-plan.ts` and `scripts/operator/local-brain-distill-eval.ts`; separately, `finance-tuning-proposal.ts` for forecast calibration | Retain model identity, evaluation inputs, failures, and proposal evidence under their existing owners. Keep forecast calibration separate from model qualification.  | The conviction-floor proposal uses scored call correctness; it is neither model-weight/hyperparameter search nor realized strategy P&L. A calibration proposal or legacy promotion record is not strategy-level execution eligibility. Model-evaluation scores cannot be averaged with strategy returns to select trades. |
| Outcome feedback        | Scheduler night settlement, `finance-outcome-backfill.ts`, reflection, tuning lifecycle, and the Central Harness lifecycle projection                                 | Feed settled, attributable outcomes back to the owner that can interpret them; keep forecast calibration separate from strategy economics and execution eligibility. | A settled paper outcome does not prove that a strategy is profitable, that an LLM learned, or that live behavior should change.                                                                                                                                                                                           |

The current `finance-strategy-all-methods.ts` is a research receipt aggregator
for the 12-method surface. It reads `experiments/manifest.json` only to check
the readiness of `source_receipts`, joins pre-existing benchmark and method
artifacts, and emits a `research_only_no_execution` receipt. Its version 2 M02
section carries all 48 fixed parameter-sensitivity cells—including
underperforming cells, both same-cost baselines, and period metrics—with a
completeness gate; each row is explicitly labeled as a sensitivity cell, not a
search candidate. This preserves the existing grid evidence in the aggregate,
but does not make the receipt an adaptive experiment or trial registry. The
manifest is not a candidate/trial registry, and the aggregate still provides no
immutable candidate parentage, cross-run evaluation budget, or enforced holdout
boundary. Reuse these artifacts as evidence inputs when a search owner exists;
do not infer search lineage or promotion from source readiness or catalog
coverage.

The strategy-rule ledger already supplies immutable declared-rule references
and explicit activation/retirement events, but its contract deliberately has no
score or ranking fields; comparative rule evaluation belongs to a separate
factor/alpha evolution loop with its own acceptance gates. A future trial record
should therefore reference the exact declared-rule `ref` instead of copying
rule identity into a second registry. If no existing receipt owner can carry
trial lineage, budget accounting, and split enforcement, the open architecture
decision is one canonical research-only experiment/evaluation owner linked to
those rule refs—not an evaluation feature hidden inside the rule ledger or the
12-method aggregator.

### Typed identity and search actions

At integration, connect existing receipts with typed references; do not reuse
one identifier for different objects:

- `thesisId` identifies an epistemic claim whose evidence can accumulate.
- `searchCandidateRef` identifies an immutable strategy-rule or model-artifact
  version and carries an explicit kind. Do not reuse a bare `candidateId`:
  finance owner contracts already use that name for exact trade-review items
  and article-derived learning-capability records, which are different objects
  from a versioned strategy or model under experiment.
- `searchId` identifies one bounded controller run and its declared scope and
  resource envelope.
- `experimentId` identifies a preregistered evaluation protocol binding a
  `searchCandidateRef` to point-in-time data, split, baseline, cost model,
  objective version, and evaluator version. Each actual evaluation gets its
  own `evaluationId`; repeated attempts remain visible and count toward
  selection bias and resource use.
- `requestId` identifies one model call, while a source-decision reference
  identifies an actual downstream decision. Neither is a candidate or an
  experiment. Request metadata can establish call attempts and outcomes, but
  without explicit linkage and token/cost evidence it cannot establish search
  lineage or enforce a model-spend ceiling.

One thesis may motivate several search candidates; one search candidate may
have several experiments; one experiment may have several evaluation attempts;
an evaluation may use multiple model calls. Preserve those links in receipts.
Where the selected integration includes them, the thesis ledger owns claims and
evidence, and the model-request trajectory owns provider-call metadata.
Strategy-lab experiment guidance defines what a frozen evaluation should
record, but by itself does not prove a durable runtime experiment store. Any
new search coordinator must link existing records rather than duplicate their
state.

Give the four controller actions auditable semantics: `improve` creates a child
of one search candidate and records the exact change; `combine` creates a child
of at least two compatible parent references and deduplicates overlapping
evidence; `pivot` creates a new branch while retaining the rejected or
untestable parent and the observation or reason that caused the pivot; `stop`
appends a terminal event to that search cycle. None of these actions edits or
erases prior evidence, changes the scheduler, or grants promotion or execution
authority.

Every behavior-changing `improve`, `combine`, or `pivot` creates a new immutable
candidate reference and requires a fresh evaluation under a preregistered
protocol; a parent's score never transfers to its child. `combine` is allowed
only when the parents share compatible market, instrument/universe, horizon,
data/label semantics, objective version, and evaluation protocol. If those
contracts differ, start a new hypothesis with a new experiment instead. A child
may cite its parents' evidence to motivate the change, but inherited or
overlapping evidence is not independent support and is not the child's result.

For LCX's current module-planning seam, `improve`, `combine`, `pivot`, and
`stop` are design semantics, not new typed actions in the run schema. The Central
Harness accepts a planning-only module proposal and retains its rationale and
research receipt; it does not automatically generate, combine, or evaluate
strategy/code candidates across runs. Within planning, the four labels can guide
selection or revision of registered analytical modules inside the existing
finite DAG and replan cap. Any future candidate-search owner must make parent
links explicit: `combine` cannot count duplicate or derived evidence as
independent support, and `pivot` must retain the rejected parent and the
observation that falsified it or made it untestable. `stop` is required when a
hard evidence/risk gate fails, the relevant budget is exhausted, or another
candidate cannot change the decision. The scheduled finance lifecycle remains
owned by the scheduler and its canonical research, risk, execution, settlement,
and separately declared calibration/promotion owners.

These labels govern how the system seeks evidence; they do not change
`decisionMode`, `strategyStage`, risk policy, or venue authority. A candidate is
still a claim awaiting its next evidence gate. `stop` ends the current research
branch or search cycle; it does not stop unrelated settlement, risk monitoring,
or already-authorized scheduler phases.

Use lexicographic gates before candidate ranking: first require provenance,
freshness, causal/data validity, and all declared risk constraints; then compare
only candidates admissible for that stage. Strategy performance, model
capability, and portfolio risk are different quantities and must not be collapsed
into one dynamically standardized score. If a stage needs a scalar objective,
freeze its metric definitions, reference population, costs, normalization,
weights, and version before search, and show sensitivity to the declared ranges.
A stage-specific Pareto or constrained comparison is preferable when no
defensible exchange rate exists between metrics. No reward score may compensate
for a failed hard gate.

Treat budgets as a vector of separately enforced ceilings, not as one fungible
number: candidate evaluations, model calls/tokens, provider/API dispatches, and
wall-clock time have different units and owners. Existing research API limits,
model-call checkpoints, Harness context/action bounds, and soft-replan limits
remain authoritative for their own resources. They do not yet form one
cross-phase candidate-search budget. A future search loop must reserve each
resource before dispatch, retain uncertain dispatches as spent until reconciled,
and stop when any required ceiling is exhausted; a model proposal cannot enlarge
those ceilings.

For any adaptive strategy search, use chronological point-in-time data and
separate training, validation, research-feedback, and final holdout intervals.
Purge or embargo observations whose label or holding horizon overlaps a split
boundary. The search controller must not receive the final holdout through
candidate prompts, selection metrics, controller-visible diagnostics, or
next-cycle feedback. A designated final evaluator may inspect it once and write
the result to a final evaluation receipt/report. If that result is used to change
the candidate, retire the set to development feedback and require a new
untouched evaluation set. LCX's strategy-method guidance calls for
train/validation/out-of-sample separation, but that instruction alone is not
evidence of an enforced, inaccessible holdout boundary.

Nightly paper outcomes that reflection or tuning consumes are feedback data,
not a permanently untouched holdout. Keep directional-call correctness,
reconciled net trade P&L, and model-task evaluation as separate evidence types;
each answers a different question, and only strategy-attributed,
cost-complete records can support claims about that strategy's economics.

The local-brain train-slice manifest now emits a content-addressed
`trainingSliceIdentity` over its source training data, output splits, and
selection/alignment policy. Treat this as the identity of one research input,
not the model candidate or a learning result. The local-brain evaluation receipt
result in the training guard log now links that verified slice ref to the exact
adapter under evaluation. The training guard only supplies the ref to a newly
trained candidate's eval; a stable-champion eval is never attributed to the
newest slice. This closes data-input lineage for that edge, but does not yet
record a complete training experiment, parent adapter, vector-budget
reconciliation, or cross-run search decision.

Before claiming the paper's full self-evolving search is integrated, LCX still
needs a versioned candidate lineage across the phases, a cross-phase budget
receipt, and an enforced holdout boundary tied to each experiment. If generated
candidate code is ever executed, it also needs an isolated evaluator with no
secrets, provider/network access, state writes, or trading authority. Keep rule
identity, lifecycle, evaluation, promotion, and execution as separate contracts;
any new experiment/evaluation owner must be the single canonical owner and link
existing rule, source, and outcome records rather than duplicate their authority.
The paper's reported performance remains a research claim from its preprint,
not LCX performance evidence.

## Optiver 的连续决策闭环

Optiver 文章的证据范围、与 LCX 的代码所有者映射、已补的持仓恢复/执行反馈/日历门禁，以及 EV、仓位校准和对手反应等未解决假设，见[研究映射](../experiments/research/optiver-trading-decision-loop.md)。文章用于提出可检验的闭环要求，不作为收益或模型能力证明。

## Research applicability and intraday execution

Evidence-backed thesis proposals may include `applicability` with `horizon`
(`intraday`, `swing`, or `long_term`) and an ISO `validUntil` after the research
as-of. The source and quality gates still apply. Applicability participates in
the research thesis identity, so a new horizon or validity window produces a
new claim record instead of silently extending an old one. Legacy records
remain readable but are not inferred to apply to intraday decisions.

Intraday review selects only active, unexpired, explicitly intraday theses for
the candidate instrument. Its receipt records the selected sources and the
excluded thesis count. Empty context means no eligible evidence, not successful
research absorption. Source coverage, thesis persistence, strategy evaluation,
activation and actual use in an order remain separate evidence steps.

Strategy-bound protective exits (`opening_range_stop`, `reward_target`, and
`pre_close`) bypass discretionary model review after owned-position checks.
Cancellation, market calendar, current strategy binding, quote and shared
execution gates still apply. Entry candidates retain model veto. Quotes that
expire during review are refreshed once and validated again; fallback review
receipts retain elapsed time.

The scheduler processes executable instruments first. Research-scope signals
remain outside the execution decision ledger. Bar collection resumes at the
first missing closed session interval for the configured feed and skips network
collection when all closed intervals are already present. Research refresh and
nightly review remain explicit scheduler options; these code paths do not enable
background model calls or activate research candidates automatically.

### Research trade economics

`node --import tsx scripts/operator/lcx-finance-trade-economics-eval.ts --replay <replay.json> --policy <policy.json> --output <new-output.json>` evaluates an existing replay without broker calls. Freeze policy and assumed round-trip costs before evaluation. The estimator uses only outcomes closed before each decision, updates gross-profit probability, subtracts explicit costs, and caps fractional-Kelly allocation by allocation and observed-loss budgets. The uncertainty penalty is not a confidence interval and historical losses do not bound future losses.

The output compares cash and fixed allocation, scores probabilities, and applies additional cost scenarios. Previously inspected data remains retrospective, not an untouched holdout. Outputs always have no execution authority and cannot promote or change the active trading strategy. A zero allocation is an abstention, not proof of profitable skill.

Central-agent loops default to five cycles, reject non-finite duration/cycle inputs, and stop when consecutive failed owner actions repeat with identical arguments and outcomes. Changed arguments or outcomes remain eligible for bounded follow-up.

### Verifying local learning evaluations

A path string is not evidence. Module-learning plans inspect bounded, nonempty local evidence files before reporting retrieval or application readiness. To report `eval_absorbed`, the evaluation JSON must use `schemaVersion: "lcx_module_learning_eval_v1"`, `verdict: "passed"`, and match the request's `targetModule`, `sourceUrlOrPath`, and `freshAdjacentApplicationTask`. Its nonempty `checks` array contains unique `id` values, `passed: true`, and an `evidencePath` plus the file's SHA-256 in `sha256`. Reviews re-read and hash the artifacts, so old declarations and modified outputs are not counted as verified absorption. Legacy unverified absorption claims remain visible as declared status and require review; no stored receipt is rewritten.

This verifies source binding and local evaluation integrity. It does not prove that an evaluator is correct, that model weights changed, that a strategy is profitable, or that execution has been authorized.

Explicit long-term research without an immediate action or current-price request uses dated historical evidence instead of requiring an executable quote. Current-price and intraday requests retain their quote gates. Provider-native macro identifiers are not interchangeable: Treasury and BLS identifiers must not be sent to FRED as implicit fallbacks.

Module-learning and finance retrieval review tools default to read-only. Persisting a report requires `writeReview: true`; the operator CLI retains its explicit write/no-write option.

### Research handoff and bounded review

When module execution and the quality harness are both enabled, the preliminary
committee runs deterministic intake and one `research_draft` to prepare producer
inputs. Evidence, risk and exposure reviews run in the post-module quality harness
instead of being repeated before the modules exist.
Its receipt says `producer_preparation`; it does not claim a complete committee
review. This preliminary draft must satisfy the producer schema and cite existing
evidence IDs, but its instrument-specific interpretations remain provisional.
Instrument citation coverage is enforced in the full post-module drafting,
formatting and final verifier; a preparation draft cannot qualify a final answer. The post-module quality harness still runs the full review, including
adversarial challenge, formatting, independent final checking and deterministic
verification. Other callers retain the full preliminary committee.

Instrument citation coverage accepts explicit instrument coverage in supplied
broker, filing and controller evidence as well as market packets. This is a
structural citation check, not semantic validation. Account-wide fee gaps do not
establish instrument-specific costs, and unrelated instrument citations remain
invalid. Contract failures provide a bounded diagnostic to the existing fallback;
they do not add retries, increase the call budget, or relax validation. Checkpoints
record the diagnostic without storing raw rejected answers.

Thesis proposals have a dedicated prompt section so normal context truncation
cannot silently remove the database handoff contract. Eligible proposals are
validated against the final supported claims and the exact evidence packet before
entering the existing thesis ledger. Empty proposals remain an explicit outcome.
Daily and intraday decision contexts both exclude explicitly expired theses;
legacy entries without applicability remain available only under the existing
horizon rules. Storage success, quality acceptance, decision consumption, order
execution and profitability remain separate observations.

The research CLI passes its resolved workspace to module execution as well as
checkpoint and receipt storage. An explicit workspace must not silently fall back
to the shell's working directory for framework writes. The separately requested
finance state directory remains the thesis-ledger destination.

Causal/scenario requirements are selected from the original user request, not
from system guidance appended to the model task. When required, the structured
analysis contract has its own bounded prompt section so context truncation cannot
hide fields that the deterministic verifier later requires.

### Module selection with incomplete retained knowledge

The existing Harness can propose a bounded `moduleSelection` through
`finance_research_run`; the central planning surface retains its existing authority.
Select lenses for the question, decision horizon, available inputs and exposure.
An ordinary ledger review need not become an entry-timing or allocation study.

Retained learning is attempted as an auxiliary source. A missing capability card
remains a failed node and cannot be described as an applied method. It does not
block independent source-backed producers. Explicitly selecting retained learning,
requesting a retained method, or declaring a dependency on it preserves that
requirement. Default dependencies connect mandatory lanes; explicit DAG edges
are preserved. Portfolio, arithmetic and causal requirements are not removed.

`requiredEvidenceReady` reports whether mandatory module outputs survived full
quality review and remain in the evidence packet. `allNodesSucceeded` and
`moduleToolsDispatched` still report complete module coverage; they stay false
when an optional lens is missing. The receipt retains every optional failure and
its source gap. The soft-replan budget governs further attempts, not permission to
claim unavailable methods succeeded. Candidate status remains separate from
execution authority.
