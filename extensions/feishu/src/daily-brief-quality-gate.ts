type DailyBriefStatus =
  | "verified"
  | "provisional"
  | "stale_snapshot"
  | "data_unavailable"
  | "low_fidelity"
  | "fresh"
  | "stale";

type DailyBriefAlertKey = "memory_critical" | "git_diverged" | "feed_degraded" | "branch_stale";

type DailyBriefAlertDefinition = {
  key: DailyBriefAlertKey;
  label: string;
  priorPattern: RegExp;
  repairPattern: RegExp;
};

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

const MARKET_NUMERIC_PATTERN =
  /\b(?:spy|qqq|iwm|dia|tlt|gld|uso|vix|dxy|spx|nasdaq|dow|russell|yield|2y|10y|rates?|treasury|oil|gold)\b[^\n]*?(?:\d+(?:\.\d+)?%?|\+\d+(?:\.\d+)?%?|-?\d+(?:\.\d+)?%?)/iu;
const EARNINGS_DATE_PATTERN =
  /\bearnings\b[^\n]*?(?:\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|before the open|after the close|bmo|amc)/iu;
const OFFICIAL_EARNINGS_SOURCE_PATTERN =
  /\b(?:official|investor relations|ir page|sec|edgar|exchange|10-q|10-k|8-k|earnings release|issuer page|official filing)\b/iu;
const MARKET_TIMESTAMP_PATTERN =
  /\b(?:data timestamp|market data timestamp|snapshot at|updated at|verified at|as of)\b[^\n]*?(?:\d{4}-\d{2}-\d{2}(?:[t\s]\d{2}:\d{2}(?::\d{2})?(?:z|[ ]?(?:utc|et|edt|est))?)?)/iu;
const DATA_DEGRADED_PATTERN =
  /\b(?:market data (?:degraded|unavailable|empty|stale)|feed degraded|stale snapshot|data unavailable|provider-limited|weak freshness|yfinance[^\n]*?(?:empty|missing|unavailable|none)|vix unavailable|dxy unavailable)\b/iu;
const LOW_FIDELITY_SEARCH_PATTERN =
  /\b(?:web search[^\n]*?(?:low-fidelity|low fidelity|hallucinat|unreliable|degraded)|google search result|search-derived|search derived|public web reference)\b/iu;
const BRANCH_STALE_PATTERN =
  /\b(?:technical_daily_branch|knowledge_maintenance_branch)\b[^\n]*?\bstale\b|\bbranch stale\b/iu;

const ALERT_DEFINITIONS: DailyBriefAlertDefinition[] = [
  {
    key: "memory_critical",
    label:
      "previous memory critical alert still active; no repair proof for zero-file/zero-chunk state.",
    priorPattern: /\b(?:memory critical|memory[^\n]*0 files\/0 chunks|0 files\/0 chunks)\b/iu,
    repairPattern:
      /\b(?:memory repair proof|memory verified|memory repaired|memory scan[^\n]*\b\d+\s+files\b[^\n]*\b\d+\s+chunks\b)\b/iu,
  },
  {
    key: "git_diverged",
    label: "previous git divergence alert still active; no explicit sync proof.",
    priorPattern: /\b(?:git diverged|git divergence|branch diverged)\b/iu,
    repairPattern:
      /\b(?:git repair proof|git synced|git clean|branch synced|divergence repaired)\b/iu,
  },
  {
    key: "feed_degraded",
    label: "previous feed degradation alert still active; no fresh timestamped data proof.",
    priorPattern:
      /\b(?:feed degraded|market data degraded|market data unavailable|search degraded|web search low-fidelity|yfinance[^\n]*empty)\b/iu,
    repairPattern:
      /\b(?:market data timestamp|snapshot at|verified at|search reliability verified|official source verified)\b/iu,
  },
  {
    key: "branch_stale",
    label:
      "previous branch freshness alert still active; technical/knowledge branches remain stale.",
    priorPattern: BRANCH_STALE_PATTERN,
    repairPattern:
      /\b(?:technical_daily_branch|knowledge_maintenance_branch)\b[^\n]*?\b(?:fresh|verified|updated)\b/iu,
  },
] as const;

