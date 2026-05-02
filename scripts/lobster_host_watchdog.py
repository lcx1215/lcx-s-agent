#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen

try:
    from scripts.branch_freshness import build_branch_freshness_snapshot, parse_iso
    from scripts.lobster_paths import ROOT, STATE_DIR, load_state_json, save_state_json
except ModuleNotFoundError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from branch_freshness import build_branch_freshness_snapshot, parse_iso
    from lobster_paths import ROOT, STATE_DIR, load_state_json, save_state_json

SCHEDULER_LABEL = "ai.openclaw.lobster.scheduler"
SCHEDULER_HEARTBEAT_STALE_AFTER_HOURS = 36.0
SCHEDULER_HEARTBEAT_STUCK_AFTER_HOURS = 6.0
SCHEDULER_CYCLE_STALE_AFTER_HOURS = 36.0
REQUIRED_CYCLE_CHECK_COUNT = 5
FEISHU_PROXY_LABEL = "ai.openclaw.feishu.proxy"
FEISHU_PROXY_ERR_LOG = Path.home() / ".openclaw" / "logs" / "feishu_proxy.err.log"
ENABLE_ALERTS_ENV = "OPENCLAW_HOST_WATCHDOG_ENABLE_ALERTS"
RUNTIME_FRESHNESS_STALE_AFTER_HOURS = 36.0


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def run_text(cmd: list[str], timeout: int = 120) -> dict[str, Any]:
    result = subprocess.run(
        cmd,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=timeout,
        env=os.environ.copy(),
    )
    return {
        "code": result.returncode,
        "stdout": result.stdout or "",
        "stderr": result.stderr or "",
    }


def parse_launchd_disabled_output(text: str) -> dict[str, bool]:
    found: dict[str, bool] = {}
    for raw in (text or "").splitlines():
        match = re.search(r'"([^"]+)"\s*=>\s*(disabled|enabled)', raw)
        if not match:
            continue
        found[match.group(1)] = match.group(2) == "disabled"
    return found


def detect_scheduler_disabled(skip_launchd: bool = False) -> dict[str, Any]:
    if skip_launchd:
        return {
            "checked_at": now_iso(),
            "known": False,
            "disabled": False,
            "code": None,
            "stderr": "",
            "skipped": True,
        }
    result = run_text(["launchctl", "print-disabled", f"gui/{os.getuid()}"])
    labels = parse_launchd_disabled_output(result.get("stdout", ""))
    disabled = labels.get(SCHEDULER_LABEL)
    return {
        "checked_at": now_iso(),
        "known": disabled is not None,
        "disabled": bool(disabled) if disabled is not None else False,
        "code": result.get("code"),
        "stderr": (result.get("stderr", "") or "")[:1000],
        "skipped": False,
    }


def inspect_launchagent(label: str, skip_launchd: bool = False) -> dict[str, Any]:
    if skip_launchd:
        return {
            "checked_at": now_iso(),
            "known": False,
            "running": False,
            "program_arguments": [],
            "working_directory": "",
            "code": None,
            "stderr": "",
            "skipped": True,
        }
    result = run_text(["launchctl", "print", f"gui/{os.getuid()}/{label}"])
    stdout = result.get("stdout", "") or ""
    args: list[str] = []
    in_arguments = False
    for raw in stdout.splitlines():
        line = raw.strip()
        if line == "arguments = {":
            in_arguments = True
            continue
        if in_arguments and line == "}":
            in_arguments = False
            continue
        if in_arguments and line:
            args.append(line)
    working_directory = ""
    match = re.search(r"working directory = (.+)", stdout)
    if match:
        working_directory = match.group(1).strip()
    return {
        "checked_at": now_iso(),
        "known": result.get("code") == 0,
        "running": "state = running" in stdout or "job state = running" in stdout,
        "program_arguments": args,
        "working_directory": working_directory,
        "code": result.get("code"),
        "stderr": (result.get("stderr", "") or "")[:1000],
        "skipped": False,
    }


def read_tail(path: Path, limit: int = 6000) -> str:
    try:
        data = path.read_bytes()
    except Exception:
        return ""
    return data[-limit:].decode("utf-8", errors="ignore")


def probe_feishu_proxy_health(timeout_seconds: float = 3.0) -> dict[str, Any]:
    try:
        with urlopen("http://127.0.0.1:3011/healthz", timeout=timeout_seconds) as response:
            raw = response.read(4000).decode("utf-8", errors="ignore")
    except (OSError, TimeoutError, URLError) as exc:
        return {"ok": False, "error": str(exc)[:500]}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {"ok": False, "error": "invalid_json", "body": raw[:500]}
    if not isinstance(payload, dict):
        return {"ok": False, "error": "invalid_payload"}
    return payload


