#!/usr/bin/env python3
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

ROOT = Path(os.environ.get("OPENCLAW_ROOT", str(Path.home() / "Projects/openclaw"))).expanduser().resolve()
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from learning_goal_registry import (
    looks_like_active_learning_request,
    looks_like_learning_request,
    looks_like_queue_only_request,
)

LOG_DIR = Path.home() / ".openclaw" / "logs"
STATE_DIR = Path.home() / ".openclaw" / "state"
TARGET_CACHE = STATE_DIR / "last_feishu_target.txt"
LOG_DIR.mkdir(parents=True, exist_ok=True)
STATE_DIR.mkdir(parents=True, exist_ok=True)

PORT = int(os.environ.get("LOBSTER_PROXY_PORT", "3011"))
ORIGIN_URL = os.environ.get("ORIGINAL_FEISHU_URL", "http://127.0.0.1:3000/feishu/events")
COMMAND_BIN = os.environ.get("LOBSTER_COMMAND_BIN", str(ROOT / "lobster_command_v2.sh"))
OPENCLAW_REPLY_BIN = os.environ.get("OPENCLAW_BIN", str(ROOT / "send_feishu_reply.sh"))
VERIFY_TOKEN = os.environ.get("LARK_VERIFY_TOKEN", "").strip()
MAX_REPLY_CHARS = int(os.environ.get("LOBSTER_MAX_REPLY_CHARS", "5000"))
DEDUP_SECONDS = int(os.environ.get("LOBSTER_DEDUP_SECONDS", "600"))
FORWARDED_LARK_HEADERS = (
    "content-type",
    "x-lark-request-timestamp",
    "x-lark-request-nonce",
    "x-lark-signature",
)

logging.basicConfig(
    filename=str(LOG_DIR / "gateway.log"),
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

SEEN: Dict[str, float] = {}
SEEN_LOCK = threading.Lock()
SHORT_CONTROL_ALIASES = {
    "继续这个研究线",
    "继续这个研究",
    "继续",
    "继续这个",
}

STATUS_COMMAND_ALIASES = {
    "学习状态",
    "学习队列",
    "队列",
    "queue",
    "learn queue",
    "learn_status",
}

TOPIC_MEMORY_COMMAND_ALIASES = {
    "学习记忆",
    "看学习记忆",
    "先看学习记忆",
    "学习记忆库",
    "记忆卡片总表",
    "memory",
    "learn memory",
}

TECHNICAL_DAILY_COMMAND_ALIASES = {
    "技术日报",
    "technical_daily",
}

LEGACY_EXACT_COMMAND_ALIASES = {
    "学习记忆",
    "看学习记忆",
    "先看学习记忆",
    "学习状态",
    "学习队列",
    "运行下一条学习",
    "运行下一条",
    "跑下一条",
    "夜间学习",
    "技术日报",
    "technical_daily",
    "tech_daily",
    "fundamental_research",
    "基本面研究",
    "基本面日报",
    "fundamental",
    "knowledge_maintenance",
    "知识维护",
    "维护分支",
    "maintenance_branch",
    "维护状态",
    "立即夜学",
    "立即刷新",
    "立即清洗",
    "立即报告",
    "立即维护",
    "立即全流程",
    "查看队列",
}

LEGACY_PREFIX_COMMAND_ALIASES = (
    "topic卡片 ",
    "topic card ",
    "topic_card ",
    "learn_topic ",
    "学习主题 ",
    "学习排队 ",
    "添加学习 ",
)

def clip_text(text: str, limit: int = MAX_REPLY_CHARS) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 20].rstrip() + "\n...[truncated]"


def parse_json_reply(text: str) -> Dict[str, Any] | None:
    raw = (text or "").strip()
    if not raw or not raw.startswith("{"):
        return None
    try:
        obj = json.loads(raw)
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def normalize_command_display_text(text: str) -> str:
    raw = (text or "").strip()
    if not raw:
        return ""

    without_code_fences = re.sub(
        r"```(?:[\w+-]+)?\n?([\s\S]*?)```",
        lambda match: f"\n{match.group(1).strip()}\n" if match.group(1).strip() else "\n",
        raw,
    )
    normalized = (
        without_code_fences
        .replace("**", "")
    )
    normalized = re.sub(r"^#{1,6}\s+", "", normalized, flags=re.MULTILINE)
    normalized = re.sub(r"^\s*---+\s*$", "", normalized, flags=re.MULTILINE)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    return normalized.strip()


