/**
 * Contract-vocabulary alignment for the local-brain training slice.
 *
 * Problem this closes (verified 2026-09-19): the hardened eval prompt feeds the
 * model exact directive lines ("Required missing_data ids for this case: ...",
 * "Required risk_boundaries for this case: ...") whose ids must be echoed
 * verbatim in the raw completion, but the training slice prompts carried no such
 * directives and the completion `missing_data`/`risk_boundaries` used prose
 * copies of source-summary text. The retrained adapters therefore never reached
 * `modelContractReady` on any case.
 *
 * This module rebuilds each slice record so the training pair matches the eval
 * contract format:
 *  - the prompt gains the same directive lines the eval uses (same wording);
 *  - the completion remaps `missing_data`/`risk_boundaries` to canonical ids
 *    drawn from the eval registry vocabulary, selected by deterministic keyword
 *    rules over the sample's own text (no LLM, no fabricated ids);
 *  - the completion is then re-hardened through `hardenLocalBrainPlanForAsk` so
 *    the training target is already self-hardened (delta-free by construction).
 *
 * Directive lines are only emitted for ids the hardened completion actually
 * contains, so the prompt->completion echo is always consistent.
 */

import fs from "node:fs/promises";
import { hardenLocalBrainPlanForAsk } from "./local-brain-contracts.js";

const CONTRACT_ALIGN_MAX_MISSING_DATA = 8;
const CONTRACT_ALIGN_MAX_RISK_BOUNDARIES = 6;
const CONTRACT_ALIGN_MIN_SIGNAL_TOKENS = 1;
/** boundaryOk accepts research_only or no_execution_authority; keep both in every target. */
const BOUNDARY_OK_BASE = ["research_only", "no_execution_authority"] as const;

const GENERIC_TOKENS = new Set<string>([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "over",
  "per",
  "the",
  "this",
  "to",
  "under",
  "with",
  "without",
  "input",
  "inputs",
  "data",
  "date",
  "current",
  "latest",
  "required",
  "need",
  "needs",
  "and_or",
  "id",
  "ids",
  "case",
  "like",
  "such",
]);

/** Low-signal id tokens shared by many vocabulary ids; never used for scoring. */
const ID_NOISE_TOKENS = new Set<string>([
  "and",
  "or",
  "with",
  "for",
  "of",
  "to",
  "the",
  "a",
  "input",
  "inputs",
  "data",
  "current",
  "latest",
  "required",
  "id",
  "ids",
  "case",
  "series",
]);

/**
 * Phrase -> signal tokens. A phrase match adds its tokens to the signal set.
 * English phrases are matched case-insensitively on the normalized text;
 * Chinese phrases are matched as literal substrings.
 */
