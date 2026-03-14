#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def main() -> None:
    runner = ROOT / "scripts" / "run_fundamental_research_branch.py"
    completed = subprocess.run(
        [sys.executable, str(runner)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )

    stdout = completed.stdout.strip()
    stderr = completed.stderr.strip()

    payload = {}
    if stdout:
        try:
            payload = json.loads(stdout)
        except Exception:
            payload = {"raw_stdout": stdout}

    state_path = ROOT / "branch_state.json"
    state = {}
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except Exception:
            state = {}

    node = state.get("fundamental_research_branch", {})
    latest_report = ROOT / node.get("report_path", "")
    report_preview = ""
    if latest_report.exists():
        text = latest_report.read_text(encoding="utf-8", errors="ignore")
        report_preview = "\n".join(text.splitlines()[:20])

    out = {
        "ok": node.get("status") == "success" and node.get("mode") != "degraded",
        "branch": "fundamental_research_branch",
        "status": node.get("status"),
        "mode": node.get("mode"),
        "summary": node.get("summary"),
        "report_path": node.get("report_path"),
        "sources_path": node.get("sources_path"),
        "provider_used": node.get("provider_used"),
        "runner_output": payload,
        "report_preview": report_preview,
    }
    if stderr:
        out["stderr"] = stderr[:4000]

    print(json.dumps(out, ensure_ascii=False, indent=2))
    raise SystemExit(0 if completed.returncode == 0 and out["ok"] else 1)

if __name__ == "__main__":
    main()
