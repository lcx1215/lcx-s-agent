#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from learning_goal_registry import resolve_learning_goal

DEFAULT_EVENT_PATH = ROOT / "branches" / "nlu" / "feedback_events.jsonl"
DEFAULT_RECEIPT_DIR = ROOT / "branches" / "nlu" / "router_override_receipts"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def feedback_event_path() -> Path:
    override = os.environ.get("LOBSTER_NLU_FEEDBACK_EVENTS_PATH", "").strip()
    return Path(override) if override else DEFAULT_EVENT_PATH


def receipt_dir() -> Path:
    override = os.environ.get("LOBSTER_NLU_ROUTER_RECEIPT_DIR", "").strip()
    return Path(override) if override else DEFAULT_RECEIPT_DIR


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


def build_routing_evalset(absorption_plan: dict[str, Any]) -> dict[str, Any]:
    cases = []
    seen: set[tuple[str, str, str, str]] = set()
    for family_row in absorption_plan.get("candidate_families", []) or []:
        if not isinstance(family_row, dict):
            continue
        family = str(family_row.get("family") or "").strip() or "unknown"
        for sample in family_row.get("candidate_samples", []) or []:
            if not isinstance(sample, dict):
                continue
            utterance = normalize_space(str(sample.get("utterance") or ""))
            expected_action = str(sample.get("expected_action") or "").strip()
            expected_topic = str(sample.get("expected_topic") or "").strip()
            if not utterance or not expected_action:
                continue
            key = (utterance, expected_action, family, expected_topic)
            if key in seen:
                continue
            seen.add(key)
            cases.append(
                {
                    "id": f"feedback-{len(cases) + 1:04d}",
                    "utterance": utterance,
                    "expected": {
                        "action": expected_action,
                        "family": family,
                        "topic": expected_topic,
                        "queued": bool(sample.get("queued")),
                        "executed": bool(sample.get("executed")),
                        "has_artifact": bool(sample.get("has_artifact")),
                        "quality_status": str(sample.get("quality_status") or ""),
                    },
                    "source": "nlu_feedback_absorption_plan",
                    "promotion_status": "candidate",
                }
            )
    return {
        "ok": True,
        "schema": "lobster.routing_evalset.v1",
        "created_at": now_iso(),
        "case_count": len(cases),
        "cases": cases,
    }


def run_deterministic_parser(utterance: str) -> dict[str, Any]:
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "feishu_nlu_parser.py"), utterance],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    raw = (proc.stdout or "").strip()
    if proc.returncode != 0:
        return {
            "ok": False,
            "error": (proc.stderr or raw or "parser failed")[:500],
            "code": proc.returncode,
        }
    try:
        obj = json.loads(raw)
    except Exception:
        return {"ok": False, "error": "non-json parser output", "raw": raw[:500]}
    return obj if isinstance(obj, dict) else {"ok": False, "error": "unexpected parser output"}


def first_parser_task(parser_result: dict[str, Any]) -> dict[str, Any]:
    tasks = parser_result.get("tasks", []) if isinstance(parser_result.get("tasks"), list) else []
    first = tasks[0] if tasks and isinstance(tasks[0], dict) else {}
    return {
        "action": str(first.get("action") or ""),
        "family": str(first.get("family") or ""),
        "topic": str(first.get("topic") or ""),
        "needs_clarification": bool(parser_result.get("needs_clarification")),
        "confidence": parser_result.get("confidence", 0),
    }


def run_semantic_candidate(utterance: str) -> dict[str, Any]:
    goal = resolve_learning_goal(utterance)
    topic = str(goal.get("canonical_topic") or "").strip()
    family = str(goal.get("family") or "").strip()
    is_learning = bool(goal.get("is_learning_request"))
    score = int(goal.get("score") or 0)
    if not is_learning or not topic:
        return {
            "action": "",
            "family": family,
            "topic": topic,
            "needs_clarification": True,
            "confidence": 0,
            "semantic_score": score,
        }
    return {
        "action": "learn_topic",
        "family": family,
        "topic": topic,
        "needs_clarification": False,
        "confidence": min(1, round(score / 20, 4)),
        "semantic_score": score,
    }


