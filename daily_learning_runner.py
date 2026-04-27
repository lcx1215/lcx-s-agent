#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
SCRIPTS_DIR = ROOT / "scripts"
for entry in (str(SCRIPTS_DIR), str(ROOT)):
    if entry not in sys.path:
        sys.path.insert(0, entry)

from lobster_paths import STATE_DIR, save_state_json

ENV_FILE = ROOT / ".env.lobster"
SCHEDULER_HEARTBEAT_PATH = STATE_DIR / "scheduler_heartbeat.json"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_env() -> None:
    if not ENV_FILE.exists():
        return
    for raw in ENV_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def load_scheduler_heartbeat() -> dict[str, Any]:
    if not SCHEDULER_HEARTBEAT_PATH.exists():
        return {}
    try:
        return json.loads(SCHEDULER_HEARTBEAT_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_scheduler_heartbeat(payload: dict[str, Any]) -> None:
    save_state_json(SCHEDULER_HEARTBEAT_PATH.name, payload)


def heartbeat_running(mode: str) -> dict[str, Any]:
    payload = dict(load_scheduler_heartbeat())
    payload.update(
        {
            "status": "running",
            "mode": mode,
            "last_started_at": utc_now_iso(),
            "pid": os.getpid(),
            "runner": "daily_learning_runner.py",
            "last_exit_code": None,
        }
    )
    write_scheduler_heartbeat(payload)
    return payload


def heartbeat_finished(exit_code: int, started: dict[str, Any], status: str) -> None:
    payload = dict(load_scheduler_heartbeat())
    payload.update(started)
    payload["last_finished_at"] = utc_now_iso()
    payload["last_exit_code"] = int(exit_code)
    payload["status"] = status
    if exit_code == 0:
        payload["last_success_at"] = payload["last_finished_at"]
    write_scheduler_heartbeat(payload)


def run_orchestrator(args: list[str]) -> int:
    result = subprocess.run(
        ["python3", str(ROOT / "lobster_orchestrator.py"), *args],
        cwd=str(ROOT),
        env=os.environ.copy(),
        text=True,
    )
    return int(result.returncode)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Clean-root daily OpenClaw learning scheduler runner")
    parser.add_argument("--dry-run", action="store_true", help="Run scheduler smoke without live side effects")
    parser.add_argument(
        "--write-receipt",
        action="store_true",
        help="Write scheduler heartbeat/smoke receipts under branches/_system",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    load_env()
    mode = "dry_run" if args.dry_run else "live_guarded"
    started = heartbeat_running(mode) if args.write_receipt else {}
    try:
        command = ["cycle", "--dry-run"] if args.dry_run else ["cycle"]
        if args.write_receipt:
            command.append("--write-receipt")
        exit_code = run_orchestrator(command)
    except Exception:
        if args.write_receipt:
            heartbeat_finished(1, started, "failed")
        raise
    if args.write_receipt:
        status = "success" if exit_code == 0 else "failed"
        heartbeat_finished(exit_code, started, status)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
