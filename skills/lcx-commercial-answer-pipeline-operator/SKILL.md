---
name: lcx-commercial-answer-pipeline-operator
description: "Audit LCX answer candidates, source/quality gates and bounded adoption under the current provider/entry profile; deterministic replay is separate from real model and visible output."
metadata: { "openclaw": { "emoji": "🧩" } }
---

# LCX Commercial Answer Pipeline Operator

Read the [runtime contract](../_shared/lcx-runtime-contract.md).

1. Identify the actual entry, answer owner, provider/model adapter and source/review contract.
2. Use `node --import tsx scripts/operator/lcx-commercial-answer-pipeline.ts --json` for the existing deterministic scenarios. For a supplied candidate use its documented `--ask`, `--candidate-answer` and applicable `--finance-mode`.
3. Treat provider names and local challengers in those fixtures as implementation examples. The deterministic owner makes no remote-provider, MLX or sender call and cannot prove that the current model committee ran.
4. For a current Harness, finance committee or other answer path, verify that path's real attributable model/source/review receipts and its actual consumer.
5. Keep retries bounded with a terminal adoption or failed-reason result; prove visible delivery separately through the selected entry/channel.

Models, council drafts and optional local patches remain candidates until TypeScript/domain gates approve adoption. Do not fabricate current data, provider success, channel receipt or user-visible observation. Research mode does not authorize an order.
