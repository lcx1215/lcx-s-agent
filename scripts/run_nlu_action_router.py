#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def current_lane_key() -> str:
    return (os.environ.get("LOBSTER_LANE_KEY", "") or "").strip() or "global"


def parse_priority(value: object) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 1


def run(cmd: list[str]) -> dict:
    p = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True)
    return {
        "code": p.returncode,
        "stdout": (p.stdout or "").strip(),
        "stderr": (p.stderr or "").strip(),
    }

def main() -> None:
    raw = " ".join(sys.argv[1:]).strip()
    if not raw:
        print(json.dumps({"ok": False, "error": "empty text"}, ensure_ascii=False, indent=2))
        raise SystemExit(1)

    parse_res = run(["python3", str(ROOT / "scripts" / "feishu_nlu_parser.py"), raw])
    if parse_res["code"] != 0:
        print(json.dumps({
            "ok": False,
            "stage": "parse",
            "stdout": parse_res["stdout"],
            "stderr": parse_res["stderr"],
        }, ensure_ascii=False, indent=2))
        raise SystemExit(1)

    obj = json.loads(parse_res["stdout"])
    if obj.get("needs_clarification"):
        print(json.dumps({
            "ok": True,
            "mode": "clarify",
            "reply": obj.get("reply_preview"),
            "parser": obj,
            "executed": [],
        }, ensure_ascii=False, indent=2))
        return

    executed = []
    for t in obj.get("tasks", []):
        action = t["action"]

        if action == "show_memory":
            r = run(["bash", str(ROOT / "lobster_command_v2.sh"), "学习记忆"])
        elif action == "show_queue":
            r = run(["python3", str(ROOT / "scripts" / "learn_queue.py"), "list"])
        elif action == "show_status":
            r = run(["python3", str(ROOT / "scripts" / "nightly_learning_status.py")])
        elif action == "run_next":
            r = run(["python3", str(ROOT / "scripts" / "run_nightly_learning_batch.py"), "1"])
        elif action == "run_night_batch":
            r = run(["python3", str(ROOT / "scripts" / "run_nightly_learning_batch.py"), "3"])
        elif action == "show_topic_card":
            topic = t.get("topic", "").strip()
            r = run(["bash", str(ROOT / "lobster_command_v2.sh"), f"topic卡片 {topic}"])
        elif action == "brain_bootstrap":
            query = str(t.get("query") or obj.get("raw_text") or "").strip()
            r = run(["python3", str(ROOT / "scripts" / "local_corpus_search.py"), query])
        elif action == "control_room_summary":
            cmd = ["python3", str(ROOT / "control_panel_summary.py"), "--brief"]
            if bool(t.get("red_team")):
                cmd.append("--red-team")
            r = run(cmd)
        elif action == "learn_topic":
            topic = t.get("topic", "").strip()
            priority_level = parse_priority(t.get("priority", 1))
            priority = str(priority_level)
            # 先入队，再根据话里是否有“立即/马上/先学”决定是否立即跑
            q = run(["python3", str(ROOT / "scripts" / "learn_queue.py"), "add", topic, priority])
            executed.append({"action": "queue_topic", "topic": topic, "result": q})
            immediate = priority_level >= 2 or any(x in obj.get("raw_text", "") for x in ["立即", "马上", "现在", "先学", "先看"])
            if immediate:
                r = run(["python3", str(ROOT / "scripts" / "run_nightly_learning_batch.py"), "1"])
            else:
                r = {"code": 0, "stdout": json.dumps({"ok": True, "queued_only": True}, ensure_ascii=False), "stderr": ""}
        else:
            r = {"code": 2, "stdout": "", "stderr": f"unknown action: {action}"}

        executed.append({
            "action": action,
            "topic": t.get("topic", ""),
            "result": r,
        })

    print(json.dumps({
        "ok": True,
        "mode": "executed",
        "lane_key": current_lane_key(),
        "reply": obj.get("reply_preview"),
        "parser": obj,
        "executed": executed,
    }, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
