# Current Priority

## Order

1. finish existing live-port tickets one by one
2. attach fixed Feishu acceptance phrases to every live patch
3. keep `dev-fixed` and `live-fixed` separate
4. harden bookkeeping / memory failure handling after the current live-port debt is reduced
5. stabilize two real branches before broader branch expansion
6. keep acceptance probes honest: old Feishu messages plus later manual reruns must not count as fresh live acceptance

## Current live-port queue

### Already live-fixed

- control-panel L4 surface alignment
  - active runtime/control surfaces no longer present the current system as `l3_status`
  - live now writes and reads:
    - `branches/_system/control_panel_state.json`
  - compatibility mirror `branches/_system/l3_status.json` is still present for old readers, but active surfaces now render:
    - `System stage: L4`
    - `Control panel status: l4_brain_hardened`
    - `Current phase: L4 baseline hardening and shared-brain runtime`
  - current live evidence:
    - `python3 control_panel_summary.py`
      no longer prints `L3 completed`
    - latest `knowledge_maintenance` report preview no longer contains old L3 milestone lines

- branch-state nested contract alignment
  - active `_system` nested branch rows no longer drop key live fields that only existed in the top-level branch rows
  - current live fix specifically restores nested:
    - `risk_handoff_path`
    - `risk_audit_path`
    for `fundamental_research_branch`
  - current live evidence:
    - `python3 scripts/lobster_runtime_state_sanity.py`
      is green again after rerunning `scripts/sync_branch_status.py`

- Feishu display normalization hardening
- procedural-transfer specificity in live retrieval
  - `local_corpus_search.py` now distinguishes:
    - `量化`
    - `风险控制`
    - `代码系统`
    inside `procedural_transfer`
  - current live top results are now stable:
    - `这个方法怎么复用到量化` -> `tlt_inflation_surprise_and_term_premium.md`
    - `这个方法怎么复用到风险控制` -> `spy_death_cross_risk.md`
    - `这个方法怎么复用到代码系统` -> `spy_death_cross_risk.md`

- procedural-transfer domain hints for real operator queries
  - `local_corpus_search.py` now also recognizes:
    - `财报阅读`
    - `策略审计`
    - `系统架构`
    - `回测 / 过拟合`
    inside the same bounded `procedural_transfer` seam
  - current live top results are now stable:
    - `这个方法怎么复用到财报阅读` -> `iwm_rotation_exhaustion_risk.md`
    - `这个方法怎么复用到策略审计` -> `iwm_rotation_exhaustion_risk.md`
    - `这个方法怎么复用到系统架构` -> `market_regime.md`
    - `回测是不是过拟合` -> `iwm_rotation_exhaustion_risk.md`

- procedural-transfer family dedupe
  - `procedural_transfer` no longer returns multiple near-identical cards from the same method family
  - current live queries like:
    - `这个方法怎么复用到财报阅读`
    - `这个方法怎么复用到策略审计`
    - `回测是不是过拟合`
    now keep one `IWM` method-family winner instead of three near-duplicate `IWM` cards

- system-learning query decontamination
  - system-style queries containing `AI智能体 / 架构 / architecture / agent`
    no longer get polluted by market-side `AI -> QQQ / AI-capex` matches
  - current live top results are now stable:
    - `AI智能体架构怎么学` -> `market_regime.md`
    - `这个方法怎么复用到AI智能体` -> `market_regime.md`

- counterfactual / invalidation recall
  - live retrieval now has a bounded `counterfactual_recall` seam for:
    - `如果错了`
    - `什么会证伪`
    - `什么时候失效`
  - current live top results are now stable:
    - `market regime 什么会证伪这个结论` -> `episodes/market_regime.md`
    - `spy death cross risk 什么会证伪` -> `spy_death_cross_risk.md`
    - `qqq 这个读法什么时候失效` -> `qqq_ai_capex_and_duration_sensitivity.md`

