---
summary: "Illustrative example of a frontier research card for WaveLSFormer-style notes"
read_when:
  - You want a concrete example of the frontier-research card format
  - You need a sample verdict and adoptable-ideas section for a methods paper
title: "WaveLSFormer Example Card"
---

# WaveLSFormer Example Card

This page is an **illustrative example** based on working notes discussed during design. Validate the actual paper text, benchmarks, and implementation details before operational use.

## Research Card

- `title`: WaveLSFormer
- `material_type`: paper
- `domain`: frontier methods

## Problem

- `problem_statement`: Improve financial time-series modeling by combining multi-scale structure extraction with a transformer-style sequence model.
- `claimed_contribution`: The method claims that multi-scale preprocessing plus transformer modeling can improve signal quality over simpler single-scale pipelines.

## Method

- `method_summary`: Use a multi-scale decomposition step to separate structure and noise, then pass the resulting representation into a sequence model that learns temporal dependencies.
- `data_setup`:
  - Requires time-series market data with enough history for scale decomposition.
  - Likely sensitive to frequency choice, regime shifts, and train-validation splits.
- `evaluation_protocol`:
  - Compare against simpler baselines rather than only against neighboring deep-learning variants.
  - Check whether the evaluation target matches the actual trading objective.
  - Stress test across regimes instead of one favorable period.

## Results

- `key_results`:
  - The multi-scale framing is the most transferable idea.
  - The paper is more useful as a method prompt than as a production recipe.

## Risks

- `possible_leakage_points`:
  - Scale decomposition can hide look-ahead leakage if windows are not handled carefully.
  - Validation choices may accidentally reward prediction metrics that do not survive trading constraints.
- `overfitting_risks`:
  - Deep sequence models can overfit narrow market regimes.
  - Architectural complexity can make weak gains look important.
- `replication_cost`:
  - `data_requirements`: clean historical time-series, reproducible feature generation, stable train-validation splits
  - `engineering_complexity`: medium
  - `compute_cost`: medium

## Lobster Relevance

- `relevance_to_lobster`:
  - Useful as a methods card inside `frontier_research_branch`
  - Not sufficient as standalone market evidence
- `adoptable_ideas`:
  - Treat multi-scale processing as a denoising and feature-organization tool.
  - Force evaluation to align with the downstream objective instead of only prediction error.
  - Make risk budget and objective definition explicit during review.
- `do_not_copy_blindly`:
  - Do not copy the model stack into production without leakage review.
  - Do not assume benchmark wins imply trading wins.
  - Do not merge paper-method evidence with premium financial evidence.

## Verdict

- `verdict`: watch_for_followup
- `confidence`: medium
- `follow_up`:
  - Build a toy reproduction with leakage-safe splits.
  - Test whether the multi-scale idea still helps under a trading-aligned objective.
  - Archive the transferable principles even if the full model is not reproduced.

## Transferable principles

- Prediction targets and trading targets can diverge.
- Risk budget should be explicit, not implicit.
- Multi-scale processing may help denoise inputs before sequence modeling.
- High-frequency or noisy inputs should not be concatenated naively.
- Model selection should follow the real decision objective, not only leaderboard metrics.
