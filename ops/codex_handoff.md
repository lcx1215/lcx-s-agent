# Codex Handoff

## Purpose

This file is the shortest useful truth-source for the current **development repo**.

It exists to stop drift between:

- chat claims
- live handoff narrative
- development-repo reality

Use this file together with:

- `AGENTS.md`
- `MEMORY.md`
- `memory/current-research-line.md`
- `memory/current_state.md`
- `ops/live-handoff/2026-03-27-workspace-division.md`
- `ops/live-handoff/2026-03-27-workspace-role-runbook.md`

## Observed In This Dev Repo

- This repo is `lcx-s-openclaw`, the **development repo**.
- The Feishu interface code being edited here lives under:
  - `extensions/feishu/src/*`
- The shared-brain / artifact-contract skeleton being built here lives mainly under:
  - `src/hooks/bundled/*`
  - `src/agents/*`
  - `src/infra/*`
- The following dev-brain structures now exist in-repo:
  - learning / correction hooks
  - frontier / method hooks
  - fundamental artifact-chain hooks
  - operating / control hooks
  - anomaly / artifact-error guardrails
  - Feishu learning-council seam
  - MiniMax default-model registry seam
- There is now a registry-backed dev artifact contract at:
  - `src/hooks/bundled/lobster-brain-registry.ts`
- There is now a shared MiniMax default-model seam at:
  - `src/agents/minimax-model-catalog.ts`
- There are now explicit external-context / external-editor tools in the dev repo:
  - `src/agents/tools/mcp-context-tool.ts`
  - `src/agents/tools/aider-tool.ts`
- There is now also a bounded Lobster desktop workface-app tool in the dev repo:
  - `src/agents/tools/lobster-workface-app-tool.ts`
  - exposed as:
    - `lobster_workface_app`
  - current boundary:
    - builds a local HTML dashboard from the latest `lobster-workface` artifact
    - if no `lobster-workface` artifact exists yet, it now builds an honest empty-state dashboard instead of leaving the desktop blank
    - can optionally present it through the existing Canvas shell
    - not a general app builder
- There is now also a bounded local durable-memory card tool in the dev repo:
  - `src/agents/tools/local-memory-record-tool.ts`
  - exposed as:
    - `local_memory_record`
  - current boundary:
    - writes only under `memory/local-memory/*.md`
    - reuses the same `subject + memoryType` path for bounded updates
    - preserves prior snapshots + revision trail instead of silently erasing old memory
    - cards can now also store:
      - `Use This Card When`
      - `First Narrowing Step`
      - `Stop Rule`
        so medium-term memory can steer future behavior instead of sitting as prose only
    - stays inside the existing `memory/*.md` recall surface
    - does not replace protected summaries or prove live persistence
- There is now also a bounded structured work-receipt seam in the dev repo:
  - Feishu final replies now write `memory/feishu-work-receipts/*.md`
  - each receipt records:
    - requested action
    - scope
    - timeframe
    - output shape
    - repair disposition
    - read-path hint
    - final reply summary
  - `src/hooks/bundled/operating-daily-workface/handler.ts` now reads those receipts into:
    - `Yesterday Work Receipts`
    - `Self-Repair Signals`
  - the receipt seam now also writes:
    - `memory/feishu-work-receipts/index.md`
    - `memory/feishu-work-receipts/repair-queue.md`
  - current reading contract:
    - repair-queue first
    - index second
    - specific receipt files only when the queue points to a concrete turn
  - current boundary:
    - this is bounded workflow evidence for debugging and repair
    - not raw hidden-thought logging
    - not a new memory architecture
- There is now also a bounded external-model feedback seam in the dev repo:
  - each `learning-council` run now distills:
    - `keep`
    - `discard`
    - `replay`
    - `next eval`
    - `Lobster improvement feedback`
  - intended use:
    - the three model lanes should not only answer the current learning command
    - they should also leave 1 to 3 concrete Lobster-level improvement cues for prompts, memory use, routing, workflow, or artifacts
  - current downstream consumers:
    - `operating-daily-workface` now exposes the first surviving cue as `improve lobster: ...`
    - Feishu daily `Improvement pulse` now surfaces that cue
  - current boundary:
    - bounded self-improvement feedback only
    - not autonomous code editing
    - not a new self-modification architecture
- The adoption-ledger lifecycle summary seam should now be treated as already-built dev truth, not as the next open build target:
  - `src/hooks/bundled/operating-daily-workface/handler.ts` already renders explicit adoption-ledger counts for:
    - adopted now
    - candidate for reuse
    - reused later
    - downranked or failed
  - current boundary:
    - dev-only lifecycle summary over explicit ledger state
    - not live proof
    - do not rebuild this seam unless a truth-preservation hole appears
  - current next priority:
    - keep finance doctrine work on the existing single-consumer mainline
    - current runtime-integrity focus:
      - Feishu control-room reachability through `createOpenClawCodingTools`
      - same-day retained-state inspection plus single and bulk finance review actions through that runtime tool path
      - fail-closed missing-artifact behavior and Feishu group-policy denial boundaries
    - current boundary:
      - runtime-equivalent validation in the dev repo only
      - not proof that the separate live Feishu repo/runtime is already migrated or enabled
- There is now also a bounded macOS Lobster panel seam in the dev repo:
  - `apps/macos/Sources/OpenClaw/LobsterWorkfacePanel.swift`
  - `apps/macos/Sources/OpenClaw/MenuContentView.swift`
  - current boundary:
    - adds `Open Lobster Panel` to the OpenClaw menu bar app
    - rebuilds a bounded in-app panel into the existing Canvas session on open
    - supports a bounded in-app `Refresh Panel` deep link for the same session
    - bootstraps from `memory/current-research-line.md` when no workface artifact is available
    - falls back to an honest empty/failure state only when neither workface nor current research line can drive the panel
    - still uses the existing Canvas shell rather than creating a standalone native `.app`
