#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from learning_goal_registry import infer_learning_family, looks_like_meta_instruction, resolve_learning_goal
REPORT_DIR = ROOT / "knowledge" / "learn"
STATE_PATH = ROOT / "branches" / "learn" / "learn_state.json"
PENDING_PATH = ROOT / "branches" / "learn" / "learn_bookkeeping_pending.json"
ANOMALY_PATH = ROOT / "branches" / "learn" / "learn_bookkeeping_anomalies.jsonl"
ONLINE_DIR = ROOT / "knowledge" / "online"
REPO_SKILLS_DIR = ROOT / "skills"
EXTENSION_SKILLS_DIR = ROOT / "extensions"
HOME_SKILLS_DIR = Path.home() / ".codex" / "skills"
REPORT_DIR.mkdir(parents=True, exist_ok=True)
STATE_PATH.parent.mkdir(parents=True, exist_ok=True)

ONLINE_PACK_FILES = {
    "frontier_paper": [
        "walk-forward-validation.md",
        "in-sample-vs-out-of-sample.md",
        "overfitting.md",
        "look-ahead-bias.md",
        "backtest-assumptions.md",
        "feature-engineering.md",
    ],
    "options": [
        "delta-audit-topic.md",
        "gamma-clean-topic.md",
        "tail-risk.md",
        "position-sizing.md",
        "stress-testing.md",
    ],
    "stock_analysis": [
        "factor-investing-basics.md",
        "equity-risk-premium.md",
        "macro-regimes.md",
        "market-microstructure-basics.md",
        "behavioral-finance-biases.md",
        "etf-liquidity.md",
    ],
    "macro_regime": [
        "macro-regimes.md",
        "inflation-and-rates-basics.md",
        "risk-on-risk-off.md",
        "equity-bond-correlation-regimes.md",
        "risk-premia.md",
        "tactical-asset-allocation.md",
    ],
    "risk_control": [
        "drawdown-control.md",
        "tail-risk.md",
        "stress-testing.md",
        "position-sizing.md",
        "transaction-cost.md",
        "slippage.md",
        "liquidity-risk.md",
    ],
    "quant_factor_timing": [
        "factor-investing-basics.md",
        "dual-momentum.md",
        "time-series-momentum.md",
        "momentum-investing.md",
        "volatility-targeting.md",
        "rebalance-frequency.md",
        "turnover.md",
        "transaction-cost.md",
        "overfitting.md",
        "look-ahead-bias.md",
        "survivorship-bias.md",
        "walk-forward-validation.md",
        "in-sample-vs-out-of-sample.md",
        "feature-engineering.md",
        "vectorized-backtest.md",
    ],
    "technical_timing": [
        "200-day-moving-average.md",
        "breakout-strategy-basics.md",
        "mean-reversion.md",
        "time-series-momentum.md",
        "trend-persistence.md",
        "regime-filter.md",
        "signal-smoothing.md",
        "volatility-targeting.md",
    ],
}

AGENT_UPDATE_PACK_FILES = [
    "docs/concepts/agent.md",
    "docs/concepts/memory.md",
    "docs/concepts/system-prompt.md",
    "docs/channels/channel-routing.md",
    "docs/tools/skills.md",
    "docs/cli/update.md",
]

STUDY_TOKEN_STOPWORDS = {
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "what",
    "how",
    "why",
    "risk",
    "risks",
    "market",
    "structure",
    "drivers",
    "drills",
    "main",
    "best",
    "topic",
    "ability",
    "skills",
    "skill",
    "paper",
    "papers",
    "study",
    "frontier",
    "stock",
    "analysis",
    "options",
    "option",
    "开源",
    "前沿",
    "金融",
    "论文",
    "期权",
    "能力",
    "股市",
    "分析",
    "怎么",
    "学习",
    "学",
}

STUDY_PROFILE_KEEPER_KEYWORDS = {
    "agent_updates": [
        "memory",
        "markdown",
        "routing",
        "channel",
        "system prompt",
        "skills",
        "workflow",
        "tool use",
        "workspace",
        "update",
        "release notes",
        "changelog",
        "source of truth",
    ],
    "frontier_paper": [
        "walk forward",
        "walk-forward",
        "out-of-sample",
        "in-sample",
        "overfitting",
        "look-ahead bias",
        "backtest",
        "validation",
        "evaluation",
    ],
    "options": [
        "position sizing",
        "tail risk",
        "gap risk",
        "hedge",
        "hedging",
        "delta",
        "gamma",
        "volatility",
        "risk management",
    ],
    "stock_analysis": [
        "risk premium",
        "factor",
        "valuation",
        "behavioral finance",
        "bias",
        "intrinsic value",
        "microstructure",
        "quantitative analysis",
        "liquidity",
    ],
    "macro_regime": [
        "macro regime",
        "risk-on",
        "risk off",
        "risk-on risk-off",
        "inflation",
        "rates",
        "term premium",
        "asset allocation",
        "correlation",
        "risk premia",
    ],
    "risk_control": [
        "drawdown",
        "tail risk",
        "stress test",
        "stress testing",
        "position sizing",
        "slippage",
        "transaction cost",
        "liquidity risk",
        "gap risk",
    ],
    "quant_factor_timing": [
        "factor",
        "factor investing",
        "dual momentum",
        "time series momentum",
        "momentum",
        "volatility targeting",
        "rebalance",
        "turnover",
        "transaction cost",
        "walk forward",
        "walk-forward",
        "out-of-sample",
        "overfitting",
        "survivorship bias",
        "look-ahead bias",
    ],
    "technical_timing": [
        "moving average",
        "breakout",
        "mean reversion",
        "trend",
        "momentum",
        "regime filter",
        "signal smoothing",
        "volatility targeting",
    ],
}

STUDY_PROFILE_REJECT_FRAGMENTS = {
    "agent_updates": [
        "read_when",
        "summary:",
        "title:",
        "next:",
        "```",
        "json5",
        "default:",
        "options:",
        "examples:",
    ],
    "frontier_paper": [
        "windowed recurrence",
        "moving sum",
        "solar flare",
        "har model",
        "vix",
        "[1709.",
    ],
    "options": [
        "expected utility",
        "utility of an outcome",
        "interwiki bots",
        "duration is a measure",
        "gamma function",
        "euler's definition",
        "bonds and to construct hedges",
    ],
    "stock_analysis": [
        "{\\displaystyle",
        "ai systems",
        "mandelbrot",
    ],
    "macro_regime": [
        "mandelbrot",
        "windowed recurrence",
        "gamma function",
        "em local currency bonds",
        "foreign currency bonds",
    ],
    "risk_control": [
        "home energy audit",
        "gamma function",
        "interwiki bots",
        "liquidity coverage ratio",
        "measures the ability of the bank",
        "lcr",
    ],
    "quant_factor_timing": [
        "solar flare",
        "home energy audit",
        "interwiki bots",
        "utility of an outcome",
        "{\\displaystyle",
    ],
    "technical_timing": [
        "solar flare",
        "mandelbrot",
        "gamma function",
        "the equation itself usually refers",
        "position space form",
    ],
}

