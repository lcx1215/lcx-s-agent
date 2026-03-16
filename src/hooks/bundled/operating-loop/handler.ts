import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import {
  compactText,
  loadSessionTurnsWithResetFallback,
  resolveMemorySessionContext,
  type SessionTurn,
} from "../artifact-memory.js";
import {
  looksLikeFrontierResearchSession,
  summarizeFrontierResearchSession,
} from "../frontier-research/handler.js";
import { looksLikeLearningSession, summarizeLearningSession } from "../learning-review/handler.js";
import {
  countTop,
  formatIsoWeek,
  toUtcDateOnly,
  type MemoryNote,
  writeMemoryNotes,
} from "../weekly-memory.js";

const log = createSubsystemLogger("hooks/operating-loop");

const LEARNING_FILE_RE = /^(\d{4}-\d{2}-\d{2})-review-.*\.md$/;
const FRONTIER_FILE_RE = /^(\d{4}-\d{2}-\d{2})-frontier-research-.*\.md$/;
const SESSION_FILE_RE = /^(\d{4}-\d{2}-\d{2})-.*\.md$/;

type SessionSnapshot = {
  date: string;
  name: string;
  sessionKey: string;
  sessionId: string;
  source: string;
  intake: string;
};

type LearningSnapshot = {
  date: string;
  name: string;
  sessionKey: string;
  sessionId: string;
  topic: string;
  mistakePattern: string;
  corePrinciple: string;
  microDrill: string;
  transferHint: string;
};

type FrontierSnapshot = {
  date: string;
  name: string;
  sessionKey: string;
  sessionId: string;
  title: string;
  materialType: string;
  methodFamily: string;
  claimedContribution: string;
  evaluationProtocol: string;
  keyResults: string;
  leakage: string;
  overfitting: string;
  adoptableIdea: string;
  replicationCost: string;
  verdict: "archive_for_knowledge" | "watch_for_followup" | "worth_reproducing" | "ignore";
};

function extractMatch(content: string, pattern: RegExp, fallback: string): string {
  return content.match(pattern)?.[1]?.trim() || fallback;
}

function formatDateFromTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function sameSession(
  item: { sessionKey: string; sessionId: string },
  sessionKey: string,
  sessionId?: string,
): boolean {
  if (sessionId?.trim()) {
    return item.sessionId === sessionId;
  }
  return item.sessionKey === sessionKey;
}

function pushCurrentSessionSnapshot(params: {
  snapshots: SessionSnapshot[];
  sessionKey: string;
  sessionId?: string;
  dateStr: string;
  turns: SessionTurn[];
  source: string;
}) {
  if (
    params.turns.length === 0 ||
    params.snapshots.some((snapshot) => sameSession(snapshot, params.sessionKey, params.sessionId))
  ) {
    return;
  }

  const latestUser =
    params.turns.toReversed().find((turn) => turn.role === "user")?.text ||
    params.turns[0]?.text ||
    "Current session";
  params.snapshots.push({
    date: params.dateStr,
    name: "(current session)",
    sessionKey: params.sessionKey,
    sessionId: params.sessionId ?? "unknown",
    source: params.source,
    intake: compactText(latestUser, 160),
  });
}

function pushCurrentLearningSnapshot(params: {
  snapshots: LearningSnapshot[];
  sessionKey: string;
  sessionId?: string;
  dateStr: string;
  turns: SessionTurn[];
}) {
  if (
    !looksLikeLearningSession(params.turns) ||
    params.snapshots.some((snapshot) => sameSession(snapshot, params.sessionKey, params.sessionId))
  ) {
    return;
  }

  const summary = summarizeLearningSession(params.turns);
  params.snapshots.push({
    date: params.dateStr,
    name: "(current session)",
    sessionKey: params.sessionKey,
    sessionId: params.sessionId ?? "unknown",
    topic: summary.topic,
    mistakePattern: summary.hints.mistake,
    corePrinciple: summary.hints.principle,
    microDrill: summary.hints.drill,
    transferHint: summary.hints.transfer,
  });
}

