#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


def load_module(path: Path):
    repo_root = str(path.parent)
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)
    spec = importlib.util.spec_from_file_location("lobster_orchestrator_test_mod", path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    module = load_module(repo_root / "lobster_orchestrator.py")

    muted = module.classify_report_delivery(
        {
            "code": 0,
            "stdout": json.dumps(
                {"ok": True, "delivered": False, "muted": True, "deliveryStatus": "muted"},
                ensure_ascii=False,
            ),
            "stderr": "",
        }
    )
    assert muted["status"] == "skipped", muted
    assert muted["delivered"] is False, muted

    delivered = module.classify_report_delivery(
        {
            "code": 0,
            "stdout": json.dumps(
                {"ok": True, "delivered": True, "deliveryStatus": "sent"},
                ensure_ascii=False,
            ),
            "stderr": "",
        }
    )
    assert delivered["status"] == "delivered", delivered
    assert delivered["delivered"] is True, delivered

    malformed = module.classify_report_delivery({"code": 0, "stdout": "not json", "stderr": ""})
    assert malformed["status"] == "malformed", malformed
    assert malformed["delivered"] is False, malformed

    failed = module.classify_report_delivery({"code": 7, "stdout": "", "stderr": "network broke"})
    assert failed["status"] == "failed", failed
    assert failed["delivered"] is False, failed

    original_run_cmd = module.run_cmd
    original_record_binding_usage = module.record_binding_usage
    original_maybe_alert = module.maybe_alert
    original_attach_codex_escalation = module.attach_codex_escalation
    try:
        def muted_runner(cmd: list[str], timeout: int = 7200):
            if str(cmd[-1]).endswith("make_learning_report.py"):
                return {"code": 0, "stdout": "built", "stderr": ""}
            return {
                "code": 0,
                "stdout": json.dumps(
                    {"ok": True, "delivered": False, "muted": True, "deliveryStatus": "muted"},
                    ensure_ascii=False,
                ),
                "stderr": "",
            }

        module.run_cmd = muted_runner
        module.record_binding_usage = lambda wf, job_name: None
        module.maybe_alert = lambda stage, result: None
        module.attach_codex_escalation = lambda *args, **kwargs: None

        wf = {"last_results": {}}
        report = module.do_report(wf)
        assert report["status"] == "skipped", report
        assert wf.get("done_recent", []) == [], wf
        assert wf.get("failed_recently", []) == [], wf

        def delivered_runner(cmd: list[str], timeout: int = 7200):
            if str(cmd[-1]).endswith("make_learning_report.py"):
                return {"code": 0, "stdout": "built", "stderr": ""}
            return {
                "code": 0,
                "stdout": json.dumps(
                    {"ok": True, "delivered": True, "deliveryStatus": "sent"},
                    ensure_ascii=False,
                ),
                "stderr": "",
            }

        module.run_cmd = delivered_runner
        wf = {"last_results": {}}
        report = module.do_report(wf)
        assert report["status"] == "delivered", report
        assert wf["done_recent"][-1]["action"] == "report", wf

        def malformed_runner(cmd: list[str], timeout: int = 7200):
            if str(cmd[-1]).endswith("make_learning_report.py"):
                return {"code": 0, "stdout": "built", "stderr": ""}
            return {"code": 0, "stdout": "oops", "stderr": ""}

        module.run_cmd = malformed_runner
        wf = {"last_results": {}}
        report = module.do_report(wf)
        assert report["status"] == "failed", report
        assert wf["failed_recently"][-1]["action"] == "report", wf
    finally:
        module.run_cmd = original_run_cmd
        module.record_binding_usage = original_record_binding_usage
        module.maybe_alert = original_maybe_alert
        module.attach_codex_escalation = original_attach_codex_escalation

    print("OK learning report delivery")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
