# LCX Agent Capability Review — 2026-07-02

This is a point-in-time, evidence-based review of what LCX Agent **actually
does today**, separate from the intent described in `README.md` and `CLAUDE.md`.
It is a review artifact, not doctrine: it does not define new rules, owners, or
boundaries, and it must not be treated as a proof surface for mind-model,
flow-graph, or head-tail consistency checks. Re-verify with the owner commands
before acting on anything time-sensitive here.

Method: read-only inspection of `extensions/feishu/src/`, `scripts/dev/lcx-*.ts`,
`src/auto-reply/reply/`, `ops/local-brain/`, and the `~/.openclaw/workspace/state`
snapshots. Three independent read passes; conclusions cross-checked.

## One-line verdict

LCX Agent is a **well-disciplined framework** for a personal finance-research
agent. The governance layer, boundary layer, and Feishu/Lark transport are real
and working. The **core finance-answer generation is not yet implemented**, the
**finance data gateway is fixture-only (no live data sources)**, and the
**local brain can train but is human-driven and has not produced a stable
improvement**. The blueprint and guardrails are real; the house is still being
built.

## Layer-by-layer, as measured

### 1. Feishu / Lark control room — most mature, real send/receive ✅

- Real SDK calls via `@larksuiteoapi/node-sdk` in `extensions/feishu/src/send.ts`
  (`client.im.message.reply/create/get`), not mocks. Inbound handling in
  `bot.ts` (`handleFeishuMessage`): webhook parse, dedup, merge_forward assembly.
  Outbound supports text / card / media / thread with a reply→create fallback.
- Scale: 121 TS files, ~97k impl lines + ~31k test lines (~48% test ratio).
- 50+ intent matchers route to specialist workflows through the gateway.
- State: `dev-ready` met; `external-channel-bound` framework in place; **no
  fresh "real user sends a Lark message → gets a reply" evidence**, so
  `user-visible-observed` is unproven. `reply-flow-audit.ts` logs send attempts,
  not a confirmed production inbound/outbound trace.

### 2. Finance answer capability — the biggest gap ⚠️

- `scripts/dev/lcx-commercial-answer-pipeline.ts` only **audits** a candidate
  answer (intent classification, forbidden-phrase gate, failed-reason return).
  It does **not synthesize** an answer — there is no answer-composition logic,
  only an audit rule list.
- `finance-data-gateway`: all data comes from **local fixtures** (hard-coded
  values, e.g. a dated QQQ price in `finance-data-gateway-smoke.ts`). **No real
  market/fundamentals/macro API is wired** (no Alpaca/IB/Yahoo/vendor calls).
  It is a data-validation framework, not a data-integration layer.
- Model calls (Kimi/MiniMax/DeepSeek) are real in `learning-council.ts`, but
  default to dry-run, are used for **learning internalization**, and are **not
  on the user-question answer path**.
- `lcx-commercial-acceptance-harness.ts` checks **structural completeness**
  (filter counts present, provider roles present, owner outputs exist), **not
  answer quality**, and leans on handoff receipts rather than real Lark dialog.
- Net user experience for "how's NVDA risk?": classify → data missing → return
  a failed reason. The user does not get a useful research packet.

### 3. Local brain (Qwen / MLX training) — real pipeline, no proven gain 🟡

- Training is real: `mlx_lm lora --model Qwen/Qwen3-0.6B --train` driven by
  `minimax-brain-training-guard.ts`; a ~7.5MB training-guard JSONL log exists;
  real MiniMax teacher loop, SHA-dedup, failure-family stratified sampling, and
  MLX-inference eval (`local-brain-distill-eval.ts`).
- Constraints are honest and in-code: base model is the weak **Qwen3-0.6B**
  (8GB RAM limit), `CATASTROPHIC_CANDIDATE_MAX_PASS_RATE`, `MIN_PROMOTION_EVAL_CASES`.
- But: the daily cycle is **fail-closed by default** (`lobster_orchestrator.py`
  blocks unless `OPENCLAW_SCHEDULER_ENABLE_CYCLE=1` or `--dry-run`); the
  scheduled command is `agent-system-loop-smoke.ts`, a smoke test, not training.
- Honest read: "the local brain trains itself daily and evolves" needs cooling
  down to "training can be run manually but has not crossed the bar of stably
  beating the base model." Promotion = a dev-ready ticket, not a capability gain.

### 4. Governance stack (40 owner tools) — real guard, but mostly static ✅

- `lcx-mind-model.ts` / `lcx-flow-graph.ts` are **real consistency guards**:
  change a doctrine line in README/AGENTS.md without updating the matching
  `.ts`, or add an owner without a test, and the check fails.
- `lcx-system-doctor.ts` **does probe runtime state** (active MLX process,
  selected adapter, module-learning blockers).
- Limit: most checks are **file-existence + term-matching**, not runtime-truth.
  They will not catch "the teacher process died" or "the eval set is empty."
- Freshness note: `lcx-governance-autopilot-latest.json` was last refreshed
  **2026-06-29** (3 days stale at review time) — the automation heartbeat is not
  currently active.

## Two things worth your attention

1. **Weight imbalance.** A large share of effort sits in the governance /
   evidence / boundary system, while the one thing that delivers user value — a
   useful finance-research answer — is the thinnest link. ~20k words of doctrine,
   but the answer pipeline does not compose answers and the data gateway has no
   data source. The guardrails currently outweigh the car.

2. **Closest step to "actually usable."** The Lark channel already sends and
   receives for real, and the training pipeline runs. The two concrete gaps
   blocking product usefulness are: **(a) a real finance data source** and
   **(b) answer-synthesis logic**. Close those two and it becomes a product you
   can actually query in Lark and get a useful answer from.

