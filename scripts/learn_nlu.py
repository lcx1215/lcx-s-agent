#!/usr/bin/env python3
from __future__ import annotations
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

ACTIVE_SESSIONS_PATH = Path(os.environ.get("OPENCLAW_LEARNING_SESSION_ACTIVE_PATH") or (ROOT / "branches" / "_system" / "learning_sessions" / "active_sessions.json"))

from learning_goal_registry import (
    canonical_learning_topic,
    looks_like_active_learning_request,
    looks_like_learning_request,
    looks_like_queue_only_request,
    looks_like_visual_learning_request,
    looks_like_meta_instruction,
    resolve_learning_goal,
)


def current_lane_key() -> str:
    return (os.environ.get("LOBSTER_LANE_KEY", "") or "").strip() or "global"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

ALIASES = [
    (r"(小盘轮动是不是快结束了|小盘轮动快结束|小盘轮动结束风险|iwm轮动衰竭|iwm轮动 exhaustion|iwm rotation exhaustion risk)", "iwm rotation exhaustion risk"),
    (r"(小盘轮动|小盘股轮动|small cap rotation and refinancing risk)", "small cap rotation and refinancing risk"),
    (r"(spy死叉风险|spy 死叉风险|death cross risk|spy death cross risk)", "spy death cross risk"),
    (r"(qqq ai capex|qqq ai capex and duration sensitivity|qqq duration sensitivity)", "qqq ai capex and duration sensitivity"),
    (r"(tlt通胀意外|tlt inflation surprise and term premium)", "tlt inflation surprise and term premium"),
    (r"(iwm轮动反转|iwm rotation reversal risk)", "iwm rotation reversal risk"),
]


def normalize_learning_goal_topic(text: str) -> str:
    return canonical_learning_topic(text)


def derive_generic_topic(text: str) -> str:
    goal = resolve_learning_goal(text)
    return str(goal.get("canonical_topic") or normalize_learning_goal_topic(text))

def sh(cmd: list[str], env_extra: dict[str, str] | None = None) -> str:
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    p = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True, env=env)
    return (p.stdout or p.stderr or "").strip()


def sh_json(cmd: list[str], env_extra: dict[str, str] | None = None) -> dict[str, Any]:
    raw = sh(cmd, env_extra=env_extra)
    if not raw:
        return {"ok": False, "error": "empty output", "cmd": " ".join(cmd)}
    try:
        obj = json.loads(raw)
    except Exception:
        return {"ok": False, "error": "non-json output", "cmd": " ".join(cmd), "raw": raw[:1000]}
    return obj if isinstance(obj, dict) else {"ok": False, "error": "unexpected json type", "cmd": " ".join(cmd)}


def load_json_relative(path: str) -> dict[str, Any]:
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


def learning_quality_from_sources(path: str) -> dict[str, Any]:
    obj = load_json_relative(path)
    quality = obj.get("learning_quality", {}) if isinstance(obj, dict) else {}
    if isinstance(quality, dict) and quality:
        return quality
    trace = obj.get("brain_trace_summary", {}) if isinstance(obj, dict) else {}
    if isinstance(trace, dict) and trace.get("intents") and trace.get("item_brain_types"):
        return {"status": "usable", "successful_topics": 1, "topics_with_brain_trace": 1}
    return {}


