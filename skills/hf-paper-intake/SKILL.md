---
name: hf-paper-intake
description: Intake arXiv or Hugging Face paper pages for LCX Agent research. Use when the user shares an arXiv ID/URL, Hugging Face paper URL, or asks to inspect linked models, datasets, code, method, limitations, and whether a paper should enter the research learning loop.
metadata: { "openclaw": { "emoji": "📄" } }
---

# hf-paper-intake

Use this skill for paper intake before deeper LCX research or finance-learning work.

This is a local adaptation inspired by `huggingface/skills` `huggingface-papers`. It is not a vendored copy, does not grant write access to Hugging Face, and does not auto-promote papers into durable finance memory.

## When To Use

Use when the user provides:

- a Hugging Face paper URL such as `https://huggingface.co/papers/2602.08025`
- an arXiv URL such as `https://arxiv.org/abs/2602.08025`
- an arXiv ID such as `2602.08025`
- a request like "learn this paper", "check the linked repo/dataset", or "is this paper worth adding to the learning loop"

Do not use for ordinary market commentary, position sizing, or Lark utterance routing.

## Safe Workflow

1. Parse the paper ID from the URL or text.
2. Prefer read-only metadata first:
   - `https://huggingface.co/api/papers/{PAPER_ID}`
   - `https://huggingface.co/papers/{PAPER_ID}.md`
3. Extract:
   - title
   - authors
   - abstract or summary
   - method claim
   - linked GitHub repo
   - linked models, datasets, or Spaces
   - benchmark or evaluation claims
   - limitations and missing evidence
4. Decide the next local route:
   - `frontier-research` for method review
   - `ml-research-loop` for experiment or reproduction plan
   - finance learning tools only after translating the paper into a safe local finance source

## Boundaries

- Do not call write endpoints, claim authorship, index papers, or update paper links.
- Do not download large models or datasets.
- Do not clone-run linked repositories by default.
- Do not treat an abstract as evidence that a method works.
- Do not promote finance claims without evidence gates and out-of-sample reasoning.
- If network access is unavailable or blocked, return `source_insufficient` with the missing source fields.

## Output Shape

Return:

- `paper_id`
- `title`
- `source_urls`
- `method_summary`
- `linked_artifacts`
- `relevance_to_lcx`
- `evidence_gaps`
- `recommended_next_skill`
- `status`: `intake_ready`, `needs_method_review`, `needs_experiment_plan`, `source_insufficient`, or `not_relevant`

Leave a concise usage receipt: skill used, why it matched, and boundary.