export type FeishuDailyBriefQualityGateParams = {
  text: string;
  dailyWorkfaceSummary?: string;
  portfolioScorecardSummary?: string;
  validationWeeklySummary?: string;
  learningTimeboxSummary?: string;
  improvementPulse?: string;
  dailyArtifactAvailabilitySummary?: string;
  priorSurfaceLineContent?: string;
};

export type FeishuDailyBriefQualityGateResult = {
  text: string;
  dataFreshnessStatus: Extract<
    DailyBriefStatus,
    "verified" | "provisional" | "stale_snapshot" | "data_unavailable"
  >;
  sourceReliabilityStatus: Extract<DailyBriefStatus, "verified" | "provisional" | "low_fidelity">;
  researchFreshnessStatus: Extract<DailyBriefStatus, "fresh" | "provisional" | "stale">;
  unresolvedCriticalAlerts: string[];
};

function sanitizeDebugResidue(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => !DEBUG_LINE_PATTERNS.some((pattern) => pattern.test(line.trim())))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collectUnresolvedAlerts(
  priorSurfaceLineContent: string | undefined,
  currentContext: string,
): string[] {
  if (!priorSurfaceLineContent?.trim()) {
    return [];
  }
  return ALERT_DEFINITIONS.filter(
    (alert) =>
      alert.priorPattern.test(priorSurfaceLineContent) && !alert.repairPattern.test(currentContext),
  ).map((alert) => alert.label);
}

function deriveDataFreshnessStatus(params: {
  currentContext: string;
  hasNumericMarketClaims: boolean;
  unresolvedCriticalAlerts: string[];
}): FeishuDailyBriefQualityGateResult["dataFreshnessStatus"] {
  if (
    /\b(?:empty yfinance|yfinance[^\n]*empty|market data unavailable|vix unavailable|dxy unavailable)\b/iu.test(
      params.currentContext,
    )
  ) {
    return "data_unavailable";
  }
  if (
    DATA_DEGRADED_PATTERN.test(params.currentContext) ||
    params.unresolvedCriticalAlerts.length > 0
  ) {
    return params.currentContext.includes("stale snapshot") ? "stale_snapshot" : "provisional";
  }
  if (params.hasNumericMarketClaims && !MARKET_TIMESTAMP_PATTERN.test(params.currentContext)) {
    return "provisional";
  }
  if (/\b(?:stale snapshot|prior snapshot)\b/iu.test(params.currentContext)) {
    return "stale_snapshot";
  }
  return "verified";
}

function deriveSourceReliabilityStatus(params: {
  currentContext: string;
  hasEarningsClaim: boolean;
}): FeishuDailyBriefQualityGateResult["sourceReliabilityStatus"] {
  if (
    LOW_FIDELITY_SEARCH_PATTERN.test(params.currentContext) &&
    !OFFICIAL_EARNINGS_SOURCE_PATTERN.test(params.currentContext)
  ) {
    return "low_fidelity";
  }
  if (params.hasEarningsClaim && !OFFICIAL_EARNINGS_SOURCE_PATTERN.test(params.currentContext)) {
    return "provisional";
  }
  return "verified";
}

function deriveResearchFreshnessStatus(params: {
  currentContext: string;
  unresolvedCriticalAlerts: string[];
}): FeishuDailyBriefQualityGateResult["researchFreshnessStatus"] {
  if (
    BRANCH_STALE_PATTERN.test(params.currentContext) ||
    params.unresolvedCriticalAlerts.some((alert) => alert.includes("branch freshness"))
  ) {
    return "stale";
  }
  if (/\b(?:provisional|stale|not freshly verified)\b/iu.test(params.currentContext)) {
    return "provisional";
  }
  return "fresh";
}