- There is now also a read-only self-update worthiness preflight in the dev repo:
  - `update.check`
  - wired through:
    - `src/gateway/server-methods/update.ts`
    - `src/agents/tools/gateway-tool.ts`
- There is now an explicit project-scoped MCP config in the repo root:
  - `.mcp.json`
  - currently aimed at the OpenAI developer docs MCP server
- External long-term memory is now also recognized as a bounded optional seam:
  - `memd`
  - `MemLayer`
  - surfaced through:
    - `src/agents/tools/mcp-context-tool.ts`
  - bounded by:
    - `ops/long-term-memory-bounded-integration.md`
- There are many local uncommitted changes in the working tree.
- Local `git log --since='7 days ago'` does **not** currently show recent commits in this repo.
- The control-room aggregate seam now also includes the bounded learning-loop state in the same operator-facing summary path used for daily workface / health-style asks.
- Feishu learning-council now also has a bounded durable-learning pack seam:
  - keep
  - discard
  - current bracket
  - ruled out
  - highest-information next checks
  - rehearsal trigger
  - next eval cue
    for high-value self-improvement topics
  - and those distilled fields now also survive into weekly rehearsal memory instead of staying reply-only
- Feishu learning-council finance study is now also anchored to current protected state instead of running as abstract topic learning:
  - lane prompts now see:
    - protected-anchor presence / missing status
    - compact `memory/current-research-line.md` fields when present
    - latest `lobster-workface` retain / discard / replay / next eval cue when present
  - if those anchors are missing, prompts now say so explicitly instead of pretending the study already matches current Lobster finance doctrine
  - matching local durable memory cards are now selected by current objective/current focus/top decision/use-when rule instead of only by recency
- The control room can now also report the latest persisted learning-session result for a chat lane when no active timebox is running, instead of flattening that state into an empty status.
- Overdue process-bound learning sessions no longer keep masquerading as active:
  - active in-memory checks are now deadline-aware
  - latest-session reads normalize overdue `running` states into `overdue`
- Feishu DS/statistics method-learning asks for ETF timing are now explicitly treated as bounded learning work instead of being silently dragged into plain technical-daily analysis when the user is clearly asking to learn methods.
- This now also covers question-style real asks such as:
  - `直接告诉我`
  - `怎么判断`
  - `怎么检验`
  - `怎么验证`
  - `怎么避免`
    when they are paired with DS/statistics method cues, so a real retail-style method question is not silently rewritten into ordinary ETF commentary.
- Control-room holdings-thesis revalidation is now also a dedicated orchestration contract instead of a generic dual-track prompt:
  - control-room now explicitly fans this path out to:
    - `knowledge_maintenance`
    - `technical_daily`
    - `fundamental_research`
  - the control-room contract now makes prior-thesis retrieval, current-anchor retrieval, and finance-foundation evidence order explicit
  - if the old thesis or durable anchor cannot be found, the prompt now requires saying that explicitly instead of pretending a real revalidation occurred
- the shared agent system prompt now also carries the same holdings-thesis revalidation contract outside Feishu:
  - base memory recall now tells the agent to retrieve prior holding analysis + current research line + correction notes + relevant foundation templates before giving a fresh stance
  - base portfolio-answer guidance now explicitly says not to answer old-thesis survival questions from scratch
- the protected summary now also carries that same rule:
  - `current-research-line.md` records holdings revalidation rule + foundation order
  - it now also records:
    - local-memory activation rule
    - decision-convergence rule
    - language-precision repair rule
  - its recall order now explicitly includes latest carryover set, correction notes, and matching local durable memory cards before older drill-down

## Observed Memory / State Reality

- `MEMORY.md` now exists and is the repo-level active Lobster brain index.
- `memory/current-research-line.md` exists and is currently the main compact state anchor.
- `memory/unified-risk-view.md` does **not** currently exist.
- Before this handoff, these files were missing:
  - `memory/current_state.md`
  - `ops/codex_handoff.md`
- This means recent system-state narration has been too distributed across:
  - chat
  - `ops/live-handoff/*.md`
  - local uncommitted changes
- The current cleanup direction is:
  - keep previous finance-domain work
  - keep the distillation chain serving both general meta-capability and the full finance research pipeline
  - use `MEMORY.md` plus `memory/current-research-line.md` as the fast active read path before `ops/live-handoff/*`
  - prefer matching local durable memory cards over arbitrary recent cards
  - use `memory/feishu-work-receipts/*.md` when debugging wording/routing/self-repair drift instead of replaying whole chats
  - prefer decision-convergence over fake-precise first answers

## Development Repo vs Feishu / Live Runtime Repo

- Development work should start in:
  - `lcx-s-openclaw`
- The repo currently described in workspace docs as the live Feishu runtime repo is:
  - `Projects/openclaw`
- The development repo contains the editable Feishu source:
  - `extensions/feishu/src/*`
- But Feishu behavior is only changed in practice after an equivalent bounded patch is:
  1. ported into `Projects/openclaw`
  2. built there
  3. restarted there
  4. verified through probe + real Feishu acceptance

## Hard Boundary

- `dev-fixed` is not `live-fixed`
- handoff text is not runtime proof
- local tests/build are not Feishu live acceptance
- this repo must not claim unattended runtime behavior without repo-grounded evidence

## Other-Live-Context Narrative

`ops/live-handoff/*.md` is useful, but it must be read as:

- handoff narrative
- migration memory
- claimed live status from another runtime context

It is **not** automatic proof that this development repo itself contains:

- the matching runtime artifacts
- the matching receipts/logs
- the matching live acceptance evidence

## Current True Posture

Treat this repo as:

- an L4-oriented **development skeleton**
- a shared-brain / multi-hook / Feishu-hardening development base
- not a fully repo-proven unattended live agent
- not a self-proving L5 system

## Recent Repo-Grounded Verified Work

The following are repo-grounded and recently re-verified here:

- Feishu learning-council default-model alignment
  - `extensions/feishu/src/learning-council.ts`
  - `extensions/feishu/src/learning-council.test.ts`
  - verified by:
    - `extensions/feishu/src/learning-council.test.ts`
    - `extensions/feishu/src/bot.test.ts`
    - `extensions/feishu/src/feishu-command-handler.test.ts`
    - `pnpm build`