def predict_case(utterance: str, router: str) -> tuple[dict[str, Any], bool, str]:
    if router == "semantic_candidate":
        return run_semantic_candidate(utterance), True, ""
    parser_result = run_deterministic_parser(utterance)
    if parser_result.get("ok", True):
        return first_parser_task(parser_result), True, ""
    return {
        "action": "",
        "family": "",
        "topic": "",
        "needs_clarification": True,
        "confidence": 0,
    }, False, str(parser_result.get("error") or "")


def evaluate_routing_evalset(evalset: dict[str, Any], router: str = "deterministic_parser") -> dict[str, Any]:
    cases = evalset.get("cases", []) if isinstance(evalset.get("cases"), list) else []
    results = []
    by_family: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for case in cases:
        if not isinstance(case, dict):
            continue
        expected = case.get("expected", {}) if isinstance(case.get("expected"), dict) else {}
        utterance = str(case.get("utterance") or "")
        predicted, parser_ok, error = predict_case(utterance, router)
        action_match = predicted["action"] == str(expected.get("action") or "")
        family_match = predicted["family"] == str(expected.get("family") or "")
        topic_match = predicted["topic"] == str(expected.get("topic") or "")
        passed = action_match and family_match and topic_match and not predicted["needs_clarification"]
        row = {
            "id": case.get("id", ""),
            "utterance": utterance,
            "expected": expected,
            "predicted": predicted,
            "passed": passed,
            "matches": {
                "action": action_match,
                "family": family_match,
                "topic": topic_match,
            },
            "parser_ok": parser_ok,
            "error": error,
        }
        results.append(row)
        family = str(expected.get("family") or "unknown")
        by_family[family].append(row)

    family_scores = {}
    for family, rows in sorted(by_family.items(), key=lambda item: item[0]):
        total = len(rows)
        passed = sum(1 for row in rows if row["passed"])
        action_hits = sum(1 for row in rows if row["matches"]["action"])
        family_hits = sum(1 for row in rows if row["matches"]["family"])
        topic_hits = sum(1 for row in rows if row["matches"]["topic"])
        family_scores[family] = {
            "count": total,
            "passed": passed,
            "accuracy": round(passed / total, 4) if total else 0,
            "action_accuracy": round(action_hits / total, 4) if total else 0,
            "family_accuracy": round(family_hits / total, 4) if total else 0,
            "topic_accuracy": round(topic_hits / total, 4) if total else 0,
            "failures": [row for row in rows if not row["passed"]][:10],
        }

    total = len(results)
    passed = sum(1 for row in results if row["passed"])
    return {
        "ok": True,
        "schema": "lobster.routing_eval_result.v1",
        "created_at": now_iso(),
        "router": router,
        "case_count": total,
        "passed": passed,
        "accuracy": round(passed / total, 4) if total else 0,
        "families": family_scores,
        "failures": [row for row in results if not row["passed"]][:20],
    }


def compare_router_evalset(evalset: dict[str, Any]) -> dict[str, Any]:
    deterministic = evaluate_routing_evalset(evalset, router="deterministic_parser")
    semantic = evaluate_routing_evalset(evalset, router="semantic_candidate")
    family_names = sorted(set(deterministic.get("families", {})) | set(semantic.get("families", {})))
    family_deltas = {}
    for family in family_names:
        d = deterministic.get("families", {}).get(family, {})
        s = semantic.get("families", {}).get(family, {})
        family_deltas[family] = {
            "deterministic_accuracy": d.get("accuracy", 0),
            "semantic_accuracy": s.get("accuracy", 0),
            "delta": round(float(s.get("accuracy", 0)) - float(d.get("accuracy", 0)), 4),
            "deterministic_failures": d.get("failures", []),
            "semantic_failures": s.get("failures", []),
        }
    delta = round(float(semantic.get("accuracy", 0)) - float(deterministic.get("accuracy", 0)), 4)
    return {
        "ok": True,
        "schema": "lobster.routing_router_comparison.v1",
        "created_at": now_iso(),
        "case_count": evalset.get("case_count", 0),
        "deterministic": deterministic,
        "semantic_candidate": semantic,
        "accuracy_delta": delta,
        "family_deltas": family_deltas,
        "recommendation": "review_semantic_candidate" if delta > 0 else "keep_deterministic_primary",
    }


