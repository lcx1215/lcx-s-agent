# MEMORY

## What LCX Agent Is

- LCX Agent is a low-frequency finance research operating system for one real user.
- Mainline scope is full finance research below the high-frequency line: ETF, major-asset, watchlist, macro, timing, screening, conviction, risk review, and company research.
- Fundamentals are for filtering and conviction-building.
- Technicals are for timing and invalidation.
- Hard risk gates are mandatory.
- This is not an execution engine, not an HFT system, and not approval theater.

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
7. `memory/feishu-work-receipts/repair-queue.md` and `index.md` first, then only the specific recent `memory/feishu-work-receipts/*.md` you need when diagnosing operator phrasing, routing drift, or self-repair failures
8. recent weekly/workface/branch artifacts that directly support the question
9. `bank/fundamental/*` only when issuer/company research artifacts are actually needed
10. `ops/live-handoff/*` only for migration history, probe history, or old ticket drill-down

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
- `ops/live-handoff/*.md` are migration notes, runtime tickets, and historical acceptance narratives, not the first brain to read.
- `bank/fundamental/*` is the research factory. Trust the newest concrete artifacts, not the mere presence of folders.
- `memory/local-memory/*.md` is reusable medium-term memory. It can sharpen recall, but it must not overwrite protected summaries by itself.
- Local durable memory is only active when it matches the current ask. Do not load arbitrary recent cards just because they are newer.
- `memory/feishu-work-receipts/index.md` and `repair-queue.md` are the first stop for workflow debugging. Only drill into individual receipt files when the index or repair queue points to a specific turn.
- `memory/feishu-work-receipts/*.md` is bounded workflow evidence. Use it to debug wording drift, routing mistakes, or repeated repair failures without replaying whole chats.

## What The Previous Work Was Trying To Build

- A full low-frequency finance research operating system, not just a holdings helper.
- A user-facing control room over an internal multi-role system.
- A finance judgment skeleton that can be reused across watchlists, ETFs, macro, issuer research, and review work.
- A self-improving loop that turns mistakes, validations, and new methods into future decision-quality gains.
- A research factory that can eventually hold real fundamental artifacts, not just chat summaries.

## What Is Still Not Finished

- The current workspace still does not have `memory/unified-risk-view.md`.
- There is still no durable per-asset or per-position state plane.
- The learning timebox is still process-bound, not a global durable workflow engine.
- The fundamental hook family is richer than the current local research corpus.
- The development repo is stronger than the live runtime proof. `dev-fixed` is not `live-fixed`.

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
