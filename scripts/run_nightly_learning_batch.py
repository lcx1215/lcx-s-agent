#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
STATE_PATH = ROOT / "branches" / "learn" / "night_batch_state.json"
REPORT_DIR = ROOT / "knowledge" / "learn_batch"
REPORT_DIR.mkdir(parents=True, exist_ok=True)

def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

def sh(cmd, env_extra=None):
    env = None
    if env_extra:
        env = dict(os.environ)
        env.update(env_extra)
    p = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True, env=env)
    out = (p.stdout or p.stderr or "").strip()
    if not out:
        return {"ok": False, "error": "empty output", "cmd": " ".join(cmd)}
    try:
        return json.loads(out)
    except Exception:
        return {"ok": False, "error": "non-json output", "cmd": " ".join(cmd), "raw": out[:1000]}

def write_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")

def write_report(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def load_brain_trace_summary(path_str: str) -> dict:
    relative = (path_str or "").strip()
    if not relative:
        return {}
    source_obj = load_json(ROOT / relative, {})
    summary = source_obj.get("brain_trace_summary", {})
    return summary if isinstance(summary, dict) else {}


def summarize_batch_brain_trace(runs: list[dict]) -> dict:
    intents: list[str] = []
    item_brain_types: list[str] = []
    per_topic = []
    for row in runs:
        trace = row.get("brain_trace_summary", {}) if isinstance(row, dict) else {}
        for intent in trace.get("intents", []) or []:
            if intent not in intents:
                intents.append(intent)
        for brain_type in trace.get("item_brain_types", []) or []:
            if brain_type not in item_brain_types:
                item_brain_types.append(brain_type)
        per_topic.append(
            {
                "topic": row.get("topic", ""),
                "lane_key": row.get("lane_key", "global"),
                "intents": trace.get("intents", []) or [],
                "item_brain_types": trace.get("item_brain_types", []) or [],
            }
        )
    return {
        "intents": intents,
        "item_brain_types": item_brain_types,
        "per_topic": per_topic,
    }


def score_learning_quality(runs: list[dict]) -> dict:
    successful = [row for row in runs if row.get("status") == "success"]
    with_trace = [
        row
        for row in successful
        if row.get("brain_trace_summary", {}).get("intents")
        and row.get("brain_trace_summary", {}).get("item_brain_types")
    ]
    status = "none"
    if successful and len(with_trace) == len(successful):
        status = "usable"
    elif successful:
        status = "partial"
    return {
        "status": status,
        "successful_topics": len(successful),
        "topics_with_brain_trace": len(with_trace),
        "needs_upgrade": [
            "real external source retrieval",
            "source quality scoring",
            "deduplicated distilled lessons",
        ],
    }

def pick_next_topics(limit: int):
    q = sh([sys.executable, str(ROOT / "scripts" / "learn_queue.py"), "list"])
    if not q.get("ok"):
        return {"ok": False, "error": "queue list failed", "queue": q}

    items = q.get("items", [])
    queued = [x for x in items if x.get("status") == "queued"]

    def sort_key(x):
        return (-int(x.get("priority", 0) or 0), x.get("updated_at", ""), x.get("created_at", ""))

    queued = sorted(queued, key=sort_key)
    return {"ok": True, "items": queued[:limit]}

def mark_running(topic: str, lane_key: str = ""):
    cmd = [sys.executable, str(ROOT / "scripts" / "learn_queue.py"), "set_status", topic, "running"]
    if lane_key:
        cmd.append(lane_key)
    return sh(cmd)

def mark_done(topic: str, report_path: str, sources_path: str, lane_key: str = ""):
    cmd = [
        sys.executable, str(ROOT / "scripts" / "learn_queue.py"), "finish",
        topic, report_path, sources_path
    ]
    if lane_key:
        cmd.append(lane_key)
    return sh(cmd)

def mark_failed(topic: str, err: str, lane_key: str = ""):
    cmd = [
        sys.executable, str(ROOT / "scripts" / "learn_queue.py"), "fail",
        topic, err[:300]
    ]
    if lane_key:
        cmd.append(lane_key)
    return sh(cmd)

def run_one(topic: str, lane_key: str = ""):
    env_extra = {"LOBSTER_LANE_KEY": lane_key} if lane_key else None
    return sh([sys.executable, str(ROOT / "scripts" / "run_local_batch_learner.py"), topic], env_extra=env_extra)


def build_feishu_batch_summary(report_path):
    import re
    from pathlib import Path

    report_path = Path(report_path)
    if not report_path.exists():
        return "夜间学习已完成，但未找到 batch 报告。"

    txt = report_path.read_text(encoding="utf-8", errors="ignore")
    rows = re.findall(r"### (.+?)\n- status: success\n- report_path: (.+?)\n", txt, flags=re.S)

    if not rows:
        return "夜间学习已完成，但本次没有可总结的新主题。"

    lines = []
    for topic, rp in rows[:3]:
        rp = (ROOT / rp.strip())
        conclusion = ""
        if rp.exists():
            body = rp.read_text(encoding="utf-8", errors="ignore")
            m = re.search(r"## 5\. Current Conclusion\s*-\s*(.+)", body)
            if not m:
                m = re.search(r"## 4\. Branch Summary\s*-\s*(.+)", body)
            if m:
                conclusion = m.group(1).strip()
        if not conclusion:
            conclusion = "已完成学习，结论待人工精炼。"
        lines.append(f"- {topic}: {conclusion}")

    return "夜间学习已完成：\n" + "\n".join(lines)

def try_send_feishu_summary(report_path):
    import subprocess

    msg = build_feishu_batch_summary(report_path)
    last_result = None
    for attempt in range(1, 3):
        try:
            res = subprocess.run(
                ["bash", "./send_feishu_reply.sh", msg],
                cwd=str(ROOT),
                capture_output=True,
                text=True
            )
            out = (res.stdout or res.stderr or "").strip()
            last_result = {
                "ok": res.returncode == 0,
                "cmd": "bash ./send_feishu_reply.sh",
                "message": msg,
                "attempts": attempt,
                "output": out[:1200]
            }
            if res.returncode == 0 or "504" not in out:
                return last_result
        except Exception as e:
            last_result = {
                "ok": False,
                "cmd": "bash ./send_feishu_reply.sh",
                "message": msg,
                "attempts": attempt,
                "output": str(e)[:500]
            }
            if "504" not in str(e):
                return last_result
        time.sleep(2)

    if last_result is not None:
        return last_result
    try:
        res = subprocess.run(
            ["bash", "./send_feishu_reply.sh", msg],
            cwd=str(ROOT),
            capture_output=True,
            text=True
        )
        out = (res.stdout or res.stderr or "").strip()
        return {
            "ok": res.returncode == 0,
            "cmd": "bash ./send_feishu_reply.sh",
            "message": msg,
            "output": out[:1200]
        }
    except Exception as e:
        return {
            "ok": False,
            "cmd": "bash ./send_feishu_reply.sh",
            "message": msg,
            "output": str(e)[:500]
        }


def main():
    limit = 3
    if len(sys.argv) > 1:
        try:
            limit = max(1, int(sys.argv[1]))
        except Exception:
            pass

    picked = pick_next_topics(limit)
    if not picked.get("ok"):
        obj = {
            "ok": False,
            "branch": "night_batch_learn",
            "status": "error",
            "mode": "normal",
            "summary": "night learning batch failed before picking topics",
            "error": picked.get("error", "pick failed"),
            "detail": picked,
        }
        print(json.dumps(obj, ensure_ascii=False, indent=2))
        return 1

    topics = picked["items"]
    runs = []

    for row in topics:
        topic = row.get("topic", "").strip()
        lane_key = str(row.get("lane_key") or "").strip()
        if not topic:
            continue

        mark_running(topic, lane_key)
        res = run_one(topic, lane_key)
        bookkeeping = res.get("bookkeeping_result", {}) if isinstance(res, dict) else {}
        bookkeeping_status = bookkeeping.get("status", "recorded")

        if res.get("ok") and bookkeeping_status == "recorded":
            report_path = res.get("report_path", "")
            sources_path = res.get("sources_path", "")
            brain_trace_summary = load_brain_trace_summary(sources_path)
            mark_done(topic, report_path, sources_path, lane_key)
            runs.append({
                "topic": topic,
                "lane_key": lane_key or "global",
                "status": "success",
                "report_path": report_path,
                "sources_path": sources_path,
                "bookkeeping_status": bookkeeping_status,
                "brain_trace_summary": brain_trace_summary,
            })
        elif res.get("ok"):
            err = f"bookkeeping {bookkeeping_status}"
            brain_trace_summary = load_brain_trace_summary(res.get("sources_path", ""))
            mark_failed(topic, err, lane_key)
            runs.append({
                "topic": topic,
                "lane_key": lane_key or "global",
                "status": "partial",
                "report_path": res.get("report_path", ""),
                "sources_path": res.get("sources_path", ""),
                "bookkeeping_status": bookkeeping_status,
                "pending_path": bookkeeping.get("pending_path", ""),
                "anomaly_path": bookkeeping.get("anomaly_path", ""),
                "brain_trace_summary": brain_trace_summary,
            })
        else:
            err = res.get("error") or res.get("summary") or "unknown learner failure"
            mark_failed(topic, err, lane_key)
            runs.append({
                "topic": topic,
                "lane_key": lane_key or "global",
                "status": "failed",
                "error": err
            })

    day = datetime.now().strftime("%Y-%m-%d")
    report_path = REPORT_DIR / f"{day}_night_batch.md"
    sources_path = REPORT_DIR / f"{day}_night_batch.sources.json"

    lines = [
        f"# Night Learning Batch - {day}",
        "",
        "## 1. Batch Summary",
        f"- picked_topics: {len(runs)}",
        "",
        "## 2. Topic Runs",
    ]

    if not runs:
        lines += [
            "- no queued topic picked",
            "",
            "## 3. Branch Summary",
            "- Night batch runner completed."
        ]
    else:
        for r in runs:
            lines.append(f"### {r['topic']}")
            lines.append(f"- lane_key: {r.get('lane_key', 'global')}")
            lines.append(f"- status: {r['status']}")
            if r["status"] in {"success", "partial"}:
                lines.append(f"- report_path: {r['report_path']}")
                lines.append(f"- sources_path: {r['sources_path']}")
                if r.get("bookkeeping_status"):
                    lines.append(f"- bookkeeping_status: {r['bookkeeping_status']}")
                if r.get("pending_path"):
                    lines.append(f"- pending_path: {r['pending_path']}")
            else:
                lines.append(f"- error: {r['error']}")
            lines.append("")
        lines += [
            "## 3. Branch Summary",
            "- Night batch runner completed."
        ]

    write_report(report_path, "\n".join(lines))
    batch_brain_trace = summarize_batch_brain_trace(runs)
    learning_quality = score_learning_quality(runs)

    write_json(sources_path, {
        "generated_at": now_iso(),
        "runs": runs,
        "brain_trace_summary": batch_brain_trace,
        "learning_quality": learning_quality,
    })

    state = {
        "night_batch_learn": {
            "enabled": True,
            "status": "success",
            "mode": "normal",
            "last_run_at": now_iso(),
            "summary": f"night learning batch completed with {len(runs)} topics",
            "report_path": str(report_path.relative_to(ROOT)),
            "sources_path": str(sources_path.relative_to(ROOT)),
            "provider_used": {
                "retrieval": "cheap_retrieval_router",
                "analysis": "local_direct",
                "synthesis": "local_direct"
            },
            "brain_trace_summary": batch_brain_trace,
            "learning_quality": learning_quality,
        }
    }
    write_json(STATE_PATH, state)

    obj = {
        "ok": True,
        "branch": "night_batch_learn",
        "status": "success",
        "mode": "normal",
        "summary": f"night learning batch completed with {len(runs)} topics",
        "report_path": str(report_path.relative_to(ROOT)),
        "sources_path": str(sources_path.relative_to(ROOT))
    }

    try:
        obj["feishu_send"] = try_send_feishu_summary(report_path)
    except Exception as e:
        obj["feishu_send"] = {
            "ok": False,
            "cmd": "bash ./send_feishu_reply.sh",
            "message": "",
            "output": str(e)[:500]
        }

    print(json.dumps(obj, ensure_ascii=False, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
