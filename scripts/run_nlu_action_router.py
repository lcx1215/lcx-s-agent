#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from nlu_feedback_memory import safe_append_feedback_event


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


def parse_stdout_json(result: dict) -> dict:
    raw = str(result.get("stdout") or "").strip()
    if not raw:
        return {}
    try:
        obj = json.loads(raw)
    except Exception:
        return {}
    return obj if isinstance(obj, dict) else {}


def load_json_relative(path: str) -> dict:
    clean = str(path or "").strip()
    if not clean:
        return {}
    target = ROOT / clean
    if not target.exists():
        return {}
    try:
        obj = json.loads(target.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return obj if isinstance(obj, dict) else {}


def extract_feishu_message_id(output: str) -> str:
    match = re.search(r"Message ID:\s*([^\s]+)", output or "")
    return match.group(1) if match else ""


def short_error(result: dict) -> str:
    stderr = str(result.get("stderr") or "").strip()
    stdout = str(result.get("stdout") or "").strip()
    text = stderr or stdout or "empty output"
    return text[:300]


def build_feedback(obj: dict, executed: list[dict]) -> dict:
    tasks = obj.get("tasks", []) if isinstance(obj.get("tasks"), list) else []
    understood = [
        {
            "action": t.get("action", ""),
            "topic": t.get("topic", ""),
            "priority": t.get("priority", ""),
        }
        for t in tasks
        if isinstance(t, dict)
    ]

    queued: list[dict] = []
    completed: list[dict] = []
    failed: list[dict] = []
    artifacts: list[dict] = []
    feishu_send: dict = {}
    learning_quality: dict = {}

    for item in executed:
        action = str(item.get("action") or "")
        topic = str(item.get("topic") or "")
        result = item.get("result", {}) if isinstance(item.get("result"), dict) else {}
        payload = parse_stdout_json(result)
        if result.get("code") != 0:
            failed.append({"action": action, "topic": topic, "error": short_error(result)})
            continue

        if action == "queue_topic":
            queued.append(
                {
                    "topic": payload.get("topic") or topic,
                    "priority": payload.get("priority", ""),
                    "lane_key": payload.get("lane_key") or current_lane_key(),
                    "queue_size": payload.get("queue_size", ""),
                }
            )
            continue

        if payload.get("queued_only"):
            completed.append({"action": action, "topic": topic, "status": "queued_only"})
            continue

        completed.append(
            {
                "action": action,
                "topic": topic,
                "status": payload.get("status") or "success",
                "summary": payload.get("summary", ""),
            }
        )

        report_path = str(payload.get("report_path") or "")
        sources_path = str(payload.get("sources_path") or "")
        if report_path or sources_path:
            artifacts.append({"report_path": report_path, "sources_path": sources_path})
        if sources_path and not learning_quality:
            sources_obj = load_json_relative(sources_path)
            quality = sources_obj.get("learning_quality", {}) if isinstance(sources_obj, dict) else {}
            if isinstance(quality, dict):
                learning_quality = quality
        send = payload.get("feishu_send", {})
        if isinstance(send, dict) and send:
            feishu_send = dict(send)
            feishu_send["message_id"] = extract_feishu_message_id(str(send.get("output") or ""))

    status = "failed" if failed else "success"
    if not completed and queued and not failed:
        status = "queued"

    return {
        "status": status,
        "lane_key": current_lane_key(),
        "understood": understood,
        "queued": queued,
        "completed": completed,
        "failed": failed,
        "artifacts": artifacts,
        "learning_quality": learning_quality,
        "feishu_send": feishu_send,
    }


def format_feedback_text(feedback: dict) -> str:
    lines: list[str] = []
    understood = feedback.get("understood", []) or []
    if understood:
        first = understood[0]
        topic = str(first.get("topic") or "").strip()
        action = str(first.get("action") or "").strip()
        label = topic or action or "自然语言任务"
        lines.append(f"已识别：{label}。")
    else:
        lines.append("已识别：自然语言任务。")

    queued = feedback.get("queued", []) or []
    if queued:
        q = queued[0]
        priority = q.get("priority", "")
        lane = q.get("lane_key") or feedback.get("lane_key") or "global"
        lines.append(f"已入队：priority={priority}，lane={lane}。")

    completed = feedback.get("completed", []) or []
    queued_only = any(x.get("status") == "queued_only" for x in completed)
    ran = [x for x in completed if x.get("status") != "queued_only"]
    if ran:
        summary = str(ran[-1].get("summary") or "").strip()
        lines.append(f"已执行：{summary or '任务已完成'}。")
    elif queued_only:
        lines.append("未立即执行：已排进学习队列，等待后续批次处理。")

    artifacts = feedback.get("artifacts", []) or []
    if artifacts:
        a = artifacts[-1]
        report = a.get("report_path") or ""
        sources = a.get("sources_path") or ""
        parts = []
        if report:
            parts.append(f"report={report}")
        if sources:
            parts.append(f"sources={sources}")
        if parts:
            lines.append("产物：" + "；".join(parts) + "。")

    quality = feedback.get("learning_quality", {}) or {}
    if quality:
        lines.append(
            "质量："
            f"{quality.get('status', 'unknown')}，"
            f"{quality.get('topics_with_brain_trace', 0)}/{quality.get('successful_topics', 0)} topics with brain trace。"
        )

    feishu = feedback.get("feishu_send", {}) or {}
    if feishu:
        msg_id = feishu.get("message_id") or ""
        if feishu.get("ok"):
            suffix = f"，message_id={msg_id}" if msg_id else ""
            lines.append(f"Lark回传：已发送{suffix}。")
        else:
            lines.append("Lark回传：发送失败，已保留执行结果。")

    failed = feedback.get("failed", []) or []
    if failed:
        f = failed[0]
        lines.append(f"失败：{f.get('action', 'task')} {f.get('error', '')}")

    return "\n".join(lines)


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
        feedback = {
            "status": "clarify",
            "lane_key": current_lane_key(),
            "understood": [],
            "queued": [],
            "completed": [],
            "failed": [],
            "artifacts": [],
            "learning_quality": {},
            "feishu_send": {},
            "text": obj.get("reply_preview") or "我需要你再说清楚要学习、查看队列、查看状态，还是跑下一条。",
        }
        feedback_memory = safe_append_feedback_event(
            raw_text=raw,
            source="run_nlu_action_router",
            reply_text=feedback["text"],
            feedback=feedback,
            parser=obj,
            executed=[],
            action=str(obj.get("intent") or ""),
        )
        print(json.dumps({
            "ok": True,
            "mode": "clarify",
            "reply": feedback["text"],
            "feedback": feedback,
            "feedback_memory": feedback_memory,
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

    feedback = build_feedback(obj, executed)
    reply = format_feedback_text(feedback)
    feedback_memory = safe_append_feedback_event(
        raw_text=raw,
        source="run_nlu_action_router",
        reply_text=reply,
        feedback=feedback,
        parser=obj,
        executed=executed,
        action=str(obj.get("intent") or ""),
    )

    print(json.dumps({
        "ok": True,
        "mode": "executed",
        "lane_key": current_lane_key(),
        "reply": reply,
        "parse_reply": obj.get("reply_preview"),
        "feedback": feedback,
        "feedback_memory": feedback_memory,
        "parser": obj,
        "executed": executed,
    }, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
