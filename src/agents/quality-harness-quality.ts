import type { LogicalAgentPlanResult, LogicalAgentTaskResult } from "./logical-agent-pool.js";
import {
  findQualityStageResult,
  isQualityRecord,
  qualityStringArray,
  requiredQualityText,
  type QualityHarnessArtifact,
  type QualityHarnessAttemptReceipt,
  type QualityHarnessEvidence,
  type QualityHarnessGate,
  type QualityHarnessRequest,
  type QualityHarnessStage,
  type QualityHarnessStageOutput,
  type QualityHarnessStageReceipt,
  type QualityHarnessVerification,
  type QualityHarnessVerifier,
} from "./quality-harness-contract.js";
import {
  reconcileQualityFindings,
  type QualityFindingReceipt,
} from "./quality-harness-findings.js";

export type QualityEvaluation = Readonly<{
  passed: boolean;
  artifact?: QualityHarnessArtifact;
  gates: readonly QualityHarnessGate[];
  feedback: readonly string[];
  findings: readonly QualityFindingReceipt[];
}>;

function normalizeFeedback(feedback: readonly string[]): string[] {
  return feedback
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim().slice(0, 1_000))
    .slice(0, 12);
}

function validateGrounding(
  artifact: QualityHarnessArtifact | undefined,
  evidence: readonly QualityHarnessEvidence[],
): string[] {
  if (!artifact) {
    return ["final artifact is missing"];
  }
  const evidenceIds = new Set(evidence.map((entry) => entry.id));
  const problems: string[] = [];
  for (const claim of artifact.claims) {
    const unknown = claim.evidenceIds.filter((id) => !evidenceIds.has(id));
    if (unknown.length > 0) {
      problems.push(`claim ${claim.id} cites unknown evidence: ${unknown.join(", ")}`);
    }
    if (claim.status === "supported" && claim.evidenceIds.length === 0) {
      problems.push(`claim ${claim.id} has no evidence`);
    }
    if (claim.status === "uncertain" && !claim.uncertainty) {
      problems.push(`claim ${claim.id} hides its uncertainty reason`);
    }
  }
  return problems;
}

/**
 * Whether the request is a finance request at all.
 *
 * When this misses, `validateFinanceAnswerSafety` returns no problems at all -- so a miss here is
 * worse than a miss in any single check below: the answer is certified clean without anything having
 * been looked at.
 *
 * Measured twice. First the list covered 股票/股价/投资/金融/市场/组合/持仓/ETF/基金/期权/收益/估值/财报/半导体,
 * so "美元走强对台积电 ADR 有什么影响？", "黄金现在能买吗？", "人民币汇率破 7.3 会怎样？",
 * "美债利率上升对 A 股有什么影响？" and "原油大跌对航运股意味着什么？" were treated as non-finance.
 * Then the same shape again one level out: index / fund / crypto / convertible-bond wording was
 * still outside, so "沪深300 现在能买吗？", "创业板指数怎么看？", "日经225 会怎么走？",
 * "比特币现在能买吗？", "以太坊怎么看？", "REITs 值得配吗？" and "可转债怎么选？" were all treated as
 * ordinary asks and "买入 TSM。" passed with no check at all.
 *
 * Deliberately NOT added: bare `rate` (matches "rate limit"), bare `index` (matches "index.js"),
 * bare `科创` (matches 科技创新), and any English term whose substring form is ordinary in
 * non-finance text. New English terms are word-bounded, with `s?`/`(?:y|ies)` where the plural is the
 * normal form; the pre-existing English group is left unbounded so that adding these does not
 * tighten it.
 */
const FINANCE_REQUEST_PATTERN =
  /股票|股价|投资|金融|市场|组合|持仓|ETF|基金|期权|收益|估值|财报|半导体|汇率|外汇|美元|人民币|日元|欧元|英镑|黄金|白银|原油|大宗商品|债券|国债|利率|期货|股指|标普|纳指|恒生|港股|美股|A股|降息|加息|通胀|指数|沪指|深指|上证|深证|创业板|科创板|北证|沪深|中证|国企指数|日经|富时|道琼斯|纳斯达克|转债|可转债|债基|货基|货币基金|QDII|LOF|FOF|比特币|以太坊|加密货币|数字资产|虚拟货币|贵金属|铜价|伦铜|沪铜|认沽|认购|行权|虚值|实值|看涨|看跌|(?:stock|equity|portfolio|finance|market|invest|etf|fund|option|yield|valuation|earnings)|\b(?:bonds?|treasur(?:y|ies)|forex|currenc(?:y|ies)|commodit(?:y|ies)|futures|nasdaq|inflation|oil|gold|indices|index\s+funds?|mutual\s+funds?|convertible\s+bonds?|reits?|bitcoin|ethereum|crypto(?:currency)?|call\s+options?|put\s+options?|strike\s+price|derivatives?|precious\s+metals?|silver)\b/iu;