- rehearsal / next-drill recall
  - live retrieval now has a bounded `rehearsal_recall` seam for:
    - `接下来怎么练`
    - `下次该怎么练`
    - `下一步该练什么`
  - current live top results are now stable:
    - `market regime 接下来怎么练` -> `market_regime.md`
    - `qqq 下次该怎么练` -> `qqq_ai_capex_and_duration_sensitivity.md`
    - `这个主题下一步该练什么` -> `market_regime.md`

- default study bootstrap routing
  - live retrieval now has a bounded `study_bootstrap` seam for natural study / reading / architecture-learning questions
  - current live top results are now stable:
    - `财报怎么看` -> `iwm_rotation_exhaustion_risk.md`
    - `系统架构怎么学` -> `market_regime.md`
    - `论文怎么学` -> `market_regime.md`
    - `AI智能体架构怎么学` -> `market_regime.md`
  - natural prompt coverage is now wider too:
    - `这篇论文该抓什么` -> `market_regime.md`
    - `这个架构值不值得学` -> `market_regime.md`
    - `这个财报重点看什么` -> `iwm_rotation_exhaustion_risk.md`
    - `这个方法值不值得继续练` -> `market_regime.md`

- skepticism-first evaluation routing
  - live retrieval now has a bounded `skepticism_eval` seam for natural trust / fragility / overfit prompts
  - current live top results are now stable enough to keep evaluation prompts off the generic transfer path:
    - `这个策略靠谱吗` -> `market_regime.md`
    - `这个回测靠谱吗` -> `market_regime.md`
    - `回测是不是过拟合` -> skepticism-first procedural recall instead of generic transfer/search
  - audit-specific ranking is now tighter too:
    - `回测是不是过拟合` -> `iwm_rotation_exhaustion_risk.md`
    - `策略审计靠谱吗` -> `iwm_rotation_exhaustion_risk.md`
  - same-family procedural duplicates are now suppressed inside `skepticism_eval`

- workflow-style natural routing
  - live retrieval now catches more control-room task phrasing instead of only cleaner one-line prompts
  - current live top results are now stable:
    - `读这篇论文给我重点和风险` -> `market_regime.md`
    - `先看这个财报，给我重点和风险` -> `iwm_rotation_exhaustion_risk.md`
    - `帮我判断这个策略值不值得继续跟` -> `market_regime.md`
    - `帮我看这个架构值不值得继续学` -> `market_regime.md`

- brain-bootstrap command routing
  - self-improvement / system-learning prompts now enter the live brain through a bounded `brain_bootstrap` command seam instead of bypassing into older generic paths
  - current live command / router behavior is now stable:
    - `系统怎么改造自己` -> `study_bootstrap` -> `market_regime.md`
    - `这个系统下一步该怎么改造` -> `study_bootstrap` -> `market_regime.md`
    - `这个架构怎么继续学` -> `study_bootstrap` -> `market_regime.md`
  - Feishu display is also humanized now:
    - these prompts render as `脑内起点摘要`
    - not raw retrieval JSON

- cmd-processor brain bootstrap
  - legacy fallback `cmd_processor.py` no longer returns `UNKNOWN` for self-improvement / system-learning prompts
  - bounded fallback behavior is now aligned with the installed brain:
    - `python3 cmd_processor.py --text '系统怎么改造自己'` -> `study_bootstrap` -> `market_regime.md`
  - this closes the gap where newer command seams used the brain but the old fallback still did not

- run-nlu-action-router brain bootstrap
  - `scripts/feishu_nlu_parser.py` + `scripts/run_nlu_action_router.py` no longer send self-improvement / system-learning prompts into clarification
  - current live behavior is now aligned:
    - `python3 scripts/feishu_nlu_parser.py '系统怎么改造自己'` -> `intent = brain_bootstrap`
    - `python3 scripts/run_nlu_action_router.py '系统怎么改造自己'` -> inner `study_bootstrap` -> `market_regime.md`
  - this closes another remaining NLU seam that still bypassed the installed brain