def strip_section(text: str, section_title: str) -> str:
    lines = text.splitlines()
    result: list[str] = []
    skipping = False
    target = section_title.strip().lower()
    for line in lines:
        normalized = line.strip().lower()
        if re.match(r"^\d+\.\s+", normalized):
            heading = re.sub(r"^\d+\.\s*", "", normalized).strip()
            if heading == target:
                skipping = True
                continue
            if skipping:
                skipping = False
        if not skipping:
            result.append(line)
    return "\n".join(result).strip()


def compact_topic_card_reply(text: str) -> str:
    normalized = normalize_command_display_text(text)
    normalized = normalized.replace("Topic Card - ", "主题卡片：", 1)
    normalized = strip_section(normalized, "Evidence Links")
    normalized = re.sub(r"^\s*1\.\s*Snapshot\s*$", "当前卡片摘要", normalized, flags=re.MULTILINE)
    normalized = re.sub(r"^\s*2\.\s*Drivers\s*$", "主要驱动", normalized, flags=re.MULTILINE)
    normalized = re.sub(r"^\s*3\.\s*Risk Flags\s*$", "风险提示", normalized, flags=re.MULTILINE)
    normalized = re.sub(r"^\s*4\.\s*Key Points\s*$", "关键点", normalized, flags=re.MULTILINE)
    normalized = re.sub(r"^\s*5\.\s*Current Conclusion\s*$", "当前结论", normalized, flags=re.MULTILINE)
    normalized = re.sub(r"^\s*-\s*topic_id:.*$", "", normalized, flags=re.MULTILINE)
    normalized = re.sub(r"^\s*-\s*updated_at:.*$", "", normalized, flags=re.MULTILINE)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    return normalized.strip()


def compact_technical_daily_reply(text: str) -> str:
    normalized = normalize_command_display_text(text)
    normalized = normalized.replace("Technical Daily Report - generated", "技术日报", 1)
    normalized = re.sub(r"^\s*1\.\s*Market Regime Snapshot\s*$", "市场快照", normalized, flags=re.MULTILINE)
    normalized = re.sub(r"^\s*2\.\s*ETF Watchlist Observations\s*$", "观察点", normalized, flags=re.MULTILINE)
    normalized = re.sub(r"^\s*3\.\s*Momentum / Trend / Volatility Notes\s*$", "动量与波动", normalized, flags=re.MULTILINE)
    normalized = re.sub(r"^\s*4\.\s*Execution Risk Notes\s*$", "执行与来源说明", normalized, flags=re.MULTILINE)
    normalized = re.sub(r"^\s*5\.\s*Risk Flags\s*$", "风险提示", normalized, flags=re.MULTILINE)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    return normalized.strip()


def shorten_lane_key(lane_key: str) -> str:
    raw = (lane_key or "").strip()
    if not raw:
        return "unknown"
    if len(raw) <= 22:
        return raw
    return raw[:19] + "..."