- Feishu learning-council now also hardens high-value self-improvement learning into a compact distillation pack
  - `extensions/feishu/src/learning-council.ts`
  - `extensions/feishu/src/learning-council.test.ts`
  - verified by:
    - `extensions/feishu/src/learning-council.test.ts`
    - `pnpm build`
  - current truth boundary:
    - Kimi now asks for distilled keepers + replay triggers
    - DeepSeek now asks for distillation-ready rules + replay triggers
    - MiniMax now asks for what to discard + replay failure checks
    - the final council output now renders one `Distilled operating pack`
    - the bounded learning-council memory note now persists and parses those distilled fields
    - `src/hooks/bundled/learning-review-weekly/handler.ts` now prefers those parsed keep/discard/rehearsal/eval cues when promoting council notes into weekly learning memory
    - this is prompt/artifact hardening, not model training, and not proof of live runtime behavior
- Feishu `learning_command` now also has a bounded process-local repeated-learning timebox seam
  - `extensions/feishu/src/learning-timebox.ts`
  - integrated via:
    - `extensions/feishu/src/bot.ts`
  - verified by:
    - `extensions/feishu/src/learning-timebox.test.ts`
    - `extensions/feishu/src/bot.test.ts`
    - `pnpm build`
  - current truth boundary:
    - one immediate audited learning pass still happens first
    - but same-chat duplicate timebox requests are now intercepted before they can trigger a second immediate learning pass
    - and while a same-chat timebox is already running, new plain learning-command requests are also blocked instead of inserting overlapping immediate-learning passes
    - and if a persisted `running` learning session still exists during the recovery window, the bot now blocks a fresh immediate learning pass instead of running one extra council turn before state catches up
    - the control room can now answer read-only learning-session status questions from local session state instead of forcing the operator to guess whether a background learning session is still running
    - background repeated learning is process-bound only
    - session state/receipts are workspace artifacts, not proof of restart persistence
    - same-chat duplicate timeboxes are rejected instead of running in parallel
- Feishu startup now also reconciles stale process-bound learning timeboxes
  - `extensions/feishu/src/monitor.ts`
  - verified by:
    - `extensions/feishu/src/learning-timebox.test.ts`
    - `extensions/feishu/src/monitor.startup.test.ts`
    - `pnpm build`
  - current truth boundary:
    - startup now scans all configured agent workspaces, not only the default agent workspace
    - if a leftover `running` session is still before `deadlineAt`, startup now restores it into the in-process scheduler
    - writes a `session_resumed` receipt
    - sends one resume notice back to the chat when Feishu send works
    - if the leftover session is already expired, startup still marks it `interrupted`
    - writes a `session_interrupted` receipt
    - sends one interruption notice back to the chat when Feishu send works
    - this is bounded restart recovery, not a durable workflow engine
- operating / hygiene / correction / validation control-family tests are currently green
  - after fixing time-freeze misuse in:
    - `src/hooks/bundled/operating-weekly-review/handler.test.ts`
    - `src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`
- self-update gateway tooling now also has a bounded read-only update preflight
  - `update.check`
  - verified by:
    - `src/agents/openclaw-gateway-tool.test.ts`
    - `src/gateway/server-methods/update.test.ts`
    - `src/gateway/method-scopes.test.ts`
    - `src/agents/system-prompt.test.ts`
  - current truth boundary:
    - check worthiness before `update.run`
    - no restart
    - no config mutation
    - no claim that auto-update is live-enabled
- external long-term memory MCP context now also has bounded integration guidance
  - recognizes:
    - `memd`
    - `MemLayer`
  - verified by:
    - `src/agents/tools/mcp-context-tool.test.ts`
    - `src/agents/system-prompt.test.ts`
  - current truth boundary:
    - supplemental durable recall / checkpoint / reflect only
    - not a replacement for protected summaries
    - hosted `memd` is warned as non-default posture
    - `memd` hosted warning is now explicit-signal only:
      - `MEMD_API_KEY`
      - `MEMD_API_URL` targeting `memd.dev`
      - MCP transport URL targeting `memd.dev`
    - an unspecified `MEMD_API_URL` is no longer treated as proof of hosted backend
- local memory recall now has a bounded fail-soft path when semantic memory search is unavailable
  - verified by:
    - `src/agents/tools/memory-tool.test.ts`
    - `src/agents/tools/memory-tool.citations.test.ts`
    - `src/agents/system-prompt.test.ts`
  - current behavior:
    - protected summaries remain the first current-state anchors:
      - `memory/current-research-line.md`
      - `memory/unified-risk-view.md`
      - `MEMORY.md`
    - `memory_search` is the replaceable broad recall surface over those memory files, not canonical current-state truth
    - if embeddings/provider recall is down, the agent is now instructed to fall back to direct reads of:
      - `memory/current-research-line.md`
      - `memory/unified-risk-view.md`
      - `MEMORY.md`
    - this is a bounded local rescue path, not external-memory promotion and not full semantic recall
- operating / control artifact contracts are now registry-backed in the dev repo
  - `src/hooks/bundled/lobster-brain-registry.ts`
  - `src/hooks/bundled/operating-weekly-review/handler.ts`
  - `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - verified by targeted operating/control Vitest + Oxlint runs
- `knowledge-validation-weekly` is now also registry-backed across producer + consumer + tests
  - `src/hooks/bundled/knowledge-validation-weekly/handler.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - verified by targeted Vitest + Oxlint + registry matcher checks
- `correction-note` is now registry-backed across producer + repeat detection + consumers + tests
  - `src/hooks/bundled/correction-loop/handler.ts`
  - `src/hooks/bundled/operating-weekly-review/handler.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
  - verified by targeted Vitest + Oxlint + registry parser checks
- watchtower anomaly / repair-ticket paths are now registry-backed across infra + control-family consumers + tests
  - `src/infra/operational-anomalies.ts`
  - `src/hooks/bundled/correction-loop/handler.ts`
  - `src/hooks/bundled/operating-weekly-review/handler.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
  - verified by targeted Vitest + Oxlint + registry path-helper checks