- learning brain-trace artifact propagation
  - live learner artifacts no longer stop at `provider_used`
  - `scripts/run_local_batch_learner.py` now writes:
    - per-item `brain_type`
    - per-query `brain_trace`
    - top-level `brain_trace_summary`
    into:
    - `knowledge/learn/*.sources.json`
    - `branches/learn/learn_state.json`
    - `branches/learn/lanes/*/learn_state.json`
  - `scripts/run_nightly_learning_batch.py` now propagates completed run `brain_trace_summary` into:
    - `knowledge/learn_batch/*.sources.json`
    - `branches/learn/night_batch_state.json`
  - current live evidence is now durable, not just router-output-only:
    - `market regime` learner run writes `semantic_recall` trace into learn sources/state
    - latest night batch writes batch `brain_trace_summary` into nightly sources/state

- learning brain-trace status + acceptance
  - `scripts/nightly_learning_status.py` now consumes brain trace instead of only exposing raw learn/night state
  - current status surface now exposes:
    - `night_batch_brain_trace`
    - `learn_brain_trace`
    - lane `brain_trace_summary`
  - `scripts/learning_acceptance_probe.py` now requires:
    - fresh lane report
    - fresh lane topic-memory
    - clean recall content
    - fresh report `brain_trace_summary`
  - it also no longer accepts generic status-surface outputs as fake learn execution evidence
  - after refreshing the two real Feishu lanes and sending new live proxy events:
    - `python3 scripts/learning_acceptance_probe.py`
      now returns:
      - `accepted: true`

- knowledge-maintenance brain-aware control panel
  - `scripts/run_knowledge_maintenance_branch.py` no longer emits a stale generic L3-style placeholder report
  - it now snapshots:
    - learn queue
    - bookkeeping pending count
    - latest global learn summary
    - current learn brain intents
    - current night-batch brain intents
    - topic-memory counts
    - active lanes
  - maintenance sources now carry:
    - `learning_status_snapshot`
    - `topic_memory_snapshot`
  - branch state now also carries:
    - `brain_trace_summary.learn_intents`
    - `brain_trace_summary.night_batch_intents`
  - fresh real Feishu verification:
    - `python3 scripts/branch_acceptance_probe.py knowledge_maintenance_branch --phrase 知识维护`
      now returns:
      - `accepted: true`

### Still dev-fixed only

- lane workspace propagation for learning council
- learning weekly artifact registry alignment
  - `src/hooks/bundled/learning-review-weekly/handler.ts`
  - `src/hooks/bundled/learning-review-bootstrap/handler.ts`
  - weekly producer, bootstrap consumer, and tests now share one artifact contract via:
    - `src/hooks/bundled/lobster-brain-registry.ts`
  - this closes the duplicated weekly learning filename/order seam in the dev L4 brain
- fundamental review chain registry alignment
  - `src/hooks/bundled/fundamental-review-queue/handler.ts`
  - `src/hooks/bundled/fundamental-review-brief/handler.ts`
  - `src/hooks/bundled/fundamental-review-plan/handler.ts`
  - `src/hooks/bundled/fundamental-review-workbench/handler.ts`
  - queue -> brief -> plan -> workbench now share one review-chain path contract via:
    - `src/hooks/bundled/lobster-brain-registry.ts`
  - this closes the duplicated core fundamental review-chain JSON/note path seam in the dev L4 brain
- fundamental target family registry alignment
  - `src/hooks/bundled/fundamental-target-packets/handler.ts`
  - `src/hooks/bundled/fundamental-target-workfiles/handler.ts`
  - `src/hooks/bundled/fundamental-target-deliverables/handler.ts`
  - `src/hooks/bundled/fundamental-target-reports/handler.ts`
  - `src/hooks/bundled/fundamental-review-memo/handler.ts`
  - `src/hooks/bundled/fundamental-collection-packets/handler.ts`
  - `src/hooks/bundled/fundamental-collection-follow-up-tracker/handler.ts`
  - `src/hooks/bundled/fundamental-manifest-patch-review/handler.ts`
  - `src/hooks/bundled/fundamental-dossier-drafts/handler.ts`
  - the fundamental target-family chain now shares one JSON/note path contract via:
    - `src/hooks/bundled/lobster-brain-registry.ts`
  - this closes the duplicated back-half fundamental artifact family seam in the dev L4 brain

