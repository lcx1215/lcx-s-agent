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
ENABLE_ALERTS_ENV = "OPENCLAW_HOST_WATCHDOG_ENABLE_ALERTS"


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


def build_watchdog_snapshot(
    *,
    branch_state: dict[str, Any],
    scheduler_state: dict[str, Any],
    heartbeat_state: dict[str, Any],
    launchd_state: dict[str, Any],
    mode: str,
) -> dict[str, Any]:
    freshness = build_branch_freshness_snapshot(branch_state, scheduler_state)
    heartbeat = build_scheduler_heartbeat_snapshot(heartbeat_state)
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
    if nonfresh:
        issues.append("branch_freshness")

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
        "branch_freshness": freshness,
        "nonfresh_branches": nonfresh,
        "boundary": {
            "noFeishuLarkSend": True,
            "noCodexEscalation": True,
            "noRemoteFetch": True,
            "noTradingExecution": True,
        },
    }


def load_snapshot_inputs() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    return (
        load_state_json("branch_state.json", {}),
        load_state_json("branch_scheduler.json", {}),
        load_state_json("scheduler_heartbeat.json", {}),
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
    parser.add_argument("--write-receipt", action="store_true", help="Write host_watchdog_state.json")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    branch_state, scheduler_state, heartbeat_state = load_snapshot_inputs()
    alerts_enabled = truthy(os.environ.get(ENABLE_ALERTS_ENV)) and not args.dry_run
    mode = "live_guarded" if alerts_enabled else "dry_run_no_alert"
    launchd_state = detect_scheduler_disabled(skip_launchd=args.skip_launchd)
    snapshot = build_watchdog_snapshot(
        branch_state=branch_state,
        scheduler_state=scheduler_state,
        heartbeat_state=heartbeat_state,
        launchd_state=launchd_state,
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