- repair-ticket markdown/schema is now shared across producers and weekly supervision
  - `src/infra/operational-anomalies.ts`
  - `src/hooks/bundled/correction-loop/handler.ts`
  - `src/hooks/bundled/operating-weekly-review/handler.ts`
  - verified by targeted Vitest + Oxlint + shared parser/renderer checks
- watchtower anomaly-record consumers now share one parser-backed read contract
  - `src/hooks/bundled/lobster-brain-registry.ts`
  - `src/hooks/bundled/operating-weekly-review/handler.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
  - verified by targeted Vitest + Oxlint + parser smoke checks
- knowledge-validation source notes now share one parser-backed read contract
  - `src/hooks/bundled/lobster-brain-registry.ts`
  - `src/hooks/bundled/knowledge-validation-weekly/handler.ts`
  - `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
  - verified by targeted Vitest + Oxlint + parser smoke checks
- learning-council memory notes now share one writer/reader contract across Feishu and current dev-side consumers
  - `src/hooks/bundled/lobster-brain-registry.ts`
  - `extensions/feishu/src/learning-council.ts`
  - `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - `src/hooks/bundled/learning-review-weekly/handler.ts`
  - verified by targeted Vitest + Oxlint + parser smoke checks
- learning-council runtime JSON artifacts now also share one writer/reader contract across Feishu and operating-daily-workface
  - `src/hooks/bundled/lobster-brain-registry.ts`
  - `extensions/feishu/src/learning-council.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - verified by targeted Vitest + Oxlint + parser smoke checks
- learning-review notes now also share one writer/reader contract across:
  - `src/hooks/bundled/lobster-brain-registry.ts`
  - `src/hooks/bundled/learning-review/handler.ts`
  - `src/hooks/bundled/learning-review-weekly/handler.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - verified by targeted Vitest + Oxlint
- MCP context + aider capability now exists as bounded agent-facing tooling in the dev repo
  - `src/agents/tools/mcp-context-tool.ts`
  - `src/agents/tools/aider-tool.ts`
  - `src/agents/openclaw-tools.ts`
  - `src/agents/system-prompt.ts`
  - `src/plugins/runtime/runtime-tools.ts`
  - `.mcp.json`
  - verified by targeted Vitest + Oxlint for:
    - `src/agents/tools/mcp-context-tool.test.ts`
    - `src/agents/tools/aider-tool.test.ts`
    - `src/agents/openclaw-tools.mcp-aider-registration.test.ts`
    - `src/agents/system-prompt.test.ts`
    - `src/plugins/runtime/index.test.ts`
- the dev repo prompt/doctrine now also carries an autoresearch-style eval-loop discipline:
  - fixed-budget experiments
  - narrow writable scope
  - one explicit metric
  - keep/discard based on eval
  - experiment receipts
  - verified by targeted `src/agents/system-prompt.test.ts`
- the dev repo prompt/doctrine now also makes CLI-first operation explicit:
  - built-in read/grep/exec and local CLI stay primary
  - `mcp_context` is supplementary when CLI/local evidence is insufficient
- OpenSpace is now scoped in-dev as an optional isolated skill-engine seam:
  - not a default brain replacement
  - local-only by default
  - dedicated skills/workspace write scope only
  - `mcp_context` surfaces integration hints when an OpenSpace MCP server is configured
  - `mcp_context` also surfaces explicit warnings when isolated OpenSpace skill dirs/workspace are missing or cloud access is enabled
- learning weekly recall artifacts now also share one parser-backed content contract across:
  - `src/hooks/bundled/lobster-brain-registry.ts`
  - `src/hooks/bundled/learning-review-weekly/handler.ts`
  - `src/hooks/bundled/learning-review-bootstrap/handler.ts`
  - verified by targeted Vitest + Oxlint
- frontier raw research cards now also share one renderer/parser content contract across:
  - `src/hooks/bundled/lobster-brain-registry.ts`
  - `src/hooks/bundled/frontier-research/handler.ts`
  - `src/hooks/bundled/frontier-research-weekly/handler.ts`
  - verified by targeted Vitest + Oxlint
- Feishu probe-result health interpretation now also shares one helper-backed contract across:
  - `extensions/feishu/src/probe.ts`
  - `extensions/feishu/src/monitor.startup.ts`
  - `extensions/feishu/src/onboarding.ts`
  - verified by targeted Vitest + Oxlint for:
    - `extensions/feishu/src/probe.test.ts`
    - `extensions/feishu/src/monitor.startup.test.ts`
    - `extensions/feishu/src/onboarding.test.ts`
    - `src/commands/channels/status.test.ts`
- Feishu learning-council memory-note date anchoring now also uses the shared ISO date-key helper
  - `extensions/feishu/src/learning-council.ts`
  - `extensions/feishu/src/learning-council.test.ts`
  - verified by targeted Vitest + Oxlint
- portfolio-answer-scorecard and knowledge-validation-weekly artifacts now also share one renderer/parser contract across:
  - `src/hooks/bundled/lobster-brain-registry.ts`
  - `src/hooks/bundled/operating-weekly-review/handler.ts`
  - `src/hooks/bundled/knowledge-validation-weekly/handler.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - `extensions/feishu/src/bot.ts`
  - verified by targeted Vitest + Oxlint + parser/renderer smoke checks
