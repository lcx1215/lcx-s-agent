#!/usr/bin/env python3
"""Local System-One style evaluator for mlx text models.

This is the local counterpart of a System One endpoint. It keeps the same
request/response shape -- state plus typed questions in, answers plus
probabilities out -- but runs entirely on a local mlx model and never performs
string generation. A single forward pass per question is used to read the logits
of short label tokens, so answers cannot fall outside the supplied criteria.

Question primitives mirror the System One contract:

  choice  {"type":"choice","instructions":str,"criteria":{label:description}}
  score   {"type":"score","instructions":str,"criteria":[band, ...]}   ordered
  noul    {"type":"noul","instructions":str,"criteria":{...}}           optional

Raw logits of a base model are NOT calibrated probabilities. Supply a
calibration file to apply temperature scaling before relying on the numbers.

Usage:
  python lcx_mlx_evaluate.py --model <path> --input request.json
  cat request.json | python lcx_mlx_evaluate.py --model <path>
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any

import mlx.core as mx
from mlx_lm import load

DEFAULT_MODEL = "Qwen/Qwen3-0.6B"
LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
NOUL_LABELS = ("true", "false")


class EvaluateError(Exception):
    """Raised when the request cannot be evaluated."""


def render_state(state: Any) -> str:
    if isinstance(state, str):
        return state
    if isinstance(state, dict):
        return json.dumps(state, ensure_ascii=False, indent=2)
    if isinstance(state, list):
        return "\n".join(str(item) for item in state)
    return str(state)


def build_prompt(state_text: str, instructions: str, options: list[str]) -> str:
    if not instructions.strip():
        raise EvaluateError("question instructions must not be empty")
    option_line = " ".join(f"{LABELS[i]}={opt}" for i, opt in enumerate(options))
    return f"{state_text}\n问题：{instructions}\n选项：{option_line}\n答案："


def read_options(question: dict[str, Any]) -> tuple[str, list[str]]:
    qtype = question.get("type")
    if qtype == "choice":
        criteria = question.get("criteria")
        if isinstance(criteria, dict):
            options = [str(key) for key in criteria]
        elif isinstance(criteria, list):
            options = [str(item) for item in criteria]
        else:
            raise EvaluateError("choice requires criteria as an object or list")
        return "choice", options
    if qtype == "score":
        criteria = question.get("criteria")
        if not isinstance(criteria, list) or len(criteria) < 2:
            raise EvaluateError("score requires at least two ordered criteria")
        return "score", [str(item) for item in criteria]
    if qtype == "noul":
        criteria = question.get("criteria")
        if isinstance(criteria, dict):
            options = [str(criteria.get("true", "true")), str(criteria.get("false", "false"))]
        else:
            options = ["true", "false"]
        return "noul", options
    raise EvaluateError(f"unsupported question type: {qtype!r}")


def resolve_label_ids(tokenizer: Any, count: int) -> list[int]:
    ids = []
    for index in range(count):
        encoded = tokenizer.encode(LABELS[index])
        if not encoded:
            raise EvaluateError(f"tokenizer produced no token for label {LABELS[index]}")
        ids.append(int(encoded[0]))
    if len(set(ids)) != len(ids):
        raise EvaluateError("label tokens collide; reduce the number of options")
    return ids


def apply_temperature(logits: mx.array, temperature: float) -> mx.array:
    if temperature <= 0:
        raise EvaluateError("temperature must be positive")
    if temperature == 1.0:
        return logits
    return logits / temperature


def compute_option_logits(
    model: Any,
    tokenizer: Any,
    state_text: str,
    question: dict[str, Any],
    use_chat_template: bool = False,
) -> tuple[str, list[str], mx.array, int]:
    """Return the pre-softmax label logits so calibration can rescale them."""
    qtype, options = read_options(question)
    if len(options) > len(LABELS):
        raise EvaluateError(f"too many options ({len(options)}); maximum is {len(LABELS)}")
    instructions = str(question.get("instructions", ""))
    prompt = build_prompt(state_text, instructions, options)
    if use_chat_template:
        prompt = tokenizer.apply_chat_template(
            [{"role": "user", "content": prompt}],
            tokenize=False,
            add_generation_prompt=True,
        )

    ids = mx.array([tokenizer.encode(prompt)])
    logits = model(ids)
    mx.eval(logits)
    last = logits[0, -1, :]

    label_ids = resolve_label_ids(tokenizer, len(options))
    raw = mx.array([float(last[i]) for i in label_ids])
    return qtype, options, raw, int(ids.shape[1])


def evaluate_question(
    model: Any,
    tokenizer: Any,
    state_text: str,
    question: dict[str, Any],
    temperature: float,
    use_chat_template: bool = False,
) -> tuple[dict[str, Any], int]:
    qtype, options, raw, tokens = compute_option_logits(
        model, tokenizer, state_text, question, use_chat_template
    )
    probs = mx.softmax(apply_temperature(raw, temperature))
    mx.eval(probs)
    values = [round(float(p), 6) for p in probs]

    if qtype == "choice":
        best = max(range(len(options)), key=lambda i: values[i])
        return (
            {
                "type": "choice",
                "choice": options[best],
                "probabilities": {opt: values[i] for i, opt in enumerate(options)},
                "confidence": values[best],
            },
            tokens,
        )
    if qtype == "score":
        weighted = sum(index * values[index] for index in range(len(options)))
        return (
            {
                "type": "score",
                "score": round(weighted, 6),
                "legend": options,
                "probabilities": {opt: values[i] for i, opt in enumerate(options)},
                "confidence": max(values),
            },
            tokens,
        )
    true_index = 0
    return (
        {
            "type": "noul",
            "probability": round(values[true_index], 6),
            "probabilities": {str(NOUL_LABELS[0]): values[0], str(NOUL_LABELS[1]): values[1]},
        },
        int(ids.shape[1]),
    )


def load_calibration(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def main() -> int:
    parser = argparse.ArgumentParser(description="Local System-One style evaluator")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="model repo id or local path")
    parser.add_argument("--input", help="path to request JSON; defaults to stdin")
    parser.add_argument("--calibration", help="path to calibration JSON")
    parser.add_argument("--max-tokens", type=int, default=0, help="unused, kept for CLI parity")
    parser.add_argument(
        "--chat-template",
        action="store_true",
        help="wrap the prompt in the tokenizer chat template (use for instruct models)",
    )
    args = parser.parse_args()

    if args.input:
        with open(args.input, encoding="utf-8") as handle:
            request = json.load(handle)
    else:
        request = json.load(sys.stdin)

    questions = request.get("questions")
    if not isinstance(questions, dict) or not questions:
        raise EvaluateError("request requires a non-empty questions object")

    calibration = load_calibration(args.calibration)
    default_temperature = float(calibration.get("temperature", 1.0))
    per_question = calibration.get("questions", {})

    load_start = time.time()
    model, tokenizer = load(args.model)
    load_seconds = round(time.time() - load_start, 3)

    state_text = render_state(request.get("state"))
    answers: dict[str, Any] = {}
    total_tokens = 0
    forward_start = time.time()
    for key, question in questions.items():
        if not isinstance(question, dict):
            raise EvaluateError(f"question {key!r} must be an object")
        temperature = float(per_question.get(key, {}).get("temperature", default_temperature))
        answer, tokens = evaluate_question(
            model, tokenizer, state_text, question, temperature, args.chat_template
        )
        answers[key] = answer
        total_tokens += tokens
    forward_seconds = round(time.time() - forward_start, 3)

    print(
        json.dumps(
            {
                "model": args.model,
                "answers": answers,
                "usage": {"prompt_tokens": total_tokens},
                "timings": {
                    "load_s": load_seconds,
                    "forward_s": forward_seconds,
                    "question_count": len(questions),
                },
                "calibrated": bool(calibration),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except EvaluateError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)
