# ETF catalyst follow-up workflow

Source: Finance Method Notebook
Publish Date: 2026-04-27
Extraction Summary: This article extracts a bounded finance research workflow for converting ETF catalyst headlines into follow-up questions, source checks, and invalidation notes.
Capability Name: ETF catalyst follow-up workflow
Capability Type: analysis_method
Related Finance Domains: event_driven, etf_regime
Capability Tags: event_catalyst_mapping, sentiment_analysis
Method Summary: Convert repeated ETF catalyst headlines into a small follow-up queue that distinguishes confirmed events, narrative amplification, and missing source checks.
Required Data Sources: public headlines, ETF issuer notes, earnings calendar, company IR notes
Causal Claim: Repeated catalyst headlines can reprioritize research follow-up when they map to ETF holdings or sector exposure, but they do not prove direction or timing.
Evidence Categories: event_catalyst_evidence, sentiment_evidence, etf_regime_evidence, equity_market_evidence, portfolio_risk_evidence
Evidence Summary: Public headlines, issuer notes, earnings calendars, and company IR notes can support a bounded catalyst follow-up queue while preserving uncertainty.
Evidence Level: case_study
Implementation Requirements: Keep a source-linked catalyst queue, mark unsupported narratives as pending, and require a red-team invalidation before any conclusion.
Risk and Failure Modes: Catalysts can be stale, already priced, irrelevant to ETF weights, or amplified by repeated coverage without new information.
Overfitting or Spurious Risk: Memorable catalyst narratives can appear causal after the fact even when sector beta or macro regime explains the move.
Compliance or Collection Notes: Use public articles, issuer pages, company IR pages, local exports, or manual operator capture only.
Suggested Attachment Point: research_capability:event_catalyst_mapping
Allowed Action Authority: research_only

This note describes a reusable research method only and leaves final judgment to a later evidence review.
