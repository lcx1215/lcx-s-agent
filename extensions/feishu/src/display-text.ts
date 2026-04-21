function normalizeMarkdownTableBlock(block: string): string {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return block;
  }

  const rows = lines
    .filter((line, index) => {
      if (index === 1 && /^\|?[-:\s|]+\|?$/.test(line)) {
        return false;
      }
      return true;
    })
    .map((line) =>
      line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean),
    )
    .filter((cells) => cells.length > 0);

  if (rows.length < 2) {
    return block;
  }

  const headers = rows[0];
  const bodyRows = rows.slice(1);
  return bodyRows
    .map((cells) => {
      const pairs = cells.map((cell, index) => {
        const header = headers[index] ?? `Column ${index + 1}`;
        return `${header}: ${cell}`;
      });
      return `- ${pairs.join("; ")}`;
    })
    .join("\n");
}

const DEBUG_LINE_PATTERNS = [
  /now i have enough signal/iu,
  /now i have good context/iu,
  /internal reasoning/iu,
  /^reasoning trace[:：]?/iu,
  /^thought process[:：]?/iu,
  /我的儿子们/u,
  /机器人/u,
  /^\s*w\s*$/iu,
] as const;

const MARKET_NUMERIC_CONTEXT_PATTERN =
  /\b(?:spy|qqq|iwm|dia|tlt|gld|uso|vix|dxy|spx|nasdaq|dow|russell|yield|2y|10y|rates?|treasury|oil|gold|bitcoin|btc|equities?|bonds?|eem)\b/iu;
const UPPERCASE_TICKER_PATTERN = /\b[A-Z]{2,5}\b/u;
const MARKET_NUMBER_VALUE_PATTERN =
  /(?:\$?\d[\d,]*(?:\.\d+)?%?|\+\d[\d,]*(?:\.\d+)?%?|-?\d[\d,]*(?:\.\d+)?%?)/u;
const HAS_NUMERIC_CLAIM_PATTERN = /\d/u;
const EARNINGS_DATE_LINE_PATTERN =
  /\b(?:earnings|earnings watch|reports?|reporting|ticker|date|avg eps|revenue avg|consensus read|guidance)\b[^\n]*?(?:\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|before the open|after the close|bmo|amc)/iu;
const OFFICIAL_EARNINGS_SOURCE_PATTERN =
  /\b(?:official|investor relations|ir page|sec|edgar|exchange|10-q|10-k|8-k|earnings release|issuer page|official filing)\b/iu;
const MARKET_TIMESTAMP_PATTERN =
  /\b(?:data timestamp|market data timestamp|snapshot at|updated at|verified at|as of)\b[^\n]*?(?:\d{4}-\d{2}-\d{2}(?:[t\s]\d{2}:\d{2}(?::\d{2})?(?:z|[ ]?(?:utc|et|edt|est))?)?)/iu;
const DATA_DEGRADED_PATTERN =
  /\b(?:market data (?:degraded|unavailable|empty|stale)|feed degraded|stale snapshot|data unavailable|provider-limited|weak freshness|yfinance[^\n]*?(?:empty|missing|unavailable|none)|vix unavailable|dxy unavailable)\b/iu;
const DATA_UNAVAILABLE_PATTERN =
  /\b(?:empty yfinance|yfinance[^\n]*?(?:empty|missing|unavailable|none)|market data unavailable|vix unavailable|dxy unavailable)\b/iu;
const LOW_FIDELITY_SEARCH_PATTERN =
  /\b(?:web search[^\n]*?(?:low-fidelity|low fidelity|hallucinat|unreliable|degraded)|google search result|search-derived|search derived|public web reference)\b/iu;
const BRANCH_STALE_PATTERN =
  /\b(?:technical_daily_branch|knowledge_maintenance_branch)\b[^\n]*?\bstale\b|\bbranch stale\b/iu;
const FINANCE_CONTEXT_PATTERN =
  /\b(?:market|spy|qqq|iwm|dia|tlt|gld|uso|vix|dxy|spx|nasdaq|dow|russell|yield|rates?|treasury|oil|gold|bitcoin|btc|earnings|portfolio|risk[- ]on|risk[- ]off|equities?|stocks?|etf|volatility|small-cap|large-cap|macro|credit|sector)\b/iu;