### Live seam under review

- workface / scorecard / validation weekly dedupe
  - current evidence suggests this may be a development-only seam, not a direct live-port seam

### Live-hardened but not yet live-fixed

- learning shared-state / recall seam
  - `scripts/learning_acceptance_probe.py` now returns `accepted: true`
  - two real Feishu lanes now show:
    - lane-suffixed reports
    - lane-scoped topic-memory cards
    - clean recall content
  - empty-lane isolation also holds:
    - `学习记忆` in a fresh lane returns `当前 lane 暂无学习记忆。`
  - global `learn_state` is repaired back to `lane_key=global`
  - `legacy_lane_state_in_global_slot` is now `null`
  - lane-aware retrieval now prefers the current lane's `topic_memory` mirror before falling back to global knowledge
  - still not full lane workspace propagation or full per-lane workspace isolation

- learning bookkeeping hardening
  - learner now separates `task_result` from `bookkeeping_result`
  - bookkeeping failure now leaves:
    - pending retry trace
    - anomaly trace
  - nightly batch now marks bookkeeping-pending runs as `partial`
  - use `scripts/test_learning_bookkeeping.py` as the local proof test

- learning status / queue py3.9 hardening
  - `nightly_learning_status.py` no longer false-greens on a broken queue call
  - live status now shows:
    - `learn_state`
    - `bookkeeping.pending_count`
    - `bookkeeping.pending_topics`
    - `bookkeeping.last_anomaly`
    - `active_lanes` merged from queue + recent lane states, not just `next_up`

- learning lane state mirror
  - learner now keeps:
    - global compatibility state
    - lane-scoped state mirror under `branches/learn/lanes/*/learn_state.json`
  - `nightly_learning_status.py` can now surface recent lane states

- topic memory lane-scope hardening
  - `topic_memory.py` no longer rebuilds only one global memory view
  - lane-scoped topic-memory indexes/cards now exist under `branches/learn/lanes/*/topic_memory`
  - `学习记忆` / `topic卡片` can now prefer the current lane mirror when `LOBSTER_LANE_KEY` is present
  - empty lanes no longer fall back to global recall
  - topic-memory now also carries a bounded episodic seed layer:
    - global episodes under `knowledge/topic_memory/episodes`
    - lane episodes under `branches/learn/lanes/*/topic_memory/episodes`
  - `local_corpus_search.py` now recognizes:
    - `episodic_recall`
    - `semantic_recall`
    - `procedural_transfer`
    - `runtime_market`
    - `runtime_market_fresh`
  - "上次 / 之前 / 教训 / 错在哪 / last time / lesson" queries now prefer episodic cards instead of falling back to semantic recall
  - episode extraction quality gate is now live:
    - wrapper titles
    - source-path/file-name lines
    - serialized JSON/news blobs
    are rejected from lesson recall
  - if no clean lesson survives, episodic recall now falls back to a clean anchor instead of storing garbage
  - legacy `knowledge/topic_memory/*.json` artifacts are now excluded from live search results
  - clean Markdown cards are now the intended searchable memory surface for:
    - semantic recall
    - procedural transfer
    - episodic recall
  - alias expansion is now intent-aware:
    - keep broad alias expansion for runtime / procedural retrieval
    - keep semantic / episodic recall narrower and more topic-like
  - same-topic duplicates are now suppressed after ranking:
    - keep current-lane semantic / episodic winners
    - drop same-topic global duplicates of the same memory type

- Feishu learn-memory routing hardening
  - `学习记忆` no longer falls through the broad research bypass
  - explicit learn-memory commands now stay on the command path in live Feishu

- learning note distillation hardening
  - learner no longer anchors current conclusions on raw markdown headings
  - flattened `technical_daily` summaries are normalized before note extraction
  - generic topic-memory recall now reuses learned conclusions instead of placeholder fallback text

