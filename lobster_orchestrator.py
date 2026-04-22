#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List
from provider_watch import analyze_result
from provider_router import degraded_summary, choose_provider
from execution_router import resolve_binding
from execution_probe import build_execution_audit_gate
from scripts.codex_escalation import (
    collect_workflow_codex_escalations,
    load_codex_escalation_state,
    record_codex_escalation,
)
from scripts.branch_freshness import (
    build_branch_freshness_snapshot,
    stale_branch_names,
    summarize_freshness,
)
from scripts.lobster_paths import (
    CONTROL_PANEL_STATE_NAME,
    ROOT,
    load_control_panel_state,
    load_state_json,
    save_state_json,
    state_path,
)

ENV_FILE = ROOT / ".env.lobster"
AUDIT = ROOT / "knowledge" / "index" / "knowledge_quality_audit.md"
ALERT_BIN = ROOT / "send_feishu_alert.py"
WF = state_path("workflow_state.json")
PROVIDER_BUDGET = state_path("provider_budget.json")
BRANCH_STATE = state_path("branch_state.json")
CONTROL_PANEL = state_path(CONTROL_PANEL_STATE_NAME)

FINANCE_HINTS = [
    "ratio", "drawdown", "turnover", "slippage", "transaction cost",
    "liquidity", "spread", "etf", "volatility", "momentum", "regime",
    "position sizing", "execution cost", "price impact", "tail risk",
    "market depth", "microstructure", "limit order"
]

AUDIT_HINTS = [
    "look-ahead bias", "survivorship bias", "overfitting",
    "walk-forward", "out-of-sample", "backtest"
]

STATS_HINTS = [
    "matrix calculus", "logistic regression", "optimization",
    "covariance", "feature engineering"
]

PREFLIGHT_GUARDED_ACTIONS = {
    "nightly",
    "refresh",
    "clean",
    "report",
    "maintenance",
    "cycle",
    "watchdog",
    "technical_daily",
    "fundamental_research",
    "knowledge_maintenance",
}

