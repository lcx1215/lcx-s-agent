#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from typing import Any

LEARNING_FAMILY_SPECS: list[dict[str, Any]] = [
    {
        "family": "agent_updates",
        "canonical_topic": "智能体系统更新",
        "strategy": "self_update_internalization",
        "signals": [
            "openclaw",
            "codex",
            "智能体",
            "agent runtime",
            "system prompt",
            "channel routing",
            "memory",
            "routing",
            "release notes",
            "release note",
            "changelog",
            "self update",
            "self-improvement",
            "自我更新",
            "更新自己",
            "最新更新",
            "升级自己",
            "update.run",
            "config.apply",
        ],
        "focus_terms": [
            "memory",
            "routing",
            "system prompt",
            "skills",
            "workflow",
            "tool use",
            "update.run",
            "config.apply",
            "release notes",
            "changelog",
            "channel routing",
            "workspace",
            "self-update",
            "self improvement",
        ],
        "generic_terms": ["openclaw", "codex", "智能体", "agent", "更新", "升级", "系统", "能力"],
    },
    {
        "family": "skills",
        "canonical_topic": "开源 skills",
        "strategy": "skill_internalization",
        "signals": [
            "开源",
            "open source",
            "github",
            "git repo",
            "repo",
            "仓库",
            "skill",
            "skills",
            "技能",
            "workflow",
            "工作流",
            "tooling",
            "tool use",
            "agent workflow",
        ],
        "focus_terms": [
            "github repo",
            "repo",
            "skill 设计",
            "workflow",
            "工作流",
            "tool use",
            "automation",
            "自动化",
            "agent",
            "prompt",
            "memory",
            "routing",
        ],
        "generic_terms": ["开源", "repo", "github", "skill", "skills", "技能", "workflow", "工作流"],
    },
    {
        "family": "frontier_paper",
        "canonical_topic": "前沿金融论文",
        "strategy": "paper_audit",
        "signals": [
            "论文",
            "paper",
            "papers",
            "arxiv",
            "研究论文",
            "research paper",
            "金融论文",
            "量化论文",
            "finance paper",
            "quant paper",
            "method paper",
        ],
        "focus_terms": [
            "walk-forward",
            "walk forward",
            "out-of-sample",
            "in-sample",
            "overfitting",
            "look-ahead bias",
            "data leakage",
            "数据泄漏",
            "feature engineering",
            "evaluation",
            "方法",
            "method",
            "回测",
            "因子",
            "微观结构",
            "期权",
            "volatility",
        ],
        "generic_terms": ["论文", "paper", "papers", "arxiv", "研究论文", "金融论文", "量化论文"],
    },
    {
        "family": "options",
        "canonical_topic": "期权能力",
        "strategy": "capability_bootstrap",
        "signals": [
            "期权",
            "option",
            "options",
            "delta",
            "gamma",
            "vega",
            "theta",
            "greek",
            "greeks",
            "hedge",
            "hedging",
            "对冲",
            "隐波",
            "implied vol",
            "volatility smile",
            "vol surface",
            "波动率曲面",
        ],
        "focus_terms": [
            "delta",
            "gamma",
            "vega",
            "theta",
            "greek",
            "greeks",
            "hedge",
            "hedging",
            "对冲",
            "隐波",
            "implied vol",
            "vol surface",
            "波动率曲面",
            "volatility smile",
            "tail risk",
            "gap risk",
            "position sizing",
            "stress testing",
        ],
        "generic_terms": ["期权", "option", "options", "能力", "基本功"],
    },
    {
        "family": "stock_analysis",
        "canonical_topic": "股市分析能力",
        "strategy": "equity_framework",
        "signals": [
            "股市",
            "股票",
            "stock",
            "stocks",
            "equity",
            "equities",
            "做多",
            "做空",
            "多空",
            "long short",
            "long-short",
            "long bias",
            "short bias",
            "财报",
            "earnings",
            "估值",
            "valuation",
            "基本面",
            "fundamental",
            "factor",
            "risk premium",
            "behavioral finance",
            "microstructure",
            "市场微观结构",
            "流动性",
            "etf liquidity",
        ],
        "focus_terms": [
            "做多",
            "做空",
            "多空",
            "long short",
            "long-short",
            "long bias",
            "short bias",
            "财报阅读",
            "earnings",
            "估值",
            "valuation",
            "股票估值",
            "基本面",
            "fundamental",
            "factor",
            "risk premium",
            "behavioral finance",
            "bias",
            "microstructure",
            "市场微观结构",
            "流动性",
            "etf liquidity",
            "execution quality",
        ],
        "generic_terms": ["股市", "股票", "stock", "stocks", "equity", "equities", "分析", "能力", "基本功"],
    },
    {
        "family": "macro_regime",
        "canonical_topic": "宏观与市场结构",
        "strategy": "regime_framework",
        "signals": [
            "宏观",
            "macro",
            "regime",
            "risk-on",
            "risk off",
            "risk-on risk-off",
            "通胀",
            "inflation",
            "rates",
            "利率",
            "term premium",
            "资产配置",
            "asset allocation",
            "correlation",
            "risk premia",
        ],
        "focus_terms": [
            "regime",
            "risk-on risk-off",
            "risk on risk off",
            "通胀",
            "inflation",
            "rates",
            "利率",
            "term premium",
            "资产配置",
            "asset allocation",
            "correlation",
            "risk premia",
            "flight to quality",
            "equity-bond correlation",
        ],
        "generic_terms": ["宏观", "macro", "regime", "市场结构", "资产配置", "框架"],
    },
    {
        "family": "risk_control",
        "canonical_topic": "风险控制能力",
        "strategy": "risk_hardening",
        "signals": [
            "风控",
            "风险控制",
            "risk control",
            "drawdown",
            "回撤",
            "tail risk",
            "压力测试",
            "stress test",
            "stress testing",
            "仓位",
            "position sizing",
            "slippage",
            "transaction cost",
            "liquidity risk",
            "gap risk",
            "生存",
        ],
        "focus_terms": [
            "drawdown",
            "回撤",
            "tail risk",
            "压力测试",
            "stress test",
            "stress testing",
            "position sizing",
            "仓位",
            "slippage",
            "transaction cost",
            "liquidity risk",
            "gap risk",
            "diversification",
            "survivorship bias",
        ],
        "generic_terms": ["风控", "风险控制", "risk control", "能力", "基本功", "框架"],
    },
    {
        "family": "quant_factor_timing",
        "canonical_topic": "量化因子择时策略",
        "strategy": "factor_timing_audit",
        "signals": [
            "量化因子择时",
            "量化因子",
            "因子择时",
            "factor timing",
            "factor-timing",
            "quant factor",
            "factor rotation",
            "因子轮动",
            "双动量",
            "dual momentum",
            "cross-sectional momentum",
            "time-series momentum",
        ],
        "focus_terms": [
            "factor",
            "因子",
            "factor timing",
            "factor rotation",
            "dual momentum",
            "time-series momentum",
            "cross-sectional momentum",
            "walk-forward",
            "out-of-sample",
            "overfitting",
            "survivorship bias",
            "look-ahead bias",
            "turnover",
            "transaction cost",
            "volatility targeting",
            "rebalance",
        ],
        "generic_terms": ["量化", "因子", "择时", "策略", "quant", "factor", "timing"],
    },
    {
        "family": "technical_timing",
        "canonical_topic": "技术择时能力",
        "strategy": "timing_discipline",
        "signals": [
            "择时",
            "timing",
            "趋势",
            "trend",
            "动量",
            "momentum",
            "均线",
            "moving average",
            "breakout",
            "mean reversion",
            "regime filter",
            "signal smoothing",
            "波动率目标",
            "volatility targeting",
        ],
        "focus_terms": [
            "moving average",
            "均线",
            "200-day",
            "breakout",
            "mean reversion",
            "trend",
            "趋势",
            "momentum",
            "动量",
            "regime filter",
            "signal smoothing",
            "volatility targeting",
        ],
        "generic_terms": ["技术", "择时", "timing", "能力", "基本功", "框架"],
    },
]