/**
 * One of the two triggers for the numeric-grounding check below.
 *
 * Word lists are how this gate has always decided *whether to look*, and that is the gate's weakest
 * joint: a miss here is silent -- the answer is certified clean with nothing having been examined.
 * Measured: `NVDA 报 480 美元。` carries a price, enters the finance branch (美元 is in
 * `FINANCE_REQUEST_PATTERN`) and then skips grounding entirely, because no word in this list appears
 * in it. `NVDA 当前报 480 美元。` and `NVDA 报 480 美元，价格偏高。` are both caught -- one word apart.
 *
 * So money is a trigger of its own, derived from the unit the number already carries (see
 * `isMonetaryAmount`) rather than from any word here. This list is left as it is: widening it moves
 * the hole one word along without closing it.
 */
const CURRENT_DATA_PATTERN =
  /当前|最新|今天|今日|现在|截至|实时|股价|价格|市值|收益率|行情|current|latest|today|now|as of|price|market cap|yield/iu;
/**
 * Measured here: "建议建仓 NVDA。" / "建议加码 NVDA。" / "I recommend you accumulate NVDA." were all
 * graded clean, while the synonymous "建议买入 NVDA。" was caught -- 建仓 / 加码 / accumulate were
 * simply not in the verb lists, and this gate is the last thing that grades a finance answer.
 *
 * `build` is bound to "a position in" so that "build the allocation" (what an allocation answer is
 * for) is not read as an instruction.
 */
const DIRECT_TRADE_ACTION_PATTERN =
  /(?:^|[.!?\n:]\s*)(?:buy|sell|add|reduce|accumulate|go long|go short|build a position in)\b[^.!?\n]{0,120}(?:[.!?\n]|$)|\b(?:you\s+should|i\s+(?:recommend|would)|recommend(?:ed)?|consider|please)\b[^.!?\n]{0,60}\b(?:buy|sell|add|reduce|accumulate|go long|go short|build a position in)\b|(?:建议|应该|推荐|考虑|立即|现在)[^\n。！？]{0,30}(?:买入|卖出|加仓|减仓|建仓|加码|减码|平仓|清仓|做多|做空|增持|减持)|(?:买入|卖出|加仓|减仓|建仓|加码|减码|平仓|清仓|做多|做空|增持|减持)[^\n。！？]{0,12}(?:股票|仓位|标的|[A-Z]{1,6}\b)/imu;
/**
 * Whether the answer assigns a portfolio weight.
 *
 * Measured false positive: the loose form -- any percentage within 80 characters of
 * 配置/仓位/投入/分配, or 100 characters of `allocation` -- flagged *risk-rule* and *statistic*
 * sentences as "a direct trade action or recommendation":
 *
 *   "风险提示：单票仓位超过账户 20% 就属于过度集中，需要先降风险预算。"
 *   "仓位上限 10% 是硬约束，超过就不再讨论新增风险。"
 *   "配置比例的历史均值是 60%，但这是统计描述不是建议。"
 *   "Allocation has historically averaged 60% for balanced books."
 *
 * Naming a position cap, or reporting a historical average, is not assigning a weight -- and the
 * risk-triage answer this project asks for is built out of exactly those sentences.
 *
 * So the percentage must sit on the allocation word itself (within 4 characters in Chinese, 10 in
 * English), and a following cap/statistic noun disqualifies it. The noun list is a deliberate
 * blocklist; the alternative -- refusing every answer that mentions a position percentage -- is what
 * was measured.
 */
const POSITION_SIZING_PATTERN =
  /(?:\b(?:allocate|allocation|position\s*(?:size|sizing)|portfolio\s*(?:weight|allocation)|invest)\b[^.!?\n]{0,10}\b\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\s*%[^.!?\n]{0,40}\b(?:portfolio|position|allocate|allocation)\b|(?:配置|仓位|投入|分配)(?!上限|下限|占比|比例|均值|预算|红线|约束|门槛|区间|范围)[^。！？\n]{0,4}\d+(?:\.\d+)?\s*%)/imu;
