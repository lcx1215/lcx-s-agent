# Local Brain Distillation

This is a bounded path for training a local auxiliary model that helps LCX Agent think more smoothly. It does not replace the main API model, does not send live Lark replies, and does not write protected memory.

For fast operator recovery when chat context is missing, start with:

```text
ops/local-brain/README.md
```

## Role

The local model learns only a planning packet:

- task family
- primary modules
- supporting modules
- required tools
- missing data
- risk boundaries
- next step
- rejected context

It should not produce final investment answers, live market claims, execution instructions, or durable doctrine edits.

## How It Trains LCX Agent

It does not directly rewrite the main agent. The training loop is:

1. Read local receipts from Lark language handoff, finance learning application,
   Feishu work receipts, and reviewed brain-distillation candidates.
2. Normalize those receipts into prompt/completion pairs.
3. Correct broad surfaces such as `control_room` and `learning_command` into
   concrete module targets when the text contains finance signals.
4. Train a small local LoRA adapter to emit a planning packet.
5. Run multi-case eval before any promotion.
6. Expose the accepted adapter through a read-only CLI helper.

The main agent can use that helper as a draft planner, then still require API
review, evidence checks, and normal LCX risk boundaries before replying.

The prompt includes the current allowed module taxonomy so the auxiliary model
learns to route work into concrete LCX modules instead of inventing broad labels:

- `macro_rates_inflation`
- `credit_liquidity`
- `etf_regime`
- `company_fundamentals_value`
- `quant_math`
- `portfolio_risk_gates`
- `causal_map`
- `finance_learning_memory`
- `source_registry`
- `review_panel`
- `control_room_summary`
- `ops_audit`

The prompt also carries hard planning hints:

- missing source URL or local file means `source_registry` plus
  `source_url_or_local_source_path`
- missing portfolio math inputs means `position_weights_and_return_series`
- company risk that can affect a portfolio or ETF sleeve must include
  `portfolio_risk_gates`

## Current Recommended Base Model

Use a small Apple Silicon friendly model first:

- `Qwen/Qwen3-0.6B`

Reason: this machine has 8 GB memory. A 0.6B model is the right first target for MLX LoRA. Larger 4B or 7B models should wait until the dataset and evaluation loop are clean.

## Build Dataset

```bash
node --import tsx scripts/dev/local-brain-distill-dataset.ts --json
node --import tsx scripts/dev/local-brain-distill-smoke.ts --json
```

Default output:

```text
~/.openclaw/local-brain-trainer/datasets/thought-flow-v1/
```

The dataset reads:

- `memory/lark-language-handoff-receipts/`
- `memory/finance-learning-apply-usage-receipts/`
- `memory/feishu-work-receipts/`
- `memory/lark-brain-distillation-reviews/`

It intentionally does not read the disabled `lark-language-routing-candidates` corpus.
It also does not train directly on pending brain candidates.

## Brain Distillation Candidate Lane

The old semantic candidate path remains language-routing-only for compatibility.
It is not the main intent brain. New API/Lark/teacher samples that should improve
thinking quality go through a separate candidate boundary:

```text
boundary=brain_distillation_candidate
directory=memory/lark-brain-distillation-candidates/
```

This lane is deliberately reviewed before training:

- unreviewed samples stay `pending_brain_review`
- accepted samples become `accepted_brain_plan`
- token-like, secret-like, empty, and binary payloads are discarded
- artifacts carry `noLanguageRoutingPromotion=true`
- artifacts carry `noLiveSenderTouched=true`

Only reviewed `accepted_brain_plan` samples enter
`local-brain-distill-dataset.ts`. This keeps language understanding and brain
learning separate: model providers can decompose the user's request, while the
local auxiliary model learns better module planning, missing-data discipline,
source boundaries, and rejected-context behavior.

Run the candidate smoke:

```bash
node --import tsx scripts/dev/lark-brain-distillation-candidate-smoke.ts
```

Review pending candidates without writing:

```bash
node --import tsx scripts/dev/lark-brain-distillation-review.ts --json
```

Write reviewed candidates when the pending artifacts look clean:

```bash
node --import tsx scripts/dev/lark-brain-distillation-review.ts --write --json
```

The review output lives under:

```text
memory/lark-brain-distillation-reviews/
```

The dataset reads reviewed artifacts from that directory. It still ignores raw
pending candidates until review marks them `accepted_brain_plan`.

## MiniMax M2.7 Teacher Batch

MiniMax M2.7 is a stronger hosted teacher than the small local Qwen adapter.
Use it to produce reviewed planning samples for the local brain; do not use it
as a direct live sender from this script.

This is additive. It does not replace the existing Lark/API candidate path,
review path, dataset builder, local Qwen adapter, or hardened planner contract.
It only appends higher-quality reviewed teacher samples into the same brain
distillation review directory.

Smoke without network:

```bash
node --import tsx scripts/dev/minimax-brain-teacher-batch.ts --mock --limit 3 --json
```

Run real MiniMax teacher calls when `MINIMAX_API_KEY` is available:

```bash
node --import tsx scripts/dev/minimax-brain-teacher-batch.ts --limit 12 --write --json
```

Defaults:

