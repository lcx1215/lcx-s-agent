#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EVENT_PATH = ROOT / "branches" / "nlu" / "feedback_events.jsonl"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def feedback_event_path() -> Path:
    override = os.environ.get("LOBSTER_NLU_FEEDBACK_EVENTS_PATH", "").strip()
    return Path(override) if override else DEFAULT_EVENT_PATH


def current_lane_key() -> str:
    return (os.environ.get("LOBSTER_LANE_KEY", "") or "").strip() or "global"


def normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def first_non_empty(values: list[Any]) -> str:
    for value in values:
        text = normalize_space(str(value or ""))
        if text:
            return text
    return ""


def build_distillation_sample(event: dict[str, Any]) -> dict[str, Any]:
    feedback = event.get("feedback", {}) if isinstance(event.get("feedback"), dict) else {}
    parser = event.get("parser", {}) if isinstance(event.get("parser"), dict) else {}
    understood = feedback.get("understood", []) if isinstance(feedback.get("understood"), list) else []
    first = understood[0] if understood and isinstance(understood[0], dict) else {}
    parser_tasks = parser.get("tasks", []) if isinstance(parser.get("tasks"), list) else []
    parser_first = parser_tasks[0] if parser_tasks and isinstance(parser_tasks[0], dict) else {}

    topic = first_non_empty([first.get("topic"), parser_first.get("topic")])
    action = first_non_empty([first.get("action"), parser_first.get("action"), event.get("action")])
    family = first_non_empty([first.get("family"), parser_first.get("family")])
    status = first_non_empty([feedback.get("status"), event.get("status")]) or "unknown"
    queued = feedback.get("queued", []) if isinstance(feedback.get("queued"), list) else []
    completed = feedback.get("completed", []) if isinstance(feedback.get("completed"), list) else []
    artifacts = feedback.get("artifacts", []) if isinstance(feedback.get("artifacts"), list) else []
    quality = feedback.get("learning_quality", {}) if isinstance(feedback.get("learning_quality"), dict) else {}

    return {
        "utterance": normalize_space(str(event.get("raw_text") or "")),
        "action": action,
        "family": family,
        "topic": topic,
        "status": status,
        "queued": bool(queued),
        "executed": bool(completed),
        "has_artifact": bool(artifacts),
        "quality_status": str(quality.get("status") or ""),
        "reply_text": str(event.get("reply_text") or ""),
    }


def read_feedback_events(path: Path | None = None) -> list[dict[str, Any]]:
    target = path or feedback_event_path()
    if not target.exists():
        return []
    out: list[dict[str, Any]] = []
    for line in target.read_text(encoding="utf-8", errors="ignore").splitlines():
        raw = line.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def sample_key(sample: dict[str, Any]) -> tuple[str, str, str, str]:
    return (
        str(sample.get("utterance") or ""),
        str(sample.get("action") or ""),
        str(sample.get("family") or ""),
        str(sample.get("topic") or ""),
    )


