# MEMORY

## What LCX Agent Is

- LCX Agent is a low-frequency finance research operating system for one real user.
- Mainline scope is full finance research below the high-frequency line: ETF, major-asset, watchlist, macro, timing, screening, conviction, risk review, and company research.
- Fundamentals are for filtering and conviction-building.
- Technicals are for timing and invalidation.
- Hard risk gates are mandatory.
- This is not an execution engine, not an HFT system, and not approval theater.

## Runtime Entry Surface

- Two entry surfaces exist and are equal. `gateway` is the long-lived daemon
  (WebSocket control plane, channels, canvas host, node pairing). `serve` is the
  daemon-free single-process HTTP entry (`POST /agent`, `GET /healthz`).
- `serve` carries no channels, canvas, or node state, so it starts anywhere a
  Node process or container runs.
- Scheduling works in both. `serve` serves the `cron` tool in-process against the
  same store file as the daemon (`CONFIG_DIR/cron/jobs.json`, relocatable via
  `OPENCLAW_STATE_DIR`). Do not run both schedulers against one store at once.
- Tools with no daemon-free equivalent (`sessions_list`, `nodes`, `canvas`,
  `browser`) return a Gateway connection error to the model under `serve`. That
  degrades the tool; it does not fail the run.
- Observations are entry-specific. State which entry produced one before treating
  it as general truth.
- Self-running is two separate capabilities, both required before claiming the
  agent runs itself: **self-start** (`serve --detach` for a terminal-free
  process; `serve install` for a `RunAtLoad` + `KeepAlive` LaunchAgent) and
  **self-scheduling** (in-process cron firing `isolated` `agentTurn` jobs).
- Verified with real providers and no human in the loop: a self-scheduled job
  fired repeatedly, each run calling a real model API, writing its artifact, and
  rescheduling itself. The council path runs Kimi (`moonshot/kimi-k2.6`) and
  DeepSeek in parallel; MiniMax is retired (absent from provider config) and is
  skipped, not failed.
- `launchctl bootstrap` can fail with `Input/output error` in a restricted tool
  session even when `launchctl kickstart` on an existing service succeeds. That
  is an environment boundary: the plist itself validates (`plutil -lint OK`) and
  installs from a normal terminal.
- The agent workspace defaults to `~/.openclaw/workspace`, and
  `tools.fs.workspaceOnly` blocks reads/writes outside it. Point the workspace
  at the repository when the agent is expected to work on repo files.

## Why This File Exists

- This is the fastest repo-level index for the active LCX Agent brain.
- Keep old work; use this file to separate active doctrine from drill-down/archive material.
- If a future agent has little context budget, this file should tell it what the system is, what to preserve, what to read first, and what is still unfinished.

## Active Read Order

1. `AGENTS.md`
2. `memory/current-research-line.md`
3. `MEMORY.md`
4. `memory/unified-risk-view.md` when present
5. latest `lobster-workface` carryover cue and correction notes
6. matching `memory/local-memory/*.md` durable cards, selected by subject match or `Use This Card When`
7. `memory/external-work-receipts/repair-queue.md` and `index.md` first, then only the specific recent `memory/external-work-receipts/*.md` you need when diagnosing operator phrasing, routing drift, or self-repair failures
8. recent weekly/workface/branch artifacts that directly support the question
9. `bank/fundamental/*` only when issuer/company research artifacts are actually needed
10. `ops/external-channel-history/*` only for migration history, probe history, or old ticket drill-down

## Decision Convergence Contract

- Do not jump from a broad ask to a fake precise answer.
- First define the current bracket: the few plausible interpretations, answer-shapes, or hypotheses still alive.
- Then rule out obvious bad fits before expanding detail.
- Then run one highest-information next check: the single check that would shrink the uncertainty range fastest.
- Stop when the actionable range is tight enough for a bounded answer, not when the prose sounds polished.
- If the operator says the previous answer was imprecise, missed the ask, or felt 词不达意, narrow first on requested action, scope, timeframe, and output shape before rewriting the substance.
- Only promote a new durable rule when that narrowing loop actually improved future behavior, not when it merely produced a nicer summary.

## What Must Be Preserved

- One main control room with internal specialist orchestration.
- The distillation chain must serve both LCX Agent's general agent meta-capability and the full finance research pipeline.
- The seven finance judgment foundations remain core:
  - portfolio sizing discipline
  - risk transmission
  - outcome review
  - behavior error correction
  - execution hygiene
  - business quality
  - catalyst map
- Knowledge validation, memory hygiene, and bounded shadow execution stay attached to the finance mainline.
- The learning, frontier, fundamental, and operating hook families stay as the main internal workflow spine.
- Correction notes, anomaly surfaces, and Codex escalation stay as explicit repair seams.
- Local durable memory cards stay as bounded supplemental long-term memory, not as a replacement for protected summaries.