- model: `MiniMax-M2.7`
- source: `openclaw agent --agent research-minimax`
- model ref: `minimax-portal/MiniMax-M2.7`
- direct API base URL, when `--direct-api` is used:
  `https://api.minimax.io/anthropic`
- output: `memory/lark-brain-distillation-reviews/`

Use `--direct-api` only when a direct MiniMax API key is available. The default
path uses the existing local OpenClaw MiniMax agent interface.

The resulting artifacts are still review artifacts with
`noLanguageRoutingPromotion=true` and `noLiveSenderTouched=true`. They feed the
local brain dataset; they do not promote language-routing families and do not
prove live Lark behavior.

## Train First LoRA

Install MLX-LM in an isolated local environment, not in repo dependencies:

```bash
python3 -m venv ~/.openclaw/local-brain-trainer/.venv
~/.openclaw/local-brain-trainer/.venv/bin/python -m pip install --upgrade pip wheel setuptools
~/.openclaw/local-brain-trainer/.venv/bin/python -m pip install mlx-lm
```

Run a tiny first pass:

```bash
~/.openclaw/local-brain-trainer/.venv/bin/python -m mlx_lm lora \
  --model Qwen/Qwen3-0.6B \
  --train \
  --data ~/.openclaw/local-brain-trainer/datasets/thought-flow-v1 \
  --adapter-path ~/.openclaw/local-brain-trainer/adapters/thought-flow-v1-qwen3-0.6b \
  --fine-tune-type lora \
  --batch-size 1 \
  --iters 20 \
  --learning-rate 1e-5 \
  --max-seq-length 2048 \
  --mask-prompt \
  --grad-checkpoint
```

For a smoke-only run on an 8 GB machine, use `--iters 2`.

## Acceptance

The trained model is only useful if it can answer an adjacent prompt with:

- no old Lark context reuse
- research-only or no-execution boundary
- correct module order
- missing data before conclusion
- next step as a planning action, not a final market call

Run the local acceptance probe:

```bash
node --import tsx scripts/dev/local-brain-distill-eval.ts \
  --model Qwen/Qwen3-0.6B \
  --adapter ~/.openclaw/local-brain-trainer/adapters/thought-flow-v1-qwen3-0.6b \
  --json
```

For the actual planner path, also test the hardened output contract. This
scores the final plan after deterministic safety overlays, not the raw model
completion:

```bash
node --import tsx scripts/dev/local-brain-distill-eval.ts \
  --model Qwen/Qwen3-0.6B \
  --adapter ~/.openclaw/local-brain-trainer/adapters/thought-flow-v1-qwen3-0.6b \
  --hardened \
  --progress \
  --json
```

The probe runs multiple cases. It must fail adapters that only learn the JSON
shape but collapse the actual work plan into a generic `finance_learning` or
`control_room` bucket. A passing adapter needs concrete finance modules such as
`macro_rates_inflation`, `credit_liquidity`, `etf_regime`,
`company_fundamentals_value`, and `portfolio_risk_gates`; it also needs to keep
ambiguous repeat requests out of old Lark context.

Current local accepted adapter:

```text
~/.openclaw/local-brain-trainer/adapters/thought-flow-v1-qwen3-0.6b-taxonomy-v3/
```

Current benchmark snapshot:

- bare `Qwen/Qwen3-0.6B`: 0 / 7 strong planning cases
- `taxonomy-v3`: 5 / 7 strong planning cases
- `taxonomy-v4`: 4 / 7 strong planning cases
- `synonym-v5`: 1 / 7 strong planning cases after expanding language
  synonym seeds. Rejected because it learned the broader wording but drifted on
  strict planning contracts such as `source_registry`, `causal_map`,
  `position_weights_and_return_series`, and stable old-context rejection.
- `teacher-v6`: 1 / 7 after adding a reviewed teacher batch and training 30
  iterations at `6e-6`. Rejected because it overfit noisy planning language,
  duplicated boundaries, and reintroduced dirty old-context concepts.
- `teacher-v7`: 0 / 7 after oversampling reviewed brain cases and training 16
  iterations at `2e-6`. Rejected because it frequently emitted prose or invalid
  JSON, confused missing-data keys, and failed ambiguous-repeat isolation.
- `teacher-v7` plus hardened planner contracts: 7 / 7 strong planning cases.
  This is accepted only as the runtime pattern "model draft plus contract
  repair"; the raw adapter is still rejected as a standalone planner.

Keep `taxonomy-v3` as the selected local helper until a newer adapter beats it
on the strong eval. Newer training runs are candidates, not automatic
promotions.

Operational fallback: `local-brain-plan.ts` applies hard contract overlays for
known high-risk families such as ambiguous repeat/reset, external source missing
URL, scholarly coverage honesty, portfolio math with missing weights/returns,
ETF timing, and company-to-portfolio risk transmission. These overlays do not
make a weak adapter promotion-ready; they keep the local helper output usable
while training improves.

Run a read-only planning pass:

```bash
node --import tsx scripts/dev/local-brain-plan.ts \
  --ask "我持有 QQQ、TLT 和 NVDA，先拆内部研究模块，不要给交易建议。" \
  --json
```

This helper reports `liveTouched=false`, `providerConfigTouched=false`, and
`durableMemoryTouched=false`. It is a local planning aid, not a live sender.

Do not promote it into live routing or final answer composition until this eval
proves it improves quality without adding drift.