function summarizeStatus(
  status:
    | FeishuDailyBriefQualityGateResult["dataFreshnessStatus"]
    | FeishuDailyBriefQualityGateResult["sourceReliabilityStatus"]
    | FeishuDailyBriefQualityGateResult["researchFreshnessStatus"],
): string {
  switch (status) {
    case "data_unavailable":
      return "data unavailable";
    case "stale_snapshot":
      return "stale snapshot";
    case "low_fidelity":
      return "low-fidelity / provisional";
    default:
      return status;
  }
}

function extractControlSummaryLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => !line.startsWith("##") && !line.startsWith("Distribution:"));
}

function gatherSectionLines(params: {
  text: string;
  predicate: (line: string) => boolean;
}): string[] {
  return params.text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("##"))
    .filter((line) => params.predicate(line));
}

function dedupeLines(lines: string[]): string[] {
  return Array.from(new Set(lines.map((line) => line.trim()).filter(Boolean)));
}

function buildNextAction(params: {
  dataFreshnessStatus: FeishuDailyBriefQualityGateResult["dataFreshnessStatus"];
  sourceReliabilityStatus: FeishuDailyBriefQualityGateResult["sourceReliabilityStatus"];
  researchFreshnessStatus: FeishuDailyBriefQualityGateResult["researchFreshnessStatus"];
  unresolvedCriticalAlerts: string[];
}): string {
  if (
    params.dataFreshnessStatus !== "verified" ||
    params.unresolvedCriticalAlerts.some((alert) => alert.includes("feed degradation"))
  ) {
    return "repair or re-verify the market-data feed and publish a fresh timestamp before showing numeric market claims.";
  }
  if (params.sourceReliabilityStatus !== "verified") {
    return "verify earnings or catalyst timing against official IR / exchange / filing sources before stating dates.";
  }
  if (params.researchFreshnessStatus !== "fresh") {
    return "refresh the stale research branches before labeling downstream learning or follow-ups as fresh.";
  }
  if (params.unresolvedCriticalAlerts.length > 0) {
    return "close the unresolved operational alert with explicit repair proof before flipping the brief back to healthy.";
  }
  return "continue with bounded follow-up using only verified sources and explicit freshness labels.";
}

function renderSection(title: string, lines: string[]): string {
  return [`## ${title}`, ...(lines.length > 0 ? lines : ["- unavailable."])].join("\n");
}