ACTIVE_LEARNING_PATTERNS = [
    r"^(现在\s*)?(自己\s*)?(去学|去读|去看|去补|先补|先学|补一下|学一下|读|研究一下|梳理一下|看看|跟上|对齐一下)",
    r"把.+?(基本功|能力|框架|方法|workflow|工作流|skills?|skill|技能|论文|paper|财报阅读|估值|风控|宏观|择时).+?(补一下|学一下|梳理一下|内化一下?)",
    r"^(加强|强化|提升).+?(能力|基本功|框架|方法)",
]

DURATION_ACTIVE_CUES = [
    "一个小时",
    "一小时",
    "两个小时",
    "两小时",
    "半小时",
]

VISUAL_CAPTURE_CUES = [
    "截图",
    "屏幕",
    "桌面",
    "图表",
    "k线",
    "k 線",
    "画图",
    "画线",
    "看图",
    "chart",
    "screenshot",
    "screen shot",
    "screen",
    "candlestick",
    "browser",
    "浏览器",
]

QUEUE_ONLY_PATTERNS = [
    "记住这个",
    "记住",
    "记下来",
    "收进记忆",
    "收进学习记忆",
    "留档",
    "别忘了",
    "以后要用",
    "以后有用",
    "后面要用",
]

QUEUE_ONLY_REGEXES = [
    r"^(把这个|把这条|把这一条)?\s*记住[:：]?",
    r"^(把这个|把这条|把这一条)?\s*记下来[:：]?",
    r"^(把这个|把这条|把这一条)?\s*收进(学习)?记忆",
    r"^(把这个|把这条|把这一条)?\s*留档",
    r"^(把这个|把这条|把这一条)?\s*别忘了",
]