def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def canonical_run_topic(topic: str) -> str:
    raw_text = (os.environ.get("LOBSTER_LEARNING_RAW_TEXT", "") or "").strip() or topic
    goal = resolve_learning_goal(raw_text)
    family = str(goal.get("family") or "").strip()
    canonical = str(goal.get("canonical_topic") or "").strip()
    is_learning_request = bool(goal.get("is_learning_request"))
    if looks_like_meta_instruction(raw_text) and not is_learning_request:
        return ""
    if family and canonical and (is_learning_request or canonical == topic.strip()):
        return canonical
    return topic.strip()


def lane_key() -> str:
    return (os.environ.get("LOBSTER_LANE_KEY", "") or "").strip() or "global"


def lane_slug() -> str:
    return slugify(lane_key()).replace("_", "-")


def lane_state_path(lane_value: str) -> Path:
    return ROOT / "branches" / "learn" / "lanes" / lane_slug_from_value(lane_value) / "learn_state.json"


def lane_slug_from_value(value: str) -> str:
    return slugify(value).replace("_", "-")

def slugify(s: str) -> str:
    s = re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "_", s.strip().lower()).strip("_")
    return s[:80] or "topic"

def clean_note_line(text: str) -> str:
    line = re.sub(r"\s+", " ", (text or "").strip())
    line = re.sub(r"^\s*[\-\*\u2022]?\s*\*\*([^*]+)\*\*:\s*", "", line)
    line = re.sub(r"^[#>\-\*\u2022]+\s*", "", line)
    line = re.sub(r"^\*\*([^*]+)\*\*:\s*", "", line)
    line = re.sub(r"^(?:\d+\.\s*)?(Drivers|Risk Flags|Current Conclusion)\s*-\s*", "", line, flags=re.IGNORECASE)
    line = re.sub(r"`+", "", line)
    line = line.strip(" -:")
    return line.strip()


def is_bad_note_line(text: str) -> bool:
    lowered = clean_note_line(text).lower()
    if not lowered:
        return True
    if lowered in {
        "technical daily report - generated",
        "market regime snapshot",
        "retrieved notes",
        "branch summary",
        "fundamental filter snapshot",
    }:
        return True
    if lowered.startswith("technical daily report - generated"):
        return True
    if lowered.startswith("market regime snapshot"):
        return True
    if lowered.startswith("fundamental research report - "):
        return True
    if lowered.startswith("topic card - "):
        return True
    if lowered.startswith("learning report - "):
        return True
    if lowered.startswith("snapshot - topic_id:"):
        return True
    if lowered.startswith("evidence links -"):
        return True
    if lowered.startswith("key points -"):
        return True
    if lowered.startswith("##"):
        return True
    if re.match(
        r"^[A-Z]{2,8}:\s+(mixed regime|neutral|bullish|bearish|risk on|risk-off|risk off|downtrend|uptrend|strong uptrend)\.?$",
        clean_note_line(text),
        flags=re.IGNORECASE,
    ):
        return True
    if len(lowered) < 16:
        return True
    return False


def normalize_summary_for_notes(text: str) -> str:
    cleaned = (text or "").strip()
    cleaned = cleaned.replace("## ", "\n## ")
    cleaned = cleaned.replace(" - **", "\n- **")
    cleaned = re.sub(r"^#\s*Technical Daily Report - generated\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^##\s*1\.\s*Market Regime Snapshot\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.replace("**", "")
    return cleaned.strip()


def short_lines(text: str, n: int = 2):
    parts = re.split(r"(?<=[\.\!\?])\s+|\n+", normalize_summary_for_notes(text))
    cleaned = []
    for part in parts:
        line = clean_note_line(part)
        if is_bad_note_line(line):
            continue
        cleaned.append(line)
    parts = cleaned
    return parts[:n]


def compress_study_method_line(text: str, profile: str = "") -> str:
    cleaned = clean_note_line(text).rstrip(".")
    lowered = canonical_text(cleaned)
    if not cleaned:
        return ""

    if profile == "agent_updates":
        if "markdown" in lowered and "memory" in lowered:
            return "记忆先写进 markdown 文件，不要假设模型会自己记住。"
        if "source of truth" in lowered and any(token in lowered for token in ["written to disk", "workspace", "files"]):
            return "先把事实写进文件，再指望智能体稳定记住。"
        if ("route replies back" in lowered or "routing" in lowered or "channel" in lowered) and "model" in lowered:
            return "回复回原渠道，别让模型自己选渠道。"
        if "system prompt" in lowered and ("openclaw" in lowered or "owned" in lowered or "assembled" in lowered):
            return "system prompt 由宿主组装，不要让模型自己定义底座。"
        if "skills" in lowered and ("three" in lowered or "workspace" in lowered or "precedence" in lowered):
            return "skills 先看加载优先级，再做覆盖和内化。"
        if "update.run" in lowered or "config.apply" in lowered or ("update" in lowered and "restart" in lowered):
            return "系统更新先走 update.run 或 config.apply，再改默认行为。"

    if profile == "skills":
        if any(token in lowered for token in ["specialized knowledge", "procedural knowledge", "workflow", "tools"]):
            return "skills 先写清场景、步骤和工具，再谈内化。"
        if any(token in lowered for token in ["when to use", "use when", "trigger"]):
            return "skills 先写清触发场景，再扩能力边界。"
        if any(token in lowered for token in ["quick start", "prerequisite", "setup"]):
            return "skills 先把前置条件写清，再谈自动调用。"

    if profile == "frontier_paper":
        if any(token in lowered for token in ["walk forward", "walk-forward", "out-of-sample", "in-sample"]):
            return "先看滚动验证和样本外结果，再信回测。"
        if "feature engineering" in lowered and any(token in lowered for token in ["evaluation", "validation", "overfitting"]):
            return "特征工程越多，越要先审验证和过拟合。"
        if "backtest" in lowered and any(token in lowered for token in ["assumption", "assumptions", "live use", "credible"]):
            return "先拆回测假设，再信论文结果。"

    if profile == "options":
        if "position sizing" in lowered and any(token in lowered for token in ["account risk", "trade risk", "before using", "investors must first figure out"]):
            return "先算账户能承受的风险，再定期权仓位。"
        if "position sizing" in lowered:
            return "先控仓位，再谈期权方向。"
        if any(token in lowered for token in ["gap risk", "tail risk", "hedge", "hedging"]):
            return "先看缺口风险和对冲成本，再信便宜保护。"
        if any(token in lowered for token in ["delta", "gamma", "vega", "theta"]):
            return "先拆 greek 风险，再讲收益结构。"

    if profile == "stock_analysis":
        if any(token in lowered for token in ["factor", "risk premium", "valuation"]):
            return "先看估值、因子和风险溢价，再谈股票观点。"
        if any(token in lowered for token in ["microstructure", "liquidity", "execution quality"]):
            return "先看流动性和微观结构，再判断价格信号。"
        if any(token in lowered for token in ["behavioral finance", "bias"]):
            return "先防行为偏差，再谈分析框架。"

    if profile == "macro_regime":
        if any(token in lowered for token in ["risk-on risk-off", "risk on risk off", "term premium", "inflation", "rates"]):
            return "先看通胀、利率和期限溢价，再谈风险偏好切换。"
        if any(token in lowered for token in ["equity-bond correlation", "correlation", "regime"]):
            return "股债相关性会变，不能拿单一 regime 硬套。"
        if any(token in lowered for token in ["asset allocation", "risk premia"]):
            return "先分清资产配置驱动，再下 regime 结论。"

    if profile == "risk_control":
        if any(token in lowered for token in ["stress testing", "stress test", "liquidity", "gap risk"]):
            return "压力测试要把流动性和缺口风险一起算进去。"
        if "position sizing" in lowered and any(token in lowered for token in ["account risk", "trade risk", "before using", "investors must first figure out"]):
            return "先算账户能承受的风险，再定仓位。"
        if any(token in lowered for token in ["drawdown", "position sizing", "diversification"]):
            return "先控仓位和回撤，再谈收益。"
        if any(token in lowered for token in ["slippage", "transaction cost"]):
            return "先把滑点和交易成本算进去，再看策略是否成立。"

    if profile == "quant_factor_timing":
        if any(token in lowered for token in ["walk forward", "walk-forward", "out-of-sample", "overfitting"]):
            return "因子择时先过走步验证和样本外，再谈有效。"
        if any(token in lowered for token in ["look-ahead", "survivorship"]):
            return "因子数据先排查前视偏差和幸存者偏差。"
        if any(token in lowered for token in ["turnover", "transaction cost", "rebalance"]):
            return "因子轮动必须先扣换手和交易成本。"
        if any(token in lowered for token in ["dual momentum", "time series momentum", "momentum"]):
            return "动量因子可能有效，但要防拥挤、反转和 regime 切换。"
        if "volatility targeting" in lowered:
            return "波动率目标能控风险，但在急变 regime 里会滞后。"

    if profile == "technical_timing":
        if any(token in lowered for token in ["breakout", "regime filter", "signal smoothing"]):
            return "突破信号先过市场状态过滤，再看确认。"
        if any(token in lowered for token in ["200-day", "moving average"]):
            return "200日均线是纪律，不是结论。"
        if any(token in lowered for token in ["trend", "momentum", "mean reversion"]):
            return "先分清趋势延续还是噪音，再做择时。"

    return cleaned + "。"


def best_conclusion_note(note_lines: list[str], profile: str = "") -> str:
    for note in note_lines:
        line = clean_note_line(note).rstrip(".")
        if is_bad_note_line(line):
            continue
        if profile:
            return compress_study_method_line(line, profile)
        return line
    return ""

def distilled(query: str, items: list[dict]) -> list[str]:
    out = []
    for item in items[:2]:
        summary = item.get("summary", "")
        lines = short_lines(summary, 2)
        for ln in lines:
            if len(ln) > 220:
                ln = ln[:220] + "..."
            out.append(ln)
            if len(out) >= 3:
                return out
    return out[:3]

def run_search(query: str):
    p = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "local_corpus_search.py"), query],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    try:
        return json.loads((p.stdout or "").strip() or "{}")
    except Exception:
        return {"ok": False, "items": []}