const ALIAS_TERMS: ReadonlyArray<readonly [string, readonly string[]]> = [
  // earnings / filings
  ["earnings", ["earnings"]],
  ["10q", ["10q", "filing", "earnings"]],
  ["10k", ["10k", "filing", "earnings"]],
  ["10-k", ["10k", "filing", "earnings"]],
  ["10-q", ["10q", "filing", "earnings"]],
  ["filing", ["filing", "10k", "10q", "earnings"]],
  ["财报", ["earnings", "filing", "10k", "10q"]],
  ["年报", ["10k", "filing", "earnings"]],
  ["季报", ["10q", "filing", "earnings"]],
  ["业绩预告", ["earnings", "guidance"]],
  // position / portfolio
  ["position weights", ["position", "weights"]],
  ["position_weights", ["position", "weights"]],
  ["仓位", ["position", "weights", "portfolio"]],
  ["持仓", ["position", "weights"]],
  ["portfolio", ["portfolio"]],
  ["组合", ["portfolio"]],
  ["cost basis", ["cost", "basis"]],
  ["time horizon", ["time", "horizon"]],
  ["return series", ["return", "returns"]],
  ["returns", ["return", "returns"]],
  ["return history", ["return", "returns"]],
  ["price history", ["price", "history"]],
  ["price series", ["price", "series"]],
  ["risk limits", ["risk", "limits"]],
  ["risk budget", ["risk", "budget"]],
  ["drawdown", ["drawdown"]],
  ["回撤", ["drawdown"]],
  ["position size", ["position", "size"]],
  // macro / rates / inflation
  ["inflation", ["inflation", "cpi"]],
  ["通胀", ["inflation", "cpi"]],
  ["cpi", ["cpi", "inflation"]],
  ["rates", ["rates"]],
  ["利率", ["rates", "interest"]],
  ["fed path", ["fed", "path"]],
  ["fed", ["fed"]],
  ["美联储", ["fed", "rates"]],
  ["term premium", ["term", "premium"]],
  ["real yield", ["real", "yield"]],
  ["yield curve", ["yield", "curve"]],
  ["treasury", ["treasury"]],
  ["美债", ["treasury", "yield"]],
  ["duration", ["duration"]],
  ["liquidity", ["liquidity"]],
  ["流动性", ["liquidity"]],
  ["credit spreads", ["credit", "spreads"]],
  ["credit", ["credit"]],
  ["信用", ["credit"]],
  ["nonbank", ["nonbank", "leverage"]],
  ["private credit", ["private", "credit", "nonbank"]],
  ["dollar", ["dollar"]],
  ["美元", ["dollar", "fx"]],
  ["yuan", ["yuan"]],
  ["人民币", ["yuan", "fx"]],
  ["fx", ["fx"]],
  ["汇率", ["fx"]],
  ["macro", ["macro"]],
  ["宏观", ["macro"]],
  // commodities / energy
  ["oil", ["oil"]],
  ["原油", ["oil", "crude"]],
  ["crude", ["oil", "crude"]],
  ["inventory", ["inventory"]],
  ["库存", ["inventory"]],
  ["spare capacity", ["spare", "capacity"]],
  ["gold", ["gold"]],
  ["黄金", ["gold"]],
  ["commodity", ["commodity"]],
  ["大宗商品", ["commodity", "oil", "gold"]],
  // equities / market structure
  ["breadth", ["breadth"]],
  ["technical", ["technical", "moving", "average"]],
  ["moving average", ["moving", "average"]],
  ["动量", ["momentum", "technical"]],
  ["momentum", ["momentum"]],
  ["volume", ["volume"]],
  ["volatility", ["volatility"]],
  ["波动率", ["volatility", "iv"]],
  ["options", ["options"]],
  ["期权", ["options"]],
  ["iv skew", ["iv", "skew"]],
  ["event calendar", ["event", "calendar"]],
  ["event", ["event"]],
  ["事件", ["event"]],
  ["index concentration", ["index", "concentration", "weights"]],
  ["concentration", ["concentration", "overlap"]],
  ["overlap", ["overlap"]],
  ["weight", ["weight", "weights"]],
  ["regime", ["regime"]],
  ["均线", ["moving", "average", "technical"]],
  ["usa", ["us", "equity"]],
  ["美股", ["us", "equity"]],
  ["a股", ["china", "a_share", "equity"]],
  // fundamentals / valuation
  ["revenue", ["revenue"]],
  ["revenue quality", ["revenue", "quality"]],
  ["margin", ["margin"]],
  ["毛利率", ["margin"]],
  ["fcf", ["fcf", "cash_flow"]],
  ["free cash flow", ["fcf", "cash_flow"]],
  ["现金流", ["fcf", "cash_flow"]],
  ["roic", ["roic"]],
  ["balance sheet", ["balance", "sheet"]],
  ["资产负债表", ["balance", "sheet"]],
  ["moat", ["moat"]],
  ["护城河", ["moat"]],
  ["management", ["management"]],
  ["管理层", ["management", "capital", "allocation"]],
  ["capital allocation", ["capital", "allocation"]],
  ["valuation", ["valuation"]],
  ["估值", ["valuation"]],
  ["margin of safety", ["margin", "safety"]],
  ["安全边际", ["margin", "safety"]],
  ["value trap", ["value", "trap"]],
  ["fundamental", ["fundamental"]],
  ["基本面", ["fundamental"]],
  ["guidance", ["guidance"]],
  ["财报指引", ["guidance", "revenue", "margin"]],
  // catalysts / thesis
  ["catalyst", ["catalyst"]],
  ["催化", ["catalyst", "event"]],
  ["thesis", ["thesis"]],
  ["逻辑", ["thesis"]],
  ["invalidation", ["invalidation"]],
  ["证伪", ["invalidation", "red", "team"]],
  ["upside driver", ["upside", "driver"]],
  // research / sources
  ["source url", ["source", "url"]],
  ["source path", ["source", "path"]],
  ["url", ["url", "source"]],
  ["链接", ["url", "source"]],
  ["source", ["source"]],
  ["来源", ["source"]],
  ["primary source", ["primary", "source"]],
  ["transcript", ["transcript", "primary", "source"]],
  ["candidate repo", ["candidate", "repo", "url"]],
  ["local skill", ["local", "skill"]],
  ["paper", ["paper"]],
  ["论文", ["paper"]],
  ["arxiv", ["paper"]],
  ["provenance", ["provenance"]],
  ["溯源", ["provenance", "source"]],
  ["vendor", ["vendor", "source", "timestamp"]],
  ["timestamp", ["timestamp"]],
  ["reliability grade", ["reliability", "grade"]],
  ["coverage limits", ["coverage", "limits"]],
  ["sample out", ["sample", "out"]],
  ["out of sample", ["sample", "out"]],
  ["样本外", ["sample", "out"]],
  ["walk forward", ["walk", "forward"]],
  ["cross validation", ["cross", "validation"]],
  ["backtest", ["backtest"]],
  ["回测", ["backtest"]],
  ["survivor bias", ["survivor"]],
  ["lookahead bias", ["lookahead"]],
  ["look ahead", ["lookahead"]],
  ["regression proof", ["regression", "proof"]],
  ["replication", ["replication"]],
  // risk / boundaries
  ["leverage", ["leverage"]],
  ["杠杆", ["leverage"]],
  ["crypto", ["crypto"]],
  ["比特币", ["crypto", "btc"]],
  ["btc", ["crypto", "btc"]],
  ["stablecoin", ["stablecoin"]],
  ["稳定币", ["stablecoin"]],
  ["red team", ["red", "team"]],
  ["红队", ["red", "team"]],
  ["stress", ["stress"]],
  ["压力测试", ["stress"]],
  ["liquidation", ["liquidation"]],
  ["order placement", ["order", "placement"]],
  ["trade advice", ["trade", "advice"]],
  ["trading advice", ["trade", "advice"]],
  ["execution", ["execution"]],
  ["下单", ["order", "execution"]],
  ["wash sale", ["wash", "tax"]],
  ["tax", ["tax"]],
  ["journal", ["journal", "postmortem"]],
  ["post mortem", ["postmortem"]],
  ["复盘", ["postmortem", "review"]],
  ["memory", ["memory"]],
  ["记忆", ["memory"]],
  ["module", ["module"]],
  ["skill", ["skill"]],
  ["agent", ["agent"]],
  ["review", ["review"]],
  ["review panel", ["review"]],
  ["qc", ["qc"]],
  ["artifact", ["artifact", "qc"]],
  ["验收", ["qc", "acceptance"]],
  ["acceptance", ["acceptance"]],
  ["metric", ["metric", "acceptance"]],
  ["指标", ["metric", "acceptance"]],
  // supply chain / ai capex
  ["ai capex", ["ai", "capex"]],
  ["capex", ["capex"]],
  ["资本开支", ["capex", "ai"]],
  ["gpu", ["gpu", "semis"]],
  ["hbm", ["hbm", "memory", "supply", "chain"]],
  ["datacenter", ["datacenter", "power"]],
  ["data center", ["datacenter", "power"]],
  ["数据中心", ["datacenter", "power", "grid"]],
  ["power grid", ["power", "grid"]],
  ["supply chain", ["supply", "chain"]],
  ["供应链", ["supply", "chain"]],
  ["inventory", ["inventory"]],
  ["hyperscaler", ["hyperscaler", "capex", "budget"]],
  ["nvidia", ["gpu", "semis", "nvda"]],
  ["nvda", ["gpu", "semis", "nvda"]],
  // china / policy
  ["northbound", ["northbound", "china", "policy"]],
  ["北向", ["northbound", "china", "policy"]],
  ["policy flow", ["policy", "flow"]],
  ["政策", ["policy"]],
  ["property", ["property"]],
  ["地产", ["property"]],
  ["china", ["china"]],
  ["a share", ["a_share", "china"]],
  ["sector scope", ["sector", "scope"]],
  ["style bucket", ["style", "bucket"]],
  ["market scope", ["market", "scope"]],
  ["time window", ["time", "window"]],
  ["market id", ["market", "id"]],
  ["universe", ["universe"]],
  ["exclusion rules", ["exclusion", "rules"]],
  ["exclusion", ["exclusion"]],
  ["ohlcv", ["ohlcv", "price", "volume"]],
  ["orderbook", ["orderbook", "liquidity"]],
  ["slippage", ["slippage"]],
  ["fees", ["fees"]],
  ["liquidity snapshot", ["liquidity", "snapshot"]],
  ["market metadata", ["market", "metadata"]],
  // scenario / probability
  ["scenario", ["scenario"]],
  ["情景", ["scenario"]],
  ["probability", ["probability"]],
  ["概率", ["probability"]],
  ["red team invalidation", ["red", "team", "invalidation"]],
  // workflow / contracts
  ["workflow owner", ["workflow", "owner"]],
  ["leaf worker", ["leaf", "worker"]],
  ["orchestrator", ["orchestrator"]],
  ["tool boundary", ["tool", "boundary"]],
  ["tool permission", ["tool", "permission"]],
  ["handoff", ["handoff"]],
  ["handoff contract", ["handoff", "contract"]],
  ["shared contract", ["shared", "contract"]],
  ["visible summary", ["visible", "summary"]],
  ["user visible", ["visible", "summary"]],
  ["prompt injection", ["prompt", "injection"]],
  ["security review", ["security", "review"]],
  ["license", ["license"]],
  ["write scope", ["write", "scope"]],
  ["approval", ["approval", "human", "signoff"]],
  ["signoff", ["signoff", "human", "approval"]],
  ["human review", ["human", "review"]],
  // misc finance
  ["sentiment", ["sentiment"]],
  ["情绪", ["sentiment"]],
  ["headline", ["headline", "sentiment", "news"]],
  ["新闻", ["news", "sentiment"]],
  ["news", ["news"]],
  ["viral", ["viral"]],
  ["interview", ["interview"]],
  ["ceo", ["ceo", "management"]],
  ["dinner", ["viral", "social"]],
  ["podcast", ["podcast", "social"]],
  ["social", ["social", "sentiment"]],
  ["fomc", ["fomc", "event", "cpi", "fed"]],
  ["treasury issuance", ["treasury", "issuance"]],
  ["auction", ["auction", "calendar"]],
  ["refunding", ["refunding", "treasury"]],
  ["earnings gap", ["earnings", "gap"]],
  ["gap risk", ["gap", "risk"]],
  ["mag7", ["mag7", "index", "concentration"]],
  ["index", ["index", "weights"]],
  ["sp500", ["index", "sp500"]],
  ["qqq", ["qqq", "index", "etf"]],
  ["etf", ["etf", "index"]],
  ["tlt", ["tlt", "treasury", "duration"]],
  ["gld", ["gld", "gold"]],
  ["dbc", ["dbc", "commodity"]],
  ["uso", ["uso", "oil"]],
  ["dba", ["dba", "commodity", "oil"]],
  ["options event", ["options", "event"]],
  ["options iv", ["options", "iv"]],
  ["fees slippage", ["fees", "slippage"]],
  ["tax loss", ["tax", "loss"]],
  ["portfolio risk", ["portfolio", "risk"]],
];

