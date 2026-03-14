#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def main() -> None:
    runner = ROOT / "scripts" / "run_technical_daily_branch.py"
    completed = subprocess.run(
        [sys.executable, str(runner)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )

    stdout = completed.stdout.strip()
    stderr = completed.stderr.strip()

    if completed.returncode != 0:
        print(json.dumps({
            "ok": False,
            "status": "error",
            "stdout": stdout,
            "stderr": stderr,
        }, ensure_ascii=False, indent=2))
        raise SystemExit(1)

    payload = {}
    if stdout:
        try:
            payload = json.loads(stdout)
        except Exception:
            payload = {"raw_stdout": stdout}

    state_path = ROOT / "branches" / "technical_daily" / "technical_daily_state.json"
    state = {}
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding="utf-8"))

    latest_report = ROOT / state.get("last_report_path", "")
    report_preview = ""
    if latest_report.exists():
        text = latest_report.read_text(encoding="utf-8")
        report_preview = "\n".join(text.splitlines()[:20])

    out = {
        "ok": state.get("last_status") == "success" and state.get("last_mode") == "normal",
        "branch": "technical_daily_branch",
        "status": state.get("last_status"),
        "mode": state.get("last_mode"),
        "summary": state.get("last_summary"),
        "report_path": state.get("last_report_path"),
        "sources_path": state.get("last_sources_path"),
        "provider_used": state.get("provider_used"),
        "runner_output": payload,
        "report_preview": report_preview,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