def infer_brain_type(path: str) -> str:
    normalized = (path or "").strip().lower()
    if "/topic_memory/episodes/" in normalized:
        return "episodic"
    if "/topic_memory/" in normalized:
        return "semantic_or_procedural"
    if "/technical_daily/" in normalized or "/fundamental_research/" in normalized or "/maintenance/" in normalized:
        return "runtime"
    return "reference"


def with_brain_type(items: list[dict]) -> list[dict]:
    normalized = []
    for item in items:
        obj = dict(item)
        obj["brain_type"] = infer_brain_type(str(item.get("path") or item.get("url") or ""))
        normalized.append(obj)
    return normalized


def relativeish(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except Exception:
        return str(path)


def section_body(text: str, heading: str) -> str:
    pattern = rf"^##\s+{re.escape(heading)}\s*$([\s\S]*?)(?=^##\s+|\Z)"
    match = re.search(pattern, text, re.MULTILINE)
    return match.group(1).strip() if match else ""


def bullet_lines(text: str) -> list[str]:
    out = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("-"):
            continue
        value = clean_note_line(stripped.lstrip("-").strip())
        if len(value) >= 16:
            out.append(value)
    return out


def extract_frontmatter_value(text: str, key: str) -> str:
    match = re.search(rf"(?m)^{re.escape(key)}:\s*\"?([^\n\"]+)\"?\s*$", text)
    return clean_note_line(match.group(1)) if match else ""


def clean_study_pack_line(text: str) -> str:
    line = text or ""
    line = re.sub(r"!\[[^\]]*\]\([^\)]*\)", " ", line)
    line = re.sub(r"\[([^\]]+)\]\([^\)]*\)", r"\1", line)
    line = re.sub(r"\S*\]\([^\)]*\)", " ", line)
    line = re.sub(r"^\[\d{4}\.\d{4,5}\]\s*", "", line)
    line = re.sub(r"https?://\S+", " ", line)
    line = re.sub(r"(?i)^search snippet:\s*", "", line)
    line = re.sub(r"(?i)^search snippet\s*", "", line)
    line = re.sub(r"\[\[[^\]]+\]\]", " ", line)
    line = line.replace("|", " ")
    line = re.sub(r"[=*]{2,}", " ", line)
    line = clean_note_line(line)
    line = re.sub(r"\s+", " ", line)
    return line.strip(" -:#")


def looks_like_study_source_title(text: str) -> bool:
    line = clean_study_pack_line(text)
    lowered = canonical_text(line)
    if not lowered:
        return True
    if re.match(r"^\[\d{4}\.\d{4,5}\]", text.strip()):
        return True
    if any(
        token in lowered
        for token in [
            "wikipedia",
            "investopedia",
            "corporate finance institute",
            "cfi net learnings",
            "top stories",
            "latest episodes",
            "trading platforms & tools",
            "understanding alpha in investing",
            "basics of algorithmic trading",
            "using paper trading",
            "value at risk - wikipedia",
            "backtesting in trading",
            "chartered market technician",
            "do not edit the contents of this page",
            "if you wish to start a new discussion",
            "topics inactive for",
            "alma mater",
            "known for",
            "awards",
        ]
    ):
        return True
    if " # " in line or " ####" in line:
        return True
    if re.match(r"^(how to|what is|understanding|basics of|master |using |trading |wikipedia talk:)", lowered):
        return True
    alpha_words = re.findall(r"[A-Za-z]+", line)
    if alpha_words and len(alpha_words) >= 4:
        titlecase_ratio = sum(1 for word in alpha_words if word[:1].isupper()) / len(alpha_words)
        if titlecase_ratio >= 0.8 and not re.search(r"[.!?。；;:]", line):
            return True
    return False


def is_bad_study_pack_line(text: str) -> bool:
    lowered = canonical_text(clean_study_pack_line(text))
    if not lowered:
        return True
    if lowered.startswith(("generated at:", "topic type:", "query:", "strict teaching sources:", "canonical topic:", "sources kept:", "whitelist size:")):
        return True
    if lowered.startswith(("domain:", "search snippet:", "markdown:", "sources json:", "whitelist used", "queries used")):
        return True
    if any(token in lowered for token in ["jump to content", "main menu", "wikipedia talk", "profile picture", "contents #", "contents *", "visit the main page"]):
        return True
    if any(token in lowered for token in ["skip to content", "personal tools", "search wikipedia", "home › resources", "start free", "play 0×"]):
        return True
    if any(token in lowered for token in ["topics inactive for", "lowercase sigmabot", "do not edit the contents of this page", "if you wish to start a new discussion", "firefighters are exposed", "alma mater", "known for", "awards", "chartered market technician", "school of computer science and engineering"]):
        return True
    if any(token in text for token in ["![", "](http", "](https", "]]", "| |", "[[", ":/"]):
        return True
    if lowered == "this file is a source-backed study note for lobster's low-frequency etf research stack. treat it as structured learning material, not direct trading advice.":
        return True
    if "search snippet" in lowered or "domain:" in lowered:
        return True
    if looks_like_study_source_title(text):
        return True
    return False


def study_profile_keeper_keywords(profile: str) -> list[str]:
    return STUDY_PROFILE_KEEPER_KEYWORDS.get(profile, [])


def study_profile_reject_fragments(profile: str) -> list[str]:
    return STUDY_PROFILE_REJECT_FRAGMENTS.get(profile, [])


def has_keeper_keyword(text: str, profile: str) -> bool:
    lowered = canonical_text(clean_study_pack_line(text))
    keywords = study_profile_keeper_keywords(profile)
    return any(token in lowered for token in keywords) if keywords else False


def has_reject_fragment(text: str, profile: str) -> bool:
    lowered = canonical_text(clean_study_pack_line(text))
    fragments = study_profile_reject_fragments(profile)
    return any(token in lowered for token in fragments) if fragments else False


def study_line_quality_score(text: str, profile: str = "") -> int:
    cleaned = clean_study_pack_line(text)
    lowered = canonical_text(cleaned)
    if not cleaned or is_bad_study_pack_line(text):
        return -1000
    if profile and has_reject_fragment(cleaned, profile):
        return -1000
    score = min(len(cleaned), 240) // 24
    if len(cleaned) > 220:
        score -= 3
    if lowered.startswith("abstract "):
        score += 8
    if any(token in lowered for token in [" is ", " are ", " means ", " helps ", " should ", " used to ", " represents ", " practice ", " essential ", " important "]):
        score += 5
    if re.search(r"[.!?。；;:]", cleaned):
        score += 3
    if any(token in lowered for token in ["alpha", "walk-forward", "out-of-sample", "position sizing", "tail risk", "risk premium", "bias", "microstructure", "feature engineering"]):
        score += 2
    if any(token in lowered for token in ["solar flare", "har model", "vix", "{\\displaystyle", "home energy audit", "firefighters", "expected utility hypothesis"]):
        score -= 6
    if profile and has_keeper_keyword(cleaned, profile):
        score += 12
    if profile == "frontier_paper":
        if any(token in lowered for token in ["walk forward", "walk-forward", "out-of-sample", "overfitting", "look-ahead bias", "feature engineering", "evaluation", "validation"]):
            score += 6
        if any(token in lowered for token in ["solar flare", "har model", "vix", "windowed recurrence", "moving sum"]):
            score -= 4
    if profile == "options":
        if any(token in lowered for token in ["position sizing", "tail risk", "hedge", "risk management", "gap risk", "delta", "gamma", "volatility"]):
            score += 6
        if any(token in lowered for token in ["home energy audit", "expected utility", "duration is a measure", "interwiki bots", "gamma function"]):
            score -= 5
    if profile == "stock_analysis":
        if any(token in lowered for token in ["risk premium", "factor", "valuation", "quantitative analysis", "behavioral finance", "bias", "intrinsic value"]):
            score += 6
        if any(token in lowered for token in ["{\\displaystyle", "ai systems", "mandelbrot"]):
            score -= 5
    if profile == "quant_factor_timing":
        if any(token in lowered for token in ["walk forward", "walk-forward", "out-of-sample", "overfitting", "look-ahead bias", "survivorship bias"]):
            score += 12
        if any(token in lowered for token in ["transaction cost", "turnover", "rebalance", "volatility targeting"]):
            score += 10
        if any(token in lowered for token in ["dual momentum", "time series momentum", "factor timing", "factor rotation"]):
            score += 8
        if any(token in lowered for token in ["solar flare", "home energy audit", "interwiki bots", "{\\displaystyle"]):
            score -= 6
    if profile == "agent_updates":
        if any(token in lowered for token in ["memory", "markdown", "routing", "channel", "system prompt", "skills", "workflow", "source of truth", "update", "workspace"]):
            score += 6
        if any(token in lowered for token in ["json5", "default is", "options:", "read_when", "summary:", "title:"]):
            score -= 5
    return score


def meaningful_lines(text: str, limit: int = 6, profile: str = "") -> list[str]:
    lines = []
    in_frontmatter = False
    frontmatter_seen = False
    paragraph: list[str] = []

    def flush_paragraph() -> list[str]:
        nonlocal paragraph
        if not paragraph:
            return []
        joined = " ".join(part.strip() for part in paragraph if part.strip())
        paragraph = []
        if not joined:
            return []
        return [part.strip() for part in re.split(r"(?<=[\.\!\?。])\s+", joined) if part.strip()]

    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped:
            for candidate in flush_paragraph():
                cleaned = clean_study_pack_line(candidate)
                if len(cleaned) < 16:
                    continue
                if study_line_quality_score(candidate, profile) <= 0:
                    continue
                lines.append(cleaned)
                if len(lines) >= limit:
                    return lines
            continue
        if stripped == "---":
            if not frontmatter_seen and not lines:
                in_frontmatter = True
                frontmatter_seen = True
                continue
            if in_frontmatter:
                in_frontmatter = False
                continue
        if in_frontmatter:
            continue
        if stripped in {"---", "```", "```bash", "```text"}:
            for candidate in flush_paragraph():
                cleaned = clean_study_pack_line(candidate)
                if len(cleaned) < 16:
                    continue
                if study_line_quality_score(candidate, profile) <= 0:
                    continue
                lines.append(cleaned)
                if len(lines) >= limit:
                    return lines
            continue
        if stripped.startswith("#"):
            for candidate in flush_paragraph():
                cleaned = clean_study_pack_line(candidate)
                if len(cleaned) < 16:
                    continue
                if study_line_quality_score(candidate, profile) <= 0:
                    continue
                lines.append(cleaned)
                if len(lines) >= limit:
                    return lines
            continue
        if stripped.startswith(("name:", "description:", "summary:", "read_when:", "title:", "homepage:", "metadata:")):
            continue
        if stripped.startswith("-"):
            for candidate in flush_paragraph():
                cleaned = clean_study_pack_line(candidate)
                if len(cleaned) < 16:
                    continue
                if study_line_quality_score(candidate, profile) <= 0:
                    continue
                lines.append(cleaned)
                if len(lines) >= limit:
                    return lines
            cleaned = clean_study_pack_line(stripped)
            if len(cleaned) < 16:
                continue
            if study_line_quality_score(stripped, profile) <= 0:
                continue
            lines.append(cleaned)
            if len(lines) >= limit:
                return lines
            continue
        paragraph.append(stripped)
    for candidate in flush_paragraph():
        cleaned = clean_study_pack_line(candidate)
        if len(cleaned) < 16:
            continue
        if study_line_quality_score(candidate, profile) <= 0:
            continue
        lines.append(cleaned)
        if len(lines) >= limit:
            return lines
    return lines


def select_study_candidates(candidates: list[str], profile: str, limit: int = 4) -> list[str]:
    seen: set[str] = set()
    ordered_unique: list[str] = []
    for candidate in candidates:
        cleaned = clean_study_pack_line(candidate)
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        ordered_unique.append(cleaned)
    keeper_candidates = [item for item in ordered_unique if has_keeper_keyword(item, profile)]
    if study_profile_keeper_keywords(profile) and not keeper_candidates:
        return []
    pool = keeper_candidates if keeper_candidates else ordered_unique
    ranked = sorted(
        pool,
        key=lambda item: (-study_line_quality_score(item, profile), pool.index(item)),
    )
    return ranked[:limit]


def summarize_pack_text(path: Path, text: str, profile: str = "") -> str:
    lines: list[str] = []
    candidates: list[str] = []
    description = extract_frontmatter_value(text, "description")
    if description:
        cleaned_description = clean_study_pack_line(description)
        if cleaned_description and study_line_quality_score(description, profile) > 0:
            candidates.append(cleaned_description)
    for heading in ["Key takeaways", "Workflow", "When to use", "Bottom line", "Source notes"]:
        body = section_body(text, heading)
        section_lines = bullet_lines(body)
        if not section_lines and body:
            section_lines = meaningful_lines(body, limit=6, profile=profile)
        for line in section_lines:
            cleaned_line = clean_study_pack_line(line)
            if study_line_quality_score(line, profile) <= 0:
                continue
            candidates.append(cleaned_line)
    if len(candidates) < 3:
        for line in meaningful_lines(text, limit=6, profile=profile):
            cleaned_line = clean_study_pack_line(line)
            if study_line_quality_score(line, profile) <= 0:
                continue
            candidates.append(cleaned_line)
    lines = select_study_candidates(candidates, profile, limit=4)
    summary = " ".join(lines).strip()
    return summary[:1500]


def study_topic_profile(topic: str) -> str:
    family_override = (os.environ.get("LOBSTER_LEARNING_FAMILY", "") or "").strip()
    if family_override:
        return family_override
    family = infer_learning_family(topic)
    if family in ONLINE_PACK_FILES or family in {"skills", "agent_updates"}:
        return family
    return ""


def study_focus(topic: str) -> str:
    focus_override = (os.environ.get("LOBSTER_LEARNING_FOCUS", "") or "").strip()
    if focus_override:
        return focus_override
    raw_text = (os.environ.get("LOBSTER_LEARNING_RAW_TEXT", "") or "").strip()
    if raw_text:
        return str(resolve_learning_goal(raw_text).get("focus") or "").strip()
    return str(resolve_learning_goal(topic).get("focus") or "").strip()


def study_strategy(topic: str) -> str:
    strategy_override = (os.environ.get("LOBSTER_LEARNING_STRATEGY", "") or "").strip()
    if strategy_override:
        return strategy_override
    raw_text = (os.environ.get("LOBSTER_LEARNING_RAW_TEXT", "") or "").strip()
    if raw_text:
        return str(resolve_learning_goal(raw_text).get("strategy") or "").strip()
    return str(resolve_learning_goal(topic).get("strategy") or "").strip()


def canonical_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def tokenize_study_text(text: str) -> list[str]:
    tokens = []
    for token in re.findall(r"[0-9a-z\u4e00-\u9fff]+", canonical_text(text)):
        if len(token) <= 1 or token in STUDY_TOKEN_STOPWORDS:
            continue
        tokens.append(token)
    return tokens


def focus_keywords(text: str) -> list[str]:
    parts = re.split(r"(?:/|、|,|，| and | 与 |和)", canonical_text(text))
    out: list[str] = []
    seen: set[str] = set()
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if len(part) > 1 and part not in STUDY_TOKEN_STOPWORDS and part not in seen:
            out.append(part)
            seen.add(part)
    for token in tokenize_study_text(text):
        if token not in seen:
            out.append(token)
            seen.add(token)
    return out[:4]


def collect_skill_pack_paths() -> list[Path]:
    found: list[Path] = []
    seen: set[str] = set()
    patterns = [
        REPO_SKILLS_DIR.glob("*/SKILL.md"),
        EXTENSION_SKILLS_DIR.glob("*/skills/*/SKILL.md"),
        HOME_SKILLS_DIR.glob("*/SKILL.md"),
    ]
    for glob_iter in patterns:
        for path in glob_iter:
            key = str(path.resolve())
            if key in seen or not path.is_file():
                continue
            seen.add(key)
            found.append(path)
    return sorted(found)


def collect_online_pack_paths(profile: str) -> list[Path]:
    files = ONLINE_PACK_FILES.get(profile, [])
    return [ONLINE_DIR / name for name in files if (ONLINE_DIR / name).exists()]


def collect_agent_update_pack_paths() -> list[Path]:
    found: list[Path] = []
    seen: set[str] = set()
    for rel in AGENT_UPDATE_PACK_FILES:
        path = ROOT / rel
        if not path.exists():
            continue
        key = str(path.resolve())
        if key in seen:
            continue
        seen.add(key)
        found.append(path)
    for path in collect_skill_pack_paths():
        key = str(path.resolve())
        if key in seen:
            continue
        seen.add(key)
        found.append(path)
    return found


def study_pack_paths(profile: str) -> list[Path]:
    if profile == "skills":
        return collect_skill_pack_paths()
    if profile == "agent_updates":
        return collect_agent_update_pack_paths()
    return collect_online_pack_paths(profile)


def study_pack_queries(profile: str, topic: str, focus: str = "") -> list[tuple[str, list[str]]]:
    focus_terms = focus_keywords(focus or topic)
    if profile == "agent_updates":
        return [
            (
                f"{topic} update principles",
                focus_terms + ["openclaw", "agent", "memory", "routing", "system prompt", "workflow"],
            ),
            (
                f"{topic} self update loop",
                focus_terms + ["skills", "tool use", "workspace", "source of truth", "update.run"],
            ),
            (
                f"{topic} internalization drill",
                focus_terms + ["changelog", "release notes", "memory", "routing", "channel"],
            ),
        ]
    if profile == "skills":
        return [
            (f"{topic} best skills", focus_terms + ["skill", "workflow", "automation", "when to use", "quick start"]),
            (f"{topic} usage patterns", focus_terms + ["cli", "workflow", "prerequisite", "use when"]),
            (f"{topic} internalization drill", focus_terms + ["workflow", "core", "recommended patterns", "quality expectations"]),
        ]
    if profile == "frontier_paper":
        return [
            (f"{topic} paper selection", focus_terms + ["arxiv", "paper", "research", "market", "strategy"]),
            (f"{topic} what to extract", focus_terms + ["contributions", "method", "evaluation", "examples"]),
            (f"{topic} audit checklist", focus_terms + ["overfitting", "out-of-sample", "walk-forward", "cost"]),
        ]
    if profile == "options":
        return [
            (f"{topic} core concepts", focus_terms + ["delta", "gamma", "tail risk", "position sizing"]),
            (f"{topic} main risks", focus_terms + ["gamma", "tail risk", "stress", "hedge"]),
            (f"{topic} practice drills", focus_terms + ["audit", "position sizing", "stress", "discipline"]),
        ]
    if profile == "stock_analysis":
        return [
            (f"{topic} framework", focus_terms + ["factor investing", "equity risk premium", "macro", "market microstructure", "valuation"]),
            (f"{topic} main risks", focus_terms + ["behavioral", "risk premium", "microstructure", "drawdown", "liquidity"]),
            (f"{topic} practice drills", focus_terms + ["framework", "factor", "macro", "timing"]),
        ]
    if profile == "macro_regime":
        return [
            (f"{topic} regime framework", focus_terms + ["macro regime", "inflation", "rates", "risk-on risk-off"]),
            (f"{topic} structural drivers", focus_terms + ["term premium", "asset allocation", "correlation", "risk premia"]),
            (f"{topic} practice drills", focus_terms + ["regime", "macro", "invalidation", "discipline"]),
        ]
    if profile == "risk_control":
        return [
            (f"{topic} control framework", focus_terms + ["drawdown", "tail risk", "stress testing", "position sizing"]),
            (f"{topic} failure modes", focus_terms + ["slippage", "transaction cost", "liquidity risk", "gap risk"]),
            (f"{topic} practice drills", focus_terms + ["risk control", "stress", "discipline", "survival"]),
        ]
    if profile == "technical_timing":
        return [
            (f"{topic} timing framework", focus_terms + ["trend", "momentum", "moving average", "breakout"]),
            (f"{topic} regime filters", focus_terms + ["mean reversion", "regime filter", "signal smoothing", "volatility targeting"]),
            (f"{topic} practice drills", focus_terms + ["timing", "discipline", "invalidation", "drawdown"]),
        ]
    if profile == "quant_factor_timing":
        return [
            (f"{topic} factor signal design", focus_terms + ["factor investing", "dual momentum", "time series momentum", "feature engineering"]),
            (f"{topic} timing and risk overlay", focus_terms + ["volatility targeting", "rebalance", "turnover", "transaction cost"]),
            (f"{topic} validation and failure modes", focus_terms + ["walk-forward", "out-of-sample", "overfitting", "look-ahead bias", "survivorship bias"]),
        ]
    return []


def score_study_pack_doc(path: Path, text: str, keywords: list[str], profile: str) -> int:
    haystack = canonical_text(f"{path.stem} {path.parent.name} {text}")
    score = 0
    for keyword in keywords:
        token = canonical_text(keyword)
        if token and token in haystack:
            score += 40 + min(len(token), 16)
    if profile == "skills" and path.name == "SKILL.md":
        score += 20
    if profile == "frontier_paper" and "arxiv.org" in haystack:
        score += 30
    if profile == "options" and any(token in haystack for token in ["delta", "gamma", "tail risk"]):
        score += 20
    if profile == "stock_analysis" and any(token in haystack for token in ["factor", "macro", "microstructure"]):
        score += 20
    if profile == "macro_regime" and any(token in haystack for token in ["macro", "inflation", "rates", "risk-on", "asset allocation"]):
        score += 20
    if profile == "risk_control" and any(token in haystack for token in ["drawdown", "tail risk", "stress", "position sizing", "slippage"]):
        score += 20
    if profile == "quant_factor_timing" and any(token in haystack for token in ["factor", "momentum", "walk-forward", "out-of-sample", "turnover", "transaction cost"]):
        score += 25
    if profile == "technical_timing" and any(token in haystack for token in ["moving average", "trend", "momentum", "breakout", "regime filter"]):
        score += 20
    return score


def title_for_study_pack(path: Path) -> str:
    if path.name == "SKILL.md":
        return path.parent.name
    return path.stem.replace("_", " ").replace("-", " ")


def run_study_pack_search(topic: str, profile: str, label: str, keywords: list[str]) -> dict:
    docs = []
    for path in study_pack_paths(profile):
        try:
            text = path.read_text(encoding="utf-8")
        except Exception:
            continue
        summary = summarize_pack_text(path, text, profile=profile)
        if not summary:
            continue
        score = score_study_pack_doc(path, text, keywords + tokenize_study_text(topic), profile)
        if score <= 0:
            continue
        docs.append({
            "title": title_for_study_pack(path),
            "url": relativeish(path),
            "path": relativeish(path),
            "summary": summary,
            "score": score,
        })
    docs.sort(key=lambda item: (-int(item.get("score") or 0), str(item.get("title") or "")))
    return {
        "ok": True,
        "intent": f"study_pack_{profile}",
        "expanded_tokens": keywords,
        "items": docs[:2],
        "provider": "study_pack",
        "query": label,
    }


def summarize_brain_trace(results: list[dict]) -> dict:
    query_traces = []
    intents: list[str] = []
    item_brain_types: list[str] = []
    for row in results:
        trace = row.get("brain_trace", {}) if isinstance(row, dict) else {}
        intent = str(trace.get("intent") or "").strip()
        if intent and intent not in intents:
            intents.append(intent)
        for brain_type in trace.get("item_brain_types", []) or []:
            if brain_type not in item_brain_types:
                item_brain_types.append(brain_type)
        query_traces.append(
            {
                "query": row.get("query", ""),
                "intent": intent,
                "expanded_tokens": trace.get("expanded_tokens") or [],
                "item_brain_types": trace.get("item_brain_types") or [],
            }
        )
    return {
        "intents": intents,
        "item_brain_types": item_brain_types,
        "query_traces": query_traces,
    }

def save_json(path: Path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def maybe_forced_write_failure(label: str) -> None:
    target = (os.environ.get("LOBSTER_TEST_FAIL_WRITE", "") or "").strip().lower()
    if target == label:
        raise OSError(f"forced write failure for {label}")


def write_text_result(path: Path, text: str, label: str) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        maybe_forced_write_failure(label)
        path.write_text(text, encoding="utf-8")
        return {"ok": True, "label": label, "path": str(path.relative_to(ROOT))}
    except Exception as exc:
        return {"ok": False, "label": label, "path": str(path.relative_to(ROOT)), "error": str(exc)[:300]}


def write_json_result(path: Path, obj, label: str) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        maybe_forced_write_failure(label)
        save_json(path, obj)
        return {"ok": True, "label": label, "path": str(path.relative_to(ROOT))}
    except Exception as exc:
        return {"ok": False, "label": label, "path": str(path.relative_to(ROOT)), "error": str(exc)[:300]}


def append_json_list(path: Path, entry: dict, keep: int = 50) -> bool:
    try:
        items = load_json(path, [])
        if not isinstance(items, list):
            items = []
        items.append(entry)
        save_json(path, items[-keep:])
        return True
    except Exception:
        return False


def append_jsonl(path: Path, entry: dict) -> bool:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return True
    except Exception:
        return False


def clear_pending_entries(path: Path, topic: str, lane_value: str) -> bool:
    try:
        items = load_json(path, [])
        if not isinstance(items, list):
            return True
        kept = [
            item for item in items
            if not (
                str(item.get("topic") or "") == topic
                and str(item.get("lane_key") or "") == lane_value
            )
        ]
        if kept:
            save_json(path, kept)
        elif path.exists():
            path.unlink()
        return True
    except Exception:
        return False


def rebuild_topic_memory() -> dict:
    try:
        proc = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "topic_memory.py"), "rebuild"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=False,
            env=dict(os.environ),
        )
    except Exception as exc:
        return {
            "ok": False,
            "label": "topic_memory",
            "path": "branches/learn/topic_memory_index.json",
            "error": str(exc)[:300],
        }

    if proc.returncode != 0:
        err = ((proc.stderr or "").strip() or (proc.stdout or "").strip() or "topic_memory rebuild failed")[:300]
        return {
            "ok": False,
            "label": "topic_memory",
            "path": "branches/learn/topic_memory_index.json",
            "error": err,
        }

    return {
        "ok": True,
        "label": "topic_memory",
        "path": "branches/learn/topic_memory_index.json",
    }