def resolve_openclaw_bin() -> str:
    explicit = (os.environ.get("OPENCLAW_BIN") or "").strip()
    candidates = [
        explicit,
        shutil.which("openclaw") or "",
        str(Path.home() / ".local" / "bin" / "openclaw"),
        str(Path.home() / ".npm-global" / "bin" / "openclaw"),
        str(Path.home() / "Library" / "pnpm" / "openclaw"),
        "/opt/homebrew/bin/openclaw",
        "/usr/local/bin/openclaw",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    return explicit or "openclaw"


def preflight_checks() -> list[tuple[str, list[str], int]]:
    return [
        (
            "lobster_guardrail_smoke",
            ["python3", str(ROOT / "scripts" / "lobster_guardrail_smoke.py")],
            7200,
        ),
        (
            "channels_probe",
            [resolve_openclaw_bin(), "channels", "status", "--probe"],
            1200,
        ),
    ]

def now_dt() -> datetime:
    return datetime.now()

def now_iso() -> str:
    return now_dt().isoformat()

def load_env() -> None:
    if not ENV_FILE.exists():
        return
    for raw in ENV_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v

def load_json(path: Path, default):
    if path.parent == WF.parent:
        return load_state_json(path.name, default)
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default

def save_json(path: Path, obj):
    obj["generated_at"] = now_iso()
    if path.parent == WF.parent:
        save_state_json(path.name, obj)
        return
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def load_branch_runtime_state(branch_name: str, legacy_path: Path) -> dict:
    state = load_state_json("branch_state.json", {})
    node = state.get(branch_name, {})
    if node:
        return node

    if legacy_path.exists():
        try:
            legacy = json.loads(legacy_path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        return {
            "status": legacy.get("last_status"),
            "mode": legacy.get("last_mode"),
            "last_run_at": legacy.get("last_run_at"),
            "summary": legacy.get("last_summary"),
            "report_path": legacy.get("last_report_path"),
            "sources_path": legacy.get("last_sources_path"),
            "risk_handoff_path": legacy.get("last_risk_handoff_path"),
            "risk_audit_path": legacy.get("last_risk_audit_path"),
            "provider_used": legacy.get("provider_used"),
        }
    return {}


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def load_text(path: Path) -> str:
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


def extract_markdown_bullets(report_rel: str, heading: str, limit: int = 5) -> list[str]:
    if not report_rel:
        return []
    text = load_text(ROOT / report_rel)
    if not text:
        return []
    capture = False
    bullets = []
    for raw in text.splitlines():
        line = raw.rstrip()
        if line.startswith("## "):
            if capture:
                break
            capture = line.strip() == heading
            continue
        if capture and line.strip().startswith("- "):
            bullets.append(line.strip()[2:])
            if len(bullets) >= limit:
                break
    return bullets

def run_cmd(cmd: list[str], timeout: int = 7200) -> dict:
    res = subprocess.run(
        cmd,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        env=os.environ.copy(),
        timeout=timeout
    )
    return {
        "code": res.returncode,
        "stdout": (res.stdout or "")[:8000],
        "stderr": (res.stderr or "")[:8000]
    }


def parse_json_output(text: str) -> dict[str, Any] | None:
    raw = (text or "").strip()
    if not raw:
        return None
    try:
        payload = json.loads(raw)
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def classify_report_delivery(result: dict[str, Any]) -> dict[str, Any]:
    code = int(result.get("code", 1) or 0)
    stdout = str(result.get("stdout") or "")
    stderr = str(result.get("stderr") or "")

    if code != 0:
        return {
            "status": "failed",
            "delivered": False,
            "deliveryStatus": "failed",
            "reason": (stderr or stdout or f"sender exited {code}")[:500],
        }

    payload = parse_json_output(stdout)
    if payload is None:
        return {
            "status": "malformed",
            "delivered": False,
            "deliveryStatus": "malformed",
            "reason": "sender returned non-JSON output",
        }

    delivery_status = str(payload.get("deliveryStatus") or "").strip().lower()
    delivered = payload.get("delivered")
    muted = bool(payload.get("muted"))

    if delivered is True or delivery_status in {"success", "sent", "delivered"}:
        return {
            "status": "delivered",
            "delivered": True,
            "deliveryStatus": delivery_status or "delivered",
            "payload": payload,
        }

    if muted or delivery_status in {"muted", "skipped", "not-delivered", "not_delivered", "noop", "no-op"}:
        return {
            "status": "skipped",
            "delivered": False,
            "deliveryStatus": delivery_status or "muted",
            "payload": payload,
            "reason": str(payload.get("message") or payload.get("reason") or "delivery muted"),
        }

    return {
        "status": "malformed",
        "delivered": False,
        "deliveryStatus": delivery_status or "malformed",
        "payload": payload,
        "reason": "sender did not declare an explicit delivery outcome",
    }


def requires_preflight(action: str) -> bool:
    return action in PREFLIGHT_GUARDED_ACTIONS


def send_alert_message(message: str, runner=subprocess.run) -> dict:
    result = runner(
        ["python3", str(ALERT_BIN), message],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=120,
        env=os.environ.copy(),
    )
    return {
        "code": result.returncode,
        "stdout": (result.stdout or "")[:4000],
        "stderr": (result.stderr or "")[:4000],
    }


def alert_preflight_block(action: str, gate: dict, runner=subprocess.run) -> dict:
    failures = ", ".join(gate.get("failures", [])) or "unknown"
    msg = (
        "🚨 Lobster Preflight Blocked\n"
        f"action: {action}\n"
        f"failures: {failures}\n"
        "mode: fail-closed\n"
        "next: inspect lobster_orchestrator.py status preflight_gate"
    )
    return send_alert_message(msg, runner=runner)


def alert_watchdog_failure(branch_name: str, result: dict, runner=subprocess.run) -> dict:
    msg = (
        "🚨 Lobster Watchdog Recovery Failed\n"
        f"branch: {branch_name}\n"
        f"code: {result.get('code', 1)}\n"
        "mode: stale-branch catch-up\n"
        "next: inspect lobster_orchestrator.py status watchdog"
    )
    return send_alert_message(msg, runner=runner)


def run_preflight_gate(
    wf: dict,
    action: str,
    runner=run_cmd,
) -> dict:
    failures: list[str] = []
    checks: dict[str, dict[str, Any]] = {}
    for name, cmd, timeout in preflight_checks():
        result = runner(cmd, timeout=timeout)
        checks[name] = result
        if result.get("code") != 0:
            failures.append(name)
    gate = {
        "at": now_iso(),
        "action": action,
        "ok": not failures,
        "failures": failures,
        "checks": checks,
    }
    wf.setdefault("last_results", {})["preflight"] = gate
    return gate


def build_watchdog_targets(
    branch_state: dict,
    scheduler_state: dict,
) -> list[dict[str, Any]]:
    snapshot = build_branch_freshness_snapshot(branch_state, scheduler_state)
    scheduler_branches = (scheduler_state.get("branches", {}) or {})
    targets: list[dict[str, Any]] = []
    for branch_name, row in snapshot.items():
        meta = scheduler_branches.get(branch_name, {}) or {}
        if not meta.get("enabled", False):
            continue
        if str(row.get("status") or "") not in {"stale", "never_run", "invalid_timestamp"}:
            continue
        entry = str(meta.get("entry") or "").strip()
        command = str(meta.get("command") or "").strip()
        if not entry or not command:
            continue
        targets.append(
            {
                "branch": branch_name,
                "entry": entry,
                "command": command,
                "freshness": row,
            }
        )
    return targets


def run_stale_branch_watchdog(
    wf: dict,
    runner=run_cmd,
    alert_runner=subprocess.run,
) -> dict:
    branch_state = load_state_json("branch_state.json", {})
    scheduler_state = load_state_json("branch_scheduler.json", {})
    targets = build_watchdog_targets(branch_state, scheduler_state)
    watchdog = {
        "at": now_iso(),
        "ok": True,
        "targets": [],
        "recovered": [],
        "failed": [],
    }

    for target in targets:
        branch_name = target["branch"]
        freshness = target.get("freshness", {}) or {}
        result = runner(["python3", str(ROOT / target["entry"])], timeout=7200)
        entry = {
            "branch": branch_name,
            "command": target.get("command", ""),
            "pre_status": freshness.get("status"),
            "pre_lag_hours": freshness.get("lag_hours"),
            "code": result.get("code", 1),
        }
        if result.get("code") == 0:
            watchdog["recovered"].append(branch_name)
            mark_done(wf, "watchdog_recover_branch", branch_name)
        else:
            watchdog["ok"] = False
            alert = alert_watchdog_failure(branch_name, result, runner=alert_runner)
            entry["alert"] = alert
            entry["codex_escalation"] = record_codex_escalation(
                category="watchdog_recovery_failure",
                issue_key=f"watchdog-{branch_name}",
                source="lobster_orchestrator",
                summary=f"Watchdog failed to recover stale branch: {branch_name}",
                details={
                    "branch": branch_name,
                    "freshness": freshness,
                    "result": result,
                },
            )
            watchdog["failed"].append(branch_name)
            mark_failed(wf, "watchdog_recover_branch", branch_name, result.get("stderr") or result.get("stdout") or "watchdog failed")
        watchdog["targets"].append(entry)
        refresh_branch_state(wf)
        refresh_unified_risk_gate(wf)
        refresh_branch_scheduler(wf)

    wf.setdefault("last_results", {})["watchdog"] = watchdog
    return watchdog

def parse_audit_rows() -> List[Dict[str, Any]]:
    if not AUDIT.exists():
        return []
    pat = re.compile(r"- \*\*(.+?)\*\* \| type: `(.+?)` \| flags: `(.+?)` \| source_count: `(\d+)`")
    rows = []
    for line in AUDIT.read_text(encoding="utf-8", errors="ignore").splitlines():
        m = pat.match(line.strip())
        if not m:
            continue
        topic = m.group(1).strip()
        topic_type = m.group(2).strip()
        flags = [x.strip() for x in m.group(3).split(",")]
        source_count = int(m.group(4))
        rows.append({
            "topic": topic,
            "topic_type": topic_type,
            "flags": flags,
            "source_count": source_count
        })
    return rows

def classify_bucket(topic: str, topic_type: str) -> str:
    t = topic.lower()
    if topic_type == "finance" or any(x in t for x in FINANCE_HINTS):
        return "finance_cleanup_queue"
    if topic_type == "audit" or any(x in t for x in AUDIT_HINTS):
        return "audit_cleanup_queue"
    if topic_type == "stats_math" or any(x in t for x in STATS_HINTS):
        return "stats_math_queue"
    return "general_cleanup_queue"

def is_retry_blocked(wf: dict, topic: str) -> bool:
    retry_after = wf.get("retry_after", {})
    ts = retry_after.get(topic)
    if not ts:
        return False
    try:
        dt = datetime.fromisoformat(ts)
    except Exception:
        return False
    return now_dt() < dt

def build_queues(wf: dict) -> None:
    rows = parse_audit_rows()
    queues = {
        "new_learning_queue": [],
        "finance_cleanup_queue": [],
        "audit_cleanup_queue": [],
        "stats_math_queue": [],
        "general_cleanup_queue": [],
        "maintenance_queue": ["report", "audit", "index"]
    }

    for row in rows:
        topic = row["topic"]
        if is_retry_blocked(wf, topic):
            continue
        bucket = classify_bucket(topic, row["topic_type"])

        # priority rule:
        # low_source_count > high_arxiv_share
        # finance/audit already separated by bucket
        priority = 0 if "low_source_count" in row["flags"] else 1
        queues[bucket].append({
            "topic": topic,
            "topic_type": row["topic_type"],
            "flags": row["flags"],
            "priority": priority,
            "source_count": row["source_count"]
        })

    for key in ["finance_cleanup_queue", "audit_cleanup_queue", "stats_math_queue", "general_cleanup_queue"]:
        queues[key].sort(key=lambda x: (x["priority"], x["source_count"], x["topic"].lower()))

    wf["queues"] = queues

def update_status(wf: dict, mode: str, action: str) -> None:
    wf["current_mode"] = mode
    wf["last_action"] = action
    wf["last_action_at"] = now_iso()

def trim_recent(wf: dict) -> None:
    wf["done_recent"] = wf.get("done_recent", [])[-20:]
    wf["failed_recently"] = wf.get("failed_recently", [])[-20:]

def mark_done(wf: dict, action: str, topic: str | None = None) -> None:
    entry = {"at": now_iso(), "action": action}
    if topic:
        entry["topic"] = topic
    wf.setdefault("done_recent", []).append(entry)
    trim_recent(wf)

def mark_failed(wf: dict, action: str, topic: str | None = None, reason: str = "") -> None:
    entry = {"at": now_iso(), "action": action, "reason": reason[:300]}
    if topic:
        entry["topic"] = topic
    wf.setdefault("failed_recently", []).append(entry)
    trim_recent(wf)

    if topic:
        backoff_min = int(wf.get("policy", {}).get("retry_backoff_minutes", 30))
        wf.setdefault("retry_after", {})[topic] = (now_dt() + timedelta(minutes=backoff_min)).isoformat()


def attach_codex_escalation(
    result_payload: dict[str, Any],
    *,
    category: str,
    issue_key: str,
    summary: str,
    details: dict[str, Any],
) -> None:
    result_payload["codex_escalation"] = record_codex_escalation(
        category=category,
        issue_key=issue_key,
        source="lobster_orchestrator",
        summary=summary,
        details=details,
    )

def do_nightly(wf: dict):
    update_status(wf, "nightly", "run_nightly")
    record_binding_usage(wf, "batch_learning")
    res = run_cmd(["python3", str(ROOT / "daily_learning_runner_legacy.py")])
    wf["last_results"]["nightly_learning"] = res
    maybe_alert("nightly_learning", res)
    if res["code"] == 0:
        mark_done(wf, "nightly")
    else:
        attach_codex_escalation(
            res,
            category="orchestrator_stage_failure",
            issue_key="nightly-learning",
            summary="Nightly learning runner failed during unattended cycle",
            details={"stage": "nightly_learning", "result": res},
        )
        mark_failed(wf, "nightly", reason=res["stderr"] or res["stdout"])
    return res

def queue_topics_for_refresh(wf: dict, limit: int) -> List[str]:
    topics: List[str] = []
    for bucket in ["finance_cleanup_queue", "audit_cleanup_queue", "stats_math_queue", "general_cleanup_queue"]:
        for item in wf["queues"].get(bucket, []):
            topics.append(item["topic"])
            if len(topics) >= limit:
                return topics
    return topics

def do_refresh(wf: dict):
    update_status(wf, "refresh", "run_flagged_refresh")
    record_binding_usage(wf, "retrieval")
    limit = int(wf.get("policy", {}).get("max_refresh_batch", 8))
    topics = queue_topics_for_refresh(wf, limit)
    wf["pending"] = topics
    wf["in_progress"] = []
    if not topics:
        res = {"code": 0, "stdout": "no flagged topics found", "stderr": ""}
        wf["last_results"]["flagged_refresh"] = res
        mark_done(wf, "refresh")
        return res

    res = run_cmd(["python3", str(ROOT / "refresh_flagged_topics.py"), "--limit", str(limit), "--sleep-sec", "1.0"])
    wf["last_results"]["flagged_refresh"] = res
    maybe_alert("flagged_refresh", res)
    if res["code"] == 0:
        for t in topics:
            mark_done(wf, "refresh_topic", t)
    else:
        attach_codex_escalation(
            res,
            category="orchestrator_stage_failure",
            issue_key="flagged-refresh",
            summary="Flagged topic refresh failed during unattended cycle",
            details={"stage": "flagged_refresh", "topics": topics, "result": res},
        )
        for t in topics:
            mark_failed(wf, "refresh_topic", t, res["stderr"] or res["stdout"])
    wf["pending"] = []
    return res

def queue_topics_for_force_clean(wf: dict, limit: int) -> List[str]:
    topics: List[str] = []
    # only finance/audit first for force-clean
    for bucket in ["finance_cleanup_queue", "audit_cleanup_queue"]:
        for item in wf["queues"].get(bucket, []):
            topics.append(item["topic"])
            if len(topics) >= limit:
                return topics
    return topics

def rewrite_force_clean_priority(topics: List[str]) -> None:
    payload = {"finance_audit_force_clean": topics}
    save_state_json("clean_priority_topics.json", payload)

def do_force_clean(wf: dict):
    update_status(wf, "force_clean", "run_force_clean")
    record_binding_usage(wf, "research")
    limit = int(wf.get("policy", {}).get("max_force_clean_batch", 4))
    topics = queue_topics_for_force_clean(wf, limit)
    if not topics:
        res = {"code": 0, "stdout": "no finance/audit topics to clean", "stderr": ""}
        wf["last_results"]["force_clean"] = res
        mark_done(wf, "force_clean")
        return res

    rewrite_force_clean_priority(topics)
    wf["pending"] = topics
    res = run_cmd(["python3", str(ROOT / "force_clean_topics.py"), "--limit", str(limit), "--sleep-sec", "1.0"])
    wf["last_results"]["force_clean"] = res
    maybe_alert("force_clean", res)
    if res["code"] == 0:
        for t in topics:
            mark_done(wf, "force_clean_topic", t)
    else:
        attach_codex_escalation(
            res,
            category="orchestrator_stage_failure",
            issue_key="force-clean",
            summary="Force-clean failed during unattended cycle",
            details={"stage": "force_clean", "topics": topics, "result": res},
        )
        for t in topics:
            mark_failed(wf, "force_clean_topic", t, res["stderr"] or res["stdout"])
    wf["pending"] = []
    return res


def autonomous_topic_expansion_enabled(wf: dict) -> bool:
    policy = wf.get("policy", {}) or {}
    return bool(policy.get("allow_autonomous_topic_expansion", False))


def mark_autonomous_expansion_skipped(wf: dict, stage: str) -> None:
    wf.setdefault("last_results", {})
    wf["last_results"][stage] = {
        "at": now_iso(),
        "status": "skipped",
        "reason": "operator_managed_learning_only",
    }

def do_report(wf: dict):
    update_status(wf, "report", "build_and_send_report")
    record_binding_usage(wf, "long_synthesis")
    a = run_cmd(["python3", str(ROOT / "make_learning_report.py")], timeout=1200)
    b = run_cmd(["python3", str(ROOT / "send_learning_report_feishu.py")], timeout=1200)
    delivery = classify_report_delivery(b)
    wf["last_results"]["report"] = {"build": a, "send": b, "delivery": delivery}
    maybe_alert("report_build", a)
    maybe_alert("report_send", b)
    if a["code"] == 0 and delivery["delivered"]:
        wf["last_results"]["report"]["status"] = "delivered"
        mark_done(wf, "report")
    elif a["code"] == 0 and delivery["status"] == "skipped":
        wf["last_results"]["report"]["status"] = "skipped"
    else:
        wf["last_results"]["report"]["status"] = "failed"
        attach_codex_escalation(
            wf["last_results"]["report"],
            category="orchestrator_stage_failure",
            issue_key="learning-report",
            summary="Learning report build/send failed during unattended cycle",
            details={"stage": "report", "build": a, "send": b, "delivery": delivery},
        )
        mark_failed(
            wf,
            "report",
            reason=(a["stderr"] + " " + b["stderr"] + " " + str(delivery.get("reason") or "")).strip(),
        )
    return wf["last_results"]["report"]

def do_maintenance(wf: dict):
    update_status(wf, "maintenance", "maintenance_cycle")
    a = run_cmd(["python3", str(ROOT / "knowledge_index_builder.py")], timeout=1200)
    b = run_cmd(["python3", str(ROOT / "knowledge_quality_audit.py")], timeout=1200)
    c = run_cmd(["python3", str(ROOT / "make_learning_report.py")], timeout=1200)
    wf["last_results"]["maintenance"] = {"index": a, "audit": b, "report": c}
    maybe_alert("maintenance_index", a)
    maybe_alert("maintenance_audit", b)
    maybe_alert("maintenance_report", c)
    if a["code"] == 0 and b["code"] == 0 and c["code"] == 0:
        mark_done(wf, "maintenance")
    else:
        attach_codex_escalation(
            wf["last_results"]["maintenance"],
            category="orchestrator_stage_failure",
            issue_key="maintenance-cycle",
            summary="Maintenance cycle failed during unattended run",
            details={"stage": "maintenance", "index": a, "audit": b, "report": c},
        )
        mark_failed(wf, "maintenance", reason=(a["stderr"] + " " + b["stderr"] + " " + c["stderr"]).strip())
    return wf["last_results"]["maintenance"]


def maybe_alert(stage: str, result: dict) -> None:
    info = analyze_result(stage, result)
    if not info.get("is_alert"):
        return
    provider = info.get("provider", "unknown")
    reason = info.get("reason", "error")
    snippet = info.get("snippet", "")
    msg = (
        "🚨 Lobster Provider Alert\n"
        f"stage: {stage}\n"
        f"provider: {provider}\n"
        f"reason: {reason}\n"
        f"snippet: {snippet[:280]}"
    )
    subprocess.run(
        ["python3", str(ALERT_BIN), msg],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=120,
        env=os.environ.copy()
    )



def record_binding_usage(wf: dict, job_name: str) -> None:
    info = resolve_binding(job_name)
    choice = info.get("choice", {})
    selected = choice.get("selected", "unknown")
    chain = choice.get("chain", [])
    primary = chain[0] if chain else "unknown"
    fallback_used = bool(choice.get("fallback_used", False))

    wf.setdefault("execution_binding", {})
    wf["execution_binding"][job_name] = {
        "at": now_iso(),
        "selected": selected,
        "primary": primary,
        "fallback_used": fallback_used,
        "reason": choice.get("reason", "")
    }

    wf.setdefault("done_recent", []).append({
        "at": now_iso(),
        "action": "execution_binding",
        "job": job_name,
        "selected": selected,
        "primary": primary,
        "fallback_used": fallback_used
    })
    trim_recent(wf)




def refresh_branch_scheduler(wf: dict) -> None:
    import subprocess
    res = subprocess.run(
        ["python3", str(ROOT / "branch_scheduler.py")],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=120
    )
    wf["branch_scheduler"] = {
        "code": res.returncode,
        "stdout": (res.stdout or "").strip(),
        "stderr": (res.stderr or "").strip()
    }

def refresh_branch_state(wf: dict) -> None:
    import subprocess, json
    res = subprocess.run(
        ["python3", str(ROOT / "branch_supervisor.py")],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=120
    )
    wf["branch_supervisor"] = {
        "code": res.returncode,
        "stdout": (res.stdout or "").strip(),
        "stderr": (res.stderr or "").strip()
    }


def refresh_unified_risk_gate(wf: dict) -> None:
    state = load_state_json("branch_state.json", {})
    fr = state.get("fundamental_research_branch", {})
    td = state.get("technical_daily_branch", {})
    km = state.get("knowledge_maintenance_branch", {})
    risk_audit_rel = fr.get("risk_audit_path") or fr.get("last_risk_audit_path", "")
    unified = {
        "source_branch": "fundamental_research_branch",
        "risk_audit_path": risk_audit_rel,
        "top_decision": "n/a",
        "approved_assets": [],
        "vetoed_assets": [],
        "blackout_status": [],
        "supporting_branch_inputs": {
            "technical_daily": {
                "status": td.get("status", ""),
                "report_path": td.get("report_path", ""),
                "risk_flags": extract_markdown_bullets(
                    td.get("report_path", ""),
                    "## 5. Risk Flags",
                    limit=5,
                ),
            },
            "knowledge_maintenance": {
                "status": km.get("status", ""),
                "report_path": km.get("report_path", ""),
                "risk_flags": extract_markdown_bullets(
                    km.get("report_path", ""),
                    "## 5. Risk Flags",
                    limit=4,
                ),
            },
        },
        "updated_at": "",
    }
    if risk_audit_rel:
        risk_audit = load_json(ROOT / risk_audit_rel, {})
        if risk_audit:
            unified.update({
                "top_decision": risk_audit.get("top_decision", "n/a"),
                "approved_assets": risk_audit.get("approved_for_upstream_risk", []),
                "vetoed_assets": risk_audit.get("blocked_by_fundamental_veto", []),
                "blackout_status": risk_audit.get("blocked_by_blackout", []),
                "updated_at": risk_audit.get("generated_at", ""),
            })
    wf["unified_risk_gate"] = unified
    # Keep the execution-side gate in lockstep with the latest unified risk view.
    wf["execution_audit_gate"] = build_execution_audit_gate(wf)

def refresh_execution_binding(wf: dict) -> None:
    wf.setdefault("execution_binding", {})
    for job_name in ["batch_learning", "research", "long_synthesis", "audit_review", "retrieval"]:
        info = resolve_binding(job_name)
        choice = info.get("choice", {})
        wf["execution_binding"][job_name] = {
            "at": now_iso(),
            "selected": choice.get("selected", "unknown"),
            "primary": (choice.get("chain") or ["unknown"])[0],
            "fallback_used": bool(choice.get("fallback_used", False)),
            "reason": choice.get("reason", "")
        }

def refresh_provider_routing(wf: dict) -> None:
    routing = degraded_summary()
    wf["provider_routing"] = routing

def routing_text(wf: dict) -> list[str]:
    routing = wf.get("provider_routing", {})
    tasks = routing.get("tasks", {})
    lines = []
    lines.append(f"degraded_mode: {routing.get('degraded_mode', False)}")
    for task in sorted(tasks):
        row = tasks[task]
        selected = row.get("selected", "unknown")
        chain = row.get("chain", [])
        primary = chain[0] if chain else "unknown"
        fallback_used = row.get("fallback_used", False)
        status = "fallback" if fallback_used else "primary"
        lines.append(f"- {task}: {selected} ({status}, primary={primary})")
    return lines


def mark_provider_fallbacks(wf: dict) -> None:
    routing = wf.get("provider_routing", {})
    tasks = routing.get("tasks", {})
    for task, row in tasks.items():
        if row.get("fallback_used"):
            entry = {
                "at": now_iso(),
                "action": "provider_fallback",
                "task": task,
                "selected": row.get("selected"),
                "primary": (row.get("chain") or ["unknown"])[0]
            }
            wf.setdefault("done_recent", []).append(entry)
    trim_recent(wf)

def summary_text(wf: dict) -> str:
    q = wf.get("queues", {})
    branch_state = load_state_json("branch_state.json", {})
    scheduler_state = load_state_json("branch_scheduler.json", {})
    freshness = build_branch_freshness_snapshot(branch_state, scheduler_state)
    stale_branches = stale_branch_names(freshness)
    host_watchdog = load_state_json("host_watchdog_state.json", {})
    lines = []
    lines.append("Lobster Orchestrator Status")
    lines.append(f"current_mode: {wf.get('current_mode','')}")
    lines.append(f"last_action: {wf.get('last_action','')}")
    lines.append(f"last_action_at: {wf.get('last_action_at','')}")
    lines.append(f"finance_cleanup_queue: {len(q.get('finance_cleanup_queue', []))}")
    lines.append(f"audit_cleanup_queue: {len(q.get('audit_cleanup_queue', []))}")
    lines.append(f"stats_math_queue: {len(q.get('stats_math_queue', []))}")
    lines.append(f"general_cleanup_queue: {len(q.get('general_cleanup_queue', []))}")
    lines.append(f"maintenance_queue: {len(q.get('maintenance_queue', []))}")
    lines.append(f"autonomous_topic_expansion: {'enabled' if autonomous_topic_expansion_enabled(wf) else 'disabled'}")
    lines.append(f"done_recent: {len(wf.get('done_recent', []))}")
    lines.append(f"failed_recently: {len(wf.get('failed_recently', []))}")

    preflight = (wf.get("last_results", {}) or {}).get("preflight", {}) or {}
    if preflight:
        lines.append("preflight_gate:")
        lines.append(f"- action: {preflight.get('action', '')}")
        lines.append(f"- at: {preflight.get('at', '')}")
        lines.append(f"- ok: {preflight.get('ok', False)}")
        lines.append(
            f"- failures: {', '.join(preflight.get('failures', [])) or 'none'}"
        )
        for name, row in sorted((preflight.get("checks", {}) or {}).items()):
            lines.append(f"- {name}: code={row.get('code', '')}")
        alert = preflight.get("alert", {}) or {}
        if alert:
            lines.append(f"- alert_code: {alert.get('code', '')}")
        codex = preflight.get("codex_escalation", {}) or {}
        if codex:
            lines.append(f"- codex_packet: {codex.get('packet_path', '')}")
            lines.append(f"- codex_triggered: {((codex.get('trigger', {}) or {}).get('triggered', False))}")
    watchdog = (wf.get("last_results", {}) or {}).get("watchdog", {}) or {}
    if watchdog:
        lines.append("watchdog:")
        lines.append(f"- at: {watchdog.get('at', '')}")
        lines.append(f"- ok: {watchdog.get('ok', False)}")
        lines.append(f"- recovered: {', '.join(watchdog.get('recovered', [])) or 'none'}")
        lines.append(f"- failed: {', '.join(watchdog.get('failed', [])) or 'none'}")
    codex_items = collect_workflow_codex_escalations(wf)
    codex_state = load_codex_escalation_state()
    if codex_items:
        latest = codex_items[-1]
        trigger = latest.get("trigger", {}) or {}
        lines.append("codex_escalation:")
        lines.append(f"- issue_key: {latest.get('issue_key', '')}")
        lines.append(f"- packet_path: {latest.get('packet_path', '')}")
        lines.append(f"- triggered: {trigger.get('triggered', False)}")
        lines.append(f"- trigger_code: {trigger.get('code', '')}")
    if codex_state:
        lines.append("codex_channel:")
        lines.append(f"- availability: {codex_state.get('availability', 'unknown')}")
        if codex_state.get("cooldown_until"):
            lines.append(f"- cooldown_until: {codex_state.get('cooldown_until', '')}")
    if host_watchdog:
        lines.append("host_watchdog:")
        lines.append(f"- ok: {host_watchdog.get('ok', False)}")
        lines.append(f"- issue_key: {host_watchdog.get('issue_key', '') or 'none'}")
        lines.append(f"- scheduler_disabled: {host_watchdog.get('scheduler_disabled', False)}")
        heartbeat = host_watchdog.get("scheduler_heartbeat", {}) or {}
        if heartbeat:
            lines.append(f"- scheduler_heartbeat_status: {heartbeat.get('status', 'unknown')}")
            lines.append(f"- scheduler_heartbeat_last_success_at: {heartbeat.get('last_success_at', '') or 'none'}")
            lines.append(f"- scheduler_heartbeat_last_exit_code: {heartbeat.get('last_exit_code', 'n/a')}")
    lines.append(f"stale_branches: {', '.join(stale_branches) or 'none'}")

    provider_fail_counts = {}
    budget = load_state_json("provider_budget.json", {"providers": {}})
    if budget:
        try:
            for name, row in budget.get("providers", {}).items():
                provider_fail_counts[name] = len(row.get("recent_failures", []))
        except Exception:
            pass

    if provider_fail_counts:
        lines.append("provider_recent_failures:")
        for name in sorted(provider_fail_counts):
            lines.append(f"- {name}: {provider_fail_counts[name]}")

    lines.append("provider_routing:")
    lines.extend(routing_text(wf))

    lines.append("execution_binding:")
    for job_name, row in sorted(wf.get("execution_binding", {}).items()):
        mode = "fallback" if row.get("fallback_used") else "primary"
        lines.append(f"- {job_name}: {row.get('selected')} ({mode}, primary={row.get('primary')})")

    lines.append("unified_risk_gate:")
    urg = wf.get("unified_risk_gate", {})
    lines.append(f"- source_branch: {urg.get('source_branch', '')}")
    lines.append(f"- risk_audit_path: {urg.get('risk_audit_path', '')}")
    lines.append(f"- top_decision: {urg.get('top_decision', 'n/a')}")
    lines.append(f"- approved_assets: {', '.join(urg.get('approved_assets', [])) or 'none'}")
    lines.append(f"- vetoed_assets: {', '.join(urg.get('vetoed_assets', [])) or 'none'}")
    lines.append(f"- blackout_status: {', '.join(urg.get('blackout_status', [])) or 'none'}")
    lines.append(f"- updated_at: {urg.get('updated_at', '')}")

    lines.append("branch_supervisor:")
    bs = wf.get("branch_supervisor", {})
    if bs.get("stdout"):
        lines.extend(bs["stdout"].splitlines())

    lines.append("branch_scheduler:")
    sch = wf.get("branch_scheduler", {})
    if sch.get("stdout"):
        lines.extend(sch["stdout"].splitlines())

    lines.append("technical_daily:")
    try:
        td = load_branch_runtime_state(
            "technical_daily_branch",
            ROOT / "branches/technical_daily/technical_daily_state.json",
        )
        if td:
            lines.append(f"- status: {td.get('last_status', td.get('status', ''))}")
            lines.append(f"- mode: {td.get('last_mode', td.get('mode', ''))}")
            lines.append(f"- last_run_at: {td.get('last_run_at', '')}")
            lines.append(f"- freshness: {summarize_freshness(freshness.get('technical_daily_branch', {}))}")
            lines.append(f"- summary: {td.get('last_summary', td.get('summary', ''))}")
            lines.append(f"- report_path: {td.get('last_report_path', td.get('report_path', ''))}")
            lines.append(f"- sources_path: {td.get('last_sources_path', td.get('sources_path', ''))}")
            providers = td.get("provider_used") or td.get("providers") or {}
            if providers:
                lines.append("- providers:")
                for k in ["retrieval", "analysis", "synthesis"]:
                    if k in providers:
                        lines.append(f"  - {k}: {providers[k]}")
        else:
            lines.append("- missing state")
    except Exception as exc:
        lines.append(f"- read_error: {exc}")

    lines.append("fundamental_research:")
    try:
        fr = load_branch_runtime_state(
            "fundamental_research_branch",
            ROOT / "branches/fundamental_research/fundamental_research_state.json",
        )
        if fr:
            lines.append(f"- status: {fr.get('last_status', fr.get('status', ''))}")
            lines.append(f"- mode: {fr.get('last_mode', fr.get('mode', ''))}")
            lines.append(f"- last_run_at: {fr.get('last_run_at', '')}")
            lines.append(f"- freshness: {summarize_freshness(freshness.get('fundamental_research_branch', {}))}")
            lines.append(f"- summary: {fr.get('last_summary', fr.get('summary', ''))}")
            lines.append(f"- report_path: {fr.get('last_report_path', fr.get('report_path', ''))}")
            lines.append(f"- sources_path: {fr.get('last_sources_path', fr.get('sources_path', ''))}")
            lines.append(f"- risk_handoff_path: {fr.get('last_risk_handoff_path', fr.get('risk_handoff_path', ''))}")
            lines.append(f"- risk_audit_path: {fr.get('last_risk_audit_path', fr.get('risk_audit_path', ''))}")
            risk_audit_rel = fr.get("last_risk_audit_path", fr.get("risk_audit_path", ""))
            if risk_audit_rel:
                risk_audit = load_json(ROOT / risk_audit_rel, {})
                if risk_audit:
                    lines.append(
                        f"- risk_top_decision: {risk_audit.get('top_decision', 'n/a')}"
                    )
                    lines.append(
                        f"- risk_approved: {', '.join(risk_audit.get('approved_for_upstream_risk', [])) or 'none'}"
                    )
                    lines.append(
                        f"- risk_blackout: {', '.join(risk_audit.get('blocked_by_blackout', [])) or 'none'}"
                    )
                    lines.append(
                        f"- risk_vetoed: {', '.join(risk_audit.get('blocked_by_fundamental_veto', [])) or 'none'}"
                    )
            providers = fr.get("provider_used") or fr.get("providers") or {}
            if providers:
                lines.append("- providers:")
                for k in ["retrieval", "analysis", "synthesis"]:
                    if k in providers:
                        lines.append(f"  - {k}: {providers[k]}")
        else:
            lines.append("- missing state")
    except Exception as exc:
        lines.append(f"- read_error: {exc}")


    lines.append("knowledge_maintenance:")
    try:
        bs_all = load_state_json("branch_state.json", {})
        km = bs_all.get("knowledge_maintenance_branch", {})
        if km:
            lines.append(f"- status: {km.get('last_status', km.get('status', 'unknown'))}")
            lines.append(f"- mode: {km.get('last_mode', km.get('mode', 'unknown'))}")
            lines.append(f"- last_run_at: {km.get('last_run_at', '')}")
            lines.append(f"- freshness: {summarize_freshness(freshness.get('knowledge_maintenance_branch', {}))}")
            lines.append(f"- summary: {km.get('last_summary', km.get('summary', ''))}")
            lines.append(f"- report_path: {km.get('last_report_path', km.get('report_path', ''))}")
            lines.append(f"- sources_path: {km.get('last_sources_path', km.get('sources_path', ''))}")
            providers = km.get("provider_used") or km.get("providers") or {}
            if providers:
                lines.append("- providers:")
                for k in ["retrieval", "analysis", "synthesis"]:
                    if k in providers:
                        lines.append(f"  - {k}: {providers[k]}")
        else:
            lines.append("- missing state")
    except Exception as exc:
        lines.append(f"- read_error: {exc}")

    lines.append("control_panel:")
    try:
        panel = load_control_panel_state({})
        lines.append(f"System stage: {panel.get('system_stage', '')}")
        lines.append(f"Control panel status: {panel.get('control_panel_status', '')}")
        lines.append(f"Current phase: {panel.get('current_phase', '')}")
        lines.append(f"Next phase: {panel.get('next_phase', '')}")
    except Exception:
        pass

    return "\n".join(lines)

def main():
    load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["status", "nightly", "refresh", "clean", "report", "maintenance", "cycle", "watchdog", "technical_daily", "fundamental_research", "knowledge_maintenance"])
    args = ap.parse_args()

    wf = load_json(WF, {
        "generated_at": "",
        "current_mode": "idle",
        "last_action": "",
        "last_action_at": "",
        "queues": {
            "new_learning_queue": [],
            "finance_cleanup_queue": [],
            "audit_cleanup_queue": [],
            "stats_math_queue": [],
            "general_cleanup_queue": [],
            "maintenance_queue": []
        },
        "pending": [],
        "in_progress": [],
        "done_recent": [],
        "failed_recently": [],
        "retry_after": {},
        "last_results": {
            "preflight": {},
            "watchdog": {},
            "nightly_learning": {},
            "flagged_refresh": {},
            "force_clean": {},
            "report": {},
            "maintenance": {}
        },
        "policy": {
            "max_refresh_batch": 8,
            "max_force_clean_batch": 4,
            "max_failed_recently": 20,
            "retry_backoff_minutes": 30,
            "allow_autonomous_topic_expansion": False
        }
    })

    build_queues(wf)
    refresh_provider_routing(wf)
    refresh_execution_binding(wf)
    refresh_branch_state(wf)
    refresh_unified_risk_gate(wf)
    refresh_branch_scheduler(wf)

    if args.action == "status":
        mark_provider_fallbacks(wf)
        print(summary_text(wf))
        save_json(WF, wf)
        return 0

    if requires_preflight(args.action):
        gate = run_preflight_gate(wf, args.action)
        if not gate.get("ok"):
            gate["alert"] = alert_preflight_block(args.action, gate)
            gate["codex_escalation"] = record_codex_escalation(
                category="preflight_block",
                issue_key=f"preflight-{args.action}",
                source="lobster_orchestrator",
                summary=f"Preflight blocked orchestrator action: {args.action}",
                details={
                    "action": args.action,
                    "failures": gate.get("failures", []),
                    "checks": gate.get("checks", {}),
                },
            )
            update_status(wf, "blocked", "preflight_blocked")
            reason = ", ".join(gate.get("failures", [])) or "unknown"
            mark_failed(wf, "preflight", reason=reason)
            refresh_branch_state(wf)
            refresh_unified_risk_gate(wf)
            refresh_branch_scheduler(wf)
            mark_provider_fallbacks(wf)
            save_json(WF, wf)
            print(summary_text(wf))
            return 1

    if args.action in {"technical_daily", "fundamental_research", "knowledge_maintenance"}:
        branch_issue_keys = {
            "technical_daily": "branch-technical-daily",
            "fundamental_research": "branch-fundamental-research",
            "knowledge_maintenance": "branch-knowledge-maintenance",
        }
        branch_entry_map = {
            "technical_daily": ROOT / "scripts" / "run_technical_daily_entry.py",
            "fundamental_research": ROOT / "scripts" / "run_fundamental_research_entry.py",
            "knowledge_maintenance": ROOT / "scripts" / "run_knowledge_maintenance_entry.py",
        }
        target = branch_entry_map[args.action]
        res = run_cmd(["python3", str(target)], timeout=7200)
        wf.setdefault("last_results", {})
        wf["last_results"][args.action] = {
            "at": now_iso(),
            "code": res.get("code", 1),
            "stdout": res.get("stdout", ""),
            "stderr": res.get("stderr", "")
        }
        if res.get("code", 1) != 0:
            attach_codex_escalation(
                wf["last_results"][args.action],
                category="branch_run_failure",
                issue_key=branch_issue_keys[args.action],
                summary=f"Live branch run failed: {args.action}",
                details={"action": args.action, "entry": str(target.relative_to(ROOT)), "result": res},
            )
        wf["last_action"] = args.action
        wf["last_action_at"] = now_iso()
        refresh_branch_state(wf)
        refresh_unified_risk_gate(wf)
        refresh_branch_scheduler(wf)
        mark_provider_fallbacks(wf)
        save_json(WF, wf)
        print(summary_text(wf))
        return 0

    if args.action == "watchdog":
        update_status(wf, "watchdog", "run_stale_branch_watchdog")
        watchdog = run_stale_branch_watchdog(wf)
        mark_provider_fallbacks(wf)
        save_json(WF, wf)
        print(summary_text(wf))
        return 0 if watchdog.get("ok") else 1

    if args.action == "nightly":
        do_nightly(wf)
    elif args.action == "refresh":
        do_refresh(wf)
    elif args.action == "clean":
        do_force_clean(wf)
    elif args.action == "report":
        do_report(wf)
    elif args.action == "maintenance":
        do_maintenance(wf)
    elif args.action == "cycle":
        update_status(wf, "watchdog", "run_stale_branch_watchdog")
        watchdog = run_stale_branch_watchdog(wf)
        if not watchdog.get("ok"):
            mark_provider_fallbacks(wf)
            save_json(WF, wf)
            print(summary_text(wf))
            return 1
        do_nightly(wf)
        if autonomous_topic_expansion_enabled(wf):
            build_queues(wf)
            do_refresh(wf)
            build_queues(wf)
            do_force_clean(wf)
        else:
            mark_autonomous_expansion_skipped(wf, "flagged_refresh")
            mark_autonomous_expansion_skipped(wf, "force_clean")
        do_report(wf)

    mark_provider_fallbacks(wf)
    save_json(WF, wf)
    print(summary_text(wf))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
