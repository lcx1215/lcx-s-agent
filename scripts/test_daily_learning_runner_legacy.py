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
    spec = importlib.util.spec_from_file_location("daily_learning_runner_legacy_test_mod", path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> int:
    path = Path(__file__).resolve().parents[1] / "daily_learning_runner_legacy.py"
    module = load_module(path)

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        module.ROOT = root
        module.CONFIG = root / "scheduler_config.json"
        module.STATE = root / "learning_state.json"
        module.CURRICULUM = root / "knowledge_curriculum.json"
        module.LOG_DIR = root / "logs"
        module.LOG_DIR.mkdir(parents=True, exist_ok=True)
        module.ENV_FILE = root / ".env.lobster"

        base_cfg = {
            "enabled": True,
            "nightly_mode": "cheap_overnight_core",
            "nightly_limit": 1,
            "nightly_sleep_sec": 0.1,
            "max_consecutive_failures": 3,
            "auto_advance": False,
            "auto_report": False,
            "push_feishu_report": False,
            "allow_autonomous_topic_expansion": False,
            "refresh_flagged_after_run": True,
            "force_clean_after_run": True,
        }
        module.CONFIG.write_text(json.dumps(base_cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        module.STATE.write_text(
            json.dumps(
                {
                    "completed_topics": [],
                    "failed_topics": [],
                    "history": [],
                    "scheduler": {"consecutive_failures": 0, "last_scheduler_run": ""},
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

        calls: list[list[str]] = []

        def fake_run(cmd, cwd=None, stdout=None, stderr=None, text=None, env=None, check=False, **kwargs):
            calls.append(list(cmd))
            rendered = " ".join(str(part) for part in cmd)
            if "send_learning_report_feishu.py" in rendered:
                payload = {
                    "ok": True,
                    "delivered": False,
                    "muted": True,
                    "deliveryStatus": "muted",
                }
                return SimpleNamespace(returncode=0, stdout=json.dumps(payload, ensure_ascii=False), stderr="")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        module.subprocess.run = fake_run
        rc = module.main()
        assert rc == 0, rc
        assert any("overnight_learn.sh" in part for call in calls for part in call), calls
        assert not any("refresh_flagged_topics.py" in part for call in calls for part in call), calls
        assert not any("force_clean_topics.py" in part for call in calls for part in call), calls

        calls.clear()
        enabled_cfg = dict(base_cfg)
        enabled_cfg["allow_autonomous_topic_expansion"] = True
        enabled_cfg["push_feishu_report"] = True
        module.CONFIG.write_text(json.dumps(enabled_cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        rc = module.main()
        assert rc == 0, rc
        assert any("refresh_flagged_topics.py" in part for call in calls for part in call), calls
        assert any("force_clean_topics.py" in part for call in calls for part in call), calls
        state = json.loads(module.STATE.read_text(encoding="utf-8"))
        assert state["scheduler"]["last_report_delivery"]["status"] == "skipped", state
        assert state["scheduler"]["last_report_delivery"]["delivered"] is False, state

        def delivered_run(cmd, cwd=None, stdout=None, stderr=None, text=None, env=None, check=False, **kwargs):
            calls.append(list(cmd))
            rendered = " ".join(str(part) for part in cmd)
            if "send_learning_report_feishu.py" in rendered:
                payload = {"ok": True, "delivered": True, "deliveryStatus": "sent"}
                return SimpleNamespace(returncode=0, stdout=json.dumps(payload, ensure_ascii=False), stderr="")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        module.subprocess.run = delivered_run
        rc = module.main()
        assert rc == 0, rc
        state = json.loads(module.STATE.read_text(encoding="utf-8"))
        assert state["scheduler"]["last_report_delivery"]["status"] == "delivered", state
        assert state["scheduler"]["last_report_delivery"]["delivered"] is True, state

        def malformed_run(cmd, cwd=None, stdout=None, stderr=None, text=None, env=None, check=False, **kwargs):
            calls.append(list(cmd))
            rendered = " ".join(str(part) for part in cmd)
            if "send_learning_report_feishu.py" in rendered:
                return SimpleNamespace(returncode=0, stdout="oops", stderr="")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        module.subprocess.run = malformed_run
        rc = module.main()
        assert rc == 0, rc
        state = json.loads(module.STATE.read_text(encoding="utf-8"))
        assert state["scheduler"]["last_report_delivery"]["status"] == "malformed", state
        assert state["scheduler"]["last_report_delivery"]["delivered"] is False, state

        def failed_run(cmd, cwd=None, stdout=None, stderr=None, text=None, env=None, check=False, **kwargs):
            calls.append(list(cmd))
            rendered = " ".join(str(part) for part in cmd)
            if "send_learning_report_feishu.py" in rendered:
                return SimpleNamespace(returncode=9, stdout="", stderr="push failed")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        module.subprocess.run = failed_run
        rc = module.main()
        assert rc == 0, rc
        state = json.loads(module.STATE.read_text(encoding="utf-8"))
        assert state["scheduler"]["last_report_delivery"]["status"] == "failed", state
        assert state["scheduler"]["last_report_delivery"]["delivered"] is False, state

    print("OK daily_learning_runner_legacy")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