function pushCurrentFrontierSnapshot(params: {
  snapshots: FrontierSnapshot[];
  sessionKey: string;
  sessionId?: string;
  dateStr: string;
  turns: SessionTurn[];
}) {
  if (
    !looksLikeFrontierResearchSession(params.turns) ||
    params.snapshots.some((snapshot) => sameSession(snapshot, params.sessionKey, params.sessionId))
  ) {
    return;
  }

  const summary = summarizeFrontierResearchSession(params.turns);
  params.snapshots.push({
    date: params.dateStr,
    name: "(current session)",
    sessionKey: params.sessionKey,
    sessionId: params.sessionId ?? "unknown",
    title: summary.title,
    materialType: summary.materialType,
    methodFamily: summary.hints.methodFamily,
    claimedContribution: summary.claimedContribution,
    evaluationProtocol: summary.evaluationProtocol,
    keyResults: summary.keyResults,
    leakage: summary.hints.leakageRisk,
    overfitting: summary.hints.overfittingRisk,
    adoptableIdea: summary.hints.adoptableIdea,
    replicationCost: summary.hints.replicationCost,
    verdict: summary.verdict,
  });
}

function parseSessionSnapshot(name: string, content: string): SessionSnapshot | undefined {
  const fileMatch = name.match(SESSION_FILE_RE);
  if (!fileMatch || !content.startsWith("# Session:")) {
    return undefined;
  }

  const intake =
    content.match(/^user:\s*(.+)$/m)?.[1]?.trim() ||
    content.match(/^assistant:\s*(.+)$/m)?.[1]?.trim() ||
    "Session note captured.";

  return {
    date: fileMatch[1],
    name,
    sessionKey: extractMatch(content, /- \*\*Session Key\*\*:\s*([^\n]+)/, "unknown"),
    sessionId: extractMatch(content, /- \*\*Session ID\*\*:\s*([^\n]+)/, "unknown"),
    source: extractMatch(content, /- \*\*Source\*\*:\s*([^\n]+)/, "unknown"),
    intake: compactText(intake, 160),
  };
}

function parseLearningSnapshot(name: string, content: string): LearningSnapshot | undefined {
  const fileMatch = name.match(LEARNING_FILE_RE);
  if (!fileMatch) {
    return undefined;
  }

  return {
    date: fileMatch[1],
    name,
    sessionKey: extractMatch(content, /- \*\*Session Key\*\*:\s*([^\n]+)/, "unknown"),
    sessionId: extractMatch(content, /- \*\*Session ID\*\*:\s*([^\n]+)/, "unknown"),
    topic: extractMatch(content, /- \*\*Topic\*\*:\s*([^\n]+)/, "math-reasoning"),
    mistakePattern: extractMatch(
      content,
      /^- mistake_pattern:\s*(.+)$/m,
      "No recurring mistake captured.",
    ),
    corePrinciple: extractMatch(
      content,
      /^- core_principle:\s*(.+)$/m,
      "No core principle captured.",
    ),
    microDrill: extractMatch(content, /^- micro_drill:\s*(.+)$/m, "No micro-drill captured."),
    transferHint: extractMatch(content, /^- transfer_hint:\s*(.+)$/m, "No transfer hint captured."),
  };
}

