#!/usr/bin/env python3
"""Fit temperature scaling for the local evaluator and report calibration.

Samples are JSONL, one per line:

  {"state": {...}, "question": {...}, "expected": "pass"}

Ground truth must be labels you actually trust. Never take expected from
another model's verdict: that only measures agreement with that model, not
correctness, and the fitted temperature inherits its bias.

Usage:
  python lcx_calibrate.py --model <path> --samples calibration-seed.jsonl \
      --out calibration.json --chat-template
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import mlx.core as mx

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lcx_mlx_evaluate as ev  # noqa: E402


def load_samples(path: str) -> list[dict]:
    samples = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                samples.append(json.loads(line))
    if not samples:
        raise SystemExit("calibration sample set is empty")
    return samples


def collect_rows(model, tokenizer, samples: list[dict], use_chat_template: bool) -> list[dict]:
    rows = []
    for index, sample in enumerate(samples):
        question = sample["question"]
        expected = sample["expected"]
        qtype, options, raw, _tokens = ev.compute_option_logits(
            model, tokenizer, ev.render_state(sample["state"]), question, use_chat_template
        )
        if expected not in options:
            raise SystemExit(f"sample {index}: expected {expected!r} not in options {options}")
        rows.append(
            {
                "task": sample.get("task", "default"),
                "raw": [float(value) for value in raw],
                "options": options,
                "expected_index": options.index(expected),
            }
        )
    return rows


def summarise(rows: list[dict]) -> dict:
    """Fit one temperature per group and report before/after calibration metrics."""
    temperature = fit_temperature(rows)
    return {
        "sample_count": len(rows),
        "temperature": temperature,
        "uncalibrated": metrics(rows, 1.0),
        "calibrated": metrics(rows, temperature),
    }


def softmax(logits: list[float], temperature: float) -> list[float]:
    scaled = [value / temperature for value in logits]
    peak = max(scaled)
    exps = [math.exp(value - peak) for value in scaled]
    total = sum(exps)
    return [value / total for value in exps]


def negative_log_likelihood(rows: list[dict], temperature: float) -> float:
    total = 0.0
    for row in rows:
        probability = softmax(row["raw"], temperature)[row["expected_index"]]
        total -= math.log(max(probability, 1e-12))
    return total / len(rows)


def metrics(rows: list[dict], temperature: float, bins: int = 10) -> dict:
    correct = 0
    brier = 0.0
    pairs: list[tuple[float, int]] = []
    for row in rows:
        probabilities = softmax(row["raw"], temperature)
        predicted = max(range(len(probabilities)), key=lambda i: probabilities[i])
        hit = 1 if predicted == row["expected_index"] else 0
        correct += hit
        target = [0.0] * len(probabilities)
        target[row["expected_index"]] = 1.0
        brier += sum(
            (probabilities[i] - target[i]) ** 2 for i in range(len(probabilities))
        )
        pairs.append((max(probabilities), hit))
    size = len(rows)
    ece = 0.0
    for bucket in range(bins):
        low = bucket / bins
        high = (bucket + 1) / bins
        members = [pair for pair in pairs if low <= pair[0] < high]
        if not members:
            continue
        avg_confidence = sum(pair[0] for pair in members) / len(members)
        avg_accuracy = sum(pair[1] for pair in members) / len(members)
        ece += len(members) / size * abs(avg_confidence - avg_accuracy)
    return {
        "accuracy": round(correct / size, 4),
        "ece": round(ece, 4),
        "brier": round(brier / size, 4),
    }


def fit_temperature(rows: list[dict]) -> float:
    best_temperature = 1.0
    best_loss = negative_log_likelihood(rows, 1.0)
    steps = 400
    for step in range(1, steps + 1):
        temperature = 0.05 * math.exp(step / steps * math.log(400.0))
        loss = negative_log_likelihood(rows, temperature)
        if loss < best_loss:
            best_loss = loss
            best_temperature = temperature
    return round(best_temperature, 4)


def main() -> int:
    parser = argparse.ArgumentParser(description="Fit temperature scaling for the local evaluator")
    parser.add_argument("--model", required=True)
    parser.add_argument("--samples", required=True)
    parser.add_argument("--out", help="path to write calibration JSON")
    parser.add_argument(
        "--chat-template",
        action="store_true",
        help="wrap prompts in the tokenizer chat template (use for instruct models)",
    )
    args = parser.parse_args()

    samples = load_samples(args.samples)
    started = time.time()
    model, tokenizer = ev.load(args.model)
    rows = collect_rows(model, tokenizer, samples, args.chat_template)

    overall = summarise(rows)
    per_task: dict[str, dict] = {}
    groups: dict[str, list[dict]] = {}
    for row in rows:
        groups.setdefault(row["task"], []).append(row)
    for task, task_rows in groups.items():
        per_task[task] = summarise(task_rows)

    result = {
        "model": args.model,
        "sample_count": len(samples),
        "overall": overall,
        "per_task": per_task,
        "elapsed_s": round(time.time() - started, 2),
    }
    print(json.dumps(result, ensure_ascii=False))

    if args.out:
        payload = {"temperature": overall["temperature"], "questions": {}}
        for task, summary in per_task.items():
            payload["questions"][task] = {"temperature": summary["temperature"]}
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