def build_feishu_proxy_snapshot(skip_launchd: bool = False) -> dict[str, Any]:
    launchd = inspect_launchagent(FEISHU_PROXY_LABEL, skip_launchd=skip_launchd)
    err_tail = read_tail(FEISHU_PROXY_ERR_LOG)
    desktop_root = "/Users/liuchengxu/Desktop/openclaw"
    runtime_root = "/Users/liuchengxu/.openclaw/live-sidecars/lcx-s-openclaw"
    args_text = "\n".join(str(item) for item in launchd.get("program_arguments", []))
    working_directory = str(launchd.get("working_directory") or "")
    points_at_desktop = desktop_root in args_text or working_directory == desktop_root
    points_at_runtime = runtime_root in args_text or working_directory == runtime_root
    error_markers = [
        marker
        for marker in [
            "Operation not permitted",
            "Address already in use",
            "cannot access parent directories",
        ]
        if marker in err_tail
    ]
    health = probe_feishu_proxy_health() if not skip_launchd else {"ok": None, "skipped": True}
    health_ok = health.get("ok") is True and health.get("port") == 3011
    stale_error_markers = (
        error_markers if health_ok and launchd.get("running") and points_at_runtime else []
    )
    status = "ok"
    if not launchd.get("known") and not skip_launchd:
        status = "unknown"
    elif not launchd.get("running") and not skip_launchd:
        status = "not_running"
    elif error_markers and not stale_error_markers:
        status = "log_errors"
    elif points_at_desktop:
        status = "root_drift"
    return {
        "status": status,
        "label": FEISHU_PROXY_LABEL,
        "launchd": launchd,
        "points_at_desktop": points_at_desktop,
        "points_at_runtime": points_at_runtime,
        "error_markers": error_markers,
        "stale_error_markers": stale_error_markers,
        "health": health,
        "err_log_path": str(FEISHU_PROXY_ERR_LOG),
        "err_tail_sample": err_tail[-1000:] if error_markers and not stale_error_markers else "",
    }


def build_scheduler_heartbeat_snapshot(
    heartbeat_state: dict[str, Any],
    now: datetime | None = None,
) -> dict[str, Any]:
    current = now or datetime.now(timezone.utc)
    raw_status = str(heartbeat_state.get("status") or "").strip()
    started_at = str(heartbeat_state.get("last_started_at") or "").strip()
    finished_at = str(heartbeat_state.get("last_finished_at") or "").strip()
    success_at = str(heartbeat_state.get("last_success_at") or "").strip()
    started_dt = parse_iso(started_at)
    success_dt = parse_iso(success_at)
    lag_hours: float | None = None

    if raw_status == "running":
        if started_dt is None:
            status = "invalid"
        else:
            lag_hours = max((current - started_dt).total_seconds() / 3600.0, 0.0)
            status = "stuck_running" if lag_hours > SCHEDULER_HEARTBEAT_STUCK_AFTER_HOURS else "running"
    elif not any([raw_status, started_at, finished_at, success_at]):
        status = "never_run"
    elif success_at and success_dt is None:
        status = "invalid"
    elif success_dt is None:
        status = "never_run"
    else:
        lag_hours = max((current - success_dt).total_seconds() / 3600.0, 0.0)
        status = "stale" if lag_hours > SCHEDULER_HEARTBEAT_STALE_AFTER_HOURS else "fresh"

    return {
        "status": status,
        "raw_status": raw_status or "unknown",
        "last_started_at": started_at,
        "last_finished_at": finished_at,
        "last_success_at": success_at,
        "last_exit_code": heartbeat_state.get("last_exit_code"),
        "pid": heartbeat_state.get("pid"),
        "lag_hours": lag_hours,
        "stale_after_hours": SCHEDULER_HEARTBEAT_STALE_AFTER_HOURS,
        "stuck_after_hours": SCHEDULER_HEARTBEAT_STUCK_AFTER_HOURS,
    }