def topic_bucket(topic: str) -> str:
    lowered = topic.lower()
    if "spy" in lowered or "death cross" in lowered:
        return "spy"
    if "iwm" in lowered or "small cap" in lowered or "small-cap" in lowered or "refinancing" in lowered:
        return "iwm"
    if "qqq" in lowered or "nasdaq" in lowered or "ai capex" in lowered:
        return "qqq"
    if "tlt" in lowered or "term premium" in lowered or "inflation surprise" in lowered:
        return "tlt"
    return "generic"


def build_study_conclusion(topic: str, profile: str, note_lines: list[str]) -> str:
    ranked = select_study_candidates(note_lines, profile, limit=6)
    best_note = best_conclusion_note(ranked, profile)
    if not best_note:
        return f"{topic} 当前本地学习包还不够，先不要把它写成市场结论，建议补更强资料后再落账。"
    if profile == "agent_updates":
        return f"{topic} 当前先内化一个智能体更新原则：{best_note}"
    if profile == "skills":
        return f"{topic} 当前先内化一个可复用技能模式：{best_note}"
    if profile == "frontier_paper":
        return f"{topic} 当前先抓住一个论文阅读框架：{best_note}"
    if profile == "options":
        return f"{topic} 当前先抓住一个期权基本功：{best_note}"
    if profile == "stock_analysis":
        return f"{topic} 当前先抓住一个股市分析框架：{best_note}"
    if profile == "macro_regime":
        return f"{topic} 当前先抓住一个宏观与市场结构框架：{best_note}"
    if profile == "risk_control":
        return f"{topic} 当前先抓住一个风险控制基本功：{best_note}"
    if profile == "quant_factor_timing":
        return f"{topic} 当前先抓住一套量化因子择时策略：{best_note}"
    if profile == "technical_timing":
        return f"{topic} 当前先抓住一个技术择时纪律：{best_note}"
    return f"{topic} 当前最值得保留的学习线索是：{best_note}"


