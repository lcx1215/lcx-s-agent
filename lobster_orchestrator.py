#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from typing import Any

from scripts.lobster_paths import ROOT, load_state_json, save_state_json

ENABLE_CYCLE_ENV = "OPENCLAW_SCHEDULER_ENABLE_CYCLE"


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

    payload["status"] = "cycle_enabled_but_no_legacy_orchestrator_ported"
    payload["reason"] = "clean-root scheduler entrypoint exists, but legacy branch cycle stages are not ported"
    save_state_json("scheduler_cycle_smoke.json", payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 3


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