def build_scheduler_cycle_snapshot(
    cycle_report: dict[str, Any],
    cycle_failure: dict[str, Any],
    now: datetime | None = None,
) -> dict[str, Any]:
    current = now or datetime.now(timezone.utc)
    source = "failure" if cycle_failure else "report"
    report = cycle_failure or cycle_report
    if not report:
        return {
            "status": "never_run",
            "source": "none",
            "generated_at": "",
            "lag_hours": None,
            "stale_after_hours": SCHEDULER_CYCLE_STALE_AFTER_HOURS,
            "check_count": 0,
            "failed_checks": [],
            "boundary_ok": False,
        }

    generated_at = str(report.get("generatedAt") or "").strip()
    generated_dt = parse_iso(generated_at)
    lag_hours: float | None = None
    if generated_dt is None:
        stale = True
        status = "invalid"
    else:
        lag_hours = max((current - generated_dt).total_seconds() / 3600.0, 0.0)
        stale = lag_hours > SCHEDULER_CYCLE_STALE_AFTER_HOURS
        status = "stale" if stale else "fresh"

    cycle_result = report.get("cycleResult") if isinstance(report.get("cycleResult"), dict) else {}
    checks = cycle_result.get("checks") if isinstance(cycle_result, dict) else []
    checks_list = checks if isinstance(checks, list) else []
    failed_checks = [
        str(item.get("name") or "unknown")
        for item in checks_list
        if isinstance(item, dict) and item.get("ok") is not True
    ]
    boundary_ok = (
        report.get("status") == "cycle_completed"
        and cycle_result.get("liveTouched") is False
        and cycle_result.get("providerConfigTouched") is False
        and cycle_result.get("protectedMemoryTouched") is False
        and cycle_result.get("remoteFetchOccurred") is False
        and cycle_result.get("executionAuthorityGranted") is False
    )
    check_count = int(cycle_result.get("checkCount") or len(checks_list) or 0)
    if source == "failure" or report.get("status") != "cycle_completed":
        status = "failed"
    elif not boundary_ok:
        status = "boundary_violation"
    elif failed_checks:
        status = "failed_checks"
    elif check_count < REQUIRED_CYCLE_CHECK_COUNT:
        status = "incomplete"

    return {
        "status": status,
        "source": source,
        "generated_at": generated_at,
        "lag_hours": lag_hours,
        "stale_after_hours": SCHEDULER_CYCLE_STALE_AFTER_HOURS,
        "check_count": check_count,
        "required_check_count": REQUIRED_CYCLE_CHECK_COUNT,
        "failed_checks": failed_checks,
        "boundary_ok": boundary_ok,
        "summary": cycle_result.get("summary") if isinstance(cycle_result, dict) else None,
    }


def build_runtime_freshness_snapshot(
    runtime_state: dict[str, Any],
    now: datetime | None = None,
) -> dict[str, Any]:
    current = now or datetime.now(timezone.utc)
    if not runtime_state:
        return {
            "status": "missing",
            "generated_at": "",
            "lag_hours": None,
            "stale_after_hours": RUNTIME_FRESHNESS_STALE_AFTER_HOURS,
            "source_root": "",
            "target_root": "",
            "checked_file_count": 0,
            "missing_count": 0,
            "mismatch_count": 0,
            "sample_missing": [],
            "sample_mismatched": [],
        }

    generated_at = str(runtime_state.get("generatedAt") or "").strip()
    generated_dt = parse_iso(generated_at)
    raw_status = str(runtime_state.get("status") or "").strip() or "unknown"
    lag_hours: float | None = None
    if generated_dt is None:
        status = "invalid"
    else:
        lag_hours = max((current - generated_dt).total_seconds() / 3600.0, 0.0)
        if lag_hours > RUNTIME_FRESHNESS_STALE_AFTER_HOURS:
            status = "stale_receipt"
        else:
            status = raw_status

    return {
        "status": status,
        "raw_status": raw_status,
        "generated_at": generated_at,
        "lag_hours": lag_hours,
        "stale_after_hours": RUNTIME_FRESHNESS_STALE_AFTER_HOURS,
        "source_root": runtime_state.get("sourceRoot") or "",
        "target_root": runtime_state.get("targetRoot") or "",
        "checked_file_count": runtime_state.get("checkedFileCount") or 0,
        "missing_count": runtime_state.get("missingCount") or 0,
        "mismatch_count": runtime_state.get("mismatchCount") or 0,
        "sample_missing": runtime_state.get("sampleMissing") or [],
        "sample_mismatched": runtime_state.get("sampleMismatched") or [],
    }


