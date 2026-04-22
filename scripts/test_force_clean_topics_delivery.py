#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace


def load_module(path: Path):
    repo_root = str(path.parent)
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)
    spec = importlib.util.spec_from_file_location("force_clean_topics_test_mod", path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    module = load_module(repo_root / "force_clean_topics.py")

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        module.ROOT = root
        module.ENV_FILE = root / ".env.lobster"
        module.STATE = root / "learning_state.json"
        module.load_force_clean_topics = lambda: {"finance_audit_force_clean": ["topic-a"]}
        module.os.environ["TAVILY_API_KEY"] = "test-key"
        module.save_state({})

        def base_runner(payload: dict | None = None, *, code: int = 0, stdout: str = "", stderr: str = ""):
            def fake_run(cmd, cwd=None, capture_output=None, text=None, timeout=None, env=None, check=None, stdout=None, stderr=None, **kwargs):
                rendered = " ".join(str(part) for part in cmd)
                if "online_learn_topic.py" in rendered:
                    return SimpleNamespace(returncode=0, stdout="ok", stderr="")
                if "send_learning_report_feishu.py" in rendered:
                    if payload is not None:
                        return SimpleNamespace(returncode=code, stdout=json.dumps(payload, ensure_ascii=False), stderr=stderr)
                    return SimpleNamespace(returncode=code, stdout=stdout, stderr=stderr)
                return SimpleNamespace(returncode=0, stdout="", stderr="")
            return fake_run

        original_argv = sys.argv[:]
        try:
            sys.argv = ["test_force_clean_topics_delivery.py", "--limit", "1", "--sleep-sec", "0"]

            module.subprocess.run = base_runner(
                {"ok": True, "delivered": False, "muted": True, "deliveryStatus": "muted"}
            )
            assert module.main() == 0
            state = json.loads(module.STATE.read_text(encoding="utf-8"))
            assert state["last_force_clean_run"]["report_delivery"]["status"] == "skipped", state
            assert state["last_force_clean_run"]["report_delivery"]["delivered"] is False, state

            module.subprocess.run = base_runner(
                {"ok": True, "delivered": True, "deliveryStatus": "sent"}
            )
            assert module.main() == 0
            state = json.loads(module.STATE.read_text(encoding="utf-8"))
            assert state["last_force_clean_run"]["report_delivery"]["status"] == "delivered", state
            assert state["last_force_clean_run"]["report_delivery"]["delivered"] is True, state

            module.subprocess.run = base_runner(payload=None, code=0, stdout="oops", stderr="")
            assert module.main() == 0
            state = json.loads(module.STATE.read_text(encoding="utf-8"))
            assert state["last_force_clean_run"]["report_delivery"]["status"] == "malformed", state
            assert state["last_force_clean_run"]["report_delivery"]["delivered"] is False, state

            module.subprocess.run = base_runner(payload=None, code=9, stdout="", stderr="push failed")
            assert module.main() == 0
            state = json.loads(module.STATE.read_text(encoding="utf-8"))
            assert state["last_force_clean_run"]["report_delivery"]["status"] == "failed", state
            assert state["last_force_clean_run"]["report_delivery"]["delivered"] is False, state
        finally:
            sys.argv = original_argv

    print("OK force_clean_topics delivery")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