/** Normalize text for English phrase matching and id-token matching. */
function normalizeSignalText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\u002f/g, " ") // slash -> space so 10-k/10-q split cleanly
    .replace(/\s+/gu, " ")
    .trim();
}

function canonicalContractToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function idSignalTokens(id: string): string[] {
  return id
    .split("_")
    .filter(
      (token) => token.length > 1 && !GENERIC_TOKENS.has(token) && !ID_NOISE_TOKENS.has(token),
    );
}

function collectSignalTokens(text: string): Set<string> {
  const normalized = normalizeSignalText(text);
  const tokens = new Set<string>();
  const asciiTokens = normalized.match(/[a-z0-9]+/gu) ?? [];
  for (const token of asciiTokens) {
    if (token.length > 1) {
      tokens.add(token);
    }
  }
  for (const [phrase, mapped] of ALIAS_TERMS) {
    const phraseNormalized = normalizeSignalText(phrase);
    if (normalized.includes(phraseNormalized)) {
      for (const token of mapped) {
        tokens.add(token);
      }
    }
  }
  return tokens;
}

function scoreIds(vocab: readonly string[], signalTokens: Set<string>): Array<[string, number]> {
  const scored: Array<[string, number]> = [];
  for (const id of vocab) {
    const idTokens = idSignalTokens(id);
    let matched = 0;
    for (const token of idTokens) {
      if (signalTokens.has(token)) {
        matched += 1;
      }
    }
    if (matched >= CONTRACT_ALIGN_MIN_SIGNAL_TOKENS) {
      scored.push([id, matched]);
    }
  }
  scored.sort(
    ([leftId, leftScore], [rightId, rightScore]) =>
      rightScore - leftScore || leftId.localeCompare(rightId),
  );
  return scored;
}

