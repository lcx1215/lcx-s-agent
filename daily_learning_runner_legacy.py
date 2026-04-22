#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime
from pathlib import Path

from scripts.learning_report_delivery import classify_report_delivery

ROOT = Path.home() / "Projects/openclaw"
CONFIG = ROOT / "scheduler_config.json"
STATE = ROOT / "learning_state.json"
CURRICULUM = ROOT / "knowledge_curriculum.json"
LOG_DIR = Path.home() / ".openclaw" / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
ENV_FILE = ROOT / ".env.lobster"

def load_env_file():
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

def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default

def save_json(path: Path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")

def completed_set(st):
    return {str(x).strip().lower() for x in st.get("completed_topics", [])}

def curriculum_has_unlearned(mode: str, st: dict) -> bool:
    curr = load_json(CURRICULUM, {})
    done = completed_set(st)
    if mode in curr.get("playbooks", {}):
        topics = curr["playbooks"][mode]
    elif mode in curr.get("tracks", {}):
        topics = curr["tracks"][mode]
    else:
        return True
    for t in topics:
        if t.strip().lower() not in done:
            return True
    return False

def pick_mode(cfg: dict, st: dict) -> str:
    if not cfg.get("auto_advance", True):
        return cfg.get("nightly_mode", "cheap_overnight_core")
    rotation = cfg.get("rotation_modes", ["cheap_overnight_core"])
    hist = st.get("history", [])
    start_idx = 0
    if hist:
        last_mode = hist[-1].get("mode", "")
        if last_mode in rotation:
            start_idx = (rotation.index(last_mode) + 1) % len(rotation)
    for offset in range(len(rotation)):
        mode = rotation[(start_idx + offset) % len(rotation)]
        if curriculum_has_unlearned(mode, st):
            return mode
    return "__maintenance__"


def autonomous_topic_expansion_enabled(cfg: dict) -> bool:
    return bool(cfg.get("allow_autonomous_topic_expansion", False))


def run_cmd(cmd: list[str]) -> dict:
    res = subprocess.run(
        cmd,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
        env=os.environ.copy(),
    )
    return {
        "code": res.returncode,
        "stdout": (res.stdout or "")[:8000],
        "stderr": (res.stderr or "")[:8000],
    }

def main() -> int:
    load_env_file()
    cfg = load_json(CONFIG, {})
    if not cfg.get("enabled", True):
        print("scheduler disabled")
        return 0

    st = load_json(STATE, {
        "generated_at": "",
        "completed_topics": [],
        "failed_topics": [],
        "playbook_progress": {},
        "last_run": {},
        "history": [],
        "scheduler": {
            "consecutive_failures": 0,
            "last_scheduler_run": ""
        }
    })

    scheduler_state = st.get("scheduler", {})
    consecutive_failures = int(scheduler_state.get("consecutive_failures", 0))
    if consecutive_failures >= int(cfg.get("max_consecutive_failures", 3)):
        print("scheduler halted: too many consecutive failures")
        return 1

    mode = pick_mode(cfg, st)
    limit = int(cfg.get("nightly_limit", 12))
    sleep_sec = float(cfg.get("nightly_sleep_sec", 1.2))
    log_file = LOG_DIR / f"scheduler_run_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"

    if mode == "__maintenance__":
        with log_file.open("w", encoding="utf-8") as f:
            f.write("maintenance mode: curriculum exhausted, run refresh + force clean only\n")
        class Dummy:
            returncode = 0
        proc = Dummy()
    else:
        cmd = ["bash", str(ROOT / "overnight_learn.sh"), mode, str(limit), str(sleep_sec)]
        with log_file.open("w", encoding="utf-8") as f:
            proc = subprocess.run(cmd, cwd=str(ROOT), stdout=f, stderr=subprocess.STDOUT, text=True, env=os.environ.copy())

    st = load_json(STATE, st)
    scheduler_state = st.get("scheduler", {})
    scheduler_state["last_scheduler_run"] = datetime.now().isoformat()
    scheduler_state["last_scheduler_mode"] = mode
    scheduler_state["last_scheduler_log"] = str(log_file)
    scheduler_state["last_scheduler_status"] = "maintenance" if mode == "__maintenance__" else "nightly"

    if proc.returncode == 0:
        scheduler_state["consecutive_failures"] = 0
    else:
        scheduler_state["consecutive_failures"] = int(scheduler_state.get("consecutive_failures", 0)) + 1

    st["scheduler"] = scheduler_state
    save_json(STATE, st)

    if autonomous_topic_expansion_enabled(cfg) and cfg.get("refresh_flagged_after_run", False):
        subprocess.run(["python3", str(ROOT / "refresh_flagged_topics.py"), "--limit", str(int(cfg.get("flagged_refresh_limit", 6))), "--sleep-sec", str(float(cfg.get("flagged_refresh_sleep_sec", 1.2)))], cwd=str(ROOT), check=False, env=os.environ.copy())

    if autonomous_topic_expansion_enabled(cfg) and cfg.get("force_clean_after_run", False):
        subprocess.run(["python3", str(ROOT / "force_clean_topics.py"), "--limit", str(int(cfg.get("force_clean_limit", 4))), "--sleep-sec", str(float(cfg.get("force_clean_sleep_sec", 1.0)))], cwd=str(ROOT), check=False, env=os.environ.copy())

    if cfg.get("auto_report", True):
        subprocess.run(["python3", str(ROOT / "make_learning_report.py")], cwd=str(ROOT), check=False, env=os.environ.copy())

    if cfg.get("push_feishu_report", True):
        report_send = run_cmd(["python3", str(ROOT / "send_learning_report_feishu.py")])
        delivery = classify_report_delivery(report_send)
        scheduler_state["last_report_delivery"] = {
            "at": datetime.now().isoformat(),
            "status": delivery["status"],
            "deliveryStatus": delivery.get("deliveryStatus"),
            "delivered": bool(delivery.get("delivered")),
            "reason": str(delivery.get("reason") or "")[:300],
        }
        st["scheduler"] = scheduler_state
        save_json(STATE, st)
        if delivery["delivered"]:
            print(f"report delivery: {delivery.get('deliveryStatus') or 'delivered'}")
        else:
            print(f"report delivery not verified: {delivery.get('deliveryStatus') or delivery['status']}")

    print(f"done: mode={mode} rc={proc.returncode} log={log_file}")
    return proc.returncode

if __name__ == "__main__":
    raise SystemExit(main())
