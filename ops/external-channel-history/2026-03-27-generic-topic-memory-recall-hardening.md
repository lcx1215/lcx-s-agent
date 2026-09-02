# Generic Topic Memory Recall Hardening

## Summary

Harden generic topic-card generation so learning reports like `market regime` no longer collapse back into placeholder recall output.

## Exact Failure Mode

- `scripts/topic_memory.py` was still using generic placeholders for non-bucket topics:
  - `drivers = local proxy drivers`
  - `key_points = Local topic summary generated.`
  - `conclusion = Local topic card generated from current knowledge base.`
- This happened even when the learner report already contained a real conclusion and usable retrieved-note lines.

## Why Dangerous

- The learner could produce a better report, but `学习记忆` / `topic卡片` would re-flatten it into a weak generic card.
- That breaks the self-learning loop at the recall layer.

## Smallest Safe Patch

- Keep the topic-memory architecture unchanged.
- For `generic` bucket topics:
  - derive drivers from `## 3. Retrieved Notes` when available
  - derive key point and conclusion from `## 5. Current Conclusion`
  - if retrieved notes are absent, fall back to the report conclusion instead of `local proxy drivers`

## Files Changed

- live:
  - `scripts/topic_memory.py`
  - `scripts/test_topic_memory_lane_scope.py`

## Proof Tests

- `python3 scripts/test_topic_memory_lane_scope.py`
- `python3 -m py_compile scripts/topic_memory.py scripts/test_topic_memory_lane_scope.py`
- `python3 scripts/topic_memory.py rebuild`

## Observed Behavior Change

`knowledge/topic_memory/market_regime.md` now reflects the actual learned content:

- drivers:
  - `Short-term broken with price below 200-day MA, though 50-day MA remains above 200-day.`
  - `Long-term uptrend intact (+21% YoY) but facing slight dip in 2026 on AI capex concerns...`
- key point / current conclusion:
  - `market regime 当前可继续跟踪，最值得保留的线索是：Short-term broken with price below 200-day MA, though 50-day MA remains above 200-day。`

instead of:

- `local proxy drivers`
- `Local topic card generated from current knowledge base.`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Remaining Out Of Scope

- This does not finish full lane workspace propagation.
- This does not improve source freshness.
- This does not replace final real Feishu multi-window acceptance.