def summarize_learning_status(payload: Dict[str, Any]) -> str:
    queue = payload.get("queue") if isinstance(payload.get("queue"), dict) else {}
    learn_state = payload.get("learn_state") if isinstance(payload.get("learn_state"), dict) else {}
    bookkeeping = payload.get("bookkeeping") if isinstance(payload.get("bookkeeping"), dict) else {}
    active_lanes = payload.get("active_lanes") if isinstance(payload.get("active_lanes"), list) else []
    lane_states = payload.get("lane_states") if isinstance(payload.get("lane_states"), list) else []

    lines = ["学习状态摘要"]
    lines.append(
        "- 队列: queued={queued}, running={running}, done={done}, failed={failed}".format(
            queued=queue.get("queued", 0),
            running=queue.get("running", 0),
            done=queue.get("done", 0),
            failed=queue.get("failed", 0),
        )
    )

    next_up = queue.get("next_up")
    if isinstance(next_up, list) and next_up:
        row = next_up[0] if isinstance(next_up[0], dict) else {}
        if row:
            lines.append(
                "- 下一条: {topic} ({lane})".format(
                    topic=str(row.get("topic") or "unknown"),
                    lane=shorten_lane_key(str(row.get("lane_key") or "global")),
                )
            )

    if learn_state:
        summary = str(learn_state.get("summary") or learn_state.get("status") or "unknown").strip()
        last_run_at = str(learn_state.get("last_run_at") or "unknown").strip()
        lines.append(f"- 全局学习: {summary}")
        lines.append(f"- 最近全局运行: {last_run_at}")

    pending_count = int(bookkeeping.get("pending_count") or 0)
    if pending_count > 0:
        pending_topics = bookkeeping.get("pending_topics") if isinstance(bookkeeping.get("pending_topics"), list) else []
        pending_preview = ", ".join(str(item) for item in pending_topics if item) or "unknown"
        lines.append(f"- Bookkeeping: pending={pending_count} ({pending_preview})")
    else:
        lines.append("- Bookkeeping: clean")

    if lane_states:
        lane_preview = ", ".join(shorten_lane_key(str(row.get("lane_key") or "")) for row in lane_states[:3] if isinstance(row, dict))
        if lane_preview:
            lines.append(f"- 活跃 lane: {lane_preview}")
    elif active_lanes:
        lane_preview = ", ".join(shorten_lane_key(str(item)) for item in active_lanes[:3] if item)
        if lane_preview:
            lines.append(f"- 活跃 lane: {lane_preview}")

    return "\n".join(lines)


def summarize_topic_memory_status(payload: Dict[str, Any]) -> str:
    topic_count = int(payload.get("topic_count") or 0)
    updated_at = str(payload.get("updated_at") or "unknown").strip()
    high_priority = payload.get("high_priority") if isinstance(payload.get("high_priority"), list) else []
    recent = payload.get("recent") if isinstance(payload.get("recent"), list) else []
    lane_indexes = payload.get("lane_indexes") if isinstance(payload.get("lane_indexes"), list) else []

    lines = ["学习记忆摘要"]
    lines.append(f"- 总卡片数: {topic_count}")
    lines.append(f"- 最近更新时间: {updated_at}")

    if high_priority:
        topics = [str(row.get("topic") or "").strip() for row in high_priority[:3] if isinstance(row, dict)]
        topics = [topic for topic in topics if topic]
        if topics:
            lines.append("- 高优先级: " + " / ".join(topics))

    if recent:
        topics = [str(row.get("topic") or "").strip() for row in recent[:3] if isinstance(row, dict)]
        topics = [topic for topic in topics if topic]
        if topics:
            lines.append("- 最近更新: " + " / ".join(topics))

    if lane_indexes:
        lane_summaries = []
        for row in lane_indexes[:3]:
            if not isinstance(row, dict):
                continue
            lane_key = shorten_lane_key(str(row.get("lane_key") or "unknown"))
            count = int(row.get("topic_count") or 0)
            lane_summaries.append(f"{lane_key}({count})")
        if lane_summaries:
            lines.append("- Lane 索引: " + ", ".join(lane_summaries))

    return "\n".join(lines)