- correction-note content now also shares one renderer/parser contract across:
  - `src/hooks/bundled/lobster-brain-registry.ts`
  - `src/hooks/bundled/correction-loop/handler.ts`
  - `src/hooks/bundled/operating-weekly-review/handler.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
  - verified by targeted Vitest + Oxlint + parser/renderer smoke checks
- lobster-workface artifact now also shares one filename/render/parse contract across:
  - `src/hooks/bundled/lobster-brain-registry.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - `extensions/feishu/src/bot.ts`
  - `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
  - verified by targeted Vitest + Oxlint + parser/renderer smoke checks
- control-room summaries for lobster-workface, portfolio-answer-scorecard, and
  knowledge-validation-weekly now also share one builder contract across:
  - `src/hooks/bundled/lobster-brain-registry.ts`
  - `extensions/feishu/src/bot.ts`
  - verified by targeted Feishu bot Vitest + Oxlint
- repair-ticket and Codex-escalation artifacts now also expose shared derived date keys across current control-family readers
  - `src/hooks/bundled/lobster-brain-registry.ts`
  - `src/hooks/bundled/operating-weekly-review/handler.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
  - verified by targeted Vitest + Oxlint for:
    - `src/infra/operational-anomalies.test.ts`
    - `src/hooks/bundled/correction-loop/handler.test.ts`
    - `src/hooks/bundled/operating-weekly-review/handler.test.ts`
    - `src/hooks/bundled/operating-daily-workface/handler.test.ts`
    - `src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`
- ISO date-key extraction is now also centralized for current control/fundamental freshness consumers
  - `src/hooks/bundled/lobster-brain-registry.ts`
  - `src/hooks/bundled/operating-loop/handler.ts`
  - verified by targeted Vitest + Oxlint including:
    - `src/hooks/bundled/operating-loop/handler.test.ts`
- Feishu surface-memory artifacts now also share one renderer/parser contract across:
  - `src/hooks/bundled/lobster-brain-registry.ts`
  - `extensions/feishu/src/bot.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - covering:
    - surface line artifacts
    - lane panel artifact
    - lane health artifact
  - verified by targeted Vitest + Oxlint + parser/renderer smoke checks
- global agent prompt now explicitly enforces short, plain-language user-facing replies while keeping internal reasoning unchanged
  - `src/agents/system-prompt.ts`
  - verified by targeted system-prompt Vitest + Oxlint
- MiniMax built-in default text model is now `MiniMax-M2.7`, and normal MiniMax onboarding paths follow the shared default resolver
  - `src/agents/minimax-model-catalog.ts`
  - `src/commands/onboard-non-interactive/local/auth-choice.ts`
  - verified by targeted Minimax/onboarding Vitest + Oxlint + catalog smoke checks
- empty-config runtime defaults now prefer MiniMax when MiniMax credentials already exist in the runtime environment
  - `src/agents/defaults.ts`
  - `src/agents/model-selection.ts`
  - `src/auto-reply/commands-registry.ts`
  - `src/auto-reply/status.ts`
  - `src/commands/status.summary.ts`
  - `src/commands/models/list.configured.ts`
  - `src/commands/models/list.status-command.ts`
  - `src/commands/doctor.ts`
  - `src/gateway/server-startup.ts`
  - verified by targeted Vitest + Oxlint + MiniMax runtime-default smoke checks
- repeated write/edit and artifact-integrity failures can now emit a shared Codex escalation packet
  - `src/hooks/bundled/lobster-brain-registry.ts`
  - `src/infra/codex-escalation.ts`
  - `src/infra/operational-anomalies.ts`
  - `src/hooks/bundled/correction-loop/handler.ts`
  - default behavior is packet-only; external wake stays off unless `OPENCLAW_CODEX_ESCALATION_COMMAND` is explicitly configured
  - verified by targeted Vitest + Oxlint for:
    - `src/infra/codex-escalation.test.ts`
    - `src/infra/operational-anomalies.test.ts`
    - `src/hooks/bundled/correction-loop/handler.test.ts`
- operating control surfaces now expose active Codex escalation packets instead of hiding them inside watchtower only
  - `src/hooks/bundled/operating-weekly-review/handler.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - verified by targeted Vitest + Oxlint for:
    - `src/hooks/bundled/operating-weekly-review/handler.test.ts`
    - `src/hooks/bundled/operating-daily-workface/handler.test.ts`
