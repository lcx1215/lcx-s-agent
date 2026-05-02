# Holdings risk math review workflow

Source: Finance Method Notebook
Publish Date: 2026-05-02
Extraction Summary: This article extracts a bounded holdings-analysis math workflow for translating volatility, drawdown, correlation, concentration, risk contribution, and tail-risk checks into research-only portfolio review.
Capability Name: Holdings risk math review workflow
Capability Type: risk_method
Related Finance Domains: portfolio_risk_gates, etf_regime, options_volatility
Capability Tags: risk_gate_design, volatility_research
Method Summary: Use basic portfolio risk math to keep holdings analysis from overreacting to a single narrative. Check position weight, realized volatility, maximum drawdown, correlation to major exposures, marginal risk contribution, and tail-risk scenario before any hold, add, reduce, or wait framing.
Required Data Sources: current position weights, recent price history, realized volatility estimate, drawdown history, correlation matrix, ETF or index exposure map, macro rate context
Causal Claim: A holding becomes portfolio-dangerous when volatility, drawdown, correlation, and marginal risk contribution rise together; one metric alone is not enough to justify a research stance.
Evidence Categories: portfolio_risk_evidence, equity_market_evidence, options_volatility_evidence, macro_rates_evidence, implementation_evidence
Evidence Summary: Position weights, realized volatility, drawdown history, correlation matrix, exposure map, and macro-rate context support a bounded holdings risk-math review without approving trades.
Evidence Level: case_study
Implementation Requirements: Refresh weights and price data, compute or estimate volatility, drawdown, correlation, and marginal risk contribution, name missing inputs, separate risk contribution from conviction, and preserve research-only language.
Risk and Failure Modes: Correlations can jump in stress, volatility can lag regime changes, small samples can understate tail risk, and qualitative conviction can hide concentration risk.
Overfitting or Spurious Risk: A recent calm window can make risk look low; a recent shock can make risk look permanently high. Require regime and sample-window caveats.
Compliance or Collection Notes: Use public market data, local exports, manual operator capture, or already retained portfolio notes only.
Suggested Attachment Point: research_capability:risk_gate_design
Allowed Action Authority: research_only

This note describes a reusable holdings-analysis math method only and does not approve trades, sizing, or doctrine mutation.