def build_feedback(result: dict[str, Any]) -> dict[str, Any]:
    queued = []
    for row in result.get("queue_ops") or []:
        queue_result = row.get("queue_result", {}) if isinstance(row, dict) else {}
        if isinstance(queue_result, dict):
            queued.append(
                {
                    "topic": queue_result.get("topic") or row.get("topic", ""),
                    "priority": queue_result.get("priority", ""),
                    "lane_key": queue_result.get("lane_key") or result.get("lane_key") or current_lane_key(),
                    "queue_size": queue_result.get("queue_size", ""),
                }
            )

    run_next = result.get("run_next") if isinstance(result.get("run_next"), dict) else {}
    night_run = result.get("night_run") if isinstance(result.get("night_run"), dict) else {}
    active_run = run_next or night_run
    artifacts = []
    if active_run:
        report_path = str(active_run.get("report_path") or "")
        sources_path = str(active_run.get("sources_path") or "")
        if report_path or sources_path:
            artifacts.append({"report_path": report_path, "sources_path": sources_path})
    quality = learning_quality_from_sources(str((active_run or {}).get("sources_path") or ""))
    feishu = result.get("feishu_send", {}) if isinstance(result.get("feishu_send"), dict) else {}
    if feishu:
        feishu = dict(feishu)
        feishu["message_id"] = extract_feishu_message_id(str(feishu.get("output") or ""))

    failed = []
    if active_run and not active_run.get("ok", True):
        failed.append(
            {
                "action": "run_next" if run_next else "night_run",
                "error": str(active_run.get("error") or active_run.get("summary") or "unknown learner failure")[:300],
            }
        )

    completed = []
    if run_next:
        completed.append(
            {
                "action": "run_next",
                "status": "success" if run_next.get("ok", True) else "failed",
                "summary": str((run_next.get("task_result") or {}).get("summary") or run_next.get("summary") or ""),
            }
        )
    if night_run:
        completed.append(
            {
                "action": "night_run",
                "status": "success" if night_run.get("ok", True) else "failed",
                "summary": str(night_run.get("summary") or ""),
            }
        )
    if result.get("learning_session"):
        completed.append({"action": "learning_session", "status": "started"})

    status = "failed" if failed else "success"
    return {
        "status": status,
        "lane_key": result.get("lane_key") or current_lane_key(),
        "understood": [
            {
                "action": "learn_topic",
                "topic": topic,
                "family": (result.get("goals") or [{}])[0].get("family", "") if result.get("goals") else "",
            }
            for topic in result.get("topics", [])
        ],
        "queued": queued,
        "completed": completed,
        "failed": failed,
        "artifacts": artifacts,
        "learning_quality": quality,
        "feishu_send": feishu,
    }


def format_feedback_text(feedback: dict[str, Any], brief: bool = False) -> str:
    understood = feedback.get("understood", []) or []
    topics = [str(x.get("topic") or "").strip() for x in understood if str(x.get("topic") or "").strip()]
    if brief:
        base = "收到。"
        if topics:
            base += f"已识别：{'、'.join(topics[:2])}。"
        if feedback.get("completed"):
            base += "已执行。"
        elif feedback.get("queued"):
            base += "已入队。"
        return base

    lines = []
    lines.append(f"已识别：{'、'.join(topics) if topics else '自然语言学习任务'}。")
    queued = feedback.get("queued", []) or []
    if queued:
        first = queued[0]
        lines.append(
            f"已入队：{len(queued)} 个主题，priority={first.get('priority', '')}，lane={first.get('lane_key') or feedback.get('lane_key') or 'global'}。"
        )
    completed = feedback.get("completed", []) or []
    if completed:
        runnable = [x for x in completed if x.get("action") in {"run_next", "night_run"}]
        if runnable:
            summary = str(runnable[-1].get("summary") or "任务已完成").strip()
            lines.append(f"已执行：{summary}。")
        if any(x.get("action") == "learning_session" for x in completed):
            lines.append("限时学习：已启动。")
    elif queued:
        lines.append("未立即执行：已排进学习队列，等待后续批次处理。")

    artifacts = feedback.get("artifacts", []) or []
    if artifacts:
        latest = artifacts[-1]
        parts = []
        if latest.get("report_path"):
            parts.append(f"report={latest['report_path']}")
        if latest.get("sources_path"):
            parts.append(f"sources={latest['sources_path']}")
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
        if feishu.get("ok"):
            suffix = f"，message_id={feishu.get('message_id')}" if feishu.get("message_id") else ""
            lines.append(f"Lark回传：已发送{suffix}。")
        else:
            lines.append("Lark回传：发送失败，已保留执行结果。")
    failed = feedback.get("failed", []) or []
    if failed:
        lines.append(f"失败：{failed[0].get('action')} {failed[0].get('error', '')}")
    return "\n".join(lines)