## Active Workflow Families

- Learning and correction: distill lessons into keep, discard, replay, next eval, correction notes, weekly review, and reusable memory.
- Frontier and method: absorb papers, methods, replication risk, leakage, and overfitting lessons without drifting into toy repo tourism.
- Fundamental research: run the company and issuer pipeline from intake to manifest, readiness, snapshot, scoring, risk handoff, review, and deliverables.
- Operating and control: keep current research line, daily workface, weekly review, and control-room overlays aligned.
- Work receipts and self-repair signals: keep structured daily receipts of what the control room thought the task was, how it shaped the answer, and whether the turn needed repair.
- External-model feedback loop: each bounded learning-council run should distill not only topic lessons but also 1 to 3 concrete LCX Agent-level improvement cues for prompts, memory use, routing, workflow, or artifacts.

## How To Read Old Work

- `memory/*.md` dated notes are evidence and drill-down material, not automatic current doctrine.
- `ops/external-channel-history/*.md` are migration notes, runtime tickets, and historical acceptance narratives, not the first brain to read.
- `bank/fundamental/*` is the research factory. Trust the newest concrete artifacts, not the mere presence of folders.
- `memory/local-memory/*.md` is reusable medium-term memory. It can sharpen recall, but it must not overwrite protected summaries by itself.
- Local durable memory is only active when it matches the current ask. Do not load arbitrary recent cards just because they are newer.
- `memory/external-work-receipts/index.md` and `repair-queue.md` are the first stop for workflow debugging. Only drill into individual receipt files when the index or repair queue points to a specific turn.
- `memory/external-work-receipts/*.md` is bounded workflow evidence. Use it to debug wording drift, routing mistakes, or repeated repair failures without replaying whole chats.

## What The Previous Work Was Trying To Build

- A full low-frequency finance research operating system, not just a holdings helper.
- A user-facing control room over an internal multi-role system.
- A finance judgment skeleton that can be reused across watchlists, ETFs, macro, issuer research, and review work.
- A self-improving loop that turns mistakes, validations, and new methods into future decision-quality gains.
- A research factory that can eventually hold real fundamental artifacts, not just chat summaries.

## What Is Still Not Finished

