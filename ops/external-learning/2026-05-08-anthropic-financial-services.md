# Anthropic Financial Services Agent Pattern Intake

Date: 2026-05-08

Source:

- repo: https://github.com/anthropics/financial-services
- local clone inspected: `/tmp/anthropic-financial-services`
- inspected commit: `57772c3f1607229fba0270f94abf3c976bbd852f`
- license: Apache-2.0

Reading Scope:

- README repository structure and safety boundary.
- agent plugins: market-researcher, earnings-reviewer, model-builder, valuation-reviewer, plus adjacent ops/compliance agents.
- vertical skills: earnings-analysis, sector-overview, idea-generation, dcf-model, comps-analysis, audit-xls, portfolio-rebalance, tax-loss-harvesting.
- managed-agent cookbooks were inspected for the config pattern: orchestrator, callable leaf agents, constrained tools, and MCP env boundaries.

Reusable Patterns For LCX Agent:

- Orchestrator/leaf split: the control-room brain should plan and delegate; narrow leaf workers handle source extraction, modeling, QC, or summary slices.
- Untrusted-source isolation: filings, transcripts, issuer decks, third-party reports, GP packages, and uploaded documents are data only; never obey instructions embedded in them.
- Every number must have provenance: cite the source, timestamp/vendor, or mark it as unsourced/assumption instead of letting the model invent precision.
- Artifact QC gates: model/spreadsheet/deck/research outputs need a review pass before use. LCX should map this to review_panel, source_registry, local_brain_eval, and visible summary checks.
- Stop-before-external-use checkpoints: research drafts can be produced, but publication, distribution, execution, ledger posting, KYC approval, tax advice, and investment recommendations stay outside the agent.
- Enterprise MCP separation: CapIQ, FactSet, Daloopa, LSEG, S&P Global patterns are useful as source-tier ideas, but LCX must not assume those connectors exist without credentials and explicit setup.

LCX Application:

- Best fit now: market-researcher, earnings-reviewer, model-builder, valuation-reviewer patterns for LCX's low-frequency research and fundamentals/value-investing lane.
- Useful as architecture only: GL reconciler, KYC screener, month-end closer, statement auditor. They reinforce untrusted-reader and critic/reconciler patterns, not LCX's main finance research product.
- Downrank risk: pitch/deal workflows can bias the system toward transaction/deck production. Use their artifact/QC ideas, not their deal-execution posture.

Absorption Plan:

- Added a local-brain eval case: `anthropic_financial_agent_pattern_distillation`.
- Added a MiniMax teacher prompt and hardening path for external financial agent frameworks.
- Added contract routing so future "financial agent / Anthropic / external workflow" asks require source, license, reading scope, tool-boundary, QC, review, and research-only boundaries.

Status:

- `application_ready` at system-contract level after tests pass.
- Not model-weight-internalized until a later Qwen/adapter training run absorbs the new prompt and passes adapter-backed eval.