/**
 * Sibling copy of `EXECUTION_CLAIM_PATTERN` in `finance-decision-policy.ts`.
 *
 * Measured here: an answer saying "已成交 NVDA。" / "NVDA 已建仓。" / "该笔交易已执行" /
 * "Filled NVDA at the open." was graded clean -- the gate reported "contains no direct trade
 * instruction or ungrounded current-data number" for an answer that claimed a fill. Only 已下单 and
 * friends were caught, because they were the words that happened to be listed.
 *
 * The two copies must be kept in step; if this list ever drifts from the policy module's, an answer
 * can be refused by one and certified by the other. 成交 is not matched bare: 成交额 / 成交量 are
 * market commentary, not claims about a fill.
 */
const EXECUTION_CLAIM_PATTERN =
  /已下单|下单成功|已经买入|已经卖出|已开仓|已平仓|交易已完成|转账成功|已(?:成交|建仓|加仓|减仓|清仓|交割|报单)|已委托[^。！？?\n]{0,6}(?:买入|卖出|下单|成交|交易)|(?:已|已经)[^。！？?\n]{0,8}成交(?!额|量)|已执行(?:买入|卖出|下单|交易|委托)|(?:交易|委托|订单|指令)已执行|(?:委托|订单|报单)已成交|成交完成|order filled|order placed|position opened|position closed|funds transferred|(?:\b(?:your|the|an?)\s+)?[A-Z][A-Z0-9.-]{1,9}\s+order\b.{0,24}\b(?:executed|filled|placed|completed)\b|\b(?:filled|executed)\b\s+(?:\d+|[A-Z][A-Z0-9.-]{1,9}\b)|\b(?:i|we)\s+(?:bought|sold|purchased|opened|closed|exited)\b/iu;

/**
 * The numbers in an answer that are *values*, as opposed to parts of a name or a label.
 *
 * Measured: the extractor took every digit run, so an index name or a tenor label contributed a
 * number that then had to be cited. With the correctly grounded answer
 * "NVDA 当前价格是 480 美元。", each of the following additions was reported as
 * "current-data numbers without matching cited evidence": 标普500, 沪深300, 创业板50, 中证500,
 * S&P 500, 10Y 美债, Q3 财报.
 *
 * Stripped before extraction, and only in the shapes that *name* something rather than measure it:
 *   - an index qualifier glued to its number (沪深300 / 标普500 / 日经225 / S&P 500). The Chinese
 *     qualifiers allow no space, so a *level* ("标普 5000 点") is still checked.
 *   - a tenor label of at most two digits (10Y / 3M / 10年期), so a value like "480M" is not stripped.
 *   - a period label (Q3 / H1 / FY24).
 *
 * The unit group is mirrored by `normalizedNumber`: a currency written as a word (480 dollars) is
 * money only if *both* recognise it. So adding a currency means adding it in the two places --
 * adding it in one is exactly how the Chinese and English sides of this gate drift apart.
 */