GLOBAL_REQUEST_CUES = [
    "学习",
    "研究",
    "学",
    "读",
    "补",
    "看",
    "内化",
    "梳理",
    "分析",
    "总结",
    "记忆",
]

GLOBAL_FOCUS_STOPWORDS = {
    "这个",
    "这条",
    "这一条",
    "自己",
    "好的",
    "几个",
    "一个",
    "一点",
    "两篇",
    "几篇",
    "帮我",
    "给我",
    "重点",
    "抓重点",
    "抓",
    "现在",
    "先",
    "最新",
    "最新的",
    "你去",
    "学前沿",
    "以后",
    "之后",
    "后面",
    "学完",
    "发群里",
    "回群里",
    "简短点",
    "短一点",
    "先跑一个",
    "就行",
    "值得你记住的",
    "值得记住的",
    "值得你记下的",
    "值得保留的",
    "值得学习的",
    "一个小时",
    "一小时",
    "两个小时",
    "两小时",
    "半小时",
    "里的",
}

META_INSTRUCTION_HINTS = [
    "不要入队",
    "优先级测试",
    "只能做一件",
    "不能做第二件",
    "在下面三者中选一个",
    "必须只选一个",
    "说明为什么",
    "另外两个现在不能排第一",
]


def canonical_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def looks_like_meta_instruction(text: str) -> bool:
    lowered = canonical_text(text)
    if any(hint in lowered for hint in META_INSTRUCTION_HINTS):
        return True
    if "先跑一个" in lowered and any(token in lowered for token in ("要求", "选一个", "说明为什么")):
        return True
    if re.search(r"\b[a-c]\b", lowered) and any(token in lowered for token in ("选一个", "说明为什么", "为什么")):
        return True
    return False


def normalize_learning_text(text: str) -> str:
    cleaned = (text or "").strip()
    cleaned = cleaned.replace("，", " ").replace("。", " ").replace("、", " ").replace("；", " ").replace("：", " ")
    cleaned = re.sub(r"^(你去\s*)?(现在\s*)?(自己\s*)?(去学|去读|去看|去补|先补|先学|学习)\s*", "", cleaned)
    cleaned = re.sub(r"^(加强|强化|提升)\s*", "", cleaned)
    cleaned = re.sub(r"^(把这个|把这条|把这一条|这个|这条|这一条)\s*", "", cleaned)
    cleaned = re.sub(
        r"(帮我|给我|重点|抓重点|再|顺便|以后|之后|后面|要用|学完发群里|发群里|回群里|别太长|不要太长|简短点|短一点|先跑一个|到自己|最新的|最新|值得你记住的|值得记住的|值得你记下的|值得保留的|值得学习的|一个小时|一小时|两个小时|两小时|半小时)",
        " ",
        cleaned,
    )
    cleaned = re.sub(r"(并?内化|内化一下|好的)", " ", cleaned)
    cleaned = re.sub(r"(几个|一个就行|一个|一点|两篇|几篇)", " ", cleaned)
    cleaned = re.sub(
        r"(学一下|学习|研究一下|看看|看一下|再看一下|分析一下|梳理一下|补一下|补一轮|记住这个|记住|记下来|收进记忆|收进学习记忆|留着|留档|别忘了|以后要用|以后有用|后面要用)",
        " ",
        cleaned,
        flags=re.I,
    )
    cleaned = re.sub(r"^[：:;\-]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ：:;-")
    return cleaned