def collect_distillation_samples(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for event in events:
        sample = event.get("distillation_sample")
        if not isinstance(sample, dict):
            sample = build_distillation_sample(event)
        if not sample.get("utterance"):
            continue
        key = sample_key(sample)
        if key in seen:
            continue
        seen.add(key)
        samples.append(sample)
    return samples


def score_family(samples: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(samples)
    queued = sum(1 for s in samples if s.get("queued"))
    executed = sum(1 for s in samples if s.get("executed"))
    artifacts = sum(1 for s in samples if s.get("has_artifact"))
    usable_quality = sum(1 for s in samples if s.get("quality_status") == "usable")
    failures = sum(1 for s in samples if s.get("status") == "failed")
    score = 0
    if total:
        score = round(
            100
            * (
                0.25 * (queued / total)
                + 0.30 * (executed / total)
                + 0.25 * (artifacts / total)
                + 0.20 * (usable_quality / total)
            )
            - 30 * (failures / total),
            2,
        )
    return {
        "count": total,
        "queued": queued,
        "executed": executed,
        "artifacts": artifacts,
        "usable_quality": usable_quality,
        "failures": failures,
        "score": max(0, score),
        "example_utterances": [str(s.get("utterance") or "") for s in samples[:5]],
    }


def summarize_feedback_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    samples = collect_distillation_samples(events)
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for sample in samples:
        family = str(sample.get("family") or "").strip() or "unknown"
        buckets[family].append(sample)

    families = {
        family: score_family(rows)
        for family, rows in sorted(buckets.items(), key=lambda item: item[0])
    }
    return {
        "ok": True,
        "schema": "lobster.nlu_feedback_summary.v1",
        "event_count": len(events),
        "sample_count": len(samples),
        "family_count": len(families),
        "families": families,
        "samples": samples,
    }


def family_absorption_reason(family_score: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    count = int(family_score.get("count") or 0)
    executed = int(family_score.get("executed") or 0)
    artifacts = int(family_score.get("artifacts") or 0)
    usable_quality = int(family_score.get("usable_quality") or 0)
    failures = int(family_score.get("failures") or 0)
    score = float(family_score.get("score") or 0)
    if count < 3:
        reasons.append("low_sample_count")
    if executed < count:
        reasons.append("not_all_executed")
    if artifacts < executed:
        reasons.append("missing_artifacts")
    if usable_quality < artifacts:
        reasons.append("weak_quality_signal")
    if failures:
        reasons.append("has_failures")
    if score < 70:
        reasons.append("score_below_target")
    return reasons


def recommended_absorption_action(reasons: list[str]) -> str:
    if "has_failures" in reasons:
        return "review_failed_routes_before_rule_promotion"
    if "low_sample_count" in reasons:
        return "collect_more_real_lark_utterances"
    if "not_all_executed" in reasons:
        return "add_immediate_vs_queue_eval_cases"
    if "missing_artifacts" in reasons or "weak_quality_signal" in reasons:
        return "connect_feedback_to_learning_artifact_quality_eval"
    return "eligible_for_corpus_promotion_review"


def build_absorption_plan(summary: dict[str, Any]) -> dict[str, Any]:
    samples = summary.get("samples", []) if isinstance(summary.get("samples"), list) else []
    by_family: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for sample in samples:
        family = str(sample.get("family") or "").strip() or "unknown"
        by_family[family].append(sample)

    candidates = []
    for family, score in (summary.get("families") or {}).items():
        if not isinstance(score, dict):
            continue
        reasons = family_absorption_reason(score)
        rows = by_family.get(family, [])
        candidate_samples = [
            {
                "utterance": str(row.get("utterance") or ""),
                "expected_action": str(row.get("action") or ""),
                "expected_family": family,
                "expected_topic": str(row.get("topic") or ""),
                "status": str(row.get("status") or ""),
                "queued": bool(row.get("queued")),
                "executed": bool(row.get("executed")),
                "has_artifact": bool(row.get("has_artifact")),
                "quality_status": str(row.get("quality_status") or ""),
            }
            for row in rows[:20]
        ]
        candidates.append(
            {
                "family": family,
                "score": score.get("score", 0),
                "reasons": reasons,
                "recommended_action": recommended_absorption_action(reasons),
                "sample_count": score.get("count", 0),
                "candidate_samples": candidate_samples,
            }
        )

    candidates.sort(key=lambda item: (float(item.get("score") or 0), str(item.get("family") or "")))
    return {
        "ok": True,
        "schema": "lobster.nlu_feedback_absorption_plan.v1",
        "source_schema": summary.get("schema"),
        "event_count": summary.get("event_count", 0),
        "sample_count": summary.get("sample_count", 0),
        "candidate_count": len(candidates),
        "candidate_families": candidates,
        "promotion_policy": {
            "auto_promote": False,
            "requires_review": True,
            "target_score": 70,
            "min_samples_per_family": 3,
        },
    }


def print_json(obj: dict[str, Any]) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def append_feedback_event(
    *,
    raw_text: str,
    source: str,
    reply_text: str,
    feedback: dict[str, Any],
    parser: dict[str, Any] | None = None,
    executed: list[dict[str, Any]] | None = None,
    action: str = "",
) -> dict[str, Any]:
    event = {
        "schema": "lobster.nlu_feedback_event.v1",
        "created_at": now_iso(),
        "source": source,
        "lane_key": current_lane_key(),
        "raw_text": raw_text,
        "action": action,
        "reply_text": reply_text,
        "feedback": feedback,
        "parser": parser or {},
        "executed": executed or [],
    }
    event["distillation_sample"] = build_distillation_sample(event)

    path = feedback_event_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fp:
        fp.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")

    return {
        "ok": True,
        "path": str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path),
        "sample": event["distillation_sample"],
    }


def safe_append_feedback_event(**kwargs: Any) -> dict[str, Any]:
    try:
        return append_feedback_event(**kwargs)
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:300]}


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "summary"
    path = Path(sys.argv[2]) if len(sys.argv) > 2 else feedback_event_path()
    events = read_feedback_events(path)
    summary = summarize_feedback_events(events)

    if cmd == "summary":
        print_json(summary)
        return 0
    if cmd == "samples":
        print_json({"ok": True, "samples": summary["samples"]})
        return 0
    if cmd == "absorb":
        print_json(build_absorption_plan(summary))
        return 0
    print_json({"ok": False, "error": f"unknown command: {cmd}"})
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