function extractDataNumbers(text: string): string[] {
  const withoutDateLiterals = text
    .replace(
      /\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}(?:[T ][0-9]{1,2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/giu,
      " ",
    )
    .replace(/\b20\d{2}年\d{1,2}月\d{1,2}日?/gu, " ");
  const withoutNameNumbers = withoutDateLiterals
    .replace(
      /(?:沪深|中证|上证|深证|创业板|科创|北证|恒生|日经|富时|标普|纳斯达克|道琼斯|国企|罗素)\d{1,4}(?!\d)/gu,
      " ",
    )
    .replace(/\b(?:S&P|SP|NASDAQ|RUSSELL|MSCI)[\s-]*\d{1,4}(?!\d)/giu, " ")
    .replace(/\b\d{1,2}(?:[YMWD]|年期?)(?!\d)/gu, " ")
    .replace(/\b(?:Q[1-4]|H[12]|FY\s?\d{2,4})\b/giu, " ");
  return (
    withoutNameNumbers.match(
      /(?<!\d)[+-]?\s*(?:[$€£¥]\s*)?\d[\d,]*(?:\.\d+)?(?:\s*%|\s*(?:USD|EUR|GBP|CNY|JPY|HKD|dollars?|euros?|pounds?|yen|yuan|美元|欧元|英镑|人民币|日元|港元|港币|元))?/giu,
    ) ?? []
  ).map((value) => value.replace(/\s+/g, ""));
}

/**
 * The digits of a number in one notation, so that two writings of the same quantity compare equal.
 *
 * They did not: `normalizedNumber` compared the digits as a string, so a formatting difference was
 * reported as the answer having invented a number. Measured, evidence on the left:
 *
 *   480.00 美元 vs 480 美元, 480 美元 vs 480.00 美元, $1,200.00 vs 1,200 美元, +3% vs 3%
 *
 * -- all four reported "current-data numbers without matching cited evidence" for a number the
 * evidence does carry.
 *
 * **Notation only**, and the boundary is the point: this is deliberately NOT any of
 *
 *   - a tolerance or rounding -- 480.12 is neither 480.13 nor 480;
 *   - a unit conversion -- 480 美元 is not 480 元, and 480 港元 is not 480 元;
 *   - dropping a `-` sign -- `+3%` is `3%`, but `-3%` is the opposite direction.
 *
 * So: strip a leading `+` and trailing zeros after the point, and nothing else. Anything beyond
 * this is a claim about the quantity, not about how it was written, and belongs to whoever decides
 * what counts as the same number -- not to a formatter.
 */
function canonicalNumber(raw: string): string {
  const unsigned = raw.startsWith("+") ? raw.slice(1) : raw;
  const point = unsigned.indexOf(".");
  if (point < 0) {
    return unsigned;
  }
  const fraction = unsigned.slice(point + 1).replace(/0+$/u, "");
  return fraction === "" ? unsigned.slice(0, point) : `${unsigned.slice(0, point)}.${fraction}`;
}

function normalizedNumber(value: string): string {
  const compact = value.replace(/\s+/g, "").replace(/,/g, "").toLowerCase();
  const number = canonicalNumber(compact.match(/[+-]?\d+(?:\.\d+)?/)?.[0] ?? compact);
  const unit = compact.includes("%")
    ? "percent"
    : /(?:\$|usd|dollars?|美元)/u.test(compact)
      ? "usd"
      : /(?:€|eur|euros?|欧元)/u.test(compact)
        ? "eur"
        : /(?:£|gbp|pounds?|英镑)/u.test(compact)
          ? "gbp"
          : /(?:jpy|yen|日元)/u.test(compact)
            ? "jpy"
            : /(?:hkd|港元|港币)/u.test(compact)
              ? "hkd"
              : /(?:¥|cny|yuan|人民币|元)/u.test(compact)
                ? "cny"
                : "unitless";
  return `${number}|${unit}`;
}

/**
 * Whether a value in an answer is money, as opposed to a bare count or a percentage.
 *
 * The unit comes from `normalizedNumber`, which is already the single place that decides what unit a
 * value carries -- so there is no second currency list here to drift out of step with it.
 *
 * Percentages are deliberately not money for this purpose. A percentage in a finance answer is as
 * often a rule or a historical statistic as a quote, and demanding a citation for it was measured:
 * "风险提示：单票仓位超过账户 20% 就属于过度集中", "配置比例的历史均值是 60%" are the sentences the
 * risk-triage answer this project asks for is built out of. Money has no such ordinary non-quote
 * use -- nothing states an amount in 美元 that is not a claim about a price.
 *
 * Known residual holes, recorded rather than papered over: a bare number with no unit at all
 * ("NVDA 收在 480。"), and a currency word the extractor does not carry as a unit (480 港元,
 * 480 dollars) -- both still need one of the words in `CURRENT_DATA_PATTERN` to be caught.
 */
function isMonetaryAmount(value: string): boolean {
  const unit = normalizedNumber(value).split("|")[1];
  return unit !== undefined && unit !== "unitless" && unit !== "percent";
}

/**
 * Chinese name -> the token the evidence is likely to use.
 *
 * The table held nine names, so a claim written in Chinese about anything else could not be matched
 * to its evidence at all: "台积电当前价格是 480 美元。" against evidence naming TSM was reported as
 * ungrounded. Only pairs whose canonical form is a Latin ticker are listed -- an A-share code is
 * all digits, and `financeEntities` does not extract those, so mapping 茅台 to 600519 would not help
 * and is deliberately omitted. A name that is not listed is not wrong, it just falls back to the
 * "no entity in the claim" path above.
 */
const FINANCE_ENTITY_ALIASES: readonly Readonly<{ alias: RegExp; canonical: string }>[] = [
  { alias: /AAPL|Apple|苹果(?:公司)?/giu, canonical: "AAPL" },
  { alias: /MSFT|Microsoft|微软(?:公司)?/giu, canonical: "MSFT" },
  { alias: /NVDA|NVIDIA|英伟达(?:公司)?/giu, canonical: "NVDA" },
  { alias: /TSLA|Tesla|特斯拉(?:公司)?/giu, canonical: "TSLA" },
  { alias: /AMZN|Amazon|亚马逊(?:公司)?/giu, canonical: "AMZN" },
  { alias: /GOOGL|Google|Alphabet|谷歌(?:公司)?/giu, canonical: "GOOGL" },
  { alias: /META|Meta|Facebook|脸书(?:公司)?/giu, canonical: "META" },
  { alias: /QQQ|Invesco\s+QQQ/giu, canonical: "QQQ" },
  { alias: /SPY|SPDR\s+S&P\s+500/giu, canonical: "SPY" },
  { alias: /\bTSM\b|台积电|台積電/giu, canonical: "TSM" },
  { alias: /\bUMC\b|联电|聯電/giu, canonical: "UMC" },
  { alias: /\bBABA\b|阿里巴巴|阿里/giu, canonical: "BABA" },
  { alias: /\bJD\b|京东|京東/giu, canonical: "JD" },
  { alias: /\bPDD\b|拼多多/giu, canonical: "PDD" },
  { alias: /\bBIDU\b|百度/giu, canonical: "BIDU" },
  { alias: /\bNTES\b|网易|網易/giu, canonical: "NTES" },
  { alias: /\bBILI\b|哔哩哔哩|嗶哩嗶哩/giu, canonical: "BILI" },
  { alias: /\bNIO\b|蔚来|蔚來/giu, canonical: "NIO" },
  { alias: /\bXPEV\b|小鹏|小鵬/giu, canonical: "XPEV" },
  { alias: /\bLI\b|理想汽车|理想汽車/giu, canonical: "LI" },
  { alias: /\bTCOM\b|携程|攜程/giu, canonical: "TCOM" },
  { alias: /\bTAL\b|好未来|好未來/giu, canonical: "TAL" },
  { alias: /\bEDU\b|新东方|新東方/giu, canonical: "EDU" },
  { alias: /\bFUTU\b|富途/giu, canonical: "FUTU" },
  { alias: /\bIQ\b|爱奇艺|愛奇藝/giu, canonical: "IQ" },
  { alias: /\bBEKE\b|贝壳|貝殼/giu, canonical: "BEKE" },
  { alias: /\bYMM\b|满帮|滿幫/giu, canonical: "YMM" },
  { alias: /\bTIGR\b|老虎证券|老虎證券/giu, canonical: "TIGR" },
  { alias: /\bMNSO\b|名创优品|名創優品/giu, canonical: "MNSO" },
];

const NON_ENTITY_TOKENS = new Set([
  // Currencies and units first: they appear in almost every finance sentence and would otherwise
  // read as the subject of the claim.
  "CNY",
  "EUR",
  "GBP",
  "HKD",
  "JPY",
  "USD",
  // Same blocklist shape as `NON_EQUITY_SYMBOL_TOKENS` in finance-research-runner: the extractor
  // reads any upper-case token as an entity, so an unlisted abbreviation becomes a "thing the claim
  // and the evidence are both about" — which is exactly what the entity comparison is meant to
  // catch. A term appearing in both therefore *masks* a genuine entity mismatch.
  // Not exhaustive by construction; when adding, remember several abbreviations are real tickers
  // (PEG, ATR) and must not be blocked.
  "API",
  "AUM",
  "CEO",
  "CFO",
  "CPI",
  "DCF",
  "EPS",
  "ESG",
  "ETF",
  "FED",
  "FOMC",
  "GAAP",
  "GDP",
  "HTTP",
  "HTTPS",
  "IFRS",
  "IPO",
  "JSON",
  "MACD",
  "NASDAQ",
  "NAV",
  "NYSE",
  "PPI",
  "PMI",
  "ROI",
  "ROE",
  "ROA",
  "RSI",
  "SEC",
  "TTM",
  "URL",
  "WACC",
  "YOY",
  "YTD",
]);

function financeEntities(text: string): Set<string> {
  let normalized = text;
  for (const { alias, canonical } of FINANCE_ENTITY_ALIASES) {
    normalized = normalized.replace(alias, ` ${canonical} `);
  }
  return new Set(
    (normalized.match(/\b[A-Z][A-Z0-9.-]{1,9}\b/gu) ?? []).filter(
      (entity) => !NON_ENTITY_TOKENS.has(entity),
    ),
  );
}

/**
 * Whether the claim and the evidence are about the same entity.
 *
 * The `claimEntities.size > 0` guard made an all-Chinese claim unprovable: `financeEntities` only
 * extracts uppercase Latin tokens (plus the alias table), so "台积电当前价格是 480 美元。" produced an
 * empty set and the answer was reported as "current-data numbers without matching cited evidence" --
 * measured for 台积电/台积电, 台积电/TSM and 腾讯/腾讯, while the Latin control and the aliased 苹果
 * passed. A claim that names no entity has no attribution to get wrong, so the check falls back to
 * requiring that the evidence not name a different entity either.
 */
function claimMatchesEvidenceEntity(claimText: string, evidenceText: string): boolean {
  const claimEntities = financeEntities(claimText);
  const evidenceEntities = financeEntities(evidenceText);
  if (claimEntities.size === 0) {
    return evidenceEntities.size === 0;
  }
  return [...claimEntities].some((entity) => evidenceEntities.has(entity));
}

function hasEvidenceSourceAndTimestamp(evidence: QualityHarnessEvidence): boolean {
  return Boolean(
    evidence.source?.trim() &&
    /\b20\d{2}[-/]\d{1,2}(?:[-/]\d{1,2})?(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?\b/iu.test(
      evidence.text,
    ),
  );
}

function validateFinanceAnswerSafety(
  artifact: QualityHarnessArtifact | undefined,
  request: QualityHarnessRequest,
): string[] {
  if (!artifact || !FINANCE_REQUEST_PATTERN.test(request.task)) {
    return [];
  }
  const problems: string[] = [];
  const allowsConditionalCandidate =
    request.sharedContext?.decisionMode === "conditional_trade_candidate";
  if (
    !allowsConditionalCandidate &&
    (DIRECT_TRADE_ACTION_PATTERN.test(artifact.answer) ||
      POSITION_SIZING_PATTERN.test(artifact.answer))
  ) {
    problems.push("final finance answer contains a direct trade action or recommendation");
  }
  if (EXECUTION_CLAIM_PATTERN.test(artifact.answer)) {
    problems.push("final finance answer contains an execution claim");
  }

  const answerStatesMoney = extractDataNumbers(artifact.answer).some(isMonetaryAmount);
  if (
    CURRENT_DATA_PATTERN.test(request.task) ||
    CURRENT_DATA_PATTERN.test(artifact.answer) ||
    answerStatesMoney
  ) {
    // A number the user supplied is not a claim about current data, so it needs no citation.
    // Measured: with the task "我自己亏了 20%，请根据最新证据判断 NVDA 当前股价和投资风险。", the
    // harness demanded evidence for the answer's "20%" -- the user's own loss -- and reported
    // "current-data numbers without matching cited evidence: 20%", while the answer's cited
    // "480 美元" passed. The adoption gate already treats user-supplied numbers this way; a number
    // the reader supplied is not the answer inventing market data.
    const userSuppliedNumbers = new Set(extractDataNumbers(request.task).map(normalizedNumber));
    const answerNumbers = extractDataNumbers(artifact.answer).filter(
      (number) => !userSuppliedNumbers.has(normalizedNumber(number)),
    );
    if (answerNumbers.length > 0) {
      const evidenceById = new Map(request.evidence.map((entry) => [entry.id, entry]));
      const supportedClaims = artifact.claims.filter((claim) => claim.status === "supported");
      const unsupportedNumbers = answerNumbers.filter((number) => {
        const normalized = normalizedNumber(number);
        return !supportedClaims.some((claim) => {
          const claimCarriesNumber = extractDataNumbers(claim.text).some(
            (value) => normalizedNumber(value) === normalized,
          );
          if (!claimCarriesNumber) {
            return false;
          }
          return claim.evidenceIds
            .map((id) => evidenceById.get(id))
            .filter((entry): entry is QualityHarnessEvidence => entry !== undefined)
            .some(
              (entry) =>
                extractDataNumbers(entry.text).some(
                  (value) => normalizedNumber(value) === normalized,
                ) &&
                hasEvidenceSourceAndTimestamp(entry) &&
                claimMatchesEvidenceEntity(claim.text, entry.text),
            );
        });
      });
      if (unsupportedNumbers.length > 0) {
        problems.push(
          `final finance answer contains current-data numbers without matching cited evidence with the same unit and timestamp: ${unsupportedNumbers.join(", ")}`,
        );
      }
    }
  }
  return problems;
}

function reviewPassed(
  result: LogicalAgentTaskResult<QualityHarnessStageOutput> | undefined,
  stage: QualityHarnessStage,
): { passed: boolean; reason: string; feedback: string[] } {
  const review =
    result?.status === "completed" && result.output?.kind === "review"
      ? result.output.review
      : undefined;
  if (!review) {
    return {
      passed: false,
      reason: `${stage} review is missing`,
      feedback: [`${stage} review did not complete`],
    };
  }
  const feedback = [...review.criticalFindings, ...review.evidenceGaps].slice(0, 12);
  const passed = review.verdict === "pass" && feedback.length === 0;
  return {
    passed,
    reason: passed ? `${stage} review passed` : `${stage} review requires revision`,
    feedback: feedback.length > 0 ? feedback : [`${stage} verdict=${review.verdict}`],
  };
}

export function evaluateQuality(
  result: LogicalAgentPlanResult<QualityHarnessStageOutput>,
  request: QualityHarnessRequest,
): QualityEvaluation {
  const format = findQualityStageResult(result, "formatting");
  const artifact =
    format?.status === "completed" && format.output?.kind === "artifact"
      ? format.output.artifact
      : undefined;
  const groundingProblems = validateGrounding(artifact, request.evidence);
  const financeSafetyProblems = validateFinanceAnswerSafety(artifact, request);
  const evidenceReview = reviewPassed(
    findQualityStageResult(result, "evidence_integrity"),
    "evidence",
  );
  const findings = reconcileQualityFindings(result.tasks, artifact, request.evidence);
  const reconciledReview = (role: string, stage: QualityHarnessStage) => {
    const original = reviewPassed(findQualityStageResult(result, role), stage);
    const roleFindings = findings.filter((finding) => finding.role === role);
    return !original.passed &&
      roleFindings.length > 0 &&
      roleFindings.every((finding) => finding.status === "resolved")
      ? {
          passed: true,
          reason: `${stage} findings independently resolved against final artifact`,
          feedback: [],
        }
      : original;
  };
  const supportingReviews = [
    reconciledReview("financial_extraction", "extraction"),
    reconciledReview("news_classification", "classification"),
    reconciledReview("risk_check", "risk"),
    reconciledReview("portfolio_exposure", "exposure"),
  ];
  const adversarialReview = reconciledReview("adversarial_challenge", "adversarial");
  const precheck = reviewPassed(findQualityStageResult(result, "final_precheck"), "precheck");
  const allStagesCompleted = result.status === "completed" && result.tasks.length === 10;
  const sideEffects = result.tasks.flatMap((entry) => entry.sideEffects);
  const gates: QualityHarnessGate[] = [
    {
      id: "all_stages_completed",
      passed: allStagesCompleted,
      reason: allStagesCompleted
        ? "all ten existing role stages completed"
        : "one or more role stages failed or were blocked",
    },
    {
      id: "artifact_contract",
      passed: artifact !== undefined,
      reason: artifact
        ? "format stage returned a structured artifact"
        : "format stage did not return an artifact",
    },
    {
      id: "claims_grounded",
      passed: groundingProblems.length === 0,
      reason:
        groundingProblems.length === 0
          ? "claims cite known evidence or explicit uncertainty"
          : groundingProblems.join("; "),
    },
    {
      id: "supporting_role_reviews",
      passed: supportingReviews.every((review) => review.passed),
      reason: supportingReviews.every((review) => review.passed)
        ? "supporting reviews passed or their findings were independently closed against the final artifact"
        : supportingReviews
            .filter((review) => !review.passed)
            .map((review) => review.reason)
            .join("; "),
    },
    {
      id: "evidence_integrity_review",
      passed: evidenceReview.passed,
      reason: evidenceReview.reason,
    },
    {
      id: "adversarial_review",
      passed: adversarialReview.passed,
      reason: adversarialReview.reason,
    },
    { id: "final_precheck", passed: precheck.passed, reason: precheck.reason },
    {
      id: "finance_answer_safety",
      passed: financeSafetyProblems.length === 0,
      reason:
        financeSafetyProblems.length === 0
          ? "final finance answer contains no direct trade instruction or ungrounded current-data number"
          : financeSafetyProblems.join("; "),
    },
    {
      id: "no_forbidden_side_effects",
      passed: sideEffects.length === 0,
      reason:
        sideEffects.length === 0
          ? "all local role stages declared no side effects"
          : `unexpected side effects: ${sideEffects.join(", ")}`,
    },
  ];
  const feedback = normalizeFeedback([
    ...groundingProblems,
    ...financeSafetyProblems,
    ...findings
      .filter((finding) => finding.status === "unresolved")
      .map(
        (finding) =>
          `${finding.role} finding ${finding.id}: ${finding.closureFailure ?? "final artifact missing"}`,
      ),
    ...supportingReviews.flatMap((review) => review.feedback),
    ...evidenceReview.feedback,
    ...adversarialReview.feedback,
    ...precheck.feedback,
    ...gates.filter((gate) => !gate.passed).map((gate) => gate.reason),
  ]);
  return Object.freeze({
    passed: gates.every((gate) => gate.passed),
    ...(artifact ? { artifact } : {}),
    gates: Object.freeze(gates),
    feedback: Object.freeze(feedback),
    findings: Object.freeze(findings),
  });
}

export function summarizeQualityStageResult(
  result: LogicalAgentTaskResult<QualityHarnessStageOutput>,
): QualityHarnessStageReceipt {
  const output = result.output;
  const review = output?.kind === "review" ? output.review : undefined;
  return Object.freeze({
    taskId: result.taskId,
    agentId: result.agentId,
    status: result.status,
    modelId: result.modelId,
    ...(output ? { outputKind: output.kind } : {}),
    ...(review
      ? {
          reviewVerdict: review.verdict,
          findingCount: review.criticalFindings.length + review.evidenceGaps.length,
        }
      : {}),
    sideEffects: Object.freeze([...result.sideEffects]),
    modelCalls: result.modelCalls ?? [],
    ...(result.error ? { error: result.error.slice(0, 1_000) } : {}),
  });
}

export function normalizeQualityVerification(
  value: QualityHarnessVerification,
): QualityHarnessVerification {
  if (
    !isQualityRecord(value) ||
    !["not-requested", "passed", "failed", "blocked"].includes(value.status as string)
  ) {
    throw new Error("quality verifier returned an invalid status");
  }
  return Object.freeze({
    status: value.status,
    summary: requiredQualityText(value.summary, "verification.summary", 2_000),
    details: Object.freeze(qualityStringArray(value.details, "verification.details", false)),
  });
}

export async function runQualityVerifier(
  verifier: QualityHarnessVerifier,
  request: QualityHarnessRequest,
  artifact: QualityHarnessArtifact,
  attempt: number,
  timeoutMs = 30_000,
  parentSignal?: AbortSignal,
): Promise<QualityHarnessVerification> {
  const boundedTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 2_147_483_647) : 30_000;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const cancellation = new Promise<{ kind: "cancelled" }>((resolve) => {
    cancel = () => {
      controller.abort();
      resolve({ kind: "cancelled" });
    };
    if (parentSignal?.aborted) {
      cancel();
    } else {
      parentSignal?.addEventListener("abort", cancel, { once: true });
    }
  });
  try {
    const result = await Promise.race([
      cancellation,
      Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) {
            throw new Error("quality verifier cancelled before start");
          }
          return verifier({ request, artifact, attempt, signal: controller.signal });
        })
        .then((value) => ({ kind: "result" as const, value })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ kind: "timeout" });
        }, boundedTimeoutMs);
      }),
    ]);
    if (result.kind === "cancelled") {
      return Object.freeze({
        status: "blocked",
        summary: "quality verifier cancelled",
        details: [],
      });
    }
    if (result.kind === "timeout") {
      return Object.freeze({
        status: "blocked",
        summary: `quality verifier timed out after ${boundedTimeoutMs}ms`,
        details: ["verifier was aborted after exceeding its bounded timeout"],
      });
    }
    return normalizeQualityVerification(result.value);
  } catch (error: unknown) {
    return Object.freeze({
      status: "failed",
      summary: error instanceof Error ? error.message : String(error),
      details: [],
    });
  } finally {
    if (cancel) {
      parentSignal?.removeEventListener("abort", cancel);
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function qualityAttemptStatus(params: {
  planStatus: LogicalAgentPlanResult<QualityHarnessStageOutput>["status"];
  qualityPassed: boolean;
  verification: QualityHarnessVerification;
}): QualityHarnessAttemptReceipt["status"] {
  if (params.planStatus !== "completed") {
    return "execution-failed";
  }
  if (!params.qualityPassed) {
    return "quality-failed";
  }
  if (params.verification.status === "failed") {
    return "verification-failed";
  }
  if (params.verification.status === "blocked") {
    return "verification-blocked";
  }
  return params.verification.status === "not-requested" ? "verification-blocked" : "quality-passed";
}

export function qualityFeedback(params: {
  quality: QualityEvaluation;
  verification: QualityHarnessVerification;
}): string[] {
  return normalizeFeedback([
    ...params.quality.feedback,
    ...(params.verification.status === "failed" || params.verification.status === "blocked"
      ? [params.verification.summary, ...params.verification.details]
      : []),
  ]);
}