def summarize_learning_action(payload: Dict[str, Any]) -> str:
    topics = payload.get("topics") if isinstance(payload.get("topics"), list) else []
    queue_ops = payload.get("queue_ops") if isinstance(payload.get("queue_ops"), list) else []
    branch = str(payload.get("branch") or "").strip()
    summary = str(payload.get("summary") or payload.get("message") or "").strip()
    reply_text = str(payload.get("reply_text") or "").strip()
    bookkeeping = payload.get("bookkeeping_result") if isinstance(payload.get("bookkeeping_result"), dict) else {}
    run_next = payload.get("run_next") if isinstance(payload.get("run_next"), dict) else {}
    learning_session = payload.get("learning_session") if isinstance(payload.get("learning_session"), dict) else {}

    if reply_text:
        lines = [reply_text]
    elif summary:
        lines = [summary]
    else:
        lines = ["学习任务已处理"]

    if topics:
        topic_preview = " / ".join(str(item).strip() for item in topics[:3] if item)
        if topic_preview:
            lines.append(f"- 主题: {topic_preview}")

    if queue_ops:
        lines.append(f"- 已入队: {len(queue_ops)}")

    if branch == "learn_branch":
        task_result = payload.get("task_result") if isinstance(payload.get("task_result"), dict) else {}
        task_summary = str(task_result.get("summary") or summary or "").strip()
        if task_summary and task_summary not in lines[0]:
            lines.append(f"- 结果: {task_summary}")
        status = str(bookkeeping.get("status") or "").strip()
        if status == "recorded":
            lines.append("- 记忆落账: recorded")
        elif status:
            lines.append(f"- 记忆落账: {status}")

    if run_next:
        task_result = run_next.get("task_result") if isinstance(run_next.get("task_result"), dict) else {}
        task_summary = str(task_result.get("summary") or run_next.get("summary") or "").strip()
        if task_summary and task_summary not in "\n".join(lines):
            lines.append(f"- 已执行: {task_summary}")
        report_path = str(run_next.get("report_path") or "").strip()
        learned_summary = extract_learning_report_summary(report_path)
        if learned_summary:
            lines.append(f"- 学到: {learned_summary}")
        nested_bookkeeping = run_next.get("bookkeeping_result") if isinstance(run_next.get("bookkeeping_result"), dict) else {}
        nested_status = str(nested_bookkeeping.get("status") or "").strip()
        if nested_status == "recorded":
            lines.append("- 记忆落账: recorded")
        elif nested_status:
            lines.append(f"- 记忆落账: {nested_status}")

    if learning_session.get("ok"):
        minutes = int(learning_session.get("minutes") or 0)
        deadline = str(learning_session.get("deadline_at") or "").strip()
        label = "沿用已有 session" if learning_session.get("existing") else "已启动"
        lines.append(f"- 限时学习: {label} {minutes} 分钟")
        if deadline:
            lines.append(f"- 预计结束: {deadline}")

    return "\n".join(lines)


def extract_learning_report_summary(report_path: str) -> str:
    raw = (report_path or "").strip()
    if not raw:
        return ""
    path = (ROOT / raw).resolve() if not Path(raw).is_absolute() else Path(raw).resolve()
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return ""

    section = re.search(
        r"^##\s+5\.\s+Current Conclusion\s*$([\s\S]*?)(?:^##\s+\d+\.|\Z)",
        text,
        flags=re.MULTILINE,
    )
    if not section:
        return ""
    body = normalize_command_display_text(section.group(1))
    lines = [line.strip(" -") for line in body.splitlines() if line.strip()]
    if not lines:
        return ""
    return lines[0][:180]


def compact_bootstrap_hint(summary: str) -> str:
    normalized = normalize_command_display_text(summary)
    normalized = re.sub(r"^(Topic Card|Episode Card)\s*-\s*[^\n]+\s*", "", normalized, flags=re.I)
    normalized = re.sub(
        r"^\s*-\s*(topic_id|lane_key|symbol|regime|revisit_priority|memory_type|relevance_tier|updated_at|episode_type):.*$",
        "",
        normalized,
        flags=re.MULTILINE,
    )
    normalized = re.sub(r"^\s*\d+\.\s*[^\n]+\s*$", "", normalized, flags=re.MULTILINE)
    normalized = re.sub(r"\n{2,}", "\n", normalized)
    single_line = re.sub(r"\s+", " ", normalized).strip(" -")
    return single_line[:180]


