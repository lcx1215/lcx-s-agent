#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
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