- The current workspace still does not have `memory/unified-risk-view.md` — the operating-loop hook (command new/reset) renders it with the real control-room ledger woven in, but no session event has fired it in the live workspace yet.
- The per-asset book is a durable read-only plane now (`finance_position_ledger_read` capability + control-room projection with equity curve); the asset-level approval/veto runtime state is still deliberately empty.
- The learning timebox is now a durable in-harness workflow surface (`learning_distill` capability: pending review notes → keep/replay/next-eval cards under `state/lcx-learning-workflow-latest.json`); it is no longer process-bound.
- The fundamental hook family is richer than the current local research corpus.
- Local core verification is stronger than external-channel proof. `core-verified` is not `user-visible-observed`.
- External-channel binding stays deferred (`deferred_training_plan_not_ready`). Verified 2026-09-19 by replaying the hardened eval on the 2026-09-14 0/213 cases against the same adapter (`thought-flow-v1-qwen3-0.6b-minimax-guard-2026-05-26T22-37-02-759Z-r2`): they now pass 8/8 with 0 parse errors, so the 0/213 was a transient runtime failure, not model regression. The durable blocker is structural: `modelContractReady` is false for every case because the adapter's raw output lacks the contract fields (`supporting_modules`, `missing_data`, `rejected_context`, `next_step`) that the post-2026-05-26 eval adds via hardening, and promotion requires raw contract completeness (`modelContractFailureCaseIds.length === 0`). Unblocking therefore needs the adapter retrained to emit those fields raw, not an eval-side fix.
- Retrain attempt 1 (2026-09-19, `--iters 40 --lr 1e-5` from the 05-26 r2 seed → `thought-flow-v1-qwen3-0.6b-minimax-guard-2026-09-19T01-14-55-r1`) improved but did not unlock: hardened eval now 213/213 pass (raw contract pass 37/213), yet `modelContractReadyCaseIds` stays empty for all 213 because raw output still omits case-required module ids and uses non-canonical module variants (normalization+hardening must patch them). Promotion audit still reports `training_plan_eval_not_promotion_ready`. Evidence: `state/lcx-local-brain-eval-verify-2026-09-19T01-14-55.json`, `state/lcx-local-brain-eval-verify-replay-latest.json`.
- Retrain attempt 2 (2026-09-19, `--iters 120 --learning-rate 1e-5`, resuming from attempt-1 → `thought-flow-v1-qwen3-0.6b-minimax-guard-2026-09-18T18-16-27-r1`, val loss 0.687) also does not unlock: quick 4-case hardened check passes 4/4 with rawContractPass 2/4 but `modelContractReady` stays 0/4. **Root cause is data-target misalignment, not training intensity.** The eval's `missing_data`/`risk_boundaries` required ids are exact case-specific snake_case strings (e.g. `latest_10q_10k_or_earnings_release`, `current_rates_inflation_fed_path_and_liquidity_inputs`) while the training completions fill the same semantic slot with natural-language prose (e.g. `"public headlines"`, `"ETF issuer notes"`). The model cannot learn to emit the eval's required ids from data that never contains them, so more iters/epochs on the current slice will not flip `modelContractReady`. Do not keep retraining on this slice. The real unblock is rebuilding the train slice so completions use the eval's exact required-id format (data-engineering change), or re-scoping the promotion gate to accept normalization-mapped raw contracts as ready (eval-contract change; previously decided against eval-side fixes, revisit explicitly if chosen).
- Retrain attempt 3 (2026-09-18/19, user-confirmed base upgrade): **slice rebuilt with contract-vocab alignment** (`scripts/operator/local-brain-contract-vocab-align.ts`, 2980 examples, echo_bad=0, vocab 141/67) and base upgraded Qwen3-0.6B → **Qwen3-1.7B-4bit (Muon, rank8, iters120, lr1e-5, max-seq1536, mask-prompt, grad-checkpoint)** → adapter `thought-flow-v1-qwen3-1.7b-minimax-guard-09-18T19-40-18Z-r1` (peak 3.5GB, final val loss 3.384). Hardened eval (213/213 parse-pass) still shows `modelContractReadyCaseIds=[]`; rawContractPass dropped 78 (0.6B) → 12 (1.7B), i.e. the 1.7B raw output diverges from exact contract-token form even more and needs normalization+hardening for all cases. **Two training lessons (do not repeat):** ① BF16 3.4GB direct training on 8GB M3 METAL-OOMs after ~20 iters (peak 5.6GB) — must quantize base to 4bit first (peak 3.1GB); ② a leftover adapter dir with crashed weights makes resumed training val-loss NaN — `rm -rf` the adapter dir before retraining. **Conclusion: user chose remote-strong-model-first.** Local 1.7B stays an auxiliary fast-gate; primary agent brain is `custom-api-deepseek-com/deepseek-v4-pro` with fallbacks `deepseek-v4-pro`/`deepseek-v4-flash`/`moonshot/kimi-k3`/`moonshot/kimi-k2.6` — all four verified reachable 2026-09-19 (HTTP 200 with content; the earlier "moonshot key is broken (401)" note is obsolete). Promotion audit stays `hold` (correct). Finance proxy: `LCX_FINANCE_HTTP_PROXY` is now **empty (= explicit direct)** in `~/.openclaw/finance-caseflow/credentials.env`; the old `127.0.0.1:7897` proxy is dead (`ECONNREFUSED`) and **going direct is the chosen fix** — do not "start the proxy" to unblock data-source smoke.

## Cleanup Rule

- Merge new active doctrine into protected summaries, `MEMORY.md`, or bounded local durable memory cards.
- Do not create parallel "active brain" handoff files when an active index already exists.
- Keep old work unless it is clearly dead or duplicate, but demote it to drill-down when it is no longer active doctrine.
- If a note changes current truth, promote it explicitly. If not, leave it as archive or evidence.

## Current Upgrade Direction

- Keep the distillation chain serving both general agent meta-capability and the full finance research pipeline.
- Keep improving the internal body by reducing duplicate state and duplicate workflow narration before adding new layers.
- Make the decision-convergence loop explicit in learning, memory, and answer-shaping so LCX Agent gets more precise after each correction instead of just sounding more elaborate.
- Next durable gains should come from cleaner finance memory, cleaner finance artifacts, and later live proof, not from more abstract architecture.

## Macro Inventory (2026-09-19)

Snapshot of the `scripts/operator/` factory floor (99 scripts) and the runtime state
faces (`~/.openclaw/workspace/state/`). Purpose: separate healthy, wired components
from residue before any deletion. Deletion of any listed item still needs explicit
authorization.

### Healthy core (tests + governance-loop wiring)

- Control/governance: `lcx-central-agent`, `lcx-governance-autopilot`, `lcx-owner-brief`,
  `lcx-owner-control-map`, `lcx-monotonic-data-ledger`, `lcx-local-failure-trace`,
  `lcx-context-recovery-exam`, `lcx-problem-cluster-radar`, `lcx-live-fadeout-audit`,
  `lcx-universe-index`, `lcx-change-impact-plan`, `lcx-system-doctor`, `lcx-agent-exam`,
  `lcx-local-paths` (shared path constants).