def compact_bootstrap_title(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return "当前记忆"
    name = raw.rsplit("/", 1)[-1]
    name = re.sub(r"\.(md|json)$", "", name, flags=re.I)
    name = name.replace("_", " ").strip()
    return name or "当前记忆"


def extract_bootstrap_field(summary: str, field_name: str) -> str:
    match = re.search(rf"{re.escape(field_name)}:\s*(.+)", summary, re.I)
    if not match:
        return ""
    value = re.split(r"\s+-\s+\w+?:", match.group(1).strip(), maxsplit=1)[0].strip()
    return value


def preferred_bootstrap_instruction(summary: str) -> str:
    for field in ("default_method", "lesson", "anchor", "next_drill"):
        value = extract_bootstrap_field(summary, field)
        if value:
            return value
    return compact_bootstrap_hint(summary)


def summarize_brain_bootstrap(payload: Dict[str, Any]) -> str:
    items = payload.get("items") if isinstance(payload.get("items"), list) else []
    lines = ["先从这里开始"]
    if items:
        first = items[0] if isinstance(items[0], dict) else {}
        if first:
            primary_title = compact_bootstrap_title(
                str(first.get("title") or first.get("path") or "当前记忆")
            )
            lines.append(f"- 先看: {primary_title}")
            hint = preferred_bootstrap_instruction(str(first.get("summary") or ""))
            if hint:
                lines.append(f"- 先做: {hint}")
        backup_item = next(
            (item for item in items[1:3] if isinstance(item, dict)),
            None,
        )
        if isinstance(backup_item, dict):
            backup_title = compact_bootstrap_title(
                str(backup_item.get("title") or backup_item.get("path") or "补充记忆")
            )
            backup_hint = preferred_bootstrap_instruction(str(backup_item.get("summary") or ""))
            if backup_hint:
                lines.append(f"- 再补: {backup_hint}")
            else:
                lines.append(f"- 再补: {backup_title}")
    intent = str(payload.get("intent") or "").strip()
    if intent and not items:
        lines.append(f"- 当前意图: {intent}")
    return "\n".join(lines)


def format_command_reply(command_text: str, payload: str) -> str:
    text = normalize_short_control_candidate(command_text)
    parsed = parse_json_reply(payload)
    if not parsed:
        if text.startswith("topic卡片 "):
            return clip_text(compact_topic_card_reply(payload))
        if text in TECHNICAL_DAILY_COMMAND_ALIASES:
            return clip_text(compact_technical_daily_reply(payload))
        return clip_text(normalize_command_display_text(payload))

    if text in STATUS_COMMAND_ALIASES or "learn_state" in parsed or "bookkeeping" in parsed:
        return clip_text(summarize_learning_status(parsed))

    if text in TOPIC_MEMORY_COMMAND_ALIASES or "topic_count" in parsed or "lane_indexes" in parsed:
        return clip_text(summarize_topic_memory_status(parsed))

    if parsed.get("action") == "learn_nlu_v2" or parsed.get("branch") == "learn_branch" or "queue_ops" in parsed:
        return clip_text(summarize_learning_action(parsed))

    if "intent" in parsed and isinstance(parsed.get("items"), list):
        return clip_text(summarize_brain_bootstrap(parsed))

    return clip_text(normalize_command_display_text(payload))

def purge_seen() -> None:
    now = time.time()
    with SEEN_LOCK:
        stale = [k for k, v in SEEN.items() if now - v > DEDUP_SECONDS]
        for k in stale:
            SEEN.pop(k, None)

def already_seen(event_id: str) -> bool:
    purge_seen()
    now = time.time()
    with SEEN_LOCK:
        if event_id in SEEN:
            return True
        SEEN[event_id] = now
        return False

def nested(d: Dict[str, Any], *keys: str) -> Any:
    cur: Any = d
    for k in keys:
        if not isinstance(cur, dict) or k not in cur:
            return None
        cur = cur[k]
    return cur

def event_id_of(body: Dict[str, Any]) -> str:
    # Prefer stable message identifiers so the same Feishu message delivered via
    # multiple envelope formats only runs once.
    for path in [
        ("event", "message", "message_id"),
        ("event", "open_message_id"),
        ("message", "message_id"),
        ("open_message_id",),
        ("message_id",),
        ("header", "event_id"),
        ("event_id",),
        ("uuid",),
    ]:
        val = nested(body, *path)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""

def maybe_verify_token(body: Dict[str, Any]) -> bool:
    if not VERIFY_TOKEN:
        return True
    token = body.get("token") or nested(body, "header", "token")
    return token == VERIFY_TOKEN


def is_card_action_callback(body: Dict[str, Any]) -> bool:
    event_type = nested(body, "header", "event_type")
    if not isinstance(event_type, str) or not event_type.strip():
        event_type = nested(body, "event", "type")
    return event_type == "card.action.trigger"


def filtered_forward_headers(headers: Any) -> Dict[str, str]:
    forwarded: Dict[str, str] = {}
    for name in FORWARDED_LARK_HEADERS:
        value = headers.get(name)
        if isinstance(value, str) and value.strip():
            forwarded[name] = value.strip()
    if "content-type" not in forwarded:
        forwarded["content-type"] = "application/json; charset=utf-8"
    return forwarded

def extract_text_from_content(content: Any) -> str:
    if isinstance(content, dict):
        structured = content.get("content")
        if isinstance(structured, list):
            parts: list[str] = []

            def walk(node: Any) -> None:
                if isinstance(node, list):
                    for item in node:
                        walk(item)
                    return
                if isinstance(node, dict):
                    text = node.get("text")
                    if isinstance(text, str) and text:
                        parts.append(text)
                    for value in node.values():
                        if isinstance(value, (list, dict)):
                            walk(value)

            walk(structured)
            if parts:
                return normalize_routing_text("".join(parts))
        for key in ["text", "text_without_at_bot", "title", "body"]:
            val = content.get(key)
            if isinstance(val, str) and val.strip():
                return normalize_routing_text(val)
        return ""

    if isinstance(content, str):
        raw = content.strip()
        if not raw:
            return ""
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict):
                structured = obj.get("content")
                if isinstance(structured, list):
                    parts: list[str] = []

                    def walk(node: Any) -> None:
                        if isinstance(node, list):
                            for item in node:
                                walk(item)
                            return
                        if isinstance(node, dict):
                            text = node.get("text")
                            if isinstance(text, str) and text:
                                parts.append(text)
                            for value in node.values():
                                if isinstance(value, (list, dict)):
                                    walk(value)

                    walk(structured)
                    if parts:
                        return normalize_routing_text("".join(parts))
                for key in ["text", "text_without_at_bot", "title", "body"]:
                    val = obj.get(key)
                    if isinstance(val, str) and val.strip():
                        return normalize_routing_text(val)
        except Exception:
            pass
        return normalize_routing_text(raw)
    return ""