def build_router_override_candidates(
    comparison: dict[str, Any],
    *,
    min_cases: int = 3,
    min_delta: float = 0.15,
) -> dict[str, Any]:
    overrides = []
    for family, delta_row in (comparison.get("family_deltas") or {}).items():
        if not isinstance(delta_row, dict):
            continue
        deterministic = float(delta_row.get("deterministic_accuracy") or 0)
        semantic = float(delta_row.get("semantic_accuracy") or 0)
        delta = float(delta_row.get("delta") or 0)
        d_failures = delta_row.get("deterministic_failures", []) if isinstance(delta_row.get("deterministic_failures"), list) else []
        s_failures = delta_row.get("semantic_failures", []) if isinstance(delta_row.get("semantic_failures"), list) else []
        deterministic_family = (comparison.get("deterministic", {}).get("families", {}) or {}).get(family, {})
        case_count = 0
        if isinstance(deterministic_family, dict):
            case_count = int(deterministic_family.get("count") or 0)

        reasons = []
        eligible = True
        if case_count < min_cases:
            eligible = False
            reasons.append("insufficient_family_cases")
        if delta < min_delta:
            eligible = False
            reasons.append("semantic_delta_below_gate")
        if semantic < deterministic:
            eligible = False
            reasons.append("semantic_worse_than_deterministic")
        if s_failures and not d_failures:
            eligible = False
            reasons.append("semantic_adds_failures")
        if eligible:
            reasons.append("semantic_candidate_passes_family_gate")

        overrides.append(
            {
                "family": family,
                "primary_router": "deterministic_parser",
                "candidate_router": "semantic_candidate",
                "case_count": case_count,
                "deterministic_accuracy": deterministic,
                "semantic_accuracy": semantic,
                "delta": delta,
                "eligible": eligible,
                "reasons": reasons,
                "review_required": True,
            }
        )

    overrides.sort(key=lambda row: (not bool(row.get("eligible")), str(row.get("family") or "")))
    return {
        "ok": True,
        "schema": "lobster.routing_override_candidates.v1",
        "created_at": now_iso(),
        "auto_apply": False,
        "min_cases": min_cases,
        "min_delta": min_delta,
        "candidate_count": len(overrides),
        "eligible_count": sum(1 for row in overrides if row.get("eligible")),
        "overrides": overrides,
    }


def write_override_receipt(
    candidates: dict[str, Any],
    *,
    source_path: Path,
    output_path: Path | None = None,
) -> dict[str, Any]:
    created = now_iso()
    target = output_path
    if target is None:
        safe_stamp = created.replace(":", "").replace("-", "")
        target = receipt_dir() / f"{safe_stamp}_router_override_candidates.json"
    receipt = {
        "ok": True,
        "schema": "lobster.routing_override_receipt.v1",
        "created_at": created,
        "source_event_path": str(source_path),
        "auto_apply": False,
        "decision": "record_only",
        "reason": "router override candidates require explicit review before activation",
        "candidate_schema": candidates.get("schema"),
        "candidate_count": candidates.get("candidate_count", 0),
        "eligible_count": candidates.get("eligible_count", 0),
        "policy": {
            "min_cases": candidates.get("min_cases"),
            "min_delta": candidates.get("min_delta"),
            "review_required": True,
        },
        "overrides": candidates.get("overrides", []),
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "ok": True,
        "path": str(target.relative_to(ROOT)) if target.is_relative_to(ROOT) else str(target),
        "receipt": receipt,
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
    if cmd == "evalset":
        print_json(build_routing_evalset(build_absorption_plan(summary)))
        return 0
    if cmd == "run-eval":
        evalset = build_routing_evalset(build_absorption_plan(summary))
        print_json(evaluate_routing_evalset(evalset))
        return 0
    if cmd == "compare-routers":
        evalset = build_routing_evalset(build_absorption_plan(summary))
        print_json(compare_router_evalset(evalset))
        return 0
    if cmd == "select-overrides":
        evalset = build_routing_evalset(build_absorption_plan(summary))
        comparison = compare_router_evalset(evalset)
        print_json(build_router_override_candidates(comparison))
        return 0
    if cmd == "write-override-receipt":
        evalset = build_routing_evalset(build_absorption_plan(summary))
        comparison = compare_router_evalset(evalset)
        candidates = build_router_override_candidates(comparison)
        out_path = Path(sys.argv[3]) if len(sys.argv) > 3 else None
        print_json(write_override_receipt(candidates, source_path=path, output_path=out_path))
        return 0
    print_json({"ok": False, "error": f"unknown command: {cmd}"})
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