function parseFrontierSnapshot(name: string, content: string): FrontierSnapshot | undefined {
  const fileMatch = name.match(FRONTIER_FILE_RE);
  if (!fileMatch) {
    return undefined;
  }

  return {
    date: fileMatch[1],
    name,
    sessionKey: extractMatch(content, /- \*\*Session Key\*\*:\s*([^\n]+)/, "unknown"),
    sessionId: extractMatch(content, /- \*\*Session ID\*\*:\s*([^\n]+)/, "unknown"),
    title: extractMatch(content, /^- title:\s*(.+)$/m, "Untitled research card"),
    materialType: extractMatch(content, /^- material_type:\s*(.+)$/m, "paper"),
    methodFamily: extractMatch(content, /^- method_family:\s*(.+)$/m, "frontier-method"),
    claimedContribution: extractMatch(
      content,
      /^- claimed_contribution:\s*(.+)$/m,
      "No claimed contribution captured.",
    ),
    evaluationProtocol: extractMatch(
      content,
      /^- evaluation_protocol:\s*(.+)$/m,
      "No evaluation protocol captured.",
    ),
    keyResults: extractMatch(content, /^- key_results:\s*(.+)$/m, "No key results captured."),
    leakage: extractMatch(
      content,
      /^- possible_leakage_points:\s*(.+)$/m,
      "No leakage note captured.",
    ),
    overfitting: extractMatch(
      content,
      /^- overfitting_risks:\s*(.+)$/m,
      "No overfitting note captured.",
    ),
    adoptableIdea: extractMatch(
      content,
      /^- adoptable_ideas:\s*(.+)$/m,
      "No adoptable idea captured.",
    ),
    replicationCost: extractMatch(content, /^- replication_cost:\s*(.+)$/m, "medium"),
    verdict: extractMatch(
      content,
      /^- verdict:\s*(.+)$/m,
      "watch_for_followup",
    ) as FrontierSnapshot["verdict"],
  };
}

async function loadExistingSnapshots(memoryDir: string): Promise<{
  sessionSnapshots: SessionSnapshot[];
  learningSnapshots: LearningSnapshot[];
  frontierSnapshots: FrontierSnapshot[];
}> {
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    const sessionSnapshots: SessionSnapshot[] = [];
    const learningSnapshots: LearningSnapshot[] = [];
    const frontierSnapshots: FrontierSnapshot[] = [];

    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map(async (entry) => {
          const content = await fs.readFile(path.join(memoryDir, entry.name), "utf-8");
          const sessionSnapshot = parseSessionSnapshot(entry.name, content);
          if (sessionSnapshot) {
            sessionSnapshots.push(sessionSnapshot);
            return;
          }

          const learningSnapshot = parseLearningSnapshot(entry.name, content);
          if (learningSnapshot) {
            learningSnapshots.push(learningSnapshot);
            return;
          }

          const frontierSnapshot = parseFrontierSnapshot(entry.name, content);
          if (frontierSnapshot) {
            frontierSnapshots.push(frontierSnapshot);
          }
        }),
    );

    const byDateDesc = <T extends { date: string; name: string }>(items: T[]) =>
      items.toSorted((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));

    return {
      sessionSnapshots: byDateDesc(sessionSnapshots),
      learningSnapshots: byDateDesc(learningSnapshots),
      frontierSnapshots: byDateDesc(frontierSnapshots),
    };
  } catch {
    return {
      sessionSnapshots: [],
      learningSnapshots: [],
      frontierSnapshots: [],
    };
  }
}

function verdictRank(verdict: FrontierSnapshot["verdict"]): number {
  switch (verdict) {
    case "worth_reproducing":
      return 4;
    case "watch_for_followup":
      return 3;
    case "archive_for_knowledge":
      return 2;
    default:
      return 1;
  }
}

function pickTopDecision(cards: FrontierSnapshot[]): string {
  const candidate = cards
    .toSorted(
      (a, b) =>
        verdictRank(b.verdict) - verdictRank(a.verdict) ||
        b.date.localeCompare(a.date) ||
        a.title.localeCompare(b.title),
    )
    .at(0);

  if (!candidate) {
    return "no_frontier_input";
  }
  return `${candidate.verdict}: ${candidate.title}`;
}

function filterByWindow<T extends { date: string }>(items: T[], fromDate: Date, toDate: Date): T[] {
  return items.filter((item) => {
    const date = new Date(`${item.date}T00:00:00.000Z`);
    return date >= fromDate && date <= toDate;
  });
}