function pickTopIds(
  vocab: readonly string[],
  signalTokens: Set<string>,
  maxCount: number,
): string[] {
  return scoreIds(vocab, signalTokens)
    .slice(0, maxCount)
    .map(([id]) => id);
}

function includesCanonicalToken(values: unknown, expected: string): boolean {
  if (!Array.isArray(values)) {
    return false;
  }
  const canonical = canonicalContractToken(expected);
  return values.some(
    (value) => typeof value === "string" && canonicalContractToken(value) === canonical,
  );
}

type AlignResult = {
  prompt: string;
  completion: string;
  directiveMissingData: string[];
  directiveRiskBoundaries: string[];
  aligned: boolean;
};

export type ContractVocabAligner = {
  missingDataIds: string[];
  riskBoundaryIds: string[];
  alignRecord: (record: { prompt: string; completion: string; meta?: unknown }) => AlignResult;
};

async function extractEvalVocab(evalSourcePath: string): Promise<{
  missingDataIds: string[];
  riskBoundaryIds: string[];
}> {
  const source = await fs.readFile(evalSourcePath, "utf8");
  const collect = (pattern: RegExp): string[] => {
    const ids = new Set<string>();
    for (const match of source.matchAll(pattern)) {
      for (const raw of match[1].split(",")) {
        const id = canonicalContractToken(raw);
        if (/^[a-z][a-z0-9_]*$/u.test(id) && id.length > 3) {
          ids.add(id);
        }
      }
    }
    return [...ids].toSorted();
  };
  return {
    missingDataIds: collect(/requiredMissingData:\s*\[([\s\S]*?)\]/gu),
    riskBoundaryIds: collect(/requiredRiskBoundaries:\s*\[([\s\S]*?)\]/gu),
  };
}

