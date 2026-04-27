#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path


def load_module(path: Path):
    spec = importlib.util.spec_from_file_location("learn_nlu_targeted_test_mod", path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> int:
    script_path = Path(__file__).resolve().parents[1] / "scripts" / "learn_nlu.py"
    module = load_module(script_path)

    calls: list[tuple[str, ...]] = []

    def fake_sh_json(cmd, env_extra=None):
        calls.append(tuple(cmd))
        if cmd[:3] == ["python3", "./scripts/learn_queue.py", "set_status"]:
            return {"ok": True, "topic": cmd[3], "status": cmd[4], "lane_key": cmd[5]}
        if cmd[:2] == ["python3", "./scripts/run_local_batch_learner.py"]:
            assert env_extra == {"LOBSTER_LANE_KEY": "feishu:chat-alpha"}, env_extra
            return {
                "ok": True,
                "branch": "learn_branch",
                "summary": "learn task completed for topic: 前沿金融论文",
                "task_result": {"summary": "learn task completed for topic: 前沿金融论文"},
                "report_path": "knowledge/learn/2026-04-03_frontier_paper__lane_feishu-chat-alpha.md",
                "sources_path": "knowledge/learn/2026-04-03_frontier_paper__lane_feishu-chat-alpha.sources.json",
                "bookkeeping_result": {"status": "recorded"},
            }
        if cmd[:3] == ["python3", "./scripts/learn_queue.py", "finish"]:
            return {"ok": True, "topic": cmd[3], "lane_key": cmd[6]}
        raise AssertionError(f"unexpected command: {cmd}")

    module.sh_json = fake_sh_json
    result = module.run_current_topic("前沿金融论文", "feishu:chat-alpha")

    assert result["branch"] == "learn_branch", result
    assert result["queue_transition"]["finish"]["ok"] is True, result
    assert ("python3", "./scripts/run_local_batch_learner.py", "前沿金融论文") in calls, calls
    assert not any(call[:2] == ("python3", "./scripts/run_nightly_learning_batch.py") for call in calls), calls

    calls.clear()

    def fake_sh_json_visual(cmd, env_extra=None):
        calls.append(tuple(cmd))
        if cmd[:3] == ["python3", "./scripts/learn_queue.py", "set_status"]:
            return {"ok": True, "topic": cmd[3], "status": cmd[4], "lane_key": cmd[5]}
        if cmd[:2] == ["python3", "./scripts/run_visual_learning_capture.py"]:
            assert env_extra == {
                "LOBSTER_LANE_KEY": "feishu:chat-alpha",
                "LOBSTER_LEARNING_FAMILY": "stock_analysis",
                "LOBSTER_LEARNING_FOCUS": "图表 / 结构",
                "LOBSTER_LEARNING_STRATEGY": "equity_framework",
                "LOBSTER_LEARNING_RAW_TEXT": "去学股市分析，自己打开我电脑截图画图分析，保存到学习记忆里",
            }, env_extra
            return {
                "ok": True,
                "branch": "learn_branch",
                "mode": "visual_capture",
                "summary": "learn task completed for topic: 股市分析能力",
                "task_result": {"summary": "learn task completed for topic: 股市分析能力"},
                "report_path": "knowledge/learn/2026-04-03_股市分析能力__lane_feishu-chat-alpha.md",
                "sources_path": "knowledge/learn/2026-04-03_股市分析能力__lane_feishu-chat-alpha.sources.json",
                "bookkeeping_result": {"status": "recorded"},
            }
        if cmd[:3] == ["python3", "./scripts/learn_queue.py", "finish"]:
            return {"ok": True, "topic": cmd[3], "lane_key": cmd[6]}
        raise AssertionError(f"unexpected command: {cmd}")

    module.sh_json = fake_sh_json_visual
    visual_goal = {
        "family": "stock_analysis",
        "focus": "图表 / 结构",
        "strategy": "equity_framework",
        "raw_text": "去学股市分析，自己打开我电脑截图画图分析，保存到学习记忆里",
    }
    visual_result = module.run_current_topic(
        "股市分析能力",
        "feishu:chat-alpha",
        goal=visual_goal,
        raw_text=visual_goal["raw_text"],
        visual_capture=True,
    )
    assert visual_result["mode"] == "visual_capture", visual_result
    assert ("python3", "./scripts/run_visual_learning_capture.py", "去学股市分析，自己打开我电脑截图画图分析，保存到学习记忆里") in calls, calls

    print("OK learn_nlu targeted run")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