export function applyFeishuDailyBriefQualityGate(
  params: FeishuDailyBriefQualityGateParams,
): FeishuDailyBriefQualityGateResult {
  const sanitizedText = sanitizeDebugResidue(params.text);
  const summaryParts = [
    sanitizedText,
    params.dailyWorkfaceSummary,
    params.portfolioScorecardSummary,
    params.validationWeeklySummary,
    params.learningTimeboxSummary,
    params.improvementPulse,
    params.dailyArtifactAvailabilitySummary,
  ]
    .map((part) => sanitizeDebugResidue(part ?? ""))
    .filter(Boolean);
  const currentContext = summaryParts.join("\n\n");
  const hasNumericMarketClaims = MARKET_NUMERIC_PATTERN.test(currentContext);
  const hasEarningsClaim = EARNINGS_DATE_PATTERN.test(currentContext);
  const unresolvedCriticalAlerts = collectUnresolvedAlerts(
    params.priorSurfaceLineContent,
    currentContext,
  );
  const dataFreshnessStatus = deriveDataFreshnessStatus({
    currentContext,
    hasNumericMarketClaims,
    unresolvedCriticalAlerts,
  });
  const sourceReliabilityStatus = deriveSourceReliabilityStatus({
    currentContext,
    hasEarningsClaim,
  });
  const researchFreshnessStatus = deriveResearchFreshnessStatus({
    currentContext,
    unresolvedCriticalAlerts,
  });

  const marketLines =
    dataFreshnessStatus === "verified"
      ? gatherSectionLines({
          text: currentContext,
          predicate: (line) =>
            MARKET_NUMERIC_PATTERN.test(line) ||
            /\b(?:market|risk|rates|yield|vix|dxy|spy|qqq|iwm|tlt|oil|gold)\b/iu.test(line),
        })
      : [
          `- ${summarizeStatus(dataFreshnessStatus)}. Exact prices, percentage moves, and VIX/DXY levels are withheld until a fresh timestamped market snapshot is present.`,
        ];

  const fundamentalLines =
    sourceReliabilityStatus === "verified"
      ? gatherSectionLines({
          text: currentContext,
          predicate: (line) =>
            /\b(?:earnings|guidance|filing|ir|investor relations|company follow-up|exchange)\b/iu.test(
              line,
            ),
        })
      : [
          `- ${summarizeStatus(sourceReliabilityStatus)}. Earnings-date or catalyst timing claims are withheld until an official IR / exchange / filing source is present.`,
        ];

  const learningLines = dedupeLines(
    [
      params.validationWeeklySummary,
      params.learningTimeboxSummary,
      params.improvementPulse,
    ].flatMap((part) =>
      sanitizeDebugResidue(part ?? "")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  );
  if (researchFreshnessStatus !== "fresh") {
    learningLines.unshift(
      `- ${summarizeStatus(researchFreshnessStatus)}. Branch freshness is not clean enough to label downstream research output as fresh.`,
    );
  }

  const controlSummary = extractControlSummaryLine(sanitizedText);
  const operationalLines = dedupeLines(
    [
      controlSummary ? `- Brief summary: ${controlSummary}` : undefined,
      params.dailyWorkfaceSummary,
      params.portfolioScorecardSummary,
      params.dailyArtifactAvailabilitySummary,
      ...gatherSectionLines({
        text: currentContext,
        predicate: (line) =>
          line.startsWith("Distribution:") ||
          /\b(?:workface|scorecard|validation radar|learning loop|protected anchors|artifacts|ops|operational)\b/iu.test(
            line,
          ),
      }).map((line) => (line.startsWith("-") ? line : `- ${line}`)),
    ].flatMap((part) =>
      sanitizeDebugResidue(part ?? "")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => (line.startsWith("-") ? line : `- ${line}`)),
    ),
  );

  const finalText = [
    renderSection("Data Freshness Status", [
      `- ${summarizeStatus(dataFreshnessStatus)}.${MARKET_TIMESTAMP_PATTERN.test(currentContext) ? ` Timestamp present in source text.` : " Numeric market claims require an explicit data timestamp."}`,
    ]),
    renderSection("Source Reliability Status", [
      `- ${summarizeStatus(sourceReliabilityStatus)}.${sourceReliabilityStatus === "verified" ? " Earnings or catalyst timing claims are backed by an official source artifact or withheld." : " Search-derived or weak-source claims stay provisional until backed by an official source artifact."}`,
    ]),
    renderSection(
      "Market / Risk Picture",
      marketLines.map((line) => (line.startsWith("-") ? line : `- ${line}`)),
    ),
    renderSection(
      "Fundamental Follow-Ups",
      fundamentalLines.map((line) => (line.startsWith("-") ? line : `- ${line}`)),
    ),
    renderSection(
      "Learning Radar",
      learningLines.map((line) => (line.startsWith("-") ? line : `- ${line}`)),
    ),
    renderSection(
      "Operational Health",
      operationalLines.length > 0
        ? operationalLines
        : ["- operational summaries unavailable in this brief."],
    ),
    renderSection(
      "Unresolved Critical Alerts",
      unresolvedCriticalAlerts.length > 0
        ? unresolvedCriticalAlerts.map((alert) => `- ${alert}`)
        : ["- none carried over without repair proof."],
    ),
    renderSection("Next Action", [
      `- ${buildNextAction({
        dataFreshnessStatus,
        sourceReliabilityStatus,
        researchFreshnessStatus,
        unresolvedCriticalAlerts,
      })}`,
    ]),
  ]
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    text: finalText,
    dataFreshnessStatus,
    sourceReliabilityStatus,
    researchFreshnessStatus,
    unresolvedCriticalAlerts,
  };
}