def build_current_conclusion(topic: str, sections: list[tuple[str, list[dict], list[str]]], profile: str = "") -> str:
    bucket = topic_bucket(topic)
    note_lines = [note for _, _, notes in sections for note in notes if note]
    if profile:
        return build_study_conclusion(topic, profile, note_lines)
    notes_text = " ".join(note_lines).lower()

    if bucket == "spy":
        return "SPY 当前主线仍是趋势转弱，需继续观察弱势是否扩展成更大级别破位，现阶段不适合盲目抄底。"
    if bucket == "iwm":
        return "小盘轮动还没有被彻底证伪，但融资与再融资压力在抬升，追高风险明显上升。"
    if bucket == "qqq":
        return "QQQ 仍受 AI capex 预期和长久期重定价牵引，若通胀与期限溢价继续走高，波动会放大。"
    if bucket == "tlt":
        return "TLT 仍受通胀意外和期限溢价压制，除非利率预期重新回落，否则反弹持续性有限。"

    best_note = best_conclusion_note(note_lines)
    if best_note:
        lowered_note = canonical_text(best_note)
        if "short-term broken" in lowered_note and "200-day" in lowered_note:
            return f"{topic} 当前先盯 200-day 附近的破位是否继续扩散，再决定是不是更大级别转弱。"
        if "risk" in notes_text or "fragile" in notes_text or "weak" in notes_text:
            return f"{topic} 当前更像风险跟踪主题，核心线索是：{best_note}。"
        return f"{topic} 当前可继续跟踪，最值得保留的线索是：{best_note}。"

    return f"{topic} 已完成本地学习，但当前可直接引用的结论仍偏有限，建议结合 topic card 继续跟踪。"

