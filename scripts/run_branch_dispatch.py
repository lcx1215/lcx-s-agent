#!/usr/bin/env python3
from __future__ import annotations

import ast
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path.home() / "Projects/openclaw"

BRANCH_MAP = {
    "technical_daily": ROOT / "scripts" / "run_technical_daily_entry.py",
    "fundamental_research": ROOT / "scripts" / "run_fundamental_research_entry.py",
    "knowledge_maintenance": ROOT / "scripts" / "run_knowledge_maintenance_entry.py",
}

def parse_output(raw: str) -> dict:
    raw = (raw or "").strip()
    if not raw:
        return {"ok": False, "status": "error", "summary": "empty stdout"}
    try:
        return json.loads(raw)
    except Exception:
        pass
    try:
        obj = ast.literal_eval(raw)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    return {"ok": False, "status": "error", "summary": raw[:500]}

def print_report_preview(obj: dict) -> None:
    report_path = obj.get("report_path")
    if not report_path:
        print(json.dumps(obj, ensure_ascii=False, indent=2))
        return

    rp = Path(report_path)
    if not rp.is_absolute():
        rp = ROOT / report_path
    if rp.exists():
        txt = rp.read_text(encoding="utf-8", errors="ignore")
        print(txt[:8000].rstrip())
        return

    print(json.dumps(obj, ensure_ascii=False, indent=2))

def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: run_branch_dispatch.py <technical_daily|fundamental_research|knowledge_maintenance>")

    action = sys.argv[1].strip()
    entry = BRANCH_MAP.get(action)
    if not entry or not entry.exists():
        print(json.dumps({
            "ok": False,
            "status": "error",
            "summary": f"missing entry for {action}: {entry}"
        }, ensure_ascii=False, indent=2))
        return 2

    res = subprocess.run(
        ["python3", str(entry)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )

    raw_stdout = (res.stdout or "").strip()
    raw_stderr = (res.stderr or "").strip()

    obj = parse_output(raw_stdout)
    if raw_stderr:
        obj.setdefault("stderr", raw_stderr[:4000])

    ok = bool(obj.get("ok")) and str(obj.get("status")) in {"success", "ok"} and str(obj.get("mode", "normal")) != "degraded"
    if not ok and raw_stdout and "report_path" in obj:
        # 允许 entry 已生成文件，命令层优先打印报告内容
        pass

    print_report_preview(obj)
    return 0 if res.returncode == 0 else res.returncode

if __name__ == "__main__":
    raise SystemExit(main())
