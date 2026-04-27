#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import datetime, timezone
from typing import Any

from scripts.lobster_paths import ROOT, load_state_json, save_state_json

ENABLE_CYCLE_ENV = "OPENCLAW_SCHEDULER_ENABLE_CYCLE"
CYCLE_COMMAND_ENV = "OPENCLAW_SCHEDULER_CYCLE_COMMAND"
DEFAULT_CYCLE_COMMAND = "pnpm exec tsx scripts/dev/agent-system-loop-smoke.ts"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def build_status_payload() -> dict[str, Any]:
    heartbeat = load_state_json("scheduler_heartbeat.json", {})
    workflow = load_state_json("workflow_state.json", {})
    branch_state = load_state_json("branch_state.json", {})
    branch_scheduler = load_state_json("branch_scheduler.json", {})
    return {
        "schemaVersion": 1,
        "status": "scheduler_entrypoint_ready",
        "mode": "clean_root_compatibility",
        "generatedAt": utc_now_iso(),
        "root": str(ROOT),
        "cycleEnabled": truthy(os.environ.get(ENABLE_CYCLE_ENV)),
        "state": {
            "schedulerHeartbeatStatus": heartbeat.get("status"),
            "schedulerLastSuccessAt": heartbeat.get("last_success_at"),
            "workflowCurrentMode": workflow.get("current_mode"),
            "workflowLastAction": workflow.get("last_action"),
            "branchStatePresent": bool(branch_state),
            "branchSchedulerPresent": bool(branch_scheduler),
        },
        "boundary": {
            "noFeishuLarkSend": True,
            "noRemoteFetch": True,
            "noTradingExecution": True,
        },
    }


def run_status(args: argparse.Namespace) -> int:
    payload = build_status_payload()
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"schedulerEntrypoint={payload['status']}")
        print(f"mode={payload['mode']}")
        print(f"root={payload['root']}")
        print(f"cycleEnabled={payload['cycleEnabled']}")
    return 0


def run_cycle(args: argparse.Namespace) -> int:
    payload = build_status_payload()
    payload["requestedAction"] = "cycle"
    payload["cycleMode"] = "dry_run" if args.dry_run else "live_guarded"
    if args.dry_run or not truthy(os.environ.get(ENABLE_CYCLE_ENV)):
        payload["status"] = "cycle_blocked_fail_closed"
        payload["reason"] = (
            "scheduler cycle is disabled unless --dry-run is used for smoke or "
            f"{ENABLE_CYCLE_ENV}=1 is explicitly set for an approved live migration"
        )
        if args.write_receipt:
            save_state_json("scheduler_cycle_smoke.json", payload)
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0 if args.dry_run else 2

    result = run_agent_system_loop(os.environ.get(CYCLE_COMMAND_ENV, DEFAULT_CYCLE_COMMAND))
    payload["status"] = "cycle_completed" if result["ok"] else "cycle_failed"
    payload["cycleCommand"] = result["command"]
    payload["cycleDurationMs"] = result["duration_ms"]
    payload["cycleResult"] = result["summary"]
    payload["boundary"]["cycleReceiptOnly"] = True
    payload["boundary"]["liveFeishuLarkSend"] = False
    if args.write_receipt:
        save_state_json(
            "scheduler_cycle_report.json" if result["ok"] else "scheduler_cycle_failure.json",
            payload,
        )
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 3


def parse_json_output(stdout: str) -> dict[str, Any]:
    text = stdout.strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {"value": data}
    except Exception:
        start = text.rfind("\n{")
        if start >= 0:
            try:
                data = json.loads(text[start + 1 :])
                return data if isinstance(data, dict) else {"value": data}
            except Exception:
                pass
    return {"stdout_tail": text[-2000:]}


def summarize_cycle_payload(payload: dict[str, Any]) -> dict[str, Any]:
    checks = payload.get("checks")
    summary: dict[str, Any] = {
        "ok": payload.get("ok"),
        "scope": payload.get("scope"),
        "summary": payload.get("summary"),
        "liveTouched": payload.get("liveTouched"),
        "providerConfigTouched": payload.get("providerConfigTouched"),
        "protectedMemoryTouched": payload.get("protectedMemoryTouched"),
        "remoteFetchOccurred": payload.get("remoteFetchOccurred"),
        "executionAuthorityGranted": payload.get("executionAuthorityGranted"),
    }
    if isinstance(checks, list):
        summary["checkCount"] = len(checks)
        summary["checks"] = [
            {
                "name": item.get("name"),
                "ok": item.get("ok"),
                "durationMs": item.get("durationMs"),
            }
            for item in checks
            if isinstance(item, dict)
        ]
    return {key: value for key, value in summary.items() if value is not None}


def run_agent_system_loop(command: str) -> dict[str, Any]:
    started = datetime.now(timezone.utc)
    result = subprocess.run(
        command,
        cwd=str(ROOT),
        env=os.environ.copy(),
        shell=True,
        capture_output=True,
        text=True,
        timeout=900,
    )
    duration_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
    payload = parse_json_output(result.stdout)
    ok = result.returncode == 0 and payload.get("ok") is True
    return {
        "ok": ok,
        "command": command,
        "duration_ms": duration_ms,
        "code": result.returncode,
        "summary": summarize_cycle_payload(payload)
        if ok
        else {
            "code": result.returncode,
            "stdout_tail": (result.stdout or "")[-2000:],
            "stderr_tail": (result.stderr or "")[-2000:],
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Clean-root OpenClaw scheduler compatibility entrypoint")
    subparsers = parser.add_subparsers(dest="command")

    status = subparsers.add_parser("status")
    status.add_argument("--json", action="store_true")
    status.set_defaults(func=run_status)

    cycle = subparsers.add_parser("cycle")
    cycle.add_argument("--dry-run", action="store_true")
    cycle.add_argument("--write-receipt", action="store_true")
    cycle.set_defaults(func=run_cycle)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not hasattr(args, "func"):
        args = parser.parse_args(["status"])
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