- dev fundamental artifact contract hardening
  - `learning artifact registry alignment` is done
  - `fundamental review chain registry alignment` is done
  - `fundamental target family registry alignment` is done
  - `fundamental front-half registry alignment` is now also done:
    - `fundamental-readiness`
    - `fundamental-snapshot-bridge`
    - `fundamental-snapshot`
    - `fundamental-scoring-gate`
    - `fundamental-risk-handoff`
  - result:
    - the fundamental artifact chain is now registry-backed end-to-end in dev

- dev frontier artifact contract hardening
  - `frontier artifact registry alignment` is now done:
    - weekly producer order
    - bootstrap priority order
    - filename generation
    - raw research-card prefix
  - result:
    - frontier study/research memory now follows the same single-source-of-truth pattern as learning and fundamental

- dev learning ingress hardening
  - `learning domain ingress broadening` is now done:
    - papers / whitepapers
    - earnings / fundamental reading
    - macro / market-structure study
    - strategy-audit / overfit study
    - GitHub / agent architecture / workflow study
  - result:
    - the next few days of training are less likely to disappear into overly narrow math-only topic buckets

- dev learning-council model seam hardening
  - `learning council minimax override` is now done
  - default remains verified `MiniMax-M2.5`
  - future official MiniMax bumps can move through:
    - `OPENCLAW_LEARNING_COUNCIL_MINIMAX_MODEL`

- dev learning-council weekly promotion
  - bounded `*-learning-council-*.md` artifacts now promote into weekly durable learning memory
  - this closes the hole where Feishu teaching artifacts existed in `memory/` but were skipped by weekly learning promotion

- dev MiniMax default model registry
  - core MiniMax defaults now share:
    - `src/agents/minimax-model-catalog.ts`
  - onboarding, auth-choice, provider build, and portal plugin now move through one bounded default-model seam
  - future verified upgrades can move through:
    - `OPENCLAW_MINIMAX_DEFAULT_MODEL`

- dev Feishu learning-council default-model alignment
  - `extensions/feishu/src/learning-council.ts` no longer freezes the MiniMax default at module load time
  - Feishu learning-council now resolves MiniMax at call time and shares the same repo-wide default seam as the rest of dev:
    - `OPENCLAW_MINIMAX_DEFAULT_MODEL`
  - council-specific override still remains available:
    - `OPENCLAW_LEARNING_COUNCIL_MINIMAX_MODEL`
  - proof already passed:
    - `extensions/feishu/src/learning-council.test.ts`
    - `extensions/feishu/src/bot.test.ts`
    - `extensions/feishu/src/feishu-command-handler.test.ts`
    - `pnpm build`

- technical_daily asset normalization
  - live `技术日报` now returns asset-aware snapshots instead of raw title/news fragments
  - `QQQ` now uses an explicit low-fidelity fallback instead of empty `technical context unavailable`
  - still needs repeat live validation before it can be called `live-fixed`

### Next after live-port debt

- branch stability:
  - `technical_daily_branch`
  - `knowledge_maintenance_branch`
  - use `scripts/branch_acceptance_probe.py` after each real Feishu acceptance phrase
  - synthetic-inbound acceptance now passes with live command seam phrases:
    - `技术日报`
    - `知识维护`
  - after each live hardening round, re-check:
    - `技术日报`
    - `知识维护`
    - two-chat `learn_topic market regime`
  - current quality focus:
    - keep `技术日报` clean across all five ETF slots, not just seam-stable

## Future-only exploratory notes

- `strategy audit / backtest skepticism`
  - research-support only
  - skepticism-first
  - used to reject weak or overfit edges before promotion
  - not a current mainline branch
  - not a profit-promise module

## Discipline

- no broad refactors in the live repo
- no opportunistic cleanup in the live repo
- no "it is probably live" claims
- no pretending L5 is about more modules
- every live patch must carry:
  - handoff record
  - bounded scope
  - build result
  - restart result
  - probe result
  - Feishu acceptance result
