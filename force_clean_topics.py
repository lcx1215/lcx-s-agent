#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from scripts.learning_report_delivery import classify_report_delivery
from scripts.lobster_paths import load_state_json

ROOT = Path.home() / "Projects/openclaw"
ENV_FILE = ROOT / ".env.lobster"
STATE = ROOT / "learning_state.json"

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def load_env_file() -> None:
    if not ENV_FILE.exists():
        return
    for raw in ENV_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v

def load_state():
    if not STATE.exists():
        return {}
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:
        return {}

def save_state(st):
    STATE.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding="utf-8")


def load_force_clean_topics() -> dict:
    return load_state_json("clean_priority_topics.json", {"finance_audit_force_clean": []})


def run_cmd(cmd: list[str], env: dict[str, str], timeout: int | None = None) -> dict:
    res = subprocess.run(
        cmd,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
        check=False,
    )
    return {
        "code": res.returncode,
        "stdout": (res.stdout or "")[:8000],
        "stderr": (res.stderr or "")[:8000],
    }

def main() -> int:
    load_env_file()

    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=8)
    ap.add_argument("--sleep-sec", type=float, default=1.0)
    args = ap.parse_args()

    if not os.environ.get("TAVILY_API_KEY"):
        raise SystemExit("ERROR: TAVILY_API_KEY missing")

    data = load_force_clean_topics()
    topics = data.get("finance_audit_force_clean", [])[:args.limit]

    st = load_state()
    hist = st.get("force_clean_history", [])
    run = {
        "started_at": now_iso(),
        "topics": topics,
        "completed": [],
        "failed": []
    }

    child_env = os.environ.copy()

    for i, topic in enumerate(topics, start=1):
        print(f"[force-clean {i}/{len(topics)}] {topic}", flush=True)
        res = subprocess.run(
            [
                "python3", str(ROOT / "online_learn_topic.py"),
                "--project-root", str(ROOT),
                "--topic", topic,
                "--stdout-brief",
                "--strict-teaching-sources"
            ],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=1200,
            env=child_env
        )
        if res.returncode == 0:
            run["completed"].append(topic)
            print(f"OK CLEAN: {topic}", flush=True)
        else:
            run["failed"].append({
                "topic": topic,
                "stderr": (res.stderr or "")[:1200],
                "stdout": (res.stdout or "")[:1200]
            })
            print(f"FAIL CLEAN: {topic}", flush=True)
        time.sleep(args.sleep_sec)

    run["finished_at"] = now_iso()
    hist.append(run)
    st["force_clean_history"] = hist
    st["last_force_clean_run"] = run
    save_state(st)

    subprocess.run(["python3", str(ROOT / "knowledge_index_builder.py")], cwd=str(ROOT), check=False, env=child_env)
    subprocess.run(["python3", str(ROOT / "knowledge_quality_audit.py")], cwd=str(ROOT), check=False, env=child_env)
    subprocess.run(["python3", str(ROOT / "make_learning_report.py")], cwd=str(ROOT), check=False, env=child_env)
    report_send = run_cmd(["python3", str(ROOT / "send_learning_report_feishu.py")], env=child_env)
    delivery = classify_report_delivery(report_send)
    run["report_delivery"] = {
        "path": "manual side path",
        "status": delivery["status"],
        "deliveryStatus": delivery.get("deliveryStatus"),
        "delivered": bool(delivery.get("delivered")),
        "reason": str(delivery.get("reason") or "")[:300],
    }
    st["last_force_clean_run"] = run
    save_state(st)

    if delivery["delivered"]:
        print(f"manual side path report delivery: {delivery.get('deliveryStatus') or 'delivered'}", flush=True)
    else:
        print(
            f"manual side path report delivery not verified: {delivery.get('deliveryStatus') or delivery['status']}",
            flush=True,
        )

    print(json.dumps({
        "completed": len(run["completed"]),
        "failed": len(run["failed"]),
        "topics": topics,
        "report_delivery": run["report_delivery"],
    }, ensure_ascii=False, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