const DIRECTIONAL_LANGUAGE_RULES = [
  {
    pattern: /\bgreen-light setup\b/giu,
    replacement: "research-positive condition requiring verification",
  },
  {
    pattern: /\brisk-on tone today\b/giu,
    replacement: "research-only risk-on condition today",
  },
  {
    pattern: /\bbroad risk-on\b/giu,
    replacement: "research-only broad risk-on condition",
  },
  {
    pattern: /\bno clear long signals?\b/giu,
    replacement: "no clear research-positive conditions yet",
  },
  {
    pattern: /\b(?:buy|sell|entry|exit) signal\b/giu,
    replacement: "watchlist condition requiring verification",
  },
  {
    pattern: /\bstrong buy\b/giu,
    replacement: "candidate for further review",
  },
  {
    pattern: /\btrade this\b/giu,
    replacement: "treat this as a watchlist condition",
  },
  {
    pattern: /\bactionable setup\b/giu,
    replacement: "candidate for further review",
  },
  {
    pattern: /\bposition now\b/giu,
    replacement: "review further before any positioning decision",
  },
  {
    pattern: /\bdefensive posture\b/giu,
    replacement: "watchlist posture for verification",
  },
  {
    pattern: /\bdefensive (?:etf|portfolio|equity) positioning is appropriate\b/giu,
    replacement: "watchlist posture for verification; allocation implications require human review",
  },
  {
    pattern: /\breduced equity exposure\b/giu,
    replacement: "a reduced-equity watchlist posture for verification",
  },
  {
    pattern: /\bincrease exposure\b/giu,
    replacement: "review whether higher exposure is warranted",
  },
  {
    pattern: /\bdecrease exposure\b/giu,
    replacement: "review whether lower exposure is warranted",
  },
  {
    pattern:
      /\brotate into\b(?=[^\n]{0,80}\b(?:etf|equities?|stocks?|bonds?|gold|treasury|sector|cash|hedges?|defensive|growth|value|usmv|schb)\b)/giu,
    replacement: "place on the watchlist for further review instead of rotating into",
  },
  {
    pattern:
      /\brotate out of\b(?=[^\n]{0,80}\b(?:etf|equities?|stocks?|bonds?|gold|treasury|sector|cash|hedges?|defensive|growth|value|usmv|schb)\b)/giu,
    replacement: "place on the watchlist for further review instead of rotating out of",
  },
  {
    pattern: /\bsensible move:?/giu,
    replacement: "bounded follow-up:",
  },
  {
    pattern: /\brun tactical portfolio stress test\b/giu,
    replacement: "review this portfolio risk scenario",
  },
  {
    pattern: /\bmonitor\b([^\n]{0,80}?)\bfor a potential follow-through entry\b/giu,
    replacement: (_match: string, captured: string) =>
      `review${captured}for a potential follow-through watchlist condition`,
  },
  {
    pattern: /\bfollow-through entry\b/giu,
    replacement: "follow-through watchlist review",
  },
  {
    pattern: /\badd hedges now\b/giu,
    replacement: "hedge implications require human review",
  },
  {
    pattern: /\btrim risk now\b/giu,
    replacement: "risk reduction implications require human review",
  },
  {
    pattern: /\bleverage up\b/giu,
    replacement: "do not escalate exposure without further review",
  },
  {
    pattern: /\bgo long\b/giu,
    replacement: "treat as a watchlist condition",
  },
  {
    pattern: /\bshort this\b/giu,
    replacement: "treat as a watchlist condition",
  },
  {
    pattern: /\bbenign for equities near-term\b/giu,
    replacement: "a research-positive condition requiring verification, not an execution signal",
  },
] as const satisfies ReadonlyArray<{
  pattern: RegExp;
  replacement: string | ((substring: string, ...args: string[]) => string);
}>;

type DailyBriefDataFreshnessStatus =
  | "verified"
  | "provisional"
  | "stale snapshot"
  | "data unavailable";
type DailyBriefSourceReliabilityStatus = "verified" | "provisional" | "low-fidelity / provisional";
type DailyBriefResearchFreshnessStatus = "fresh" | "provisional" | "stale";

function sanitizeDebugResidue(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => !DEBUG_LINE_PATTERNS.some((pattern) => pattern.test(line.trim())))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function deriveDataFreshnessStatus(text: string): DailyBriefDataFreshnessStatus {
  if (DATA_UNAVAILABLE_PATTERN.test(text)) {
    return "data unavailable";
  }
  if (DATA_DEGRADED_PATTERN.test(text)) {
    return text.includes("stale snapshot") ? "stale snapshot" : "provisional";
  }
  const hasUntimestampedMarketClaims = text
    .split(/\r?\n/u)
    .some((line) => hasMarketNumericClaim(line) && !MARKET_TIMESTAMP_PATTERN.test(line));
  if (hasUntimestampedMarketClaims && !MARKET_TIMESTAMP_PATTERN.test(text)) {
    return "provisional";
  }
  return "verified";
}