function renderDailyIntakeLog(params: {
  dateStr: string;
  sessionKey: string;
  sessionSnapshots: SessionSnapshot[];
}) {
  return [
    `# Intake Log: ${params.dateStr}`,
    "",
    `- **Session Key**: ${params.sessionKey}`,
    `- **Session Count**: ${params.sessionSnapshots.length}`,
    "",
    "## Inputs",
    ...(params.sessionSnapshots.length > 0
      ? params.sessionSnapshots.map(
          (snapshot) =>
            `- ${snapshot.source} | ${snapshot.sessionId} | ${snapshot.intake} (${snapshot.name})`,
        )
      : ["- No session intake captured yet."]),
    "",
  ].join("\n");
}

function renderDailyFetchLog(params: { dateStr: string; frontierSnapshots: FrontierSnapshot[] }) {
  return [
    `# Fetch Log: ${params.dateStr}`,
    "",
    `- **Frontier Card Count**: ${params.frontierSnapshots.length}`,
    "",
    "## Methods Pulled Into Review",
    ...(params.frontierSnapshots.length > 0
      ? params.frontierSnapshots.map(
          (snapshot) =>
            `- ${snapshot.title} | ${snapshot.materialType} | ${snapshot.methodFamily} | verdict=${snapshot.verdict}`,
        )
      : ["- No frontier method fetches captured today."]),
    "",
  ].join("\n");
}

function renderDailyReviewLog(params: {
  dateStr: string;
  learningSnapshots: LearningSnapshot[];
  frontierSnapshots: FrontierSnapshot[];
}) {
  return [
    `# Review Log: ${params.dateStr}`,
    "",
    `- **Learning Review Count**: ${params.learningSnapshots.length}`,
    `- **Frontier Verdict Count**: ${params.frontierSnapshots.length}`,
    "",
    "## Learning Reviews",
    ...(params.learningSnapshots.length > 0
      ? params.learningSnapshots.map(
          (snapshot) =>
            `- ${snapshot.topic} | mistake=${snapshot.mistakePattern} | principle=${snapshot.corePrinciple}`,
        )
      : ["- No learning review captured today."]),
    "",
    "## Frontier Verdicts",
    ...(params.frontierSnapshots.length > 0
      ? params.frontierSnapshots.map(
          (snapshot) =>
            `- ${snapshot.title} | verdict=${snapshot.verdict} | idea=${snapshot.adoptableIdea}`,
        )
      : ["- No frontier verdict captured today."]),
    "",
  ].join("\n");
}

function renderDailyBranchSummary(params: {
  dateStr: string;
  sessionSnapshots: SessionSnapshot[];
  learningSnapshots: LearningSnapshot[];
  frontierSnapshots: FrontierSnapshot[];
}) {
  const topTopic = countTop(
    params.learningSnapshots.map((snapshot) => snapshot.topic),
    1,
  )[0]?.value;
  const topPrinciple = countTop(
    params.learningSnapshots.map((snapshot) => snapshot.corePrinciple),
    1,
  )[0]?.value;
  const topMethod = countTop(
    params.frontierSnapshots.map((snapshot) => snapshot.methodFamily),
    1,
  )[0]?.value;
  return [
    `# Branch Summary: ${params.dateStr}`,
    "",
    `- **Sessions Observed**: ${params.sessionSnapshots.length}`,
    `- **Learning Reviews**: ${params.learningSnapshots.length}`,
    `- **Frontier Cards**: ${params.frontierSnapshots.length}`,
    "",
    "## Current Focus",
    `- learning_focus: ${topTopic ?? "none"}`,
    `- default_learning_principle: ${topPrinciple ?? "none"}`,
    `- frontier_focus: ${topMethod ?? "none"}`,
    `- top_decision: ${pickTopDecision(params.frontierSnapshots)}`,
    "",
    "## Source Chains",
    "- session-memory",
    "- learning-review",
    "- frontier-research",
    "",
  ].join("\n");
}