def build_watchdog_snapshot(
    *,
    branch_state: dict[str, Any],
    scheduler_state: dict[str, Any],
    heartbeat_state: dict[str, Any],
    cycle_report_state: dict[str, Any],
    cycle_failure_state: dict[str, Any],
    runtime_freshness_state: dict[str, Any],
    launchd_state: dict[str, Any],
    feishu_proxy_state: dict[str, Any],
    mode: str,
) -> dict[str, Any]:
    freshness = build_branch_freshness_snapshot(branch_state, scheduler_state)
    heartbeat = build_scheduler_heartbeat_snapshot(heartbeat_state)
    cycle = build_scheduler_cycle_snapshot(cycle_report_state, cycle_failure_state)
    runtime_freshness = build_runtime_freshness_snapshot(runtime_freshness_state)
    nonfresh = [
        {"branch": branch_name, "status": str(row.get("status") or "")}
        for branch_name, row in freshness.items()
        if str(row.get("status") or "") in {"stale", "never_run", "invalid_timestamp"}
    ]

    issues: list[str] = []
    if launchd_state.get("disabled"):
        issues.append("scheduler_disabled")

    heartbeat_status = str(heartbeat.get("status") or "")
    heartbeat_issue = heartbeat_status in {"stale", "invalid", "stuck_running"}
    if heartbeat_status == "never_run":
        heartbeat_issue = bool(launchd_state.get("disabled")) or bool(nonfresh)
    if heartbeat_issue:
        issues.append("scheduler_heartbeat")
    if str(cycle.get("status") or "") in {
        "never_run",
        "invalid",
        "stale",
        "failed",
        "boundary_violation",
        "failed_checks",
        "incomplete",
    }:
        issues.append("scheduler_cycle")
    if str(feishu_proxy_state.get("status") or "") in {"unknown", "not_running", "log_errors"}:
        issues.append("feishu_proxy")
    if nonfresh:
        issues.append("branch_freshness")
    if str(runtime_freshness.get("status") or "") != "fresh":
        issues.append("runtime_freshness")

    return {
        "schemaVersion": 1,
        "checked_at": now_iso(),
        "mode": mode,
        "ok": not issues,
        "issues": issues,
        "issue_key": "|".join(issues),
        "scheduler_disabled": bool(launchd_state.get("disabled", False)),
        "launchd": launchd_state,
        "scheduler_heartbeat": heartbeat,
        "scheduler_cycle": cycle,
        "feishu_proxy": feishu_proxy_state,
        "runtime_freshness": runtime_freshness,
        "branch_freshness": freshness,
        "nonfresh_branches": nonfresh,
        "boundary": {
            "noFeishuLarkSend": True,
            "noCodexEscalation": True,
            "noRemoteFetch": True,
            "noTradingExecution": True,
        },
    }


def load_snapshot_inputs() -> tuple[
    dict[str, Any],
    dict[str, Any],
    dict[str, Any],
    dict[str, Any],
    dict[str, Any],
    dict[str, Any],
]:
    return (
        load_state_json("branch_state.json", {}),
        load_state_json("branch_scheduler.json", {}),
        load_state_json("scheduler_heartbeat.json", {}),
        load_state_json("scheduler_cycle_report.json", {}),
        load_state_json("scheduler_cycle_failure.json", {}),
        load_state_json("runtime_freshness.json", {}),
    )


def write_receipt(snapshot: dict[str, Any]) -> Path:
    payload = dict(snapshot)
    payload["receipt_written_at"] = now_iso()
    return save_state_json("host_watchdog_state.json", payload)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Clean-root OpenClaw host watchdog compatibility check")
    parser.add_argument("--json", action="store_true", help="Emit the full JSON snapshot")
    parser.add_argument("--dry-run", action="store_true", help="Force no-alert compatibility mode")
    parser.add_argument("--skip-launchd", action="store_true", help="Skip launchctl read during tests")
    parser.add_argument("--skip-feishu-proxy", action="store_true", help="Skip Feishu/Lark proxy inspection")
    parser.add_argument("--write-receipt", action="store_true", help="Write host_watchdog_state.json")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    (
        branch_state,
        scheduler_state,
        heartbeat_state,
        cycle_report_state,
        cycle_failure_state,
        runtime_freshness_state,
    ) = load_snapshot_inputs()
    alerts_enabled = truthy(os.environ.get(ENABLE_ALERTS_ENV)) and not args.dry_run
    mode = "live_guarded" if alerts_enabled else "dry_run_no_alert"
    launchd_state = detect_scheduler_disabled(skip_launchd=args.skip_launchd)
    feishu_proxy_state = build_feishu_proxy_snapshot(
        skip_launchd=args.skip_launchd or args.skip_feishu_proxy
    )
    snapshot = build_watchdog_snapshot(
        branch_state=branch_state,
        scheduler_state=scheduler_state,
        heartbeat_state=heartbeat_state,
        cycle_report_state=cycle_report_state,
        cycle_failure_state=cycle_failure_state,
        runtime_freshness_state=runtime_freshness_state,
        launchd_state=launchd_state,
        feishu_proxy_state=feishu_proxy_state,
        mode=mode,
    )

    if args.write_receipt:
        snapshot["receipt_path"] = str(write_receipt(snapshot).relative_to(ROOT))
    if args.json:
        print(json.dumps(snapshot, ensure_ascii=False, indent=2))
    else:
        print(f"hostWatchdog={ 'ok' if snapshot['ok'] else 'issues_detected' }")
        print(f"mode={snapshot['mode']}")
        print(f"issues={','.join(snapshot['issues']) or 'none'}")
        print(f"noFeishuLarkSend={snapshot['boundary']['noFeishuLarkSend']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