def contains_phrase(text: str, phrase: str) -> bool:
    normalized = canonical_text(text)
    target = canonical_text(phrase)
    return bool(target) and target in normalized


def ordered_phrase_matches(text: str, phrases: list[str]) -> list[str]:
    lowered = canonical_text(text)
    hits: list[tuple[int, str]] = []
    seen: set[str] = set()
    for phrase in phrases:
        target = canonical_text(phrase)
        if not target or target in seen:
            continue
        idx = lowered.find(target)
        if idx < 0:
            continue
        seen.add(target)
        hits.append((idx, phrase))
    hits.sort(key=lambda item: item[0])
    return [phrase for _, phrase in hits]


def family_score(cleaned: str, spec: dict[str, Any]) -> int:
    score = 0
    for phrase in spec["signals"]:
        if contains_phrase(cleaned, phrase):
            score += 6
    for phrase in spec["focus_terms"]:
        if contains_phrase(cleaned, phrase):
            score += 4
    if contains_phrase(cleaned, spec["canonical_topic"]):
        score += 10
    return score


def family_spec(family: str) -> dict[str, Any] | None:
    for spec in LEARNING_FAMILY_SPECS:
        if spec["family"] == family:
            return spec
    return None


def clean_focus_text(text: str) -> str:
    cleaned = text
    for token in sorted(GLOBAL_FOCUS_STOPWORDS, key=len, reverse=True):
        cleaned = re.sub(re.escape(token), " ", cleaned, flags=re.I)
    cleaned = re.sub(r"[,\.;:!?！？。、“”\"'()（）\[\]]", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" -:/")
    return cleaned


def derive_focus(cleaned: str, spec: dict[str, Any]) -> str:
    generic_terms = {canonical_text(term) for term in spec["generic_terms"]}
    matched_focus = []
    for phrase in ordered_phrase_matches(cleaned, spec["focus_terms"]):
        if canonical_text(phrase) in generic_terms:
            continue
        matched_focus.append(phrase)
    if matched_focus:
        return " / ".join(matched_focus[:3])

    fallback = cleaned
    for phrase in sorted(spec["signals"] + spec["generic_terms"] + [spec["canonical_topic"]], key=len, reverse=True):
        fallback = re.sub(re.escape(phrase), " ", fallback, flags=re.I)
    fallback = re.sub(r"\b(能力|基本功|框架|方法|paper|papers|论文|arxiv|skills?|skill|workflow|工作流)\b", " ", fallback, flags=re.I)
    fallback = clean_focus_text(fallback)
    if not fallback:
        return ""
    if canonical_text(fallback) == canonical_text(spec["canonical_topic"]):
        return ""
    if len(re.findall(r"[0-9a-z\u4e00-\u9fff]+", canonical_text(fallback))) < 2:
        return ""
    return fallback


def looks_like_active_learning_request(text: str) -> bool:
    if any(re.search(pattern, text, flags=re.I) for pattern in ACTIVE_LEARNING_PATTERNS):
        return True
    lowered = canonical_text(text)
    if any(cue in lowered for cue in DURATION_ACTIVE_CUES):
        cleaned = normalize_learning_text(text)
        return any(family_score(cleaned, spec) > 0 for spec in LEARNING_FAMILY_SPECS)
    if lowered.startswith("学习"):
        cleaned = normalize_learning_text(text)
        return any(family_score(cleaned, spec) > 0 for spec in LEARNING_FAMILY_SPECS)
    return False