- memory hygiene now also sees Codex escalation packets and can surface them as weekly supervision input
  - `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
  - verified by targeted Vitest + Oxlint for:
    - `src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`
- weekly/control UTC date-key and trailing-window logic now shares one helper contract instead of duplicated `slice(0, 10)` and trailing-week implementations
  - `src/hooks/bundled/weekly-memory.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - `src/hooks/bundled/operating-weekly-review/handler.ts`
  - `src/hooks/bundled/knowledge-validation-weekly/handler.ts`
  - `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
  - verified by targeted Vitest + Oxlint + diff cleanliness

## Not Proven From This Repo Alone

- unattended multi-day runtime execution
- real Feishu production behavior
- fresh live gateway acceptance
- any claim that the whole system is already a mature live L4 agent
- any claim that the system is already L5

## What To Do First

Before changing code again:

1. read `AGENTS.md`
2. read `memory/current-research-line.md`
3. read `memory/current_state.md`
4. read this file
5. read `ops/dev-to-live-feishu-acceptance-runbook.md` before claiming any Feishu/live verification plan
6. separate:
   - observed
   - inferred
   - live-handoff narrative
   - unknown

## Current Best Next Action

Do not add features first.

Prefer this order:

1. keep truth-source files current
2. keep dev/live boundaries explicit
3. close verified holes in current hook / Feishu / control seams
4. only then consider bounded live-port work

## Newly Closed Control-Room Hole

- broad control-room aggregate asks were still at risk of inheriting a specialist state lane in `extensions/feishu/src/bot.ts`
- the bounded fix now pins only `includeDailyWorkface=true` control-room aggregates back to `control_room` for:
  - session scoping
  - feishu surface-memory ledger writes
- explicit single-slice asks from the control room still keep bounded specialist scoping
- the direct learning-status shortcut no longer steals global summary asks that merely contain `学习状态`

## Newly Closed Learning/Research Routing Holes

- GitHub/open-source/internalization asks were too easy to collapse into `knowledge_maintenance` instead of the real `learning_command` path
- LLM-in-finance-agent article learning asks could fall through without entering the learning path
- holdings-thesis revalidation asks could be misread as plain position-management and collapse to a single technical slice
- DS/statistics ETF-timing method questions could enter `learning_command` at routing time but still get dragged into `technical_daily` during control-room orchestration just because they mentioned ETFs
- bounded fix:
  - strategic learning asks now route into `learning_command`
  - holdings-thesis revalidation now stays a two-track research question: `technical_daily + fundamental_research`
  - DS/statistics method questions now keep a learning-only aggregate path instead of mixing in `technical_daily`
  - holdings-thesis revalidation now explicitly requires prior thesis / correction retrieval before answering; if the old thesis is missing, the answer must admit that and lower confidence
  - even more adversarial thesis-revalidation wording like `旧判断哪里失效，不要重新编一套` now stays on the same dual-track revalidation path instead of slipping back into plain position-management
  - learning-council prompts now also distinguish:
    - high-value learning worth durable internalization
    - shallow ecosystem recap / broad survey noise
  - GitHub/open-source/internalization asks now explicitly demand:
    - reusable rules or heuristics Lobster should actually keep
    - explicit discard of hype / novelty-only / generic best-practice fluff
    - a concrete `what changes for Lobster now` angle
  - `别做表面总结` style asks now explicitly penalize survey language instead of rewarding polished but low-transfer summaries
  - learning-result audit asks like `最近学的 openclaw 更新到底有没有内化成可复用规则，别给我做总结秀` are now treated as a focused `knowledge_maintenance + ops_audit` audit path instead of a four-surface control-room daily overview
  - the answer-layer prompt for those asks now explicitly requires:
    - checking recent learning outputs
    - checking protected summaries when present, the latest learning carryover cue, and reusable rules
    - checking related correction notes
    - admitting when no durable rule or anchor can be found instead of pretending the learning really stuck

## Forbidden Overclaims

- do not describe this repo as already fully live
- do not describe handoff markdown as runtime receipts
- do not describe local tests as real Feishu acceptance
- do not describe shadow / skeleton / contract work as autonomous runtime capability
- 2026-04-09: Hardened Feishu learning-internalization audit synonym coverage. Real operator phrasing such as `最近学的 openclaw 更新到底沉淀成了哪些以后会复用的规则` previously missed the audit path and fell back to broad control-room overview. Matcher now captures `沉淀成了哪些.*复用.*规则` / `以后会复用的规则` in both `surfaces.ts` and `bot.ts`, with regression coverage in surfaces/bot/real-utterance tests.
- 2026-04-09: Hardened two more colloquial Feishu operator phrasings. (1) Fresh-learning GitHub phrasing like `去github上学值得你学的，但别做开源综述，直接告诉我哪些会改你以后的做法` now routes to single-lane `learning_command` instead of slipping to `knowledge_maintenance`. (2) Prior-thesis phrasing like `以前那套 thesis 现在还站不站得住` now activates the holdings-thesis revalidation answer path even without explicit `持仓` wording.
- 2026-04-09: Added a distinct Feishu learning-workflow audit seam. Phrases like `最近后台自动学习有没有卡住，卡在哪` and `昨天让你学的东西，现在到底写进记忆还是只是生成了报告` previously fell into fresh-learning or generic control-room paths. They now route to `knowledge_maintenance + ops_audit`, and `bot.ts` adds a dedicated workflow-audit notice that checks the latest learning carryover cue, protected summaries when present, session receipts/timebox state, and whether learning actually changed reusable behavior. Also broadened thesis-revalidation phrasing to catch `上次那套逻辑现在是不是已经失效了`.
- 2026-04-09: Hardened rougher real-world phrasing beyond clean operator language. Fresh-learning asks like `github上那些能偷的招你去偷...别做分享会` and `最近 agent 圈子里什么东西真能让你以后少犯错` now stay on `learning_command`. Workflow-audit asks like `写进脑子了还是还躺在 report 里装样子` and `自动学习后台最近是不是死过机，后来是续上了还是装没事` now stay on `knowledge_maintenance + ops_audit`. Prior-thesis revalidation asks like `原来拿它的理由还剩几成` / `那套说法已经烂掉了，哪句烂了` / `继续拿着的核心理由现在还剩什么` now stay on the dual-track `technical_daily + fundamental_research` path instead of collapsing into position-management or a generic recap.
- 2026-04-09: Hardened even messier broken-oral operator phrasing. Internalization-audit asks like `前几天读那堆东西，到底留下啥了，还是过眼云烟` and `前阵子学的那些长期记忆玩意儿，进规矩了没，还是嘴上热闹` now route to `knowledge_maintenance + ops_audit`. Workflow-audit asks like `后台那条学习链是不是半路断过，然后又装作啥事没有` / `自动学习后台是不是自己断过又没报` no longer shrink to single-lane `knowledge_maintenance`; they now stay on the same `knowledge_maintenance + ops_audit` seam. Prior-thesis asks like `上回那个看多的由头现在还有活口没` / `原先撑着继续拿的那几个点，现在死了几个` / `之前那套继续拿着的根据，现在是不是就剩嘴硬了` now stay on dual-track thesis revalidation instead of falling through to empty control-room framing.
- 2026-04-09: Hardened another batch of complaint-style, broken-oral Feishu asks after direct local probing of answer/workflow behavior. Internalization/workflow audits like `别端水，就说上次学的那些花活有没有一条真改掉你老毛病`, `那条后台学习是不是根本没落账，只是文件看着多`, `你是不是把前阵子学过的东西又忘回去了`, `前阵子补的记忆那套，真进总线了还是边上堆垃圾`, and `自动学习后台是不是只会留痕，不会真落账` now consistently route to `knowledge_maintenance + ops_audit` instead of broad control-room recap or single-lane shrinkage. Prior-thesis asks like `别给我行情秀，我问的是之前那份看多理由现在塌了没`, `原来扛着不卖那点底气还剩几口气`, `之前死扛它那口气，现在还有没有道理`, and `原来那份继续拿着的说法，现在还有没有骨头` now consistently stay on dual-track thesis revalidation (`technical_daily + fundamental_research`) instead of collapsing into position-management or empty control-room framing.
- 2026-04-09: The distilled learning pack is no longer trapped in reply/workface layers. The newest `lobster-workface` learning carryover cue (`retain / discard / replay / next eval`) now feeds both `learning-review-bootstrap` and `frontier-research-bootstrap`, and `operating-loop` carries the same retain/discard/replay/next-eval lines into the protected summaries (`memory/current-research-line.md`, `memory/unified-risk-view.md`). Handoff truth: Lobster still is not `live-fixed`, but dev now has one tighter closed loop where learning changes what the next batch sees and what the protected brain summaries remember.
- 2026-04-09: `Learning status` replies no longer overclaim partial carryover as if the full pack landed. They now only say the latest workface has complete learning carryover when all four fields (`retain / discard / replay / next eval`) are present; otherwise they explicitly report an incomplete cue and list which fields were actually seen.
- 2026-04-09: Hardened the memory-tool contract so `memory_search` no longer implies "semantic/RAG is the canonical memory truth path". Tool payloads, the system prompt, and the tool catalog now describe it as a replaceable broad recall surface, while protected summaries remain the first anchors for current-state truth. If we later replace vector/semantic recall with a better structured memory or replay layer, the agent-facing contract now needs a smaller swap instead of a broad doctrine rewrite.
- 2026-04-10: Reached a bounded Feishu control-room/shared-state parity milestone in dev. Before this pass, several control-room variants still split the user-visible truth from the ledger/audit truth: local `Learning status` could answer honestly but write to the wrong surface or omit anomaly receipts, daily-brief replies could show `Learning loop` while the surface ledger remembered only a pre-wrap half-summary, empty daily-brief states could silently omit the learning loop altogether, and broadcast control-room replies could leave `reply summary unavailable` or no ledger update at all. After this pass, the same learning/workflow truth now survives across single-agent control-room replies, daily-brief control-room summaries, control-room surface ledgers, and broadcast control-room ledgers. `Learning status` / `Timebox status` early-return paths persist the same evidence-bearing text they show the operator, `Learning loop` is forced visible for true daily-brief asks even when the learning side is empty (`no active timebox`, `no latest lobster-workface`, missing protected anchors), surface-memory write failures now leave `feishu.surface_memory` anomaly receipts instead of log-only traces, and both single-agent and broadcast ledger capture now observe the final wrapped reply rather than a pre-wrap artifact. Honest state remains: `dev-fixed yes`, `live-fixed no`.
- 2026-04-10: Hardened the new daily-brief `Improvement pulse` against progress theater. Before this pass, any readable `lobster-workface` could emit a pulse, even if it only showed `learned 0 / corrected 0` and no `keep / discard / replay / next eval` cue. The pulse now appears only when the latest workface records a concrete delta or carryover rule, so Feishu control-room does not present a zero-delta day as visible improvement.
- 2026-04-10: Hardened the memory rescue path so the fallback is no longer fake. Before this pass, `memory_search` unavailable payloads told the agent to use direct `memory_get` reads on protected summaries, but `memory_get` still depended on the memory manager and could fail closed with `disabled=true` when embeddings/backend setup was unavailable. It now falls back to a direct workspace file read for `MEMORY.md` and `memory/*.md`, preserving protected-summary rescue without reopening the retrieval architecture.
- 2026-04-10: Hardened Feishu learning-council lane honesty for future model swaps. Before this pass, env overrides could run a council lane on another provider, but the visible headings, MiniMax audit prompt, and persisted runtime artifact still implied legacy `Kimi / MiniMax / DeepSeek` vendor execution. The council still keeps the same three lane ids and five-section schema, but each lane now records its capability contract plus the actual runtime provider/model, so future OpenAI / Anthropic / Hermes-style substitutions land as bounded runtime swaps instead of silent label drift.
- 2026-04-10: Hardened the learning-command surface notice so it stops propagating the old vendor assumption. The top-level learning-council doctrine in `extensions/feishu/src/surfaces.ts` now treats `Kimi / MiniMax / DeepSeek` as stable lane labels rather than proof of the runtime provider, and explicitly says runtime receipts must win if a lane is backed by another provider/model.
- 2026-04-10: Hardened the learning-council system prompts to match that doctrine. The Kimi / MiniMax / DeepSeek prompt builders in `extensions/feishu/src/learning-council.ts` now describe those names as stable lane labels rather than vendor identity, so using a lane heavily for quota reasons does not silently teach the prompt the wrong provider story.
- 2026-04-10: Hardened learning-command against generic super-agent drift. Finance-domain learning still gets the auto-heavy council pressure, but generic GitHub/open-source/agent-platform internalization asks no longer get promoted to the same heavy default just because they sound like self-improvement. They still stay on `learning_command`, but the prompts now force a finance-mainline filter: only keep tooling/agent/platform lessons that materially improve finance research workflow, filtering, timing discipline, or risk control.
- 2026-04-10: Hardened control-room prioritization for the same boundary. Mixed asks that mention both meta-agent learning and urgent holdings work now let holdings-thesis revalidation win first instead of routing the whole turn into `learning_command`. This preserves "borrow from other agents" as a capability, but no longer lets it delay finance learning or holdings analysis when the operator explicitly wants those first.
- 2026-04-10: Hardened the Lobster desktop visualization path toward the more stable macOS-app route. Before this pass, the concrete visualization seam existed only as a generated local HTML dashboard, so the capability was real but not yet a stable in-app OpenClaw surface. `apps/macos/Sources/OpenClaw/LobsterWorkfacePanel.swift` now rebuilds a bounded panel from the configured workspace whenever `Open Lobster Panel` is triggered from `apps/macos/Sources/OpenClaw/MenuContentView.swift`, and it writes that panel into the existing Canvas session rather than continuing to point Canvas at a detached file URL. The panel stays honest when the latest workface artifact is missing, unreadable, or malformed instead of failing closed.
- 2026-04-10: Hardened the in-app Lobster panel refresh loop. Before this pass, once the panel was open the operator had to go back to the menu to force a rebuild. The panel now includes `Refresh Panel`, backed by a local `openclaw://lobster-panel` deep link route in `apps/shared/OpenClawKit/Sources/OpenClawKit/DeepLinks.swift` and `apps/macos/Sources/OpenClaw/DeepLinks.swift`, so the current Canvas session can rebuild in place without bouncing through the agent path.
- 2026-04-10: Hardened the no-workface Lobster panel path so it remains useful, not just honest. Before this pass, if no `lobster-workface` artifact existed the panel mostly degraded to an empty-state explanation. `apps/macos/Sources/OpenClaw/LobsterWorkfacePanel.swift` now bootstraps from `memory/current-research-line.md` when present, so the in-app panel still surfaces the current research line, next step, guardrail, and anchor snapshot instead of acting like a blank shell.
- 2026-04-11: Learning-council now reads the consolidated finance brain, not just the current research line fragment. Before this pass, finance-learning runs only saw `memory/current-research-line.md` fields plus the latest carryover cue, so they could still learn from a narrow slice of state even after `MEMORY.md` and local durable memory cards were introduced. `extensions/feishu/src/learning-council.ts` now also injects compact `MEMORY.md` bullets plus up to two recent `memory/local-memory/*.md` card summaries into the lane preamble, so finance and meta-capability learning both start from the same active brain spine.
- 2026-04-11: The first learning ingress now also starts from the active brain instead of a blank generic study prompt. Before this pass, `extensions/feishu/src/bot.ts` told `learning_command` turns to do learning/open-source study work in broad terms, but it did not explicitly tell the very first learning hop to anchor on `memory/current-research-line.md`, `MEMORY.md`, the latest carryover cue, and local durable memory cards. That entrance prompt now does so, and also states that learning distillation must stay useful for both Lobster's general meta-capability and the full finance research pipeline.
- 2026-04-11: Explicit "start learning now" phrasing now routes to the real learning lane instead of relying on looser generic matches. `extensions/feishu/src/surfaces.ts` now recognizes `开始学习 / 开始学 / 现在开始学 / 先开始学 / 立刻开始学` as direct `learning_command` ingress so an operator can tell Lobster to start learning immediately without risking a slide back into plain `knowledge_maintenance`.
- 2026-04-11: Learning-council artifacts are now packet-backed instead of result-only. Before this pass, the council had better anchors and better distilled output, but downstream recovery still had to reconstruct objective, anchors used, and keep/discard/replay/next-eval state by reparsing the final prose. `extensions/feishu/src/learning-council.ts` now persists a bounded `runPacket` into the runtime artifact and memory note, `src/hooks/bundled/lobster-brain-registry.ts` now parses it, and `src/hooks/bundled/operating-daily-workface/handler.ts` now prefers that structured packet over re-scraping final reply prose. This is still bounded artifact hardening, not a new workflow engine or memory architecture.
- 2026-04-11: Correction-loop now also captures high-confidence natural complaint-style operator corrections instead of depending only on `反馈：/复盘：/纠正：` prefixes. Inputs like `你刚才那段还是词不达意。我让你先说动作和范围，不是直接重写长文。` now trigger the same correction-loop notice in `extensions/feishu/src/bot.ts` and the same durable correction-note path in `src/hooks/bundled/correction-loop/handler.ts`, so language-repair feedback can survive into memory/review instead of dissolving as plain chat.
- 2026-04-12: Broad knowledge distillation is now explicit doctrine, not just a loose open-source-learning side effect. `extensions/feishu/src/learning-council.ts` now treats Hermes / GitHub CLI / install / setup / migration / context files / memory providers as bounded adoption study and forces `adopt now / skip / compatibility risk / one next local step` instead of broad ecosystem recap. `extensions/feishu/src/surfaces.ts` also now routes Hermes/context-file/memory-provider learning phrasing directly to `learning_command` so those asks stop depending on generic `agent platform` wording.
- 2026-04-12: Adoption distillation now enters the bounded self-repair queue instead of stopping at learning artifacts. `extensions/feishu/src/bot.ts` now reads the matching learning-council runtime artifact for Hermes / GitHub CLI / install / context-file / memory-provider study receipts, converts `runPacket.lobsterImprovementLines` into `memory/feishu-work-receipts/repair-queue.md`, and names a real `Next Priority Self-Repair` target. This does not grant autonomous code mutation; it only shortens the path from broad learning to the next bounded repair candidate.
- 2026-04-12: Feishu now also has a bounded recent-message read seam in dev. `extensions/feishu/src/send.ts` can list recent chat messages via the Feishu/Lark message API, and `extensions/feishu/src/channel.ts` exposes that as channel action `read` for chat targets only. This is for live acceptance verification and bounded reply auditing, not a full watcher loop or autonomous monitoring plane.
- 2026-04-12: A bounded `feishu_live_probe` tool now exists in the dev repo. It sends a Feishu acceptance phrase, waits, reads the recent chat window back, applies simple accept/reject string checks, and writes both a receipt under `memory/feishu-live-probes/*.md` and a summarized `memory/feishu-live-probes/index.md`. Current real receipt evidence is still honest rather than optimistic: self-sent probes into `learning_command` returned `no_reply_observed`, and the tool now upgrades that into `self_authored_probe_not_processed_or_live_ingress_not_migrated` so future repair work does not waste time pretending the live ingress is already on this repo/runtime.
- 2026-04-12: The Feishu work-receipt seam now also materializes zero-state artifacts instead of only existing after a successful receipt write. `extensions/feishu/src/bot.ts` now ensures `memory/feishu-work-receipts/index.md` and `repair-queue.md` exist during real Feishu message handling, and `src/hooks/bundled/operating-daily-workface/handler.ts` does the same before reading receipts. This narrows the gap between “the contract exists in code/prompt” and “the files actually exist in the workspace,” but it remains dev-only until live runtime proof exists.