def run_current_topic(
    topic: str,
    lane_key: str,
    goal: dict[str, Any] | None = None,
    raw_text: str = "",
    visual_capture: bool = False,
) -> dict[str, Any]:
    queue_running = sh_json(
        ["python3", "./scripts/learn_queue.py", "set_status", topic, "running", lane_key]
    )
    env_extra = {"LOBSTER_LANE_KEY": lane_key}
    if goal:
        family = str(goal.get("family") or "").strip()
        focus = str(goal.get("focus") or "").strip()
        strategy = str(goal.get("strategy") or "").strip()
        raw_text = str(goal.get("raw_text") or "").strip()
        if family:
            env_extra["LOBSTER_LEARNING_FAMILY"] = family
        if focus:
            env_extra["LOBSTER_LEARNING_FOCUS"] = focus
        if strategy:
            env_extra["LOBSTER_LEARNING_STRATEGY"] = strategy
        if raw_text:
            env_extra["LOBSTER_LEARNING_RAW_TEXT"] = raw_text
    if visual_capture:
        cmd = ["python3", "./scripts/run_visual_learning_capture.py", raw_text or topic]
    else:
        cmd = ["python3", "./scripts/run_local_batch_learner.py", topic]
    learn_result = sh_json(cmd, env_extra=env_extra)

    bookkeeping = learn_result.get("bookkeeping_result", {}) if isinstance(learn_result, dict) else {}
    bookkeeping_status = str(bookkeeping.get("status") or "").strip() or "recorded"

    if learn_result.get("ok") and bookkeeping_status == "recorded":
        queue_finish = sh_json(
            [
                "python3",
                "./scripts/learn_queue.py",
                "finish",
                topic,
                str(learn_result.get("report_path") or ""),
                str(learn_result.get("sources_path") or ""),
                lane_key,
            ]
        )
        merged = dict(learn_result)
        merged["queue_transition"] = {
            "set_status": queue_running,
            "finish": queue_finish,
        }
        return merged

    if learn_result.get("ok"):
        failure_reason = f"bookkeeping {bookkeeping_status}"
    else:
        failure_reason = str(learn_result.get("error") or learn_result.get("summary") or "unknown learner failure").strip()

    queue_fail = sh_json(
        ["python3", "./scripts/learn_queue.py", "fail", topic, failure_reason[:300], lane_key]
    )
    merged = dict(learn_result)
    merged["queue_transition"] = {
        "set_status": queue_running,
        "fail": queue_fail,
    }
    return merged


def parse_duration_minutes(text: str) -> int:
    raw = (text or "").strip()
    if not raw:
        return 0
    if "半小时" in raw:
        return 30
    if "两个小时" in raw or "两小时" in raw:
        return 120
    if "一个小时" in raw or "一小时" in raw:
        return 60
    match = re.search(r"(\d+)\s*(小时|h\b)", raw, flags=re.I)
    if match:
        return max(0, int(match.group(1))) * 60
    match = re.search(r"(\d+)\s*分钟", raw)
    if match:
        return max(0, int(match.group(1)))
    return 0


def feishu_target_from_lane(lane_key: str) -> str:
    raw = (lane_key or "").strip()
    if raw.startswith("feishu:"):
        return raw.split(":", 1)[1].strip()
    return ""