function renderRiskAuditSnapshot(params: {
  dateStr: string;
  frontierSnapshots: FrontierSnapshot[];
}) {
  const verdicts = countTop(
    params.frontierSnapshots.map((snapshot) => snapshot.verdict),
    4,
  );
  const leakage = countTop(
    params.frontierSnapshots.map((snapshot) => snapshot.leakage),
    3,
  );
  const overfitting = countTop(
    params.frontierSnapshots.map((snapshot) => snapshot.overfitting),
    3,
  );
  const candidates = params.frontierSnapshots.filter(
    (snapshot) => snapshot.verdict === "worth_reproducing",
  );
  return [
    `# Risk Audit Snapshot: ${params.dateStr}`,
    "",
    `- **Top Decision**: ${pickTopDecision(params.frontierSnapshots)}`,
    `- **Risk Scope**: methods-only`,
    `- **Frontier Input Count**: ${params.frontierSnapshots.length}`,
    "",
    "## Verdict Distribution",
    ...(verdicts.length > 0
      ? verdicts.map((entry) => `- ${entry.value} (${entry.count})`)
      : ["- No frontier input today."]),
    "",
    "## Leakage Checks",
    ...(leakage.length > 0
      ? leakage.map((entry) => `- ${entry.value} (${entry.count})`)
      : ["- No leakage checks captured yet."]),
    "",
    "## Overfitting Checks",
    ...(overfitting.length > 0
      ? overfitting.map((entry) => `- ${entry.value} (${entry.count})`)
      : ["- No overfitting checks captured yet."]),
    "",
    "## Replication Candidates",
    ...(candidates.length > 0
      ? candidates.map(
          (snapshot) =>
            `- ${snapshot.title} | evaluation=${snapshot.evaluationProtocol} | cost=${snapshot.replicationCost}`,
        )
      : ["- No method cleared the reproduction threshold today."]),
    "",
  ].join("\n");
}

function renderUnifiedRiskView(params: {
  dateStr: string;
  nowIso: string;
  frontierSnapshots: FrontierSnapshot[];
}) {
  return [
    "# Unified Risk View",
    "",
    `- top_decision: ${pickTopDecision(params.frontierSnapshots)}`,
    "- approved_assets: []",
    "- vetoed_assets: []",
    `- blackout_status: ${params.frontierSnapshots.length > 0 ? "method_only_no_asset_gate" : "no_frontier_input"}`,
    "- source_branch: frontier_research_branch",
    `- risk_audit_path: memory/${params.dateStr}-risk-audit-snapshot.md`,
    `- updated_at: ${params.nowIso}`,
    "",
    "## Notes",
    "- This view is derived from frontier method cards only.",
    "- Asset-level approvals or vetoes are intentionally left empty because this repo does not provide that runtime state yet.",
    "",
  ].join("\n");
}

