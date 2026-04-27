#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_module(path: Path):
    spec = importlib.util.spec_from_file_location("nlu_feedback_memory_test_mod", path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


def run_router(text: str, event_path: Path) -> dict:
    env = dict(os.environ)
    env["LOBSTER_NLU_FEEDBACK_EVENTS_PATH"] = str(event_path)
    res = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "run_nlu_action_router.py"), text],
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if res.returncode != 0:
        raise RuntimeError(f"router failed\nstdout:\n{res.stdout}\nstderr:\n{res.stderr}")
    return json.loads((res.stdout or "").strip())


def main() -> int:
    module = load_module(ROOT / "scripts" / "nlu_feedback_memory.py")

    with tempfile.TemporaryDirectory() as td:
        event_path = Path(td) / "feedback_events.jsonl"
        os.environ["LOBSTER_NLU_FEEDBACK_EVENTS_PATH"] = str(event_path)
        receipt = module.safe_append_feedback_event(
            raw_text="顺便学习宏观利率框架",
            source="test",
            reply_text="已识别：宏观与市场结构。",
            feedback={
                "status": "success",
                "understood": [{"action": "learn_topic", "topic": "宏观与市场结构", "family": "macro_regime"}],
                "queued": [{"topic": "宏观与市场结构"}],
                "completed": [],
                "artifacts": [],
                "learning_quality": {},
            },
            parser={"intent": "learn_topic", "tasks": [{"action": "learn_topic", "topic": "宏观与市场结构", "family": "macro_regime"}]},
            executed=[],
            action="learn_topic",
        )
        assert receipt["ok"] is True, receipt
        row = json.loads(event_path.read_text(encoding="utf-8").strip())
        sample = row["distillation_sample"]
        assert sample["utterance"] == "顺便学习宏观利率框架", sample
        assert sample["action"] == "learn_topic", sample
        assert sample["family"] == "macro_regime", sample
        assert sample["topic"] == "宏观与市场结构", sample
        assert sample["queued"] is True, sample
        assert sample["executed"] is False, sample

    with tempfile.TemporaryDirectory() as td:
        event_path = Path(td) / "router_events.jsonl"
        routed = run_router("顺便学习宏观利率框架", event_path)
        assert routed["feedback_memory"]["ok"] is True, routed
        assert routed["feedback_memory"]["sample"]["topic"] == "宏观与市场结构", routed
        rows = [json.loads(line) for line in event_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        assert len(rows) == 1, rows
        assert rows[0]["source"] == "run_nlu_action_router", rows
        assert rows[0]["distillation_sample"]["utterance"] == "顺便学习宏观利率框架", rows
        assert rows[0]["distillation_sample"]["queued"] is True, rows

    print("OK nlu_feedback_memory")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

