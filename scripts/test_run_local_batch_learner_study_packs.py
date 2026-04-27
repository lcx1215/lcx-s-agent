#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
from pathlib import Path


def load_module(path: Path):
    spec = importlib.util.spec_from_file_location("run_local_batch_learner_test_mod", path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def main() -> int:
    script_path = Path(__file__).resolve().parents[1] / "scripts" / "run_local_batch_learner.py"
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        module = load_module(script_path)
        module.ROOT = root
        module.REPORT_DIR = root / "knowledge" / "learn"
        module.STATE_PATH = root / "branches" / "learn" / "learn_state.json"
        module.PENDING_PATH = root / "branches" / "learn" / "learn_bookkeeping_pending.json"
        module.ANOMALY_PATH = root / "branches" / "learn" / "learn_bookkeeping_anomalies.jsonl"
        module.ONLINE_DIR = root / "knowledge" / "online"
        module.REPO_SKILLS_DIR = root / "skills"
        module.EXTENSION_SKILLS_DIR = root / "extensions"
        module.HOME_SKILLS_DIR = root / "home-skills"
        module.REPORT_DIR.mkdir(parents=True, exist_ok=True)
        module.STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        module.rebuild_topic_memory = lambda: {"ok": True, "label": "topic_memory", "path": "branches/learn/topic_memory_index.json"}
        module.run_search = lambda query: (_ for _ in ()).throw(AssertionError(f"run_search should not be used for study packs: {query}"))

        write_text(
            root / "home-skills" / "playwright" / "SKILL.md",
            "\n".join([
                "---",
                'name: "playwright"',
                'description: "Automate a real browser from the terminal and capture screenshots or traces."',
                "---",
                "",
                "# Playwright",
                "",
                "## Workflow",
                "- Open the page, snapshot the UI, and interact with stable refs.",
                "- Re-snapshot after major DOM changes.",
            ]),
        )
        write_text(
            root / "skills" / "session-logs" / "SKILL.md",
            "\n".join([
                "---",
                'name: "session-logs"',
                'description: "Inspect agent session logs and extract concrete failure evidence."',
                "---",
                "",
                "## When to use",
                "- Use when an agent loop is confused and you need exact evidence.",
            ]),
        )
        write_text(
            root / "knowledge" / "online" / "delta-audit-topic.md",
            "\n".join([
                "# delta audit topic",
                "",
                "## Key takeaways",
                "- Delta tells you the first-order directional exposure of an option position.",
                "- Always separate directional delta from gamma and vega before trusting the payoff story.",
            ]),
        )
        write_text(
            root / "knowledge" / "online" / "gamma-clean-topic.md",
            "\n".join([
                "# gamma clean topic",
                "",
                "## Key takeaways",
                "- Gamma risk can force large hedge adjustments when the underlying moves quickly.",
                "- Practice drills should include hedge slippage and gap scenarios.",
            ]),
        )
        write_text(
            root / "knowledge" / "online" / "factor-investing-basics.md",
            "\n".join([
                "# factor investing basics",
                "",
                "## Key takeaways",
                "- Stock analysis starts with a repeatable framework instead of isolated tips.",
                "- Factor, macro, and market-microstructure views should be checked together.",
                "- Factor timing should combine a persistent factor signal with explicit regime and cost controls.",
            ]),
        )
        write_text(
            root / "knowledge" / "online" / "dual-momentum.md",
            "\n".join([
                "# dual momentum",
                "",
                "## Key takeaways",
                "- Dual momentum combines cross-sectional strength with time-series momentum as a timing gate.",
                "- It can fail when leadership reverses, factors crowd, or the regime changes abruptly.",
            ]),
        )
        write_text(
            root / "knowledge" / "online" / "turnover.md",
            "\n".join([
                "# turnover",
                "",
                "## Key takeaways",
                "- Factor rotation must subtract turnover, transaction cost, and tax drag before accepting an edge.",
                "- High turnover can turn a beautiful signal into an untradable strategy.",
            ]),
        )
        write_text(
            root / "knowledge" / "online" / "market-microstructure-basics.md",
            "\n".join([
                "# market microstructure basics",
                "",
                "## Key takeaways",
                "- Microstructure helps explain spread, liquidity, and execution quality.",
                "- It matters when judging whether price action is noisy or informative.",
            ]),
        )
        write_text(
            root / "knowledge" / "online" / "feature-engineering.md",
            "\n".join([
                "# feature engineering",
                "",
                "## Source notes",
                "- domain: `arxiv.org`",
                "- Extract the paper contribution, feature design, and evaluation setup before trusting results.",
            ]),
        )
        write_text(
            root / "knowledge" / "online" / "backtest-assumptions.md",
            "\n".join([
                "# backtest assumptions",
                "",
                "## Key takeaways",
                "- A paper is only credible when its backtest assumptions are explicit and testable.",
                "- Hidden assumptions usually mean the result will not survive live use.",
            ]),
        )
        write_text(
            root / "knowledge" / "online" / "walk-forward-validation.md",
            "\n".join([
                "# walk forward validation",
                "",
                "## Key takeaways",
                "- Frontier finance papers should be checked for walk-forward and out-of-sample discipline.",
                "- Beautiful in-sample results are not enough.",
            ]),
        )
        write_text(
            root / "knowledge" / "online" / "macro-regimes.md",
            "\n".join([
                "# macro regimes",
                "",
                "## Key takeaways",
                "- Macro regime work starts by separating inflation, rates, and liquidity drivers.",
                "- The first drill is to state which regime would invalidate the current view.",
            ]),
        )
        write_text(
            root / "knowledge" / "online" / "risk-on-risk-off.md",
            "\n".join([
                "# risk on risk off",
                "",
                "## Key takeaways",
                "- Risk-on risk-off is useful only when tied to observable macro transmission channels.",
                "- Treat it as a regime summary, not a slogan.",
            ]),
        )
        write_text(
            root / "knowledge" / "online" / "drawdown-control.md",
            "\n".join([
                "# drawdown control",
                "",
                "## Key takeaways",
                "- Drawdown control starts with explicit stop conditions and smaller position sizing.",
                "- A risk-control drill should state what loss level forces de-risking.",
            ]),
        )
        write_text(
            root / "knowledge" / "online" / "stress-testing.md",
            "\n".join([
                "# stress testing",
                "",
                "## Key takeaways",
                "- Stress testing should include gaps, liquidity thinning, and slippage shocks.",
                "- A clean risk process asks how the position fails before it asks how it wins.",
            ]),
        )
        write_text(
            root / "knowledge" / "online" / "200-day-moving-average.md",
            "\n".join([
                "# 200 day moving average",
                "",
                "## Key takeaways",
                "- Moving-average timing is only useful when paired with a clear invalidation rule.",
                "- Trend-following drills should distinguish persistence from noise.",
            ]),
        )
        write_text(
            root / "knowledge" / "online" / "breakout-strategy-basics.md",
            "\n".join([
                "# breakout strategy basics",
                "",
                "## Key takeaways",
                "- Breakout timing works better when volume and regime filters agree.",
                "- Do not treat every breakout as equal-quality timing evidence.",
            ]),
        )
        write_text(
            root / "docs" / "concepts" / "agent.md",
            "\n".join([
                "---",
                'summary: "Agent runtime and workspace contract"',
                "---",
                "",
                "# Agent Runtime",
                "",
                "- OpenClaw uses a single embedded agent runtime.",
                "- The workspace is the agent's source of truth for tools and context.",
            ]),
        )
        write_text(
            root / "docs" / "concepts" / "memory.md",
            "\n".join([
                "---",
                'summary: "Memory files and recall rules"',
                "---",
                "",
                "# Memory",
                "",
                "- OpenClaw memory is plain Markdown in the agent workspace.",
                "- The files are the source of truth; the model only remembers what gets written to disk.",
            ]),
        )
        write_text(
            root / "docs" / "concepts" / "system-prompt.md",
            "\n".join([
                "---",
                'summary: "System prompt assembly"',
                "---",
                "",
                "# System Prompt",
                "",
                "- OpenClaw builds a custom system prompt for every agent run.",
                "- The system prompt is OpenClaw-owned and assembled by the host runtime.",
            ]),
        )
        write_text(
            root / "docs" / "channels" / "channel-routing.md",
            "\n".join([
                "---",
                'summary: "Routing rules"',
                "---",
                "",
                "# Channel Routing",
                "",
                "- OpenClaw routes replies back to the channel where a message came from.",
                "- The model does not choose a channel; routing is deterministic and host-controlled.",
            ]),
        )
        write_text(
            root / "docs" / "tools" / "skills.md",
            "\n".join([
                "---",
                'summary: "Skills precedence"',
                "---",
                "",
                "# Skills",
                "",
                "- Skills are loaded from bundled, managed, and workspace locations.",
                "- Check precedence before overriding or internalizing a skill pattern.",
            ]),
        )
        write_text(
            root / "docs" / "cli" / "update.md",
            "\n".join([
                "---",
                'summary: "Update flow"',
                "---",
                "",
                "# update",
                "",
                "- Safely update OpenClaw and switch channels with the update command.",
                "- Use the update path before changing default behavior in place.",
            ]),
        )

        skills_result = module.run_topic("开源 skills")
        assert skills_result["ok"] is True, skills_result
        assert skills_result["bookkeeping_result"]["status"] == "recorded", skills_result
        skills_report = (root / skills_result["report_path"]).read_text(encoding="utf-8")
        assert "可复用技能模式" in skills_report, skills_report
        assert "ai capex" not in skills_report.lower(), skills_report
        skills_sources = json.loads((root / skills_result["sources_path"]).read_text(encoding="utf-8"))
        assert skills_sources["mode"] == "bounded_local_study_pack", skills_sources
        assert all(row["provider"] == "study_pack" for row in skills_sources["results"]), skills_sources
        assert any("SKILL.md" in item["path"] for row in skills_sources["results"] for item in row["items"]), skills_sources

        options_result = module.run_topic("期权能力")
        options_report = (root / options_result["report_path"]).read_text(encoding="utf-8")
        assert "期权基本功" in options_report, options_report
        assert any(token in options_report.lower() for token in ["position sizing", "tail risk", "gamma", "delta", "hedge"]), options_report
        assert "ai capex" not in options_report.lower(), options_report
        assert "generated at" not in options_report.lower(), options_report
        assert "expected value of an outcome" not in options_report.lower(), options_report
        assert "interwiki bots" not in options_report.lower(), options_report

        stock_result = module.run_topic("股市分析能力")
        stock_report = (root / stock_result["report_path"]).read_text(encoding="utf-8")
        assert "股市分析框架" in stock_report, stock_report
        assert "factor" in stock_report.lower() or "microstructure" in stock_report.lower(), stock_report
        assert "generated at" not in stock_report.lower(), stock_report

        os.environ["LOBSTER_LEARNING_RAW_TEXT"] = "把股市分析基本功补一下，先跑一个，回群里"
        commandish_result = module.run_topic("把股市分析基本功补一下 先跑一个 回群里")
        os.environ.pop("LOBSTER_LEARNING_RAW_TEXT", None)
        assert "股市分析能力" in commandish_result["report_path"], commandish_result
        assert "把股市分析基本功补一下" not in commandish_result["report_path"], commandish_result
        commandish_sources = json.loads((root / commandish_result["sources_path"]).read_text(encoding="utf-8"))
        assert commandish_sources["topic"] == "股市分析能力", commandish_sources
        assert commandish_sources["requested_topic"] == "把股市分析基本功补一下 先跑一个 回群里", commandish_sources

        os.environ["LOBSTER_LEARNING_FAMILY"] = "macro_regime"
        os.environ["LOBSTER_LEARNING_FOCUS"] = "regime / risk-on risk-off"
        os.environ["LOBSTER_LEARNING_STRATEGY"] = "regime_framework"
        macro_result = module.run_topic("宏观与市场结构")
        macro_report = (root / macro_result["report_path"]).read_text(encoding="utf-8")
        assert "宏观与市场结构框架" in macro_report, macro_report
        assert "risk-on" in macro_report.lower() or "regime" in macro_report.lower(), macro_report

        os.environ["LOBSTER_LEARNING_FAMILY"] = "risk_control"
        os.environ["LOBSTER_LEARNING_FOCUS"] = "drawdown / stress testing"
        os.environ["LOBSTER_LEARNING_STRATEGY"] = "risk_hardening"
        risk_result = module.run_topic("风险控制能力")
        risk_report = (root / risk_result["report_path"]).read_text(encoding="utf-8")
        assert "风险控制基本功" in risk_report, risk_report
        assert "drawdown" in risk_report.lower() or "stress" in risk_report.lower(), risk_report

        os.environ["LOBSTER_LEARNING_FAMILY"] = "technical_timing"
        os.environ["LOBSTER_LEARNING_FOCUS"] = "moving average / breakout"
        os.environ["LOBSTER_LEARNING_STRATEGY"] = "timing_discipline"
        timing_result = module.run_topic("技术择时能力")
        timing_report = (root / timing_result["report_path"]).read_text(encoding="utf-8")
        assert "技术择时纪律" in timing_report, timing_report
        assert "moving average" in timing_report.lower() or "breakout" in timing_report.lower(), timing_report

        os.environ["LOBSTER_LEARNING_FAMILY"] = "quant_factor_timing"
        os.environ["LOBSTER_LEARNING_FOCUS"] = "factor timing / dual momentum / overfitting"
        os.environ["LOBSTER_LEARNING_STRATEGY"] = "factor_timing_audit"
        quant_timing_result = module.run_topic("量化因子择时策略")
        quant_timing_report = (root / quant_timing_result["report_path"]).read_text(encoding="utf-8")
        assert "量化因子择时策略" in quant_timing_report, quant_timing_report
        quant_timing_lower = quant_timing_report.lower()
        assert (
            "walk-forward" in quant_timing_lower
            or "out-of-sample" in quant_timing_lower
            or "transaction cost" in quant_timing_lower
        ), quant_timing_report

        os.environ["LOBSTER_LEARNING_FAMILY"] = "agent_updates"
        os.environ["LOBSTER_LEARNING_FOCUS"] = "openclaw / memory / routing"
        os.environ["LOBSTER_LEARNING_STRATEGY"] = "self_update_internalization"
        agent_update_result = module.run_topic("智能体系统更新")
        agent_update_report = (root / agent_update_result["report_path"]).read_text(encoding="utf-8")
        assert "智能体更新原则" in agent_update_report, agent_update_report
        assert (
            "记忆先写进 markdown 文件" in agent_update_report
            or "回复回原渠道" in agent_update_report
            or "先把事实写进文件" in agent_update_report
        ), agent_update_report

        os.environ.pop("LOBSTER_LEARNING_FAMILY", None)
        os.environ.pop("LOBSTER_LEARNING_FOCUS", None)
        os.environ.pop("LOBSTER_LEARNING_STRATEGY", None)

        paper_result = module.run_topic("前沿金融论文")
        paper_report = (root / paper_result["report_path"]).read_text(encoding="utf-8")
        assert "论文阅读框架" in paper_report, paper_report
        assert "walk-forward" in paper_report.lower() or "out-of-sample" in paper_report.lower(), paper_report
        assert "generated at" not in paper_report.lower(), paper_report
        assert "trading platforms & tools" not in paper_report.lower(), paper_report
        assert "windowed recurrence" not in paper_report.lower(), paper_report
        assert "moving sum" not in paper_report.lower(), paper_report

        assert module.clean_study_pack_line("Search snippet: The equity risk premium represents the expected return from investing in the stock market over a risk-free rate.") == "The equity risk premium represents the expected return from investing in the stock market over a risk-free rate."
        assert module.is_bad_study_pack_line("# Trading Platforms & Tools") is True
        assert module.is_bad_study_pack_line("Value at risk - Wikipedia ===============") is True
        assert module.is_bad_study_pack_line("Kelly](https://www.investopedia.com/x) ![Timothy Li]()") is True
        assert module.is_bad_study_pack_line("The equity risk premium represents the expected return from investing in the stock market over a risk-free rate.") is False
        assert module.study_line_quality_score("Abstract This study explores the behavior of machine learning-based flare forecasting models deployed in a simulated operational environment.", "frontier_paper") > module.study_line_quality_score("Trading Platforms & Tools", "frontier_paper")
        assert module.study_line_quality_score("Before using correct position sizing for a trade, investors must first figure out their account risk.", "options") > module.study_line_quality_score("Home energy audit.", "options")
        assert module.study_line_quality_score("The equity risk premium represents the expected return from investing in the stock market over a risk-free rate.", "stock_analysis") > module.study_line_quality_score("The capital asset pricing model (CAPM): {\\displaystyle E(R_i)=R_f+...}", "stock_analysis")
        assert module.has_keeper_keyword("Walk forward optimization is a method used in finance to determine the robustness of the strategy.", "frontier_paper") is True
        assert module.has_reject_fragment("At its core, a windowed recurrence is a calculation applied iteratively to a sliding window.", "frontier_paper") is True
        assert module.has_reject_fragment("He proposed that a nonlinear function of the utility of an outcome should be used instead of the expected value.", "options") is True
        assert module.select_study_candidates([
            "At its core, a windowed recurrence is a calculation applied iteratively to a sliding window.",
            "Walk forward optimization is a method used in finance to determine the robustness of the strategy.",
        ], "frontier_paper", limit=1) == [
            "Walk forward optimization is a method used in finance to determine the robustness of the strategy."
        ]
        assert module.study_topic_profile("GitHub repo 里的 skill 设计和工作流") == "skills"
        assert module.study_topic_profile("读两篇 arxiv 金融 paper") == "frontier_paper"
        assert module.study_topic_profile("补一下期权 greek 和对冲基本功") == "options"
        assert module.study_topic_profile("补一下财报阅读和股票估值框架") == "stock_analysis"
        assert module.study_topic_profile("去学宏观 regime 和 risk-on risk-off 框架") == "macro_regime"
        assert module.study_topic_profile("补一下回撤控制和压力测试") == "risk_control"
        assert module.study_topic_profile("学习一套很好的量化因子择时策略") == "quant_factor_timing"
        assert module.study_topic_profile("补一下趋势跟踪、均线和 breakout 择时") == "technical_timing"
        assert module.study_topic_profile("去学 openclaw 的最新更新并内化到自己") == "agent_updates"

        print(json.dumps({"ok": True, "status": "study pack learner routing passed"}, ensure_ascii=False, indent=2))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
