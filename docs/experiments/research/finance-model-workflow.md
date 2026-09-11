# Finance model workflow

The canonical finance role contracts in `src/shared/lcx-ontology.ts` now drive
`src/agents/finance-model-workflow.ts`. The existing research operator enables the
workflow with `--workflow-models`; omit `--live` to inspect its model allocation
without inference. Add `--live` only for a bounded real source/model run.

| Responsibility                               | Candidate selection                       | Admission boundary                          |
| -------------------------------------------- | ----------------------------------------- | ------------------------------------------- |
| Intake                                       | Deterministic supplied-task/evidence plan | No model inference claim                    |
| Extraction, news review, formatting          | Existing configured primary               | Stage output contract                       |
| Risk, exposure, research draft               | First distinct configured fallback        | Stage output contract and downstream review |
| Evidence, adversarial review, final precheck | Prefer another configured provider        | Record actual model, including fallback     |

Configuration order is a candidate allocation, not a model-quality ranking or a
parameter-count claim. A different model/provider does not prove statistical
independence. Existing static API keys and unexpired bearer tokens are read from configuration,
environment or the existing auth profile store without refreshing OAuth or
writing authentication. Missing credentials remain visible failures. Ordinary
stages have one existing fallback; review stages may consider two, excluding
models that actually authored the draft (and the formatter for final precheck).
Formatting follows the actual successful draft model, keeping one artifact author
and preserving another model for review. Missing or ambiguous author identity
blocks affinity routing and review, including incomplete checkpoint recovery.
Every provider attempt shares one bounded call budget. Default per-attempt
timeouts are 90 seconds for fast work, 180 for reasoning, rewriting and review;
outer scheduling allows the bounded fallback chain to finish.

Pre-draft specialists perform their own evidence checks and do not demand a final
answer from a preceding plan/review. Outputs must match the requested role and stage. Review `pass` cannot coexist
with declared critical findings or evidence gaps. Artifact citations must point
to supplied evidence IDs. These structural checks do not establish numerical,
causal, financial, or factual correctness; the existing quality harness remains
responsible for review and verification. Contract revisions and specialist scope
participate in checkpoint identity.

`finance-model-specialist.ts` supplies a 24-item synthetic entity-relevance
canary. Each request contains at most eight unlabeled cases. The evaluator records
correct usable output, raw contract compliance and transport observation
separately. Extracted/repaired JSON cannot pass raw compliance. A perfect canary
only permits further held-out evaluation; it never promotes a model or proves
larger-model equivalence. No local specialist is automatically placed on the
workflow. Router role/input limits prevent a bounded specialist from becoming a
general fallback.

A useful small-model progression is: freeze the narrow contract, establish a
large-model baseline, build verified examples, train only under separate training
authority, test unseen/time-separated cases, then shadow a single runtime role.
Widen responsibility only after the new scope has independent evidence. Add a
new large model only for a measured quality, latency, cost or availability gap
that the configured candidates cannot close.

The explicit workflow defaults to `bounded_workflow` reasoning policy. On
transports that declare effort support (or the verified official DeepSeek V4
endpoint), extraction, classification, draft synthesis, formatting and final precheck request
`low` effort; risk/exposure and unsupported transports retain provider defaults.
This prevents the entire output allowance being consumed before synthesis starts,
but output truncation is still a failure, never a successful artifact. The actual
requested effort is recorded in transport observations. Use
`--workflow-reasoning provider_default` to retain provider defaults for every role.
This is a per-workflow request option and does not write global model settings.
DeepSeek's [thinking-mode contract](https://api-docs.deepseek.com/guides/thinking_mode/)
defines the supported effort values and defaults.

Channel integrations call the registered `finance_research_run` agent tool through
normal tool dispatch. Supply `ask` and an explicit `asOf` timestamp; planning is
the default. `live: true` enables the existing source collector, committee and
quality workflow under shared model/API budgets and a total cancellation deadline.
The tool returns a private local receipt and exposes the final artifact only after
quality verification. Both operator and tool use `finance-research-runner.ts`;
platform adapters do not own a second research scheduler.

`lcx-external-channel-binding.ts --compatibility-only --json` inspects the generic
channel contract without binding a platform. It writes a separate compatibility
snapshot and cannot be combined with `--apply`. Channel plugins supply inbound
dispatch and outbound adapters; compatibility readiness does not prove an installed
runtime or delivery on a particular platform.

Learning review defaults to all dated batches, retaining supersession and terminal
outcomes across midnight. The sedimentation bridge reuses prior-day receipts.
Absorption audits never synthesize training or adjacent-task evidence, including
when the legacy write flag is supplied. Historical absorption labels remain claims
subject to the evidence gate. A covered, newer native-contract failure routes the
training plan back to candidate repair before another identical evaluation.

## Local preprocessing on an 8 GB Mac

The registered `local_specialist` tool runs small, offline base weights before
the research workflow. `classify`, `extract` and `summarize` currently select
Qwen3.5-2B-4bit under `~/.openclaw/models/local-specialists`. Inputs are capped at
4,000 characters and outputs at 512 tokens, with a 90-second deadline. No cloud
fallback is implicit. The models are loaded on demand and the process exits
after each invocation; text and vision adapters share an OS inference lock.
The text runner limits MLX allocation to 3 GiB and cache to 128 MiB; this is not
a guarantee about total process or system memory. Recurring training remains a
separate owner and must not be started alongside local inference on this host.

Classification is a suggested label, never authority to discard source evidence.
Extracted quotations must be exact substrings of the input; completeness and
summary accuracy still require review. Base outputs may unwrap one complete JSON
code fence, but cannot repair missing fields, incomplete JSON or surrounding
commentary. Receipts distinguish raw contract compliance from usable content and
never claim training absorption. Receipts are written under the workspace's
`state/local-specialist-runs` directory.

Qwen3.5-0.8B-4bit is a smaller installed candidate, not an enabled fallback: its
classification quality did not justify automatic use. The existing Qwen3-0.6B
training/LoRA lane and Qwen3-VL image adapter retain their roles. Model weight
downloads are separate from the Git checkout and record source revision and
SHA-256 verification; a cached model alone is not an active route.
