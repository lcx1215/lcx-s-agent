#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path


def load_module(path: Path):
    spec = importlib.util.spec_from_file_location("learn_nlu_test_mod", path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> int:
    script_path = Path(__file__).resolve().parents[1] / "scripts" / "learn_nlu.py"
    module = load_module(script_path)

    generic = module.derive_generic_topic("把这个记住：market regime 以后要用")
    assert generic == "market regime", generic

    generic2 = module.derive_generic_topic("收进记忆 qqq ai capex and duration sensitivity")
    assert generic2 == "qqq ai capex and duration sensitivity", generic2

    generic3 = module.derive_generic_topic("自己去学开源的好的skills并内化")
    assert generic3 == "开源 skills", generic3

    generic3b = module.derive_generic_topic("自己去学几个开源技能，先内化一个就行，发群里短一点")
    assert generic3b == "开源 skills", generic3b

    generic3c = module.derive_generic_topic("去学一下 GitHub repo 里的 skill 设计和工作流")
    assert generic3c == "开源 skills", generic3c

    generic4 = module.derive_generic_topic("去读前沿金融论文")
    assert generic4 == "前沿金融论文", generic4

    generic4b = module.derive_generic_topic("读两篇 arxiv 金融 paper，抓方法")
    assert generic4b == "前沿金融论文", generic4b

    generic4c = module.derive_generic_topic("去学最新的好的金融策略论文里的值得你记住的")
    assert generic4c == "前沿金融论文", generic4c

    generic4d = module.derive_generic_topic("现在先学最新的好的金融策略论文里的值得你记住的")
    assert generic4d == "前沿金融论文", generic4d

    generic4e = module.derive_generic_topic("你去学习一个小时，学前沿论文里值得学习的策略和概念")
    assert generic4e == "前沿金融论文", generic4e

    generic5 = module.derive_generic_topic("去学期权能力")
    assert generic5 == "期权能力", generic5

    generic5b = module.derive_generic_topic("先补一点期权基本功，学完发群里")
    assert generic5b == "期权能力", generic5b

    generic5c = module.derive_generic_topic("补一下期权 greek 和对冲基本功")
    assert generic5c == "期权能力", generic5c

    generic6 = module.derive_generic_topic("去学股市分析能力")
    assert generic6 == "股市分析能力", generic6

    generic6b = module.derive_generic_topic("把股市分析基本功补一下，先跑一个，回群里")
    assert generic6b == "股市分析能力", generic6b

    generic6c = module.derive_generic_topic("补一下财报阅读和股票估值框架")
    assert generic6c == "股市分析能力", generic6c

    generic6d = module.derive_generic_topic("加强做空做多分析能力")
    assert generic6d == "股市分析能力", generic6d

    generic7 = module.derive_generic_topic("去学宏观 regime 和 risk-on risk-off 框架")
    assert generic7 == "宏观与市场结构", generic7

    generic8 = module.derive_generic_topic("补一下回撤控制和压力测试")
    assert generic8 == "风险控制能力", generic8

    generic9 = module.derive_generic_topic("补一下趋势跟踪、均线和 breakout 择时")
    assert generic9 == "技术择时能力", generic9

    generic9b = module.derive_generic_topic("学习一套很好的量化因子择时策略")
    assert generic9b == "量化因子择时策略", generic9b

    generic10 = module.derive_generic_topic("去学 openclaw 的最新更新并内化到自己")
    assert generic10 == "智能体系统更新", generic10

    generic11 = module.derive_generic_topic("去学其他前沿智能体最近怎么更新自己")
    assert generic11 == "智能体系统更新", generic11

    generic11b = module.derive_generic_topic("学习新的智能体架构并内化加到你自己身上")
    assert generic11b == "智能体系统更新", generic11b

    assert module.parse_duration_minutes("你去学习一个小时，学前沿论文里值得学习的策略和概念") == 60
    assert module.parse_duration_minutes("去学半小时期权能力") == 30
    assert module.parse_duration_minutes("去学两个小时宏观框架") == 120

    generic_bad = module.derive_generic_topic("不要入队 这是自我改进优先级测试 你现在只能做一件改进 不能做第二件 在下面三者中选一个 并说明为什么 A 更会 更多内容 B 更会在需要时调用旧方法 C 更会从网上找到资料 要求 先跑一个")
    assert generic_bad == "", generic_bad
    resolved_bad = module.resolve_learning_goal("不要入队 这是自我改进优先级测试 你现在只能做一件改进 不能做第二件 在下面三者中选一个 并说明为什么 A 更会 更多内容 B 更会在需要时调用旧方法 C 更会从网上找到资料 要求 先跑一个")
    assert resolved_bad["family"] == "", resolved_bad
    assert resolved_bad["canonical_topic"] == "", resolved_bad

    active_run = module.parse_actions("去学期权能力")
    assert active_run["want_run_next"] is True, active_run

    active_run2 = module.parse_actions("自己去学几个开源技能，先内化一个就行，发群里短一点")
    assert active_run2["want_run_next"] is True, active_run2

    active_run3 = module.parse_actions("读两篇 arxiv 金融 paper，抓方法")
    assert active_run3["want_run_next"] is True, active_run3

    active_run3b = module.parse_actions("去学最新的好的金融策略论文里的值得你记住的")
    assert active_run3b["want_run_next"] is True, active_run3b

    active_run3c = module.parse_actions("现在先学最新的好的金融策略论文里的值得你记住的")
    assert active_run3c["want_run_next"] is True, active_run3c
    assert active_run3c["want_bump"] is True, active_run3c

    active_run3d = module.parse_actions("你去学习一个小时，学前沿论文里值得学习的策略和概念")
    assert active_run3d["want_run_next"] is True, active_run3d
    assert active_run3d["duration_minutes"] == 60, active_run3d

    active_run4 = module.parse_actions("补一下期权 greek 和对冲基本功")
    assert active_run4["want_run_next"] is True, active_run4

    active_run5 = module.parse_actions("补一下财报阅读和股票估值框架")
    assert active_run5["want_run_next"] is True, active_run5

    active_run6 = module.parse_actions("去学宏观 regime 和 risk-on risk-off 框架")
    assert active_run6["want_run_next"] is True, active_run6

    active_run7 = module.parse_actions("补一下回撤控制和压力测试")
    assert active_run7["want_run_next"] is True, active_run7

    active_run8 = module.parse_actions("补一下趋势跟踪、均线和 breakout 择时")
    assert active_run8["want_run_next"] is True, active_run8

    active_run9 = module.parse_actions("去学 openclaw 的最新更新并内化到自己")
    assert active_run9["want_run_next"] is True, active_run9

    active_run10 = module.parse_actions("加强做空做多分析能力")
    assert active_run10["want_run_next"] is True, active_run10

    active_run11 = module.parse_actions("学习新的智能体架构并内化加到你自己身上")
    assert active_run11["want_run_next"] is True, active_run11

    assert module.resolve_learning_goal("补一下期权 greek 和对冲基本功")["focus"] == "greek / 对冲"
    assert module.resolve_learning_goal("补一下财报阅读和股票估值框架")["family"] == "stock_analysis"
    assert module.resolve_learning_goal("加强做空做多分析能力")["family"] == "stock_analysis"
    assert module.resolve_learning_goal("去学宏观 regime 和 risk-on risk-off 框架")["family"] == "macro_regime"
    assert module.resolve_learning_goal("补一下回撤控制和压力测试")["family"] == "risk_control"
    assert module.resolve_learning_goal("补一下趋势跟踪、均线和 breakout 择时")["family"] == "technical_timing"
    assert module.resolve_learning_goal("学习一套很好的量化因子择时策略")["family"] == "quant_factor_timing"
    assert module.resolve_learning_goal("去学 openclaw 的最新更新并内化到自己")["family"] == "agent_updates"
    assert module.resolve_learning_goal("学习新的智能体架构并内化加到你自己身上")["is_active_request"] is True
    assert module.resolve_learning_goal("现在先学最新的好的金融策略论文里的值得你记住的")["family"] == "frontier_paper"
    assert module.resolve_learning_goal("你去学习一个小时，学前沿论文里值得学习的策略和概念")["is_active_request"] is True

    with tempfile.TemporaryDirectory() as tmpdir:
        active_path = Path(tmpdir) / "active_sessions.json"
        active_path.write_text(
            json.dumps(
                {
                    "feishu:oc_test::前沿金融论文": {
                        "session_id": "existing-session",
                        "topic": "前沿金融论文",
                        "lane_key": "feishu:oc_test",
                        "minutes": 60,
                        "deadline_at": "2099-01-01T00:00:00Z",
                        "state_path": "branches/_system/learning_sessions/existing-session.json",
                        "target": "oc_test",
                    }
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        module.ACTIVE_SESSIONS_PATH = active_path
        existing = module.start_learning_session("前沿金融论文", "feishu:oc_test", 60)
        assert existing["ok"] is True, existing
        assert existing["existing"] is True, existing
        assert existing["session_id"] == "existing-session", existing

    queue_only = module.parse_actions("把这个记住：market regime 以后要用")
    assert queue_only["want_run_next"] is False, queue_only

    topics = module.extract_topics("把这个记住：market regime 以后要用")
    assert topics == [], topics

    print("OK learn_nlu generic topic")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