function renderWeeklyLearningLoop(params: {
  sessionKey: string;
  weekKey: string;
  rangeLabel: string;
  sessionSnapshots: SessionSnapshot[];
  learningSnapshots: LearningSnapshot[];
  frontierSnapshots: FrontierSnapshot[];
}) {
  const principles = countTop(
    params.learningSnapshots.map((snapshot) => snapshot.corePrinciple),
    3,
  );
  const transfers = countTop(
    params.frontierSnapshots.map((snapshot) => snapshot.adoptableIdea),
    3,
  );
  const mistakes = countTop(
    params.learningSnapshots.map((snapshot) => snapshot.mistakePattern),
    3,
  );
  const leakage = countTop(
    params.frontierSnapshots.map((snapshot) => snapshot.leakage),
    3,
  );
  const overfitting = countTop(
    params.frontierSnapshots.map((snapshot) => snapshot.overfitting),
    3,
  );

  const gaps: string[] = [];
  if (params.learningSnapshots.length === 0) {
    gaps.push("- Learning coverage was empty this week.");
  }
  if (params.frontierSnapshots.length === 0) {
    gaps.push("- Frontier method coverage was empty this week.");
  }
  if (
    params.frontierSnapshots.length > 0 &&
    !params.frontierSnapshots.some((snapshot) => snapshot.verdict === "worth_reproducing")
  ) {
    gaps.push("- Evidence quality never cleared the reproduction threshold.");
  }
  gaps.push(
    "- Asset approval and veto state are still unavailable, so the risk gate remains methods-only.",
  );

  const improvements = [
    ...countTop(
      params.learningSnapshots.map((snapshot) => snapshot.microDrill),
      2,
    ).map((entry) => `- Run this drill next week: ${entry.value}`),
    ...countTop(
      params.frontierSnapshots.map((snapshot) => snapshot.adoptableIdea),
      2,
    ).map((entry) => `- Transfer this method pattern carefully: ${entry.value}`),
  ];

  return [
    `# Weekly Learning Loop: ${params.weekKey}`,
    "",
    `- **Window**: ${params.rangeLabel}`,
    `- **Session Key**: ${params.sessionKey}`,
    `- **Sessions Observed**: ${params.sessionSnapshots.length}`,
    `- **Learning Reviews**: ${params.learningSnapshots.length}`,
    `- **Frontier Cards**: ${params.frontierSnapshots.length}`,
    "",
    "## What Was Learned",
    ...(principles.length > 0
      ? principles.map((entry) => `- learning_principle: ${entry.value} (${entry.count})`)
      : ["- No repeated learning principle captured."]),
    ...(transfers.length > 0
      ? transfers.map((entry) => `- transferable_method: ${entry.value} (${entry.count})`)
      : ["- No frontier method transfer captured."]),
    "",
    "## What Failed",
    ...(mistakes.length > 0
      ? mistakes.map((entry) => `- learning_failure: ${entry.value} (${entry.count})`)
      : ["- No learning failure pattern captured."]),
    ...(leakage.length > 0
      ? leakage.map((entry) => `- leakage_risk: ${entry.value} (${entry.count})`)
      : ["- No leakage risk captured."]),
    ...(overfitting.length > 0
      ? overfitting.map((entry) => `- overfitting_risk: ${entry.value} (${entry.count})`)
      : ["- No overfitting risk captured."]),
    "",
    "## Coverage, Evidence, And Risk Gate Gaps",
    ...gaps,
    "",
    "## Improve Next Week",
    ...(improvements.length > 0 ? improvements : ["- No concrete follow-up was captured yet."]),
    "",
    "## Source Notes",
    ...params.sessionSnapshots.map((snapshot) => `- session: ${snapshot.date} ${snapshot.name}`),
    ...params.learningSnapshots.map((snapshot) => `- learning: ${snapshot.date} ${snapshot.name}`),
    ...params.frontierSnapshots.map((snapshot) => `- frontier: ${snapshot.date} ${snapshot.name}`),
    "",
  ].join("\n");
}

function buildNotes(params: {
  dateStr: string;
  nowIso: string;
  sessionKey: string;
  weekKey: string;
  rangeLabel: string;
  dailySessions: SessionSnapshot[];
  dailyLearning: LearningSnapshot[];
  dailyFrontier: FrontierSnapshot[];
  weeklySessions: SessionSnapshot[];
  weeklyLearning: LearningSnapshot[];
  weeklyFrontier: FrontierSnapshot[];
}): MemoryNote[] {
  return [
    {
      filename: `${params.dateStr}-intake-log.md`,
      content: renderDailyIntakeLog({
        dateStr: params.dateStr,
        sessionKey: params.sessionKey,
        sessionSnapshots: params.dailySessions,
      }),
    },
    {
      filename: `${params.dateStr}-fetch-log.md`,
      content: renderDailyFetchLog({
        dateStr: params.dateStr,
        frontierSnapshots: params.dailyFrontier,
      }),
    },
    {
      filename: `${params.dateStr}-review-log.md`,
      content: renderDailyReviewLog({
        dateStr: params.dateStr,
        learningSnapshots: params.dailyLearning,
        frontierSnapshots: params.dailyFrontier,
      }),
    },
    {
      filename: `${params.dateStr}-branch-summary.md`,
      content: renderDailyBranchSummary({
        dateStr: params.dateStr,
        sessionSnapshots: params.dailySessions,
        learningSnapshots: params.dailyLearning,
        frontierSnapshots: params.dailyFrontier,
      }),
    },
    {
      filename: `${params.dateStr}-risk-audit-snapshot.md`,
      content: renderRiskAuditSnapshot({
        dateStr: params.dateStr,
        frontierSnapshots: params.dailyFrontier,
      }),
    },
    {
      filename: `${params.weekKey}-weekly-learning-loop.md`,
      content: renderWeeklyLearningLoop({
        sessionKey: params.sessionKey,
        weekKey: params.weekKey,
        rangeLabel: params.rangeLabel,
        sessionSnapshots: params.weeklySessions,
        learningSnapshots: params.weeklyLearning,
        frontierSnapshots: params.weeklyFrontier,
      }),
    },
    {
      filename: "unified-risk-view.md",
      content: renderUnifiedRiskView({
        dateStr: params.dateStr,
        nowIso: params.nowIso,
        frontierSnapshots:
          params.dailyFrontier.length > 0 ? params.dailyFrontier : params.weeklyFrontier,
      }),
    },
  ];
}