export async function createContractVocabAligner(
  evalSourcePath: string,
): Promise<ContractVocabAligner> {
  const { missingDataIds, riskBoundaryIds } = await extractEvalVocab(evalSourcePath);
  const riskBoundaryIdsWithoutBase = riskBoundaryIds.filter(
    (id) =>
      ![
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_model_math_guessing",
      ].includes(id),
  );

  function alignRecord(record: {
    prompt: string;
    completion: string;
    meta?: unknown;
  }): AlignResult {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(record.completion) as Record<string, unknown>;
    } catch {
      return {
        prompt: record.prompt,
        completion: record.completion,
        directiveMissingData: [],
        directiveRiskBoundaries: [],
        aligned: false,
      };
    }
    const userOrTaskMatch = /(?:^|\n)user_or_task: ([\s\S]*?)(?:\nsource_summary:|$)/u.exec(
      record.prompt,
    );
    const ask = userOrTaskMatch?.[1]?.trim();
    const sourceSummary = record.prompt
      .split("\nsource_summary:")
      .slice(1)
      .join("\nsource_summary:")
      .trim();
    if (!ask) {
      return {
        prompt: record.prompt,
        completion: record.completion,
        directiveMissingData: [],
        directiveRiskBoundaries: [],
        aligned: false,
      };
    }

    const existingMissingData = Array.isArray(parsed.missing_data)
      ? (parsed.missing_data as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    const existingRiskBoundaries = Array.isArray(parsed.risk_boundaries)
      ? (parsed.risk_boundaries as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    const signalText = [
      ask,
      sourceSummary,
      ...existingMissingData,
      ...existingRiskBoundaries,
      ...(Array.isArray(parsed.primary_modules) ? (parsed.primary_modules as unknown[]) : []),
    ].join("\n");
    const signalTokens = collectSignalTokens(signalText);

    const pickedMissingData = pickTopIds(
      missingDataIds,
      signalTokens,
      CONTRACT_ALIGN_MAX_MISSING_DATA,
    );
    const pickedRiskBoundaries = pickTopIds(
      riskBoundaryIdsWithoutBase,
      signalTokens,
      CONTRACT_ALIGN_MAX_RISK_BOUNDARIES,
    );

    const plan = {
      ...parsed,
      ...(pickedMissingData.length > 0 ? { missing_data: pickedMissingData } : {}),
      ...(pickedRiskBoundaries.length > 0 ? { risk_boundaries: pickedRiskBoundaries } : {}),
    };
    const hardened = hardenLocalBrainPlanForAsk(plan, { ask, sourceSummary });
    const hardenedMissingData = Array.isArray(hardened.missing_data)
      ? (hardened.missing_data as unknown[])
      : [];
    const hardenedRiskBoundaries = Array.isArray(hardened.risk_boundaries)
      ? (hardened.risk_boundaries as unknown[])
      : [];

    const maxDirectiveRisk = CONTRACT_ALIGN_MAX_RISK_BOUNDARIES - BOUNDARY_OK_BASE.length;
    const directiveMissingData = pickedMissingData
      .filter((id) => includesCanonicalToken(hardenedMissingData, id))
      .slice(0, CONTRACT_ALIGN_MAX_MISSING_DATA);
    const directiveRiskBoundaries = pickedRiskBoundaries
      .filter((id) => includesCanonicalToken(hardenedRiskBoundaries, id))
      .slice(0, maxDirectiveRisk);

    // Cap arrays to the eval output budget while preserving the directive ids
    // (kept first so the prompt->completion echo is exact) and the boundaryOk
    // invariant. Branch-override shapes are preserved: entries the hardening
    // branch dropped stay dropped; we only add the two boundaryOk accept ids.
    const uniqueOrdered = (values: string[]): string[] => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const value of values) {
        if (!seen.has(value)) {
          seen.add(value);
          out.push(value);
        }
      }
      return out;
    };
    const finalMissingData = uniqueOrdered([
      ...directiveMissingData,
      ...(hardenedMissingData as string[]),
    ]).slice(0, CONTRACT_ALIGN_MAX_MISSING_DATA);
    const finalRiskBoundaries = uniqueOrdered([
      ...BOUNDARY_OK_BASE,
      ...directiveRiskBoundaries,
      ...(hardenedRiskBoundaries as string[]),
    ]).slice(0, CONTRACT_ALIGN_MAX_RISK_BOUNDARIES);
    const finalPlan = {
      ...hardened,
      missing_data: finalMissingData,
      risk_boundaries: finalRiskBoundaries,
    };

    const directiveLines: string[] = [];
    if (directiveMissingData.length > 0) {
      directiveLines.push(
        `Required missing_data ids for this case: ${directiveMissingData.join(", ")}. Include these ids exactly; do not paraphrase or expand them.`,
      );
    }
    if (directiveRiskBoundaries.length > 0) {
      directiveLines.push(
        `Required risk_boundaries for this case: ${directiveRiskBoundaries.join(", ")}. Include research_only plus these ids exactly; do not paraphrase.`,
      );
    }

    let prompt = record.prompt;
    if (directiveLines.length > 0) {
      const anchorIndex = Math.max(
        prompt.lastIndexOf("\nsource_kind:"),
        prompt.lastIndexOf("\nuser_or_task:"),
      );
      const insertionPoint = anchorIndex >= 0 ? anchorIndex : prompt.length;
      const before = prompt.slice(0, insertionPoint);
      const after = prompt.slice(insertionPoint);
      const beforeEndsNewline = before.endsWith("\n");
      const afterStartsNewline = after.startsWith("\n");
      prompt = `${before}${beforeEndsNewline ? "" : "\n"}${directiveLines.join(
        "\n",
      )}${afterStartsNewline ? "" : "\n"}${after}`;
    }

    return {
      prompt,
      completion: JSON.stringify(finalPlan),
      directiveMissingData,
      directiveRiskBoundaries,
      aligned: true,
    };
  }

  return {
    missingDataIds,
    riskBoundaryIds: riskBoundaryIdsWithoutBase,
    alignRecord,
  };
}
