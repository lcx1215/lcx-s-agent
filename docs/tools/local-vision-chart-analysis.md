---
summary: "Local open vision model selection and chart-analysis path"
read_when:
  - Enabling local chart or screenshot analysis
  - Changing the default local vision model
title: "Local vision chart analysis"
---

# Local vision chart analysis

LCX now has a local visual-analysis lane for chart images. The lane is an
adapter behind the existing `image` tool, so the finance chart tool keeps its
two separate authorities:

1. OHLCV numbers come from the canonical finance source registry.
2. Pixels are interpreted by a vision model and are labeled as research
   context. Pixel interpretation never replaces timestamped market data and
   never gains order, broker, wallet, sizing, or sender authority.

## Model decision

The current local quality profile is **Qwen3-VL 4B Instruct 4-bit**:
`mlx-community/Qwen3-VL-4B-Instruct-4bit`. It was downloaded and run end to
end on the current M3/8 GB host. The 2B 3-bit profile remains available as an
explicit low-memory fallback:
`mlx-community/Qwen3-VL-2B-Instruct-3bit`.
Qwen's official release describes the family as its strongest vision-language
generation and calls out OCR, spatial reasoning, long-context documents, and
visual-agent use cases. The MLX 4B conversion is about 3.09 GB and ran
successfully on the current M3/8 GB host; it is therefore the quality-first
local default. This is a hardware-aware choice, not a claim that one model is
permanently best on every benchmark. The 2B profile is smaller and faster but
showed substantially weaker chart reading in the local comparison.

For higher-memory hosts, the same adapter can point at Qwen3-VL-8B or a larger
hosted profile. Microsoft Phi-4-reasoning-vision-15B
is retained as a research comparator because Microsoft's published table shows
strong ChartQA performance, but it is not installed on this 8 GB machine.

Primary references:

- [Qwen3-VL official repository](https://github.com/QwenLM/Qwen3-VL)
- [Qwen3-VL MLX 4B 4-bit model card](https://huggingface.co/mlx-community/Qwen3-VL-4B-Instruct-4bit)
- [Qwen3-VL MLX 2B 3-bit model card](https://huggingface.co/mlx-community/Qwen3-VL-2B-Instruct-3bit)
- [Microsoft Phi-4-reasoning-vision release and evaluation](https://www.microsoft.com/en-us/research/blog/phi-4-reasoning-vision-and-the-lessons-of-training-a-multimodal-reasoning-model/)
- [InternVL3.5 model card](https://huggingface.co/OpenGVLab/InternVL3_5-14B)
- [GLM-V official repository](https://github.com/zai-org/GLM-V)

## Runtime contract

The runtime is intentionally outside Git-tracked source and weights:

- Python: `LCX_LOCAL_VISION_PYTHON`, defaulting to the existing local-brain
  virtualenv at `~/.openclaw/local-brain-trainer/.venv/bin/python`.
- Model: `LCX_LOCAL_VISION_MODEL`, defaulting to
  `mlx-community/Qwen3-VL-4B-Instruct-4bit`.
- Enable local image routing with `LCX_LOCAL_VISION_ENABLED=1`.
- The model cache is managed by Hugging Face and is never committed.
- `LCX_LOCAL_VISION_TIMEOUT_MS` and `LCX_LOCAL_VISION_MAX_TOKENS` bound the
  child process.

When local routing is enabled, LCX selects `mlx-vlm/local` first. Any existing
configured image providers remain ordered fallbacks. An explicit
`agents.defaults.imageModel` still wins, so a deployment can select a hosted
large model without changing source code.

## Commands

Run a real local image inference:

```bash
export LCX_LOCAL_VISION_ENABLED=1
pnpm lcx:vision:smoke --image /absolute/path/to/chart.png
```

The finance path is then available through the existing `finance_chart_analysis`
tool. Pass both a symbol/bars source and an image when available: the tool
returns deterministic OHLCV features plus a separate visual handoff/result.

When an image is loaded, the visual lane carries a
`lcx_finance_chart_visual_provenance_v1` receipt: SHA-256 image hash, resolved
image reference, MIME/byte size, `asOf` and source timestamp range, prompt
contract, effective provider/model when known, latency when the configured
image tool ran, and an explicit uncertainty state. Native-vision results are
marked as a handoff until the selected model returns its own observation.

For a non-agent smoke test, the CLI reports `runtime=local`, the resolved model,
the Python executable, and the actual generated text. A successful process
start alone is not considered a visual-proof receipt.

## Upgrade path

The model id is a runtime selection, not a hard-coded product authority. To
move to a larger profile on a machine with enough memory:

```bash
export LCX_LOCAL_VISION_MODEL=mlx-community/Qwen3-VL-8B-Instruct-4bit
pnpm lcx:vision:smoke --image /absolute/path/to/chart.png
```

Before promotion, compare the larger profile against the same chart fixture
set and keep the model, runtime, prompt, source timestamp, and uncertainty in
the receipt. Do not promote a model solely because a download, HTTP response,
or one fluent answer succeeded.

For a constrained host, select the verified smaller profile explicitly:

```bash
export LCX_LOCAL_VISION_MODEL=mlx-community/Qwen3-VL-2B-Instruct-3bit
pnpm lcx:vision:smoke --image /absolute/path/to/chart.png
```