const saveOperatingLoopArtifacts: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { memoryDir, sessionId, sessionFile } = await resolveMemorySessionContext({
      event,
      fallbackToLatestNonReset: true,
    });
    const now = new Date(event.timestamp);
    const dateStr = formatDateFromTimestamp(event.timestamp);
    const dayStart = toUtcDateOnly(now);
    const { weekKey, rangeLabel } = formatIsoWeek(now);
    const weekStart = new Date(dayStart);
    weekStart.setUTCDate(weekStart.getUTCDate() - 6);

    const currentTurns = sessionFile
      ? await loadSessionTurnsWithResetFallback(sessionFile, 20)
      : [];
    const { sessionSnapshots, learningSnapshots, frontierSnapshots } =
      await loadExistingSnapshots(memoryDir);
    const commandSource = event.context?.commandSource;
    const source = typeof commandSource === "string" ? commandSource : "unknown";

    pushCurrentSessionSnapshot({
      snapshots: sessionSnapshots,
      sessionKey: event.sessionKey,
      sessionId,
      dateStr,
      turns: currentTurns,
      source,
    });
    pushCurrentLearningSnapshot({
      snapshots: learningSnapshots,
      sessionKey: event.sessionKey,
      sessionId,
      dateStr,
      turns: currentTurns,
    });
    pushCurrentFrontierSnapshot({
      snapshots: frontierSnapshots,
      sessionKey: event.sessionKey,
      sessionId,
      dateStr,
      turns: currentTurns,
    });

    const dailySessions = filterByWindow(sessionSnapshots, dayStart, dayStart);
    const dailyLearning = filterByWindow(learningSnapshots, dayStart, dayStart);
    const dailyFrontier = filterByWindow(frontierSnapshots, dayStart, dayStart);
    const weeklySessions = filterByWindow(sessionSnapshots, weekStart, dayStart);
    const weeklyLearning = filterByWindow(learningSnapshots, weekStart, dayStart);
    const weeklyFrontier = filterByWindow(frontierSnapshots, weekStart, dayStart);

    if (
      dailySessions.length === 0 &&
      dailyLearning.length === 0 &&
      dailyFrontier.length === 0 &&
      weeklySessions.length === 0 &&
      weeklyLearning.length === 0 &&
      weeklyFrontier.length === 0
    ) {
      return;
    }

    await writeMemoryNotes(
      memoryDir,
      buildNotes({
        dateStr,
        nowIso: now.toISOString(),
        sessionKey: event.sessionKey,
        weekKey,
        rangeLabel,
        dailySessions,
        dailyLearning,
        dailyFrontier,
        weeklySessions,
        weeklyLearning,
        weeklyFrontier,
      }),
    );

    log.info(`Operating loop artifacts saved for ${dateStr}`);
  } catch (err) {
    log.error("Failed to save operating loop artifacts", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default saveOperatingLoopArtifacts;
