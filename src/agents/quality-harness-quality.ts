import { hasFinanceExecutionClaim } from "./finance-decision-policy.js";
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

// Relation labels can restrict support; a contrary/context citation must never certify a claim.
// Older artifacts without relation annotations retain their existing citation contract.
export function supportingEvidenceIds(
  claim: QualityHarnessArtifact["claims"][number],
): readonly string[] {
  return claim.evidenceRelations === undefined
    ? claim.evidenceIds
    : claim.evidenceIds.filter((id) =>
        claim.evidenceRelations?.some(
          (entry) => entry.evidenceId === id && entry.relation === "supports",
        ),
      );
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
    if (claim.status === "supported" && supportingEvidenceIds(claim).length === 0) {
      problems.push(`claim ${claim.id} has no supporting evidence`);
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
 * Keep sizing language blocked by default; a sentence prefix cannot establish its authority.
 * Only a reporting predicate connected to that specific sizing match distinguishes a third
 * party's own capital plan or past holding from instructions about the reader's portfolio.
 */
const POSITION_SIZING_PATTERN =
  /\b(?:allocate|allocation|position\s*(?:size|sizing)|portfolio\s*(?:weight|allocation)|invest)\b(?:\s+(?:should|must)\s+be)?[^.!?\n]{0,10}\b\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\s*%[^.!?\n]{0,40}\b(?:portfolio|position|allocate|allocation)\b|\b(?:cap|limit)\s+(?:[A-Z][A-Z0-9.-]{1,9}|(?:(?:your|the)\s+)?(?:position|portfolio|exposure))\s+(?:at|to)\s+\d+(?:\.\d+)?\s*%/giu;
const REPORTED_SIZING_PREFIX_PATTERN =
  /^\s*(?:[a-z][a-z0-9.&'-]*\s+){1,8}(?:(?:plans?|intends?)\s+to|held|allocated|invested|kept)\s*$/iu;
const REPORTED_SIZING_VALUE_PATTERN =
  /^(?:allocation|position\s*(?:size|sizing)|portfolio\s*(?:weight|allocation))\s+(?:was|were|has\s+(?:historically\s+)?averaged|had\s+averaged)\b/iu;
const CHINESE_POSITION_SIZING_PATTERN =
  /(?:配置|仓位|投入|分配)(?!上限|下限|占比|比例|均值|预算|红线|约束|门槛|区间|范围)[^。！？\n]{0,4}\d+(?:\.\d+)?\s*%/u;

function hasPositionSizing(answer: string): boolean {
  return (
    CHINESE_POSITION_SIZING_PATTERN.test(answer) ||
    answer.split(/(?<=[.!?;])\s+|(?<=:)\s+(?=[A-Za-z])|\n/u).some((statement) =>
      [...statement.matchAll(POSITION_SIZING_PATTERN)].some((match) => {
        if (/\b(?:you|your|should|must|recommend(?:ed)?|suggest(?:ed)?)\b/iu.test(statement)) {
          return true;
        }
        const prefix = statement.slice(0, match.index);
        const suffix = statement.slice(match.index + match[0].length);
        const ownedCapital =
          /\b(?:its|their)\s+(?:capital|budget|portfolio|position)\b/iu.test(match[0]) ||
          /^\s+(?:of\s+)?(?:its|their)\s+(?:capital|budget|portfolio|position)\b/iu.test(suffix);
        return (
          !REPORTED_SIZING_VALUE_PATTERN.test(match[0]) &&
          !(REPORTED_SIZING_PREFIX_PATTERN.test(prefix) && ownedCapital)
        );
      }),
    )
  );
}
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
/**
 * What a date looks like -- in one place, because two places used to disagree.
 *
 * `extractDataNumbers` stripped `2026年9月6日` before looking for values, while
 * `hasEvidenceSourceAndTimestamp` only accepted `2026-09-06`. So an evidence dated in a notation
 * this file already understood elsewhere was treated as *undated*, and every number it carried came
 * back as "current-data numbers without matching cited evidence" -- the answer was blamed for a
 * timestamp the evidence did have. The reverse gap existed too: `2026-09` counted as a timestamp but
 * was not stripped, so its digits were then demanded as values.
 *
 * Both now read these two patterns. They are deliberately **not** global: a `/g` regex carries
 * `lastIndex` between `.test` calls and would make the timestamp check start mid-string. The
 * extractor makes its own global copy for `.replace`.
 */
const ISO_DATE_PATTERN =
  /\b20\d{2}[-/]\d{1,2}(?:[-/]\d{1,2})?(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?\b/iu;
const CHINESE_DATE_PATTERN = /\b20\d{2}年\d{1,2}月\d{1,2}日?/u;
const ENGLISH_MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
// Require a delimited calendar date, not a year carrying a decimal, percent or currency unit.
const ENGLISH_DATE_PATTERN = new RegExp(
  `\\b(${ENGLISH_MONTHS.join("|")})\\s+(\\d{1,2}),?\\s+(20\\d{2})(?!\\.\\d)(?=\\s*(?:[,.;:!?\\n]|$))`,
  "giu",
);

function withoutEnglishDateLiterals(text: string): string {
  return text.replace(
    ENGLISH_DATE_PATTERN,
    (literal: string, month: string, day: string, year: string) => {
      const monthIndex = ENGLISH_MONTHS.indexOf(month.toLowerCase());
      const date = new Date(Date.UTC(Number(year), monthIndex, Number(day)));
      return date.getUTCFullYear() === Number(year) &&
        date.getUTCMonth() === monthIndex &&
        date.getUTCDate() === Number(day)
        ? " "
        : literal;
    },
  );
}

const NUMBER_UNIT_PATTERN =
  /%|USD|EUR|GBP|CNY|JPY|HKD|dollars?|euros?|pounds?|yen|yuan|美元|欧元|英镑|人民币|日元|港元|港币|元/iu;
const COMPLETE_NUMBER_UNIT_PATTERN = new RegExp(`^(?:${NUMBER_UNIT_PATTERN.source})?$`, "iu");

function extractDataNumbers(text: string): string[] {
  // A complete standalone UUID is an identity, not a financial quantity. Keep
  // malformed/embedded tokens and unit-bearing values under the numeric gate.
  const withoutIdentifiers = text.replace(
    /(?<![\p{L}\p{N}_$€£¥])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\p{L}\p{N}_]|\.\d|\s*(?:%|USD|EUR|GBP|CNY|JPY|HKD|dollars?|euros?|pounds?|yen|yuan|美元|欧元|英镑|人民币|日元|港元|港币|元))/giu,
    " ",
  );
  const withoutDateLiterals = withoutEnglishDateLiterals(withoutIdentifiers)
    .replace(new RegExp(ISO_DATE_PATTERN.source, "giu"), " ")
    .replace(new RegExp(CHINESE_DATE_PATTERN.source, "gu"), " ");
  const withoutNameNumbers = withoutDateLiterals
    .replace(
      /(?:沪深|中证|上证|深证|创业板|科创|北证|恒生|日经|富时|标普|纳斯达克|道琼斯|国企|罗素)\d{1,4}(?!\d)/gu,
      " ",
    )
    .replace(/\b(?:S&P|SP|NASDAQ|RUSSELL|MSCI)[\s-]*\d{1,4}(?!\d)/giu, " ")
    .replace(/\b\d{1,2}(?:[YMWD]|年期?)(?!\d)/gu, " ")
    .replace(/\b(?:Q[1-4]|H[12]|FY\s?\d{2,4})\b/giu, " ")
    // A named metric's window (12-month volatility) labels the method, not its value.
    .replace(
      /\b\d{1,3}[- ](?:months?|days?|years?)\b(?=\s+(?:daily[- ]return\s+)?(?:volatility|lookback|moving[- ]average|momentum)\b)/giu,
      " ",
    );
  return (
    withoutNameNumbers.match(
      new RegExp(
        `(?<!\\d)(?:[$€£¥+-]\\s*)*\\d[\\d,]*(?:\\.\\d+)?(?:\\s*(?:${NUMBER_UNIT_PATTERN.source}))?(?:[$€£¥+-]+(?![$€£¥+\\-\\d]))?`,
        "giu",
      ),
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
 * So: strip a leading `+`, integer padding zeros and trailing fractional zeros. Anything beyond
 * this is a claim about the quantity, not about how it was written, and belongs to whoever decides
 * what counts as the same number -- not to a formatter.
 */
function canonicalNumber(raw: string): string {
  const unsigned = (raw.startsWith("+") ? raw.slice(1) : raw).replace(/^(-?)0+(?=\d)/u, "$1");
  const point = unsigned.indexOf(".");
  if (point < 0) {
    return unsigned;
  }
  const fraction = unsigned.slice(point + 1).replace(/0+$/u, "");
  return fraction === "" ? unsigned.slice(0, point) : `${unsigned.slice(0, point)}.${fraction}`;
}

function numberUnit(value: string): string {
  const compact = value.toLowerCase();
  return compact.includes("%")
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
}

function normalizedNumber(value: string): string | undefined {
  const compact = value.replace(/\s+/g, "").replace(/,/g, "").toLowerCase();
  const amount = compact.match(/^([+-]?)([$€£¥]?)([+-]?)(\d+(?:\.\d+)?)(.*)$/u);
  if (!amount || (amount[1] && amount[3]) || !COMPLETE_NUMBER_UNIT_PATTERN.test(amount[5])) {
    return undefined;
  }
  if (amount[2] && amount[5] && numberUnit(amount[2]) !== numberUnit(amount[5])) {
    return undefined;
  }
  return `${canonicalNumber(`${amount[1] || amount[3]}${amount[4]}`)}|${numberUnit(compact)}`;
}

/**
 * Whether a value in an answer is money, as opposed to a bare count or a percentage.
 *
 * The unit comes from `numberUnit`, the shared place that decides what unit a
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
  // A malformed money/percent mixture still needs validation, not a percent exemption.
  return numberUnit(value.replace(/%/gu, "")) !== "unitless";
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
  "LLM",
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
    (ISO_DATE_PATTERN.test(evidence.text) ||
      CHINESE_DATE_PATTERN.test(evidence.text) ||
      withoutEnglishDateLiterals(evidence.text) !== evidence.text),
  );
}

// Keep positions and nonmarket units intact: exempting a numeric magnitude globally
// would let a fixture budget also ground an unrelated real market quote.
const NON_MARKET_QUANTITY = /(?<![\d.])[+-]?\d[\d,]*(?:\.\d+)?\s*(?:测试单位|秒)/gu;

function nonMarketQuantityKey(value: string): string {
  return `${normalizedNumber(extractDataNumbers(value)[0] ?? value)}|${value.endsWith("秒") ? "seconds" : "test-units"}`;
}

function withoutGroundedNonMarketQuantities(
  artifact: QualityHarnessArtifact,
  evidence: readonly QualityHarnessEvidence[],
): string {
  const evidenceById = new Map(evidence.map((entry) => [entry.id, entry]));
  const carries = (text: string, key: string) =>
    [...text.matchAll(NON_MARKET_QUANTITY)].some((match) => nonMarketQuantityKey(match[0]) === key);
  return artifact.answer.replace(NON_MARKET_QUANTITY, (value: string, offset: number) => {
    const key = nonMarketQuantityKey(value);
    const before =
      artifact.answer
        .slice(0, offset)
        .split(/[。！？;；\n]/u)
        .at(-1) ?? "";
    const after = artifact.answer.slice(offset + value.length).split(/[。！？;；\n]/u)[0];
    const context = `${before}${value}${after}`;
    // Exact assertion binding is intentionally conservative: a shared quantity and
    // entity cannot prove that a second sentence describes the same synthetic fact.
    const normalizeAssertion = (text: string) => text.replace(/[\s\p{P}]/gu, "");
    const contextAssertion = normalizeAssertion(context);
    const contextEntities = financeEntities(context);
    const grounded = artifact.claims.some(
      (claim) =>
        claim.status === "supported" &&
        claim.text
          .split(/[。！？;；\n]/u)
          .some((assertion) => normalizeAssertion(assertion) === contextAssertion) &&
        carries(claim.text, key) &&
        (contextEntities.size === 0 || claimMatchesEvidenceEntity(context, claim.text)) &&
        supportingEvidenceIds(claim).some((id) => {
          const entry = evidenceById.get(id);
          return (
            entry !== undefined &&
            (entry.kind === "synthetic_fixture" || entry.kind === "policy") &&
            Boolean(entry.source?.trim()) &&
            carries(entry.text, key) &&
            claimMatchesEvidenceEntity(claim.text, entry.text)
          );
        }),
    );
    return grounded ? " ".repeat(value.length) : value;
  });
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
    (DIRECT_TRADE_ACTION_PATTERN.test(artifact.answer) || hasPositionSizing(artifact.answer))
  ) {
    problems.push("final finance answer contains a direct trade action or recommendation");
  }
  if (hasFinanceExecutionClaim(artifact.answer)) {
    problems.push("final finance answer contains an execution claim");
  }

  const rawAnswerNumbers = extractDataNumbers(artifact.answer);
  const answerStatesMoney = rawAnswerNumbers.some(isMonetaryAmount);
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
    const groundedAnswer = withoutGroundedNonMarketQuantities(artifact, request.evidence);
    const answerAssertions = groundedAnswer
      .split(/[。！？;；\n]|(?<=\.)\s+/u)
      .flatMap((assertion) => {
        const conjunctions = [
          ...assertion.matchAll(
            /\b(?:and|while|whereas|but)\b|以及|而|和|与|，|(?<!\d),|,(?!\d)/giu,
          ),
        ];
        const clauses: string[] = [];
        let start = 0;
        for (const [index, conjunction] of conjunctions.entries()) {
          const after = conjunction.index + conjunction[0].length;
          const left = assertion.slice(start, conjunction.index);
          const right = assertion.slice(after, conjunctions[index + 1]?.index);
          // Keep joint subjects attached to their shared value. A new clause
          // may start with a subject list whose value occurs after another separator.
          if (
            extractDataNumbers(left).length > 0 &&
            extractDataNumbers(assertion.slice(after)).length > 0 &&
            financeEntities(right).size > 0
          ) {
            clauses.push(left);
            start = after;
          }
        }
        return [...clauses, assertion.slice(start)];
      })
      .map((text) => ({
        entities: [...financeEntities(text)],
        numbers: new Set(extractDataNumbers(text).map(normalizedNumber)),
      }));
    const answerNumbers = [
      ...new Set([
        ...rawAnswerNumbers.filter((number) => normalizedNumber(number) === undefined),
        ...extractDataNumbers(groundedAnswer),
      ]),
    ].filter((number) => {
      const normalized = normalizedNumber(number);
      return normalized === undefined || !userSuppliedNumbers.has(normalized);
    });
    if (answerNumbers.length > 0) {
      const evidenceById = new Map(request.evidence.map((entry) => [entry.id, entry]));
      const supportedClaims = artifact.claims.filter((claim) => claim.status === "supported");
      const unsupportedNumbers = answerNumbers.filter((number) => {
        const normalized = normalizedNumber(number);
        if (normalized === undefined) {
          return true;
        }
        const assertions = answerAssertions.filter((assertion) =>
          assertion.numbers.has(normalized),
        );
        // Keep repeated values attached to every answer assertion, rather than
        // borrowing an unrelated claim about another instrument at the same price.
        // A formatting break inside a number/unit retains the full context.
        const contexts =
          assertions.length > 0 ? assertions : [{ entities: [...financeEntities(groundedAnswer)] }];
        return contexts.some((context) => {
          const entities = context.entities;
          const subjects = entities.length > 0 ? entities : [undefined];
          return subjects.some(
            (entity) =>
              !supportedClaims.some((claim) => {
                const claimCarriesNumber = extractDataNumbers(claim.text).some(
                  (value) => normalizedNumber(value) === normalized,
                );
                if (!claimCarriesNumber || (entity && !financeEntities(claim.text).has(entity))) {
                  return false;
                }
                return supportingEvidenceIds(claim)
                  .map((id) => evidenceById.get(id))
                  .filter((entry): entry is QualityHarnessEvidence => entry !== undefined)
                  .some(
                    (entry) =>
                      extractDataNumbers(entry.text).some(
                        (value) => normalizedNumber(value) === normalized,
                      ) &&
                      hasEvidenceSourceAndTimestamp(entry) &&
                      (!entity || financeEntities(entry.text).has(entity)) &&
                      claimMatchesEvidenceEntity(claim.text, entry.text),
                  );
              }),
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
  evidenceBatches: readonly (readonly QualityHarnessEvidence[])[] = [request.evidence],
  auditEvidenceBatches = false,
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
  const additionalBatchReviews: string[] = [];
  for (let index = 0; auditEvidenceBatches && index < evidenceBatches.length; index += 1) {
    const batch = evidenceBatches[index] ?? [];
    const batchNumber = index + 1;
    const taskChecks = [
      ...(index > 0 ? ([{ suffix: "extract", label: "context extraction" }] as const) : []),
      { suffix: "review", label: "final artifact audit" },
    ];
    for (const { suffix, label } of taskChecks) {
      const taskId = `evidence_batch_${suffix}_${batchNumber}`;
      const stageResult = findQualityStageResult(result, taskId);
      const reviewResult =
        suffix === "extract"
          ? reconciledReview(taskId, "extraction")
          : reviewPassed(stageResult, "evidence");
      const output = stageResult?.status === "completed" ? stageResult.output : undefined;
      const review = output?.kind === "review" ? output.review : undefined;
      const uncoveredIds = batch
        .map((entry) => entry.id)
        .filter((id) => !review?.notes.some((note) => note.includes(`[${id}]`)));
      const allowedIds = new Set(batch.map((entry) => entry.id));
      const reviewedText = [
        ...(review?.notes ?? []),
        ...(review?.criticalFindings ?? []),
        ...(review?.evidenceGaps ?? []),
      ];
      const referencedOutOfScopeIds = request.evidence
        .map((entry) => entry.id)
        .filter((id) => !allowedIds.has(id))
        .filter((id) =>
          reviewedText.some((text) => {
            let offset = 0;
            while (offset < text.length) {
              const index = text.indexOf(id, offset);
              if (index < 0) {
                return false;
              }
              const before = text[index - 1];
              const after = text[index + id.length];
              if (
                (before === undefined || !/[\p{L}\p{N}_.:-]/u.test(before)) &&
                (after === undefined || !/[\p{L}\p{N}_.:-]/u.test(after))
              ) {
                return true;
              }
              offset = index + 1;
            }
            return false;
          }),
        );
      const outOfScopeIds = [
        ...new Set(
          [
            ...(review?.notes ?? []),
            ...(review?.criticalFindings ?? []),
            ...(review?.evidenceGaps ?? []),
          ]
            .flatMap((note) => [...note.matchAll(/\[([^\]]+)\]/gu)].map((match) => match[1]))
            .filter((id) => !allowedIds.has(id))
            .concat(referencedOutOfScopeIds),
        ),
      ];
      if (!reviewResult.passed || uncoveredIds.length > 0 || outOfScopeIds.length > 0) {
        additionalBatchReviews.push(
          `batch ${batchNumber} ${label} incomplete${uncoveredIds.length > 0 ? `; missing note IDs: ${uncoveredIds.join(",")}` : ""}${outOfScopeIds.length > 0 ? `; out-of-scope note IDs: ${outOfScopeIds.join(",")}` : ""}${!reviewResult.passed ? `; ${reviewResult.reason}` : ""}`,
        );
      }
    }
  }
  const allStagesCompleted =
    result.status === "completed" &&
    result.tasks.length ===
      10 +
        (auditEvidenceBatches
          ? Math.max(0, evidenceBatches.length - 1) + evidenceBatches.length
          : 0);
  const sideEffects = result.tasks.flatMap((entry) => entry.sideEffects);
  const gates: QualityHarnessGate[] = [
    {
      id: "all_stages_completed",
      passed: allStagesCompleted,
      reason: allStagesCompleted
        ? "all planned base and evidence-batch stages completed"
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
      id: "evidence_batch_reviews",
      passed: additionalBatchReviews.length === 0,
      reason:
        additionalBatchReviews.length === 0
          ? auditEvidenceBatches
            ? `all ${evidenceBatches.length} evidence batches have ID-covered final-artifact review and additional batches have ID-covered extraction`
            : "single evidence batch requires no additional passes"
          : additionalBatchReviews.slice(0, 12).join("; "),
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
    ...additionalBatchReviews,
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
