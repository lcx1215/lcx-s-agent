#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run_py(script: str, text: str) -> dict:
    res = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / script), text],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    if res.returncode != 0:
        raise RuntimeError(f"{script} failed\nstdout:\n{res.stdout}\nstderr:\n{res.stderr}")
    return json.loads((res.stdout or "").strip())


def main() -> int:
    parsed = run_py("feishu_nlu_parser.py", "系统怎么改造自己")
    assert parsed["needs_clarification"] is False, parsed
    assert parsed["tasks"][0]["action"] == "brain_bootstrap", parsed
    assert parsed["tasks"][0]["query"] == "系统怎么改造自己", parsed

    routed = run_py("run_nlu_action_router.py", "系统怎么改造自己")
    assert routed["mode"] == "executed", routed
    assert routed["executed"][0]["action"] == "brain_bootstrap", routed
    result = routed["executed"][0]["result"]
    inner = json.loads(result["stdout"])
    assert inner["intent"] == "study_bootstrap", inner
    assert inner["items"][0]["path"] == "knowledge/topic_memory/market_regime.md", inner

    control_text = "给我一个今天的控制室总结，如果错了最可能错在哪"
    control_parsed = run_py("feishu_nlu_parser.py", control_text)
    assert control_parsed["needs_clarification"] is False, control_parsed
    assert control_parsed["tasks"][0]["action"] == "control_room_summary", control_parsed
    assert control_parsed["tasks"][0]["red_team"] is True, control_parsed

    control_routed = run_py("run_nlu_action_router.py", control_text)
    assert control_routed["mode"] == "executed", control_routed
    assert control_routed["executed"][0]["action"] == "control_room_summary", control_routed
    control_stdout = control_routed["executed"][0]["result"]["stdout"]
    assert "今天控制室总结" in control_stdout, control_stdout
    assert "如果现在最可能错" in control_stdout, control_stdout

    classify = subprocess.run(
        ["bash", str(ROOT / "lobster_command_v2.sh"), "--classify", control_text],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    assert classify.returncode == 0, classify.stderr
    classify_payload = json.loads((classify.stdout or "").strip())
    assert classify_payload["items"][0]["action"] == "control_room_summary", classify_payload

    direct = subprocess.run(
        ["bash", str(ROOT / "lobster_command_v2.sh"), control_text],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    assert direct.returncode == 0, direct.stderr
    assert "今天控制室总结" in (direct.stdout or ""), direct.stdout
    assert "如果现在最可能错" in (direct.stdout or ""), direct.stdout

    overview_text = "现在整体怎么样，先给我一个总览"
    overview_parsed = run_py("feishu_nlu_parser.py", overview_text)
    assert overview_parsed["needs_clarification"] is False, overview_parsed
    assert overview_parsed["tasks"][0]["action"] == "control_room_summary", overview_parsed
    assert overview_parsed["tasks"][0]["red_team"] is False, overview_parsed

    overview_classify = subprocess.run(
        ["bash", str(ROOT / "lobster_command_v2.sh"), "--classify", overview_text],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    assert overview_classify.returncode == 0, overview_classify.stderr
    overview_payload = json.loads((overview_classify.stdout or "").strip())
    assert overview_payload["items"][0]["action"] == "control_room_summary", overview_payload

    overview_direct = subprocess.run(
        ["bash", str(ROOT / "lobster_command_v2.sh"), overview_text],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    assert overview_direct.returncode == 0, overview_direct.stderr
    assert "今天控制室总结" in (overview_direct.stdout or ""), overview_direct.stdout
    assert "如果现在最可能错" not in (overview_direct.stdout or ""), overview_direct.stdout

    learn_text = "现在先学最新的好的金融策略论文里的值得你记住的"
    learn_parsed = run_py("feishu_nlu_parser.py", learn_text)
    assert learn_parsed["needs_clarification"] is False, learn_parsed
    assert learn_parsed["tasks"][0]["action"] == "learn_topic", learn_parsed
    assert learn_parsed["tasks"][0]["topic"] == "前沿金融论文", learn_parsed
    learn_routed = run_py("run_nlu_action_router.py", learn_text)
    assert learn_routed["mode"] == "executed", learn_routed
    assert learn_routed["executed"][0]["action"] == "queue_topic", learn_routed
    assert learn_routed["executed"][1]["action"] == "learn_topic", learn_routed
    assert learn_routed["executed"][1]["result"]["code"] == 0, learn_routed

    print("OK run_nlu_action_router brain bootstrap + control room summary + learning task")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
