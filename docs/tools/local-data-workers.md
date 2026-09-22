# Agent-supervised local data workers

Local models are auxiliary data workers, not research planners, risk authorities
or final reviewers. The agent chooses a task, supplies bounded source records,
reviews the returned evidence and decides what happens next. No local result
confers trading, messaging, tool execution, provider configuration or memory
write authority.

## Duties

- `clean`: deterministic whitespace normalization and duplicate marking. No
  inference. Every record and original text remains present; duplicate records
  receive `duplicateOf`, not deletion.
- `classify`: preliminary labels from the caller's label list. Never discard a
  source or decide a trade based on a label. A valid label is not proof of semantic
  correctness.
- `extract`: verbatim quotes covering all non-whitespace source characters,
  including signs, units and caveats. This deliberately conservative check can
  reject a useful partial extraction. It returns the original source to the
  supervising agent instead of accepting an incomplete result.
- `summarize`: compatibility request only; currently returns source without
  inference because unrestricted summaries have not qualified.
- `local_vision`: bounded descriptions of supplied images for review against the
  original image. No numeric trading or risk authority is inferred from pixels.

The existing Qwen3.5-2B profile handles text preprocessing. The 0.8B candidate and
old Qwen3 adapters are not automatic fallbacks. The old local quality-harness
adapter has an empty role scope and rejects direct invocation before model
loading. Isolated model evaluations may use the low-level adapter, but that does
not qualify it for production research or final review.

## Batch contract

Use `local_specialist` with either `text` or `records`, never both:

```json
{
  "task": "clean",
  "records": [
    { "id": "source-1", "text": " revenue   -5% " },
    { "id": "source-2", "text": "revenue -5%" }
  ]
}
```

A batch accepts at most 32 uniquely identified records, 4,000 characters per
record and 32,000 characters overall. The batch deadline is 60 seconds; each
model call has a 15-second deadline and a 512-token limit. There are no automatic
retries or fallback models. An inference or contract failure stops further model
calls in that batch, with source preserved for remaining records. A subsequent
batch receives a fresh budget. Simultaneous batches receive a busy response,
not an unbounded queue.

Within one batch, byte-for-byte identical text reuses a contract-accepted result
for the same task and labels. Every record remains present and requires its own
agent review. Reused items report `modelCalls: 0` and `reusedFrom` with the first
record and its receipt; they never invent another inference observation. The
batch reports `reusedCount`. Whitespace differences are not normalized for this
purpose. Failure clears reuse, and subsequent batches always start fresh.

The result contains one item per input, source text, review status and local
receipts. `batch_partial` indicates fallback items; `batch_completed` means all
items were processed, not that model judgments are correct. The source hash
supports comparison with the original. Cancellation terminates an active local
inference; interrupted requests are never replayed automatically.

## Residency and supervision

The host owns a JSONL worker process in `scripts/local-model/lcx_text_worker.py`.
It accepts only bounded text generation requests and has no tool dispatcher.
Weights load on the first inference and are reused across subsequent batches.
The worker uses the existing cross-process inference lock, an offline environment
without provider credentials, and MLX memory/cache limits. Vision uses the same
inference lock and allows one concurrent invocation, with a 30-second limit.

Both the daemon-free `serve` entry and the Gateway model-fleet plugin use
`startLocalSpecialistService`. Missing optional weights or Python degrade this
capability rather than aborting host startup. A supervised worker restarts after
exit with bounded backoff; failed requests return to the agent, never replay.
Host shutdown stops the child. Continuous availability therefore depends on the
existing host supervisor being deployed and running; adding this code is not
proof of deployment or login persistence. It does not create another scheduler,
install a service or change live provider configuration.

The existing resident-worker tests cover process reuse, concurrent-call rejection,
cancellation, timeout and crash recovery. Real MLX observations must remain
separate from these protocol fixtures and from deployed-service evidence.

## Responsibility handoff

| Layer                  | Existing owner                                     | Responsibility after local role retirement                                                                   |
| ---------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| System planning        | Central Agent Harness and its TypeScript gate      | Discover registered modules, propose and validate bounded plans; no live execution authority                 |
| Research orchestration | Finance research runner and finance model workflow | Source collection, committee dependencies, research drafting, risk review and quality review                 |
| Data processing        | `local_specialist` and its host-supervised worker  | Bounded cleaning, preliminary labels and source-preserving extraction                                        |
| Failure handling       | Calling agent and workflow receipts                | Preserve original input, report missing evidence or failed stages; never treat fallback as accepted research |

Both finance CLI entry points now require explicit configured-model selection
before live research. `lcx-finance-research-run.ts --live --workflow-models
--write` hands committee and quality stages to the existing finance model
workflow with one shared call budget. `lcx-finance-research.ts` retains its
existing `--workflow-models` and `--configured-model` routes; `--sources-only`
remains available for collection without research inference. Configured models
are candidates, not automatically qualified models.

Old local research commands fail before source collection and adapter resolution,
with the replacement route in the error. No automatic provider escalation occurs.
Selecting `--workflow-models` without `--live` still produces only a plan. This
handoff changes local code; existing unattended invocations need their explicit
execution policy checked before deployment. Training, model promotion and live
service configuration remain separate responsibilities.

The workflow role-handoff test exercises the CLI, existing router and all ten
role contracts with fixture transports: deterministic intake, nine bounded model
stages, distinct draft/final-review models, and a shared exhausted-budget gate.
It does not fetch sources or prove model answer quality. Workflow revision v10
assigns formatting to the reasoning slot used by drafting, avoiding an initial
fast-model rejection on the normal route while retaining runtime author affinity
when drafting used a fallback. No ontology relation or persisted state shape is
changed.