def normalize_routing_text(text: str) -> str:
    cleaned = re.sub(r"<[^>]+>", " ", text or "")
    cleaned = re.sub(r"[\u200b-\u200d\ufeff]", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()

def normalize_short_control_candidate(text: str) -> str:
    cleaned = normalize_routing_text(text)
    cleaned = re.sub(r"^[>\-*\u2022\u00b7]+\s*", "", cleaned)
    cleaned = re.sub(r"^(?:\d+[.)]\s*)+", "", cleaned)
    cleaned = re.sub(r"[。！？!?]+$", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()

def canonical_short_control_alias(text: str) -> str:
    normalized = normalize_short_control_candidate(text)
    return normalized if normalized in SHORT_CONTROL_ALIASES else ""

def extract_text(body: Dict[str, Any]) -> str:
    candidates = [
        nested(body, "event", "message", "content"),
        nested(body, "event", "text"),
        nested(body, "message", "content"),
        nested(body, "content"),
        nested(body, "text"),
        nested(body, "event", "body"),
    ]
    for item in candidates:
        txt = extract_text_from_content(item)
        if txt:
            return txt
    return ""

def extract_target(body: Dict[str, Any]) -> str:
    candidates = [
        nested(body, "event", "message", "chat_id"),
        nested(body, "event", "message", "open_chat_id"),
        nested(body, "event", "chat_id"),
        nested(body, "event", "open_chat_id"),
        nested(body, "message", "chat_id"),
        nested(body, "message", "open_chat_id"),
        nested(body, "chat_id"),
        nested(body, "open_chat_id"),
        nested(body, "event", "sender", "sender_id", "open_id"),
        nested(body, "event", "sender", "sender_id", "user_id"),
    ]
    for val in candidates:
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""

def cache_target(target: str) -> None:
    if target:
        TARGET_CACHE.write_text(target, encoding="utf-8")
        logging.info("cached feishu target=%r", target)

def run_subprocess(cmd: list[str], timeout: int = 60, env_extra: Dict[str, str] | None = None) -> tuple[int, str, str]:
    env = os.environ.copy()
    if env_extra:
        env.update({k: v for k, v in env_extra.items() if isinstance(v, str) and v})
    res = subprocess.run(cmd, capture_output=True, text=True, cwd=str(ROOT), timeout=timeout, env=env)
    return res.returncode, (res.stdout or "").strip(), (res.stderr or "").strip()

def classify_command(text: str) -> Dict[str, Any]:
    try:
        code, out, err = run_subprocess(["bash", COMMAND_BIN, "--classify", text], timeout=20)
        logging.info("classify code=%s out=%r err=%r", code, out[:1000], err[:1000])
        payload = json.loads(out or "{}")
        return payload if isinstance(payload, dict) else {"is_command": False}
    except Exception as exc:
        logging.exception("classify failed: %s", exc)
        return {"is_command": False, "error": str(exc)}

def should_bypass_command_classifier(text: str) -> bool:
    normalized = normalize_short_control_candidate(text)
    lowered = normalized.lower()
    if not lowered:
        return False

    # Legacy command routing is now explicit-only. Natural-language requests
    # should reach the main agent path by default instead of being pre-empted by
    # the old local classifier.
    if normalized in SHORT_CONTROL_ALIASES:
        return False

    if normalized in LEGACY_EXACT_COMMAND_ALIASES:
        return False

    if lowered.startswith(LEGACY_PREFIX_COMMAND_ALIASES):
        return False

    # Only explicit learning intents stay on the legacy command path. Mixed or
    # active asks should go to the main agent unless the user is clearly asking
    # Lobster to study/store something for later.
    if looks_like_active_learning_request(normalized):
        return False

    if looks_like_queue_only_request(normalized):
        return False

    # Retain a final safety valve for simple “学习/记住” requests that do not
    # include an immediate execution ask, but stop broad research cue matching
    # from hijacking normal control-room language.
    if looks_like_learning_request(normalized) and not re.search(
        r"(打开|帮我|给我|分析|生成|推荐|列出|挑几个|最看好|报告|总结|浏览器|browser)",
        lowered,
        flags=re.I,
    ):
        return False

    return True

def is_legacy_shadow_event(body: Dict[str, Any]) -> bool:
    return bool(body.get("uuid")) and nested(body, "event", "message") is None

def rewrite_short_control_body(body: Dict[str, Any], canonical_text: str) -> Dict[str, Any]:
    if not canonical_text:
        return body

    event = body.get("event")
    if not isinstance(event, dict):
        return body
    message = event.get("message")
    if not isinstance(message, dict):
        return body

    rewritten = json.loads(json.dumps(body, ensure_ascii=False))
    rewritten_event = rewritten.get("event", {})
    rewritten_message = rewritten_event.get("message", {})
    rewritten_message["content"] = json.dumps({"text": canonical_text}, ensure_ascii=False)
    rewritten_message["message_type"] = "text"
    return rewritten

def lane_key_for_target(target: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9:_-]+", "_", (target or "").strip())
    return f"feishu:{normalized}" if normalized else "feishu:unknown"


def run_command(text: str, target: str = "") -> str:
    env_extra = {
        "LOBSTER_LANE_KEY": lane_key_for_target(target),
        "LOBSTER_SOURCE_SURFACE": "feishu",
        "LOBSTER_FEISHU_TARGET": target,
    }
    code, out, err = run_subprocess(["bash", COMMAND_BIN, text], timeout=3600, env_extra=env_extra)
    logging.info("run_command code=%s out=%r err=%r", code, out[:2000], err[:2000])
    payload = out if out else err
    if payload:
        return clip_text(format_command_reply(text, payload))
    return "命令执行完成，但没有可返回内容。"

def send_reply(target: str, text: str) -> Dict[str, Any]:
    try:
        code, out, err = run_subprocess([OPENCLAW_REPLY_BIN, target, clip_text(text)], timeout=90)
        logging.info(
            "reply_send code=%s target=%r text_preview=%r out=%r err=%r",
            code,
            target,
            clip_text(text, 240),
            out[:1200],
            err[:1200],
        )
        return {"ok": code == 0, "code": code, "stdout": out, "stderr": err}
    except Exception as exc:
        logging.exception("reply send failed")
        return {"ok": False, "code": 1, "stdout": "", "stderr": str(exc)}

def forward_to_origin(
    body: Dict[str, Any] | bytes,
    headers: Dict[str, str] | None = None,
) -> tuple[int, bytes]:
    payload = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request_headers = {"Content-Type": "application/json; charset=utf-8"}
    if headers:
        request_headers.update(headers)
    req = Request(
        ORIGIN_URL,
        data=payload,
        headers=request_headers,
        method="POST",
    )
    try:
        with urlopen(req, timeout=25) as resp:
            data = resp.read()
            logging.info("forward status=%s bytes=%s", resp.status, len(data))
            return resp.status, data
    except HTTPError as exc:
        data = exc.read()
        logging.exception("forward http error: %s", exc)
        return exc.code, data
    except URLError as exc:
        logging.exception("forward url error: %s", exc)
        return 502, json.dumps({"ok": False, "error": "forward_failed", "detail": str(exc)}).encode("utf-8")
    except Exception as exc:
        logging.exception("forward failed: %s", exc)
        return 502, json.dumps({"ok": False, "error": "forward_failed", "detail": str(exc)}).encode("utf-8")

class Handler(BaseHTTPRequestHandler):
    server_version = "LobsterProxy/targetcache"

    def _send_json(self, obj: Any, status: int = 200) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_bytes(self, data: bytes, status: int = 200, content_type: str = "application/json; charset=utf-8") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._send_json({
                "ok": True,
                "port": PORT,
                "origin_url": ORIGIN_URL,
                "command_bin": COMMAND_BIN,
                "reply_bin": OPENCLAW_REPLY_BIN,
                "last_feishu_target_exists": TARGET_CACHE.exists()
            })
            return
        self._send_json({"ok": False, "error": "not_found"}, 404)

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            body = {}

        logging.info("incoming path=%s body=%s", self.path, json.dumps(body, ensure_ascii=False)[:5000])

        if self.path == "/debug/send":
            text = body.get("text", "Lobster debug send")
            target = body.get("target", "")
            result = send_reply(target, text) if target else {"ok": False, "code": 2, "stdout": "", "stderr": "missing target"}
            self._send_json(result, 200 if result.get("ok") else 500)
            return

        if self.path not in ["/", "/feishu/events"]:
            self._send_json({"ok": False, "error": "not_found"}, 404)
            return

        if body.get("type") == "url_verification" and body.get("challenge"):
            self._send_json({"challenge": body["challenge"]})
            return

        if "encrypt" in body:
            status, data = forward_to_origin(raw, filtered_forward_headers(self.headers))
            self._send_bytes(data, status)
            return

        if is_card_action_callback(body):
            status, data = forward_to_origin(raw, filtered_forward_headers(self.headers))
            self._send_bytes(data, status)
            return

        if not maybe_verify_token(body):
            self._send_json({"ok": False, "error": "bad_token"}, 403)
            return

        text = extract_text(body)
        target = extract_target(body)
        canonical_control = canonical_short_control_alias(text)
        if target:
            cache_target(target)
        logging.info("extracted_text=%r extracted_target=%r", text, target)

        if is_legacy_shadow_event(body):
            logging.info("skipping legacy feishu shadow event")
            self._send_json({"ok": True, "skipped": "legacy_shadow_event"})
            return

        ev_id = event_id_of(body)
        if ev_id and already_seen(ev_id):
            self._send_json({"ok": True, "dedup": True})
            return

        if text and not should_bypass_command_classifier(text):
            cls = classify_command(normalize_short_control_candidate(text))
            if cls.get("is_command"):
                if not target:
                    logging.error("missing target for command text=%r body=%s", text, json.dumps(body, ensure_ascii=False)[:5000])
                    self._send_json({"ok": False, "error": "missing_target_for_reply", "classify": cls}, 500)
                    return

                def worker() -> None:
                    try:
                        reply = run_command(normalize_short_control_candidate(text), target=target)
                        send_reply(target, reply)
                    except Exception as exc:
                        logging.exception("command worker failed: %s", exc)
                        send_reply(target, f"命令执行失败\n{str(exc)[:1000]}")
                threading.Thread(target=worker, daemon=True).start()
                self._send_json({"ok": True, "queued": True, "classify": cls, "target": target})
                return

        status, data = forward_to_origin(
            rewrite_short_control_body(body, canonical_control),
            filtered_forward_headers(self.headers),
        )
        self._send_bytes(data, status)

    def log_message(self, fmt: str, *args: Any) -> None:
        logging.info("http " + fmt, *args)

def main() -> None:
    logging.info("proxy start port=%s root=%s", PORT, ROOT)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.serve_forever()

if __name__ == "__main__":
    raise SystemExit(main())