def looks_like_learning_request(text: str) -> bool:
    cleaned = normalize_learning_text(text)
    if not cleaned:
        return False
    if looks_like_active_learning_request(text):
        return True
    if any(marker in text for marker in QUEUE_ONLY_PATTERNS):
        return True
    lowered = canonical_text(text)
    if not any(cue in lowered for cue in GLOBAL_REQUEST_CUES):
        return False
    return any(family_score(cleaned, spec) > 0 for spec in LEARNING_FAMILY_SPECS)


def looks_like_queue_only_request(text: str) -> bool:
    normalized = canonical_text(text)
    if not normalized:
        return False
    if any(re.search(pattern, normalized, flags=re.I) for pattern in QUEUE_ONLY_REGEXES):
        return True
    return any(marker in normalized for marker in ("收进记忆", "收进学习记忆", "留档", "以后要用", "以后有用", "后面要用"))


def looks_like_visual_learning_request(text: str) -> bool:
    cleaned = normalize_learning_text(text)
    if not cleaned or not looks_like_active_learning_request(text):
        return False
    lowered = canonical_text(text)
    return any(cue in lowered for cue in VISUAL_CAPTURE_CUES)


def resolve_learning_goal(text: str) -> dict[str, Any]:
    cleaned = normalize_learning_text(text)
    is_learning = looks_like_learning_request(text)
    is_active = looks_like_active_learning_request(text)
    if not is_learning and looks_like_meta_instruction(text):
        return {
            "raw_text": text,
            "normalized_text": cleaned,
            "is_learning_request": False,
            "is_active_request": False,
            "family": "",
            "canonical_topic": "",
            "focus": "",
            "strategy": "",
            "score": 0,
        }
    if not looks_like_active_learning_request(text) and looks_like_queue_only_request(text):
        return {
            "raw_text": text,
            "normalized_text": cleaned,
            "is_learning_request": is_learning,
            "is_active_request": False,
            "family": "",
            "canonical_topic": cleaned,
            "focus": cleaned,
            "strategy": "general_study",
            "score": 0,
        }

    ranked: list[tuple[int, dict[str, Any]]] = []
    for spec in LEARNING_FAMILY_SPECS:
        score = family_score(cleaned, spec)
        if score > 0:
            ranked.append((score, spec))
    ranked.sort(key=lambda item: item[0], reverse=True)
    best_score, best_spec = ranked[0] if ranked else (0, None)

    if best_spec is None:
        return {
            "raw_text": text,
            "normalized_text": cleaned,
            "is_learning_request": is_learning,
            "is_active_request": is_active,
            "family": "",
            "canonical_topic": cleaned,
            "focus": cleaned,
            "strategy": "general_study",
            "score": 0,
        }

    return {
        "raw_text": text,
        "normalized_text": cleaned,
        "is_learning_request": is_learning,
        "is_active_request": is_active,
        "family": best_spec["family"],
        "canonical_topic": best_spec["canonical_topic"],
        "focus": derive_focus(cleaned, best_spec),
        "strategy": best_spec["strategy"],
        "score": best_score,
    }


def infer_learning_family(text: str) -> str:
    return str(resolve_learning_goal(text).get("family") or "")


def canonical_learning_topic(text: str) -> str:
    goal = resolve_learning_goal(text)
    return str(goal.get("canonical_topic") or "")


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"ok": False, "error": "missing mode"}, ensure_ascii=False, indent=2))
        return 1

    mode = args[0]
    text = " ".join(args[1:]).strip()
    if mode == "--is-learning":
        print("1" if looks_like_learning_request(text) else "0")
        return 0
    if mode == "--json":
        print(json.dumps(resolve_learning_goal(text), ensure_ascii=False, indent=2))
        return 0
    if mode == "--topic":
        print(canonical_learning_topic(text))
        return 0
    if mode == "--family":
        print(infer_learning_family(text))
        return 0
    if mode == "--visual":
        print("1" if looks_like_visual_learning_request(text) else "0")
        return 0

    print(json.dumps({"ok": False, "error": f"unknown mode: {mode}"}, ensure_ascii=False, indent=2))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