def load_active_sessions() -> dict[str, Any]:
    if not ACTIVE_SESSIONS_PATH.exists():
        return {}
    try:
        payload = json.loads(ACTIVE_SESSIONS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def save_active_sessions(payload: dict[str, Any]) -> None:
    ACTIVE_SESSIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    ACTIVE_SESSIONS_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def start_learning_session(
    topic: str,
    lane_key: str,
    minutes: int,
    goal: dict[str, Any] | None = None,
    raw_text: str = "",
    visual_capture: bool = False,
) -> dict[str, Any]:
    if minutes <= 0:
        return {"ok": False, "error": "invalid_minutes"}
    active_key = f"{lane_key}::{topic}"
    active_sessions = load_active_sessions()
    existing = active_sessions.get(active_key)
    if isinstance(existing, dict):
        deadline_raw = str(existing.get("deadline_at") or "").strip()
        if deadline_raw:
            try:
                deadline_dt = datetime.fromisoformat(deadline_raw.replace("Z", "+00:00")).astimezone(timezone.utc)
            except Exception:
                deadline_dt = None
        else:
            deadline_dt = None
        if deadline_dt is None or deadline_dt > now_utc():
            return {
                "ok": True,
                "existing": True,
                "session_id": str(existing.get("session_id") or ""),
                "minutes": int(existing.get("minutes") or minutes),
                "deadline_at": deadline_raw,
                "state_path": str(existing.get("state_path") or ""),
                "target": str(existing.get("target") or ""),
            }
    session_key = re.sub(r"[^a-zA-Z0-9._-]+", "-", topic).strip("-") or "topic"
    session_id = f"{now_utc().strftime('%Y%m%dT%H%M%SZ')}__{session_key}"
    deadline = now_utc() + timedelta(minutes=minutes)
    state_path = ROOT / "branches" / "_system" / "learning_sessions" / f"{session_id}.json"
    log_path = Path.home() / ".openclaw" / "logs" / f"learning_session_{session_id}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["LOBSTER_LANE_KEY"] = lane_key
    env["LOBSTER_LEARNING_SESSION_ID"] = session_id
    env["LOBSTER_LEARNING_SESSION_MINUTES"] = str(minutes)
    env["LOBSTER_LEARNING_SESSION_DEADLINE"] = iso_utc(deadline)
    env["LOBSTER_LEARNING_SESSION_STATE_PATH"] = str(state_path)
    target = feishu_target_from_lane(lane_key)
    if target:
        env["LOBSTER_SESSION_REPLY_TARGET"] = target
    if goal:
        family = str(goal.get("family") or "").strip()
        focus = str(goal.get("focus") or "").strip()
        strategy = str(goal.get("strategy") or "").strip()
        goal_raw = str(goal.get("raw_text") or raw_text or "").strip()
        if family:
            env["LOBSTER_LEARNING_FAMILY"] = family
        if focus:
            env["LOBSTER_LEARNING_FOCUS"] = focus
        if strategy:
            env["LOBSTER_LEARNING_STRATEGY"] = strategy
        if goal_raw:
            env["LOBSTER_LEARNING_RAW_TEXT"] = goal_raw
    cmd = [sys.executable, str(ROOT / "scripts" / "run_learning_timebox.py"), topic, "--minutes", str(minutes), "--session-id", session_id]
    if visual_capture:
        cmd.append("--visual-capture")
    active_entry = {
        "session_id": session_id,
        "topic": topic,
        "lane_key": lane_key,
        "minutes": minutes,
        "deadline_at": iso_utc(deadline),
        "state_path": str(state_path.relative_to(ROOT)),
        "target": target,
    }
    active_sessions[active_key] = active_entry
    save_active_sessions(active_sessions)
    try:
        with log_path.open("a", encoding="utf-8") as log_fp:
            proc = subprocess.Popen(
                cmd,
                cwd=str(ROOT),
                env=env,
                stdout=log_fp,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                text=True,
            )
    except Exception as exc:
        active_sessions = load_active_sessions()
        active_sessions.pop(active_key, None)
        save_active_sessions(active_sessions)
        return {"ok": False, "error": f"start_failed: {exc}"}
    return {
        "ok": True,
        "session_id": session_id,
        "minutes": minutes,
        "deadline_at": iso_utc(deadline),
        "state_path": str(state_path.relative_to(ROOT)),
        "log_path": str(log_path),
        "pid": proc.pid,
        "target": target,
    }

def extract_topics(text: str) -> list[str]:
    found = []
    low = text.lower()
    for pat, canon in ALIASES:
        if re.search(pat, text, flags=re.I):
            found.append(canon)

    # very light generic catches
    if "spy" in low and ("死叉" in text or "death cross" in low):
        found.append("spy death cross risk")
    if ("小盘" in text or "iwm" in low or "small cap" in low) and ("轮动" in text or "rotation" in low):
        if ("结束" in text or "衰竭" in text or "exhaust" in low):
            found.append("iwm rotation exhaustion risk")
        else:
            found.append("small cap rotation and refinancing risk")

    # dedup preserve order
    out = []
    seen = set()
    for x in found:
        if x not in seen:
            out.append(x)
            seen.add(x)
    return out

def parse_actions(text: str) -> dict:
    want_memory = any(k in text for k in ["学习记忆", "先看学习记忆", "先看记忆", "看学习记忆", "看看记忆"])
    explicit_run_command = any(k in text for k in ["运行下一条", "跑下一条", "run next"])
    incidental_run_next = "先跑一个" in text
    queue_only_request = looks_like_queue_only_request(text) or any(k in text for k in ["排队", "添加学习"])
    active_learning_request = looks_like_active_learning_request(text)
    want_run_next = explicit_run_command or incidental_run_next or (active_learning_request and not queue_only_request)
    want_night = any(k in text for k in ["今晚跑掉", "今晚跑", "夜间学习", "今晚上跑", "今晚学完"])
    want_brief = any(k in text for k in ["别太长", "简短", "短一点", "别太多", "brief"])
    want_reply = any(k in text for k in ["发群里", "回群里", "发飞书", "发到飞书群", "发群"])
    want_bump = any(k in text for k in ["插队", "优先", "重点学", "重点看", "先学"])
    want_card = text.startswith("topic卡片 ") or text.startswith("topic card ")
    duration_minutes = parse_duration_minutes(text)

    return {
        "want_memory": want_memory,
        "want_run_next": want_run_next,
        "explicit_run_command": explicit_run_command,
        "want_night": want_night,
        "want_brief": want_brief,
        "want_reply": want_reply,
        "want_bump": want_bump,
        "want_card": want_card,
        "want_visual_capture": looks_like_visual_learning_request(text),
        "duration_minutes": duration_minutes,
    }

def main():
    text = " ".join(sys.argv[1:]).strip()
    if not text:
        print(json.dumps({"ok": False, "message": "empty text"}, ensure_ascii=False, indent=2))
        raise SystemExit(1)

    a = parse_actions(text)
    topics = extract_topics(text)
    resolved_goal = resolve_learning_goal(text)
    if not topics:
        generic = str(resolved_goal.get("canonical_topic") or derive_generic_topic(text)).strip()
        if generic:
            topics = [generic]

    result = {
        "ok": True,
        "action": "learn_nlu_v2",
        "lane_key": current_lane_key(),
        "topics": topics,
        "goals": [],
        "visual_capture": a["want_visual_capture"],
        "reply_to_feishu": a["want_reply"],
        "brief": a["want_brief"],
        "memory": None,
        "queue_ops": [],
        "run_next": None,
        "learning_session": None,
        "night_run": None,
        "message": "",
    }
    if topics and resolved_goal.get("canonical_topic") == topics[0]:
        result["goals"] = [resolved_goal]

    if a["want_memory"]:
        result["memory"] = sh(["python3", "./scripts/topic_memory.py", "summary_short"])

    for t in topics:
        q = sh_json(["python3", "./scripts/learn_queue.py", "add", t])
        result["queue_ops"].append({"topic": t, "queue_result": q})
        if a["want_bump"]:
            b = sh_json(["python3", "./scripts/learn_queue.py", "bump", t])
            result["queue_ops"][-1]["bump_result"] = b

    if a["want_run_next"]:
        if topics:
            goal = result["goals"][0] if result["goals"] else None
            result["run_next"] = run_current_topic(
                topics[0],
                result["lane_key"],
                goal=goal,
                raw_text=text,
                visual_capture=a["want_visual_capture"],
            )
            if a["duration_minutes"] > 0:
                result["learning_session"] = start_learning_session(
                    topics[0],
                    result["lane_key"],
                    a["duration_minutes"],
                    goal=goal,
                    raw_text=text,
                    visual_capture=a["want_visual_capture"],
                )
        elif a.get("explicit_run_command"):
            result["run_next"] = sh_json(["python3", "./scripts/run_nightly_learning_batch.py", "1"])
        elif looks_like_meta_instruction(text) or not looks_like_learning_request(text):
            result["run_next"] = None

    if a["want_night"]:
        result["night_run"] = sh_json(["python3", "./scripts/run_nightly_learning_batch.py", "3"])

    msg_parts = []
    if a["want_memory"]:
        msg_parts.append("已读取学习记忆")
    if topics:
        msg_parts.append(f"已处理 {len(topics)} 个主题")
    if result.get("run_next"):
        msg_parts.append("已执行下一条")
    if result.get("learning_session"):
        msg_parts.append("已启动限时学习")
    if a["want_night"]:
        msg_parts.append("已触发夜间学习")
    if a["want_reply"]:
        msg_parts.append("需回飞书")
    if a["want_brief"]:
        msg_parts.append("简短回复")
    result["message"] = "，".join(msg_parts) if msg_parts else "已解析"


    result["feedback"] = build_feedback(result)
    result["reply_text"] = format_feedback_text(result["feedback"], brief=bool(result.get("brief")))

    # direct-path Feishu send for lobster_command_v2.sh -> learn_nlu.py
    try:
        if result.get("reply_to_feishu") and result.get("reply_text"):
            send_candidates = [
                ["bash", "./send_feishu_reply.sh", result["reply_text"]],
                ["bash", "./send_feishu_reply.sh", result["reply_text"]],
            ]
            send_out = None
            last_err = None
            for cmd in send_candidates:
                try:
                    p2 = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True)
                    out = (p2.stdout or p2.stderr or "").strip()
                    if p2.returncode == 0:
                        send_out = {
                            "ok": True,
                            "cmd": " ".join(cmd[:2]),
                            "output": out[:500],
                        }
                        break
                    last_err = {
                        "ok": False,
                        "cmd": " ".join(cmd[:2]),
                        "output": out[:500],
                    }
                except Exception as e:
                    last_err = {
                        "ok": False,
                        "cmd": " ".join(cmd[:2]),
                        "output": str(e)[:500],
                    }
            result["feishu_send"] = send_out if send_out is not None else last_err
    except Exception as e:
        result["feishu_send"] = {"ok": False, "output": str(e)[:500]}

    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