- Semantic/evidence gates: `lcx-ontology`, `lcx-mind-model`, `lcx-flow-graph`,
  `lcx-head-tail-consistency`, `lcx-commercial-answer-pipeline`,
  `lcx-projection-reader-audit`.
- Training/learning pipeline: `local-brain-{contracts,taxonomy,plan,distill-dataset,
distill-train-slice,distill-eval,distill-smoke,generalization-generator,
generalization-harness,open-eval,open-eval-provider,promotion-audit,training-plan}`,
  `module-learning-pipeline-{plan,review}`, `minimax-brain-{teacher-batch,training-guard,
failure-curriculum}`, `minimax-quota-brain-saturator`.
- External channel: `lcx-external-channel-{binding,compat,status}`,
  `external-channel-sidecar-runtime-{bundle,freshness}`.
- Finance: `lcx-finance-{research,research-run,live-execution,position-ledger}`,
  `lcx-directed-daily-research-brief`, `lcx-research-data-tool`,
  `lcx-commercial-acceptance-harness`, `lcx-visible-answer-quality-fuzzer`,
  `lcx-external-short-intent-fuzzer`, `lcx-external-agent-upgrade-radar`, `lcx-skillopt-lite`.
- 31 package.json-wired smoke/live-smoke entries cover the live-probe surface.

### Orphan script candidates (no package.json/test/docs/src wiring; only change-impact inventory)

- `minimax-provider-quota-saturator.ts` — MiniMax VLM provider is retired; superseded by
  `minimax-quota-brain-saturator`. Dead weight.
- `geospatial-source-live-smoke.ts` — one-shot probe, no wiring.
- `test-device-pair-telegram.ts` — one-shot device-pair probe, no wiring.

### Docs-only, not wired (keep or wire, do not silently delete)

- `finance-learning-{event-review,multi-candidate,pipeline}-smoke` (referenced by the
  finance-learning runbook), `discord-acp-plain-language-smoke` (testing.md),
  `lcx-finance-capability-collect` + `lcx-finance-source-limit-probe` (feed the
  registered-data-capabilities / source-quota docs).

### State-face residue (no consumers anywhere in src/scripts/test/docs; cleanup candidate)

- kimi-k2.6 era (2026-05-22): `kimi-k2.6-{high-intensity-output,local-usage-policy,
real-output-smoke-latest,real-output-smoke-strict}-latest.json`,
  `deepseek-high-intensity-quality-smoke-latest.json`.
- sidecar era (2026-05-23): `lcx-safe-sidecar-{workpack,extra-workpack}-latest.{json,md}`.
- blind-eval series (2026-08-30): `lcx-blind-{six-case*-round*,six-case*-prefill-round*,
short-lark-r2-prefill,generated-holdout*}-*.json` (12 files),
  `lcx-parse-stability-six-case-receipt-latest.json`.
- 2026-09 probes: `lcx-short-lark-blind-no-prefill-20260901.json`,
  `lcx-blind-commodity-challenger-receipt-latest.json`,
  `lcx-required-module-eval-receipt-latest.json`,
  `lcx-contract-repair-{eval,training}-20260911-r1.json` (+ checkpoint),
  `lcx-native-contract-repair-queue-latest.json`, `lcx-live-lark-brain-binding-latest.json`.
- older misc: `lcx-evolution-next-idle-actions.json`, `lcx-evolution-promotion-manual-check-latest.json`,
  `commercial-answer-real-provider-sample-latest.json`, `openclaw-beta-intake-2026-09-01.json`,
  `codex-{current-runtime-audit,lcx-engine-consolidation,openclaw-latest-beta-cutover}-20260901.md`.

### Healthy active state faces (verified consumers)

`lcx-central-agent-latest`, `lcx-control-room-latest`, `lcx-governance-autopilot-latest`,
`lcx-owner-brief-latest`, `lcx-owner-control-map-latest`, `lcx-monotonic-data-ledger-latest`,
`lcx-local-failure-trace-latest`, `lcx-evolution-promotion-digest-latest`,
`lcx-external-channel-binding-latest`, `lcx-universe-index-latest`, `lcx-local-operator-latest`,
`lcx-learning-workflow-latest`, `lcx-self-repair-hands-latest`, `lcx-context-recovery-handoff-latest.md`,
`model-fleet-runtime.json`, `local-specialist-runs/`.

### Verified gate status (2026-09-19)

- ontology: 59 vocabulary / 15 relation contracts / 3 orchestration patterns / 58 contract
  task-families canonical, 0 errors; 24 integration surfaces ok.
- flow-graph 9/9, mind-model 40/40 checks green; promotion audit: `promotionApplied=false`
  (external channel stays `deferred_training_plan_not_ready`, see the retrain note above).