function hasMarketNumericClaim(line: string): boolean {
  const sanitized = line.replace(/\*\*/g, " ").replace(/`/g, " ").trim();
  if (!MARKET_NUMBER_VALUE_PATTERN.test(sanitized)) {
    return false;
  }
  return MARKET_NUMERIC_CONTEXT_PATTERN.test(sanitized) || UPPERCASE_TICKER_PATTERN.test(sanitized);
}

function deriveSourceReliabilityStatus(text: string): DailyBriefSourceReliabilityStatus {
  const hasOfficialSource = OFFICIAL_EARNINGS_SOURCE_PATTERN.test(text);
  if (LOW_FIDELITY_SEARCH_PATTERN.test(text) && !hasOfficialSource) {
    return "low-fidelity / provisional";
  }
  if (EARNINGS_DATE_LINE_PATTERN.test(text) && !hasOfficialSource) {
    return "provisional";
  }
  return "verified";
}

function deriveResearchFreshnessStatus(text: string): DailyBriefResearchFreshnessStatus {
  if (BRANCH_STALE_PATTERN.test(text)) {
    return "stale";
  }
  if (/\b(?:provisional|stale|not freshly verified)\b/iu.test(text)) {
    return "provisional";
  }
  return "fresh";
}

function applyFinanceLanguageDiscipline(
  text: string,
  dataFreshnessStatus: DailyBriefDataFreshnessStatus,
): { text: string; directionalLanguageRewritten: boolean; provisionalDisclaimerAdded: boolean } {
  const hasFinanceContext = FINANCE_CONTEXT_PATTERN.test(text);
  let directionalLanguageRewritten = false;
  let rewrittenText = text;

  for (const rule of DIRECTIONAL_LANGUAGE_RULES) {
    const nextText = rewrittenText.replace(rule.pattern, (...args) => {
      directionalLanguageRewritten = true;
      if (typeof rule.replacement === "function") {
        return rule.replacement(args[0] as string, ...(args.slice(1, -2) as string[]));
      }
      return rule.replacement;
    });
    rewrittenText = nextText;
  }

  const shouldAddProvisionalDisclaimer =
    directionalLanguageRewritten && hasFinanceContext && dataFreshnessStatus !== "verified";
  if (shouldAddProvisionalDisclaimer) {
    const disclaimer =
      "Directional finance language remains provisional, research-only, and not an execution signal.";
    const existingLines = rewrittenText.split(/\r?\n/u).map((line) => line.trimEnd());
    const hasDisclaimer = existingLines.some((line) => line.trim() === disclaimer);
    if (!hasDisclaimer) {
      existingLines.push(disclaimer);
      rewrittenText = existingLines.join("\n");
    }
  }

  return {
    text: rewrittenText,
    directionalLanguageRewritten,
    provisionalDisclaimerAdded: shouldAddProvisionalDisclaimer,
  };
}

function applyDailyBriefQualityGate(text: string): string {
  const sanitizedText = sanitizeDebugResidue(text);
  const dataFreshnessStatus = deriveDataFreshnessStatus(sanitizedText);
  const sourceReliabilityStatus = deriveSourceReliabilityStatus(sanitizedText);
  const researchFreshnessStatus = deriveResearchFreshnessStatus(sanitizedText);
  const languageDisciplined = applyFinanceLanguageDiscipline(sanitizedText, dataFreshnessStatus);

  let blockedMarketClaims = false;
  let blockedEarningsClaims = false;

  const gatedLines = languageDisciplined.text
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }
      if (
        sourceReliabilityStatus !== "verified" &&
        EARNINGS_DATE_LINE_PATTERN.test(trimmed) &&
        !OFFICIAL_EARNINGS_SOURCE_PATTERN.test(trimmed)
      ) {
        blockedEarningsClaims = true;
        return false;
      }
      if (
        dataFreshnessStatus !== "verified" &&
        HAS_NUMERIC_CLAIM_PATTERN.test(trimmed) &&
        hasMarketNumericClaim(trimmed) &&
        !MARKET_TIMESTAMP_PATTERN.test(trimmed)
      ) {
        blockedMarketClaims = true;
        return false;
      }
      return true;
    });

  const shouldAnnotate =
    blockedMarketClaims ||
    blockedEarningsClaims ||
    dataFreshnessStatus !== "verified" ||
    sourceReliabilityStatus !== "verified" ||
    researchFreshnessStatus !== "fresh" ||
    languageDisciplined.provisionalDisclaimerAdded;

  if (!shouldAnnotate) {
    return gatedLines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const annotations = [
    `Data freshness status: ${dataFreshnessStatus}.`,
    `Source reliability status: ${sourceReliabilityStatus}.`,
    `Research freshness status: ${researchFreshnessStatus}.`,
  ];

  if (blockedMarketClaims) {
    annotations.push(
      "Exact prices, percentage moves, and VIX/DXY levels are withheld because market data is degraded, stale, or lacks an explicit timestamp.",
    );
  }
  if (blockedEarningsClaims) {
    annotations.push(
      "Earnings-date or catalyst timing claims are withheld until an official IR / exchange / filing source is cited.",
    );
  }
  if (researchFreshnessStatus !== "fresh") {
    annotations.push(
      "Branch freshness is not clean enough to label downstream research output as fresh.",
    );
  }

  return [...annotations, "", gatedLines.join("\n").trim()]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeFeishuDisplayText(text: string): string {
  const normalizedTables = text.replace(
    /(^|\n)(\|.+\|[\r\n]+\|[-:| ]+\|(?:[\r\n]+\|.*\|)+)/g,
    (_match, prefix: string, table: string) => `${prefix}${normalizeMarkdownTableBlock(table)}`,
  );

  const withoutCodeFences = normalizedTables.replace(
    /```(?:[\w+-]+)?\n?([\s\S]*?)```/g,
    (_match, codeBody: string) => {
      const body = codeBody
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trim();
      return body ? `\n${body}\n` : "\n";
    },
  );

  const normalized = withoutCodeFences
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*---+\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return applyDailyBriefQualityGate(normalized);
}
