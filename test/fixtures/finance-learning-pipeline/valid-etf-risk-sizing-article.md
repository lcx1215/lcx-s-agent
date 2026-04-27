# ETF risk sizing review workflow

Source: Finance Method Notebook
Publish Date: 2026-04-27
Extraction Summary: This article extracts a bounded finance research workflow for turning ETF event triage into risk-review and qualitative sizing discipline without approving trades.
Capability Name: ETF risk sizing review workflow
Capability Type: risk_method
Related Finance Domains: etf_regime, portfolio_risk_gates
Capability Tags: risk_gate_design
Method Summary: Use ETF event and regime evidence to decide whether a research idea needs a tighter risk gate, wait discipline, or rejection before any qualitative sizing comment.
Required Data Sources: ETF issuer notes, drawdown context, volatility indicators, public headlines
Causal Claim: ETF event triage is more useful when paired with drawdown, volatility, and issuer context, but risk gates should block unsupported timing or sizing language.
Evidence Categories: equity_market_evidence, portfolio_risk_evidence, etf_regime_evidence, implementation_evidence, event_catalyst_evidence
Evidence Summary: Issuer notes, drawdown context, volatility indicators, and event evidence support a bounded risk-review scaffold for ETF research outputs.
Evidence Level: case_study
Implementation Requirements: Require a drawdown check, volatility context, invalidation trigger, and explicit no-trade boundary before any qualitative sizing implication.
Risk and Failure Modes: Risk checks can become cosmetic, volatility can spike after the review, and qualitative sizing language can drift into implicit trade approval.
Overfitting or Spurious Risk: Backward-looking drawdown comfort can hide regime shifts and make weak timing claims look controlled.
Compliance or Collection Notes: Use public articles, issuer pages, local exports, or manual operator capture only.
Suggested Attachment Point: research_capability:risk_gate_design
Allowed Action Authority: research_only

This note describes a reusable research method only and does not approve execution, sizing, or doctrine mutation.
