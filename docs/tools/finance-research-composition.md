# Finance research module composition

`finance_research_run` supports both rule-selected analysis and caller-proposed
module combinations. The optional choice uses the existing finance module
registry; it does not create another ontology or an execution authority.

The combination is a finite DAG when the caller needs more than a preferred
list. Each node names one registered module and its upstream node IDs. The
control layer rejects unknown modules, duplicate IDs, missing dependencies,
cycles, excessive depth, excessive edges, and more than two bounded replans.
The planner adds the required memory, causal, math, and portfolio lanes after
validation; those lanes cannot be removed by a model proposal.

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

`moduleToolsDispatched: false` is intentional. This feature composes analytical
context for the existing research workflow; it does not execute every tool named
in the catalog. A declared tool dependency is not proof that the tool is enabled,
called or successful. Actual tool invocation must use the existing tool runtime,
its authorization checks and its own receipts.

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
`moduleToolsDispatched: false`. The full orchestration remains in the durable
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
