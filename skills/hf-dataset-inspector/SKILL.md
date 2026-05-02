---
name: hf-dataset-inspector
description: Inspect Hugging Face datasets through read-only Dataset Viewer metadata. Use when the user shares a public HF dataset, asks whether data is suitable for a local experiment, or needs split/schema/size/sample checks before learning or evaluation.
metadata: { "openclaw": { "emoji": "🗂️" } }
---

# hf-dataset-inspector

Use this skill to inspect dataset suitability before LCX Agent learns from or evaluates against a dataset.

This is a local adaptation inspired by `huggingface/skills` `huggingface-datasets`. It is intentionally read-only and does not upload data, download large shards by default, or mutate model cards.

## When To Use

Use when the user provides:

- a Hugging Face dataset id such as `namespace/repo`
- a dataset URL
- a request like "check if this dataset is usable", "what are the splits", "sample rows", or "is this safe for a local experiment"

Do not use for live trading data collection, private datasets without explicit authorization, or broad web crawling.

## Safe Workflow

Use read-only Dataset Viewer endpoints first:

- Validate: `https://datasets-server.huggingface.co/is-valid?dataset=<dataset>`
- Splits: `https://datasets-server.huggingface.co/splits?dataset=<dataset>`
- First rows: `https://datasets-server.huggingface.co/first-rows?dataset=<dataset>&config=<config>&split=<split>`
- Size: `https://datasets-server.huggingface.co/size?dataset=<dataset>`
- Statistics: `https://datasets-server.huggingface.co/statistics?dataset=<dataset>&config=<config>&split=<split>`

If the API fails, state the exact failed step and do not invent schema or row counts.

## Inspection Checklist

- dataset id and license, if visible
- configs and splits
- row counts and size class
- column names and sample row shape
- target labels or outcome fields
- obvious PII or sensitive data risk
- leakage risk for the intended experiment
- whether a tiny local smoke test is possible

## Boundaries

- Do not upload datasets or create repos.
- Do not use private/gated datasets unless the user explicitly provides authorization.
- Do not download parquet shards unless the user asks for local extraction.
- Do not treat dataset existence as method validity.
- For finance learning, pass only safe local source artifacts into the finance learning pipeline.

## Output Shape

Return:

- `dataset`
- `configs_splits`
- `schema_summary`
- `size_summary`
- `sample_readiness`
- `risk_flags`
- `recommended_next_skill`
- `status`: `dataset_ready`, `sample_ready`, `needs_authorization`, `source_insufficient`, or `not_relevant`

Leave a concise usage receipt: skill used, why it matched, and boundary.