def run_topic(topic: str) -> dict:
    requested_topic = topic
    topic = canonical_run_topic(topic)
    if not topic:
        return {
            "ok": False,
            "branch": "learn_branch",
            "status": "blocked",
            "mode": "normal",
            "summary": "learn task blocked: command-like text is not a durable topic",
            "error": "command-like text is not a durable topic",
        }
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    slug = slugify(topic)
    lane_value = lane_key()
    lane_suffix = f"__lane_{lane_slug()}"
    report_path = REPORT_DIR / f"{day}_{slug}{lane_suffix}.md"
    sources_path = REPORT_DIR / f"{day}_{slug}{lane_suffix}.sources.json"

    study_profile = study_topic_profile(topic)
    learning_focus = study_focus(topic)
    learning_strategy = study_strategy(topic)
    if study_profile:
        decomposed = study_pack_queries(study_profile, topic, learning_focus)
    else:
        decomposed = [
            (f"{topic} drivers", []),
            (f"{topic} risks", []),
            (f"{topic} market structure", []),
        ]

    results = []
    sections = []

    for q, keywords in decomposed:
        if study_profile:
            res = run_study_pack_search(topic, study_profile, q, keywords)
        else:
            res = run_search(q)
        items = with_brain_type(res.get("items", [])[:2])
        notes = distilled(q, items)
        brain_trace = {
            "intent": str(res.get("intent") or "").strip(),
            "expanded_tokens": res.get("expanded_tokens") or [],
            "item_brain_types": [item.get("brain_type", "") for item in items if item.get("brain_type")],
        }
        results.append({
            "query": q,
            "provider": str(res.get("provider") or "local_corpus"),
            "items": items,
            "brain_trace": brain_trace,
            "distilled_notes": notes,
        })
        sections.append((q, items, notes))

    lines = [
        f"# Learning Report - {day}",
        "",
        "## 1. Topic",
        f"- {topic}",
        f"- lane_key: {lane_key()}",
    ]
    lines.append(f"- learning_family: {study_profile or 'general'}")
    if learning_focus:
        lines.append(f"- learning_focus: {learning_focus}")
    if learning_strategy:
        lines.append(f"- learning_strategy: {learning_strategy}")
    lines += [
        "",
        "## 2. Decomposed Topics",
    ]
    for q, _ in decomposed:
        lines.append(f"- {q}")
    lines += ["", "## 3. Retrieved Notes"]

    for q, items, notes in sections:
        lines.append(f"### {q}")
        if not items:
            lines.append("- no clean source available")
            lines.append("")
            continue
        if notes:
            for n in notes:
                lines.append(f"- {n}")
        else:
            lines.append("- matched local corpus, but no distilled note extracted")
        lines.append("- supporting sources:")
        for item in items:
            lines.append(f"  - {item.get('title')} ({item.get('url')})")
        lines.append("")

    conclusion = build_current_conclusion(topic, sections, study_profile)

    branch_summary_lines = [
        "## 4. Branch Summary",
    ]
    if study_profile:
        branch_summary_lines.extend([
            "- Study-topic pack learner completed in bounded local mode.",
            "- Retrieval preferred curated local study packs before generic market memory.",
            "- This prevents generic learning topics from inheriting unrelated market topic cards.",
            "- This remains controlled batch learning, not autonomous unrestricted web learning.",
        ])
    else:
        branch_summary_lines.extend([
            "- Local batch learner completed in cheap-only mode.",
            "- Retrieval prefers hard-gated local corpus.",
            "- Learn reports do not feed back into retrieval by default.",
            "- This remains controlled batch learning, not autonomous unrestricted web learning.",
        ])

    lines += branch_summary_lines + [
        "",
        "## 5. Current Conclusion",
        f"- {conclusion}",
        "",
    ]
    report_text = "\n".join(lines)

    brain_trace_summary = summarize_brain_trace(results)

    payload = {
        "generated_at": now(),
        "mode": "bounded_local_study_pack" if study_profile else "cheap_local_batch_distilled",
        "topic": topic,
        "requested_topic": requested_topic,
        "lane_key": lane_value,
        "learning_goal": {
            "family": study_profile,
            "focus": learning_focus,
            "strategy": learning_strategy,
        },
        "results": results,
        "brain_trace_summary": brain_trace_summary,
    }

    task_summary = f"learn task completed for topic: {topic}"
    state_payload = {
        "enabled": True,
        "status": "success",
        "mode": "normal",
        "last_run_at": now(),
        "summary": task_summary,
        "report_path": str(report_path.relative_to(ROOT)),
        "sources_path": str(sources_path.relative_to(ROOT)),
        "lane_key": lane_value,
        "learning_goal": payload["learning_goal"],
        "provider_used": {
            "retrieval": "study_pack_local" if study_profile else "local_corpus_hard_gated",
            "analysis": "local_direct",
            "synthesis": "local_direct",
        },
        "brain_trace_summary": brain_trace_summary,
    }
    lane_state_payload = dict(state_payload)
    lane_state_payload["state_scope"] = "lane"

    writes = [
        write_text_result(report_path, report_text, "report"),
        write_json_result(sources_path, payload, "sources"),
        write_json_result(lane_state_path(lane_value), lane_state_payload, "lane_state"),
    ]
    if lane_value == "global":
        writes.insert(2, write_json_result(STATE_PATH, state_payload, "state"))
    if all(item["ok"] for item in writes):
        writes.append(rebuild_topic_memory())
    all_recorded = all(item["ok"] for item in writes)
    bookkeeping_status = "recorded" if all_recorded else "pending_retry"
    failures = [item for item in writes if not item["ok"]]

    pending_written = False
    anomaly_logged = False
    if failures:
        failure_summary = "; ".join(
            f"{item['label']}={item.get('error', 'unknown')}" for item in failures
        )[:500]
        pending_entry = {
            "created_at": now(),
            "topic": topic,
            "lane_key": lane_value,
            "task_result": "success",
            "bookkeeping_result": bookkeeping_status,
            "summary": task_summary,
            "report_path": str(report_path.relative_to(ROOT)),
            "sources_path": str(sources_path.relative_to(ROOT)),
            "state_path": str(STATE_PATH.relative_to(ROOT)) if lane_value == "global" else "",
            "lane_state_path": str(lane_state_path(lane_value).relative_to(ROOT)),
            "failures": failures,
            "retry_status": "pending",
        }
        anomaly_entry = {
            "created_at": now(),
            "category": "memory_write_failed",
            "source": "learn_branch",
            "topic": topic,
            "lane_key": lane_value,
            "summary": failure_summary,
            "failures": failures,
        }
        pending_written = append_json_list(PENDING_PATH, pending_entry)
        anomaly_logged = append_jsonl(ANOMALY_PATH, anomaly_entry)
    else:
        clear_pending_entries(PENDING_PATH, topic, lane_value)

    return {
        "ok": True,
        "branch": "learn_branch",
        "status": "success",
        "mode": "normal",
        "summary": task_summary,
        "report_path": str(report_path.relative_to(ROOT)),
        "sources_path": str(sources_path.relative_to(ROOT)),
        "lane_key": lane_value,
        "task_result": {
            "status": "success",
            "summary": task_summary,
        },
        "bookkeeping_result": {
            "status": bookkeeping_status,
            "writes": writes,
            "pending_path": str(PENDING_PATH.relative_to(ROOT)) if pending_written else "",
            "anomaly_path": str(ANOMALY_PATH.relative_to(ROOT)) if anomaly_logged else "",
            "lane_state_path": str(lane_state_path(lane_value).relative_to(ROOT)),
        },
    }


def main():
    topic = " ".join(sys.argv[1:]).strip()
    if not topic:
        print(json.dumps({"ok": False, "message": "missing topic"}, ensure_ascii=False, indent=2))
        raise SystemExit(1)

    print(json.dumps(run_topic(topic), ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