---

## Landing plan: data source + answer synthesis

Scoped to the two gaps above. Follows the repo's own boundaries (research-only,
no execution authority, source/timestamp provenance, dev vs user-visible split).

> Status 2026-07-02: **Track A and Track B are landed** (dev-ready, tested).
> See "Landed work" at the end of this doc. The plan below is kept for context.

### Track A — real finance data source (behind the existing gateway)

Goal: replace fixture data with at least one real provider, without breaking the
gateway's validation contract or provenance discipline.

1. Pick one low-friction provider first (e.g. a free/keyed quote+fundamentals
   API). Keep it behind the existing `finance-data-gateway` interface so the
   validation/provenance layer is unchanged.
2. Implement a real fetch adapter that fills the existing snapshot shape:
   source timestamp, field definition, unit/currency, adjusted status, provider
   role, issuer/official reference scope. Route conflicts to
   `data_provenance_quality` exactly as the fixture path does today.
3. Keep the fixture path as an offline test double; add a `--live` flag so the
   gateway can run either way. Gate live fetch behind an env key, fail-closed
   when absent (matches the repo's no-silent-degrade rule).
4. Proof: a real snapshot with a live timestamp for one symbol, plus a
   regression test that the validation contract still holds on live-shaped data.

### Track B — answer-synthesis logic (make the pipeline compose, not just audit)

Goal: turn `lcx-commercial-answer-pipeline.ts` from audit-only into
compose→audit, so a real question yields a research-grade packet.

1. Add a compose step ahead of the existing audit: take (intent, gateway
   snapshot, portfolio/memory context) → produce the README's research-decision
   packet shape (evidence status, source+timestamp, missing data, thesis /
   counter-thesis, catalyst / invalidation, technical/flow context, portfolio
   impact, next safe work).
2. Put the model call (MiniMax as primary draft + red-team, per doctrine) **on
   the answer path**, then run the existing audit gate on its output. Terminal
   decision stays `adopt_visible_answer` or `return_failed_reason`.
3. When data is missing, compose the "useful missing-data answer" the
   visible-answer-quality-fuzzer already expects, instead of a bare failure.
4. Proof: `lcx-visible-answer-quality-fuzzer.ts` must show good concise answers
   are **adopted** (not only bad ones rejected), on at least one adjacent
   non-identical scenario beyond the seed example.

### Sequencing

Track A first (an answer needs real inputs), then Track B. Each track lands with
its own targeted test/eval, keeps the dev / external-channel / user-visible split
strict, and does not claim `user-visible-observed` until a real Lark
inbound+outbound is observed. Refresh the governance autopilot snapshot after
landing so the heartbeat stops being stale.

---

## Landed work (2026-07-02)

Both tracks are implemented as testable, dev-scoped modules that reuse existing
contracts. Nothing here sends Lark messages, mutates provider config, writes
protected memory, or claims `user-visible-observed`.

### Track A — real market data behind the gateway

- `src/agents/finance-live-market-source.ts` — a real fetch adapter for the
  Yahoo Finance public chart endpoint (key-less, delayed quotes). It fetches a
  quote, maps it to the gateway's observation contract with full provenance
  (source timestamp, field definition, currency, delay status, source URL), and
  feeds it into the existing pure validator `buildFinanceDataGatewaySnapshot`.
  The fetch impl is injectable (offline-testable) and every network/data failure
  throws `LiveMarketFetchError` so callers fail closed — no fake/empty snapshot.
- `scripts/dev/finance-data-gateway-live-smoke.ts` — opt-in live smoke. `--live`
  fetches for real; without it, dry mode prints guidance and exits 0.
- `src/agents/finance-live-market-source.test.ts` — 11 tests (parse, map,
  compose-to-gateway, all fail-closed paths).
- Verified live: `--live --symbol QQQ` returned a real price with a real source
  timestamp and, honestly, `qualityStatus=blocked` +
  `missingEvidence=cross_check_market_data_provider` — a single public source
  only fills the primary role, and the gateway says so instead of pretending.

### Track B — compose then audit (reuses the existing model interface + audit)

- `src/agents/finance-answer-composer.ts` — `composeFinanceAnswer` renders the
  live gateway snapshot into an honest grounding block (numbers only with their
  source and timestamp; blocked/needs-review stated plainly), then calls the
  SAME real model interface the agent already uses (Kimi / DeepSeek / MiniMax
  via the gateway `agent` method), injected as `FinanceModelCaller` so it is
  offline-testable. It returns a candidate answer; it is NOT the final
  authority. Empty ask or empty model output fails closed.
- The candidate is handed to the existing terminal audit
  `buildPipelineResult` (unchanged) — that gate stays the authority.
- `src/agents/finance-answer-composer.test.ts` (6 tests) +
  `src/agents/finance-answer-compose-audit.integration.test.ts` (2 tests):
  a grounded research-grade answer is **adopted**, a trade-instruction answer is
  **rejected**, on an adjacent scenario (semiconductor sector, not the QQQ seed).

### Verification

- 19 new tests pass; full `tsgo` typecheck clean; existing gateway tests
  (`finance-data-gateway-tool`, `finance-external-source-adapter`) still green.

### Not done yet (honest remaining gaps)

- Real **cross-check** + **official/issuer** providers (so a snapshot can reach
  `ready`, not just `blocked` on one source).
- Wiring compose→audit into the **runtime reply path**
  (`src/auto-reply/reply/get-reply-run.ts`) so a real Lark question uses it;
  today it is a tested dev module, not yet on the live user path.
- `user-visible-observed` still requires a real Lark inbound + outbound.
