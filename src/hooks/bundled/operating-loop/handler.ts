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
import type { FundamentalCollectionFollowUpTrackerArtifact } from "../fundamental-collection-follow-up-tracker/handler.js";
import type { FundamentalManifestScaffold } from "../fundamental-intake/handler.js";
import type { FundamentalReviewMemoArtifact } from "../fundamental-review-memo/handler.js";
import {
  buildFundamentalRiskHandoff,
  type FundamentalRiskHandoffArtifact,
} from "../fundamental-risk-handoff/handler.js";
import type { FundamentalScoringGateArtifact } from "../fundamental-scoring-gate/handler.js";
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

type FundamentalRiskSnapshot = {
  date: string;
  name: string;
  artifactPath: string;
  handoff: FundamentalRiskHandoffArtifact;
};

type FundamentalReviewMemoSnapshot = {
  date: string;
  name: string;
  artifactPath: string;
  memo: FundamentalReviewMemoArtifact;
};

type FundamentalFollowUpTrackerSnapshot = {
  date: string;
  name: string;
  artifactPath: string;
  tracker: FundamentalCollectionFollowUpTrackerArtifact;
};

type WorkingMemoryDiscipline = {
  freshness: "fresh" | "warm" | "stale";
  anchor: string;
  anchorDate: string;
  drillDownOnlyBefore: string;
};

function extractMatch(content: string, pattern: RegExp, fallback: string): string {
  return content.match(pattern)?.[1]?.trim() || fallback;
}

function formatDateFromTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function daysBetweenDateOnly(laterDate: string, earlierDate: string): number {
  const later = Date.parse(`${laterDate}T00:00:00.000Z`);
  const earlier = Date.parse(`${earlierDate}T00:00:00.000Z`);
  if (Number.isNaN(later) || Number.isNaN(earlier)) {
    return 0;
  }
  return Math.max(0, Math.floor((later - earlier) / 86_400_000));
}

function shiftDateOnly(date: string, days: number): string {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) {
    return date;
  }
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

function deriveWorkingMemoryDiscipline(params: {
  nowIso: string;
  sessionSnapshots: SessionSnapshot[];
  reviewMemos: FundamentalReviewMemoSnapshot[];
  followUpTrackers: FundamentalFollowUpTrackerSnapshot[];
}): WorkingMemoryDiscipline {
  const currentDate = params.nowIso.slice(0, 10);
  const trackerDate = params.followUpTrackers[0]?.tracker.generatedAt.slice(0, 10);
  if (trackerDate) {
    const ageDays = daysBetweenDateOnly(currentDate, trackerDate);
    return {
      freshness: ageDays <= 3 ? "fresh" : ageDays <= 10 ? "warm" : "stale",
      anchor: "fundamental-collection-follow-up-tracker",
      anchorDate: trackerDate,
      drillDownOnlyBefore: shiftDateOnly(trackerDate, -14),
    };
  }

  const memoDate = params.reviewMemos[0]?.memo.generatedAt.slice(0, 10);
  if (memoDate) {
    const ageDays = daysBetweenDateOnly(currentDate, memoDate);
    return {
      freshness: ageDays <= 3 ? "fresh" : ageDays <= 10 ? "warm" : "stale",
      anchor: "fundamental-review-memo",
      anchorDate: memoDate,
      drillDownOnlyBefore: shiftDateOnly(memoDate, -14),
    };
  }

  const sessionDate = params.sessionSnapshots[0]?.date ?? currentDate;
  const ageDays = daysBetweenDateOnly(currentDate, sessionDate);
  return {
    freshness: ageDays <= 1 ? "fresh" : ageDays <= 7 ? "warm" : "stale",
    anchor: "session-memory",
    anchorDate: sessionDate,
    drillDownOnlyBefore: shiftDateOnly(sessionDate, -14),
  };
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

async function loadJsonArtifacts<T>(params: {
  dirPath: string;
  relativePrefix: string;
}): Promise<Array<{ name: string; relativePath: string; data: T }>> {
  try {
    const fileNames = (await fs.readdir(params.dirPath))
      .filter((name) => name.endsWith(".json"))
      .toSorted();
    return await Promise.all(
      fileNames.map(async (name) => {
        const relativePath = `${params.relativePrefix}/${name}`;
        const raw = await fs.readFile(path.join(params.dirPath, name), "utf-8");
        return {
          name,
          relativePath,
          data: JSON.parse(raw) as T,
        };
      }),
    );
  } catch {
    return [];
  }
}

async function loadFundamentalRiskSnapshots(
  workspaceDir: string,
): Promise<FundamentalRiskSnapshot[]> {
  const [manifests, scoringGates, persistedHandoffs] = await Promise.all([
    loadJsonArtifacts<FundamentalManifestScaffold>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "manifests"),
      relativePrefix: "bank/fundamental/manifests",
    }),
    loadJsonArtifacts<FundamentalScoringGateArtifact>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "scoring-gates"),
      relativePrefix: "bank/fundamental/scoring-gates",
    }),
    loadJsonArtifacts<FundamentalRiskHandoffArtifact>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "risk-handoffs"),
      relativePrefix: "bank/fundamental/risk-handoffs",
    }),
  ]);

  const manifestById = new Map(manifests.map(({ data }) => [data.manifestId, data]));
  const persistedById = new Map(
    persistedHandoffs.map(({ data, name, relativePath }) => [
      data.manifestId,
      {
        date: data.generatedAt.slice(0, 10),
        name,
        artifactPath: relativePath,
        handoff: data,
      } satisfies FundamentalRiskSnapshot,
    ]),
  );

  const snapshots = new Map<string, FundamentalRiskSnapshot>();
  for (const [manifestId, snapshot] of persistedById) {
    snapshots.set(manifestId, snapshot);
  }

  for (const { data: scoringGate, relativePath, name } of scoringGates) {
    const manifest = manifestById.get(scoringGate.manifestId);
    if (!manifest) {
      continue;
    }

    const persisted = persistedById.get(scoringGate.manifestId);
    if (persisted && persisted.handoff.generatedAt >= scoringGate.generatedAt) {
      snapshots.set(scoringGate.manifestId, persisted);
      continue;
    }

    const synthesized = buildFundamentalRiskHandoff({
      nowIso: scoringGate.generatedAt,
      scoringGatePath: relativePath,
      manifestRiskHandoffStatus: manifest.riskHandoff.status,
      scoringGate,
    });
    snapshots.set(scoringGate.manifestId, {
      date: synthesized.generatedAt.slice(0, 10),
      name,
      artifactPath: `bank/fundamental/risk-handoffs/${scoringGate.manifestId}.json`,
      handoff: synthesized,
    });
  }

  return [...snapshots.values()].toSorted(
    (a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name),
  );
}

async function loadFundamentalReviewMemoSnapshots(
  workspaceDir: string,
): Promise<FundamentalReviewMemoSnapshot[]> {
  const memos = await loadJsonArtifacts<FundamentalReviewMemoArtifact>({
    dirPath: path.join(workspaceDir, "bank", "fundamental", "review-memos"),
    relativePrefix: "bank/fundamental/review-memos",
  });
  return memos
    .map(({ data, name, relativePath }) => ({
      date: data.generatedAt.slice(0, 10),
      name,
      artifactPath: relativePath,
      memo: data,
    }))
    .toSorted(
      (a, b) =>
        b.memo.generatedAt.localeCompare(a.memo.generatedAt) || a.name.localeCompare(b.name),
    );
}

async function loadFundamentalFollowUpTrackerSnapshots(
  workspaceDir: string,
): Promise<FundamentalFollowUpTrackerSnapshot[]> {
  const trackers = await loadJsonArtifacts<FundamentalCollectionFollowUpTrackerArtifact>({
    dirPath: path.join(workspaceDir, "bank", "fundamental", "collection-follow-up-trackers"),
    relativePrefix: "bank/fundamental/collection-follow-up-trackers",
  });
  return trackers
    .map(({ data, name, relativePath }) => ({
      date: data.generatedAt.slice(0, 10),
      name,
      artifactPath: relativePath,
      tracker: data,
    }))
    .toSorted(
      (a, b) =>
        b.tracker.generatedAt.localeCompare(a.tracker.generatedAt) || a.name.localeCompare(b.name),
    );
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

function riskHandoffRank(decision: FundamentalRiskHandoffArtifact["handoffDecision"]): number {
  switch (decision) {
    case "ready":
      return 5;
    case "partial":
      return 3;
    default:
      return 1;
  }
}

function pickTopFrontierDecision(cards: FrontierSnapshot[]) {
  const candidate = cards
    .toSorted(
      (a, b) =>
        verdictRank(b.verdict) - verdictRank(a.verdict) ||
        b.date.localeCompare(a.date) ||
        a.title.localeCompare(b.title),
    )
    .at(0);

  if (!candidate) {
    return undefined;
  }

  return {
    label: `${candidate.verdict}: ${candidate.title}`,
    rank: verdictRank(candidate.verdict),
  };
}

function pickTopDecision(cards: FrontierSnapshot[]): string {
  const candidate = pickTopFrontierDecision(cards);
  if (!candidate) {
    return "no_frontier_input";
  }
  return candidate.label;
}

function pickTopFundamentalDecision(handoffs: FundamentalRiskSnapshot[]) {
  const candidate = handoffs
    .flatMap((snapshot) =>
      snapshot.handoff.targetDecisions.map((target) => ({
        label:
          target.handoffDecision === "ready"
            ? `ready_for_risk_review: ${target.targetLabel}`
            : target.handoffDecision === "partial"
              ? `partial_risk_review: ${target.targetLabel}`
              : `blocked_for_risk_review: ${target.targetLabel}`,
        rank: riskHandoffRank(target.handoffDecision),
        date: snapshot.date,
        targetLabel: target.targetLabel,
      })),
    )
    .toSorted(
      (a, b) =>
        b.rank - a.rank ||
        b.date.localeCompare(a.date) ||
        a.targetLabel.localeCompare(b.targetLabel),
    )
    .at(0);

  return candidate;
}

function pickTopUnifiedDecision(params: {
  frontierSnapshots: FrontierSnapshot[];
  fundamentalHandoffs: FundamentalRiskSnapshot[];
}): string {
  const frontier = pickTopFrontierDecision(params.frontierSnapshots);
  const fundamental = pickTopFundamentalDecision(params.fundamentalHandoffs);
  if (fundamental && (!frontier || fundamental.rank > frontier.rank)) {
    return fundamental.label;
  }
  if (frontier) {
    return frontier.label;
  }
  if (fundamental) {
    return fundamental.label;
  }
  return "no_risk_input";
}

function summarizeFundamentalHandoffs(handoffs: FundamentalRiskSnapshot[]) {
  return handoffs.reduce(
    (summary, snapshot) => {
      if (snapshot.handoff.handoffDecision === "ready") {
        summary.readyArtifacts += 1;
      } else if (snapshot.handoff.handoffDecision === "partial") {
        summary.partialArtifacts += 1;
      } else {
        summary.blockedArtifacts += 1;
      }
      summary.readyTargets += snapshot.handoff.handoffSummary.readyTargets;
      summary.partialTargets += snapshot.handoff.handoffSummary.partialTargets;
      summary.blockedTargets += snapshot.handoff.handoffSummary.blockedTargets;
      return summary;
    },
    {
      totalArtifacts: handoffs.length,
      readyArtifacts: 0,
      partialArtifacts: 0,
      blockedArtifacts: 0,
      readyTargets: 0,
      partialTargets: 0,
      blockedTargets: 0,
    },
  );
}

function deriveRiskScope(params: {
  frontierSnapshots: FrontierSnapshot[];
  fundamentalHandoffs: FundamentalRiskSnapshot[];
}): string {
  if (params.frontierSnapshots.length > 0 && params.fundamentalHandoffs.length > 0) {
    return "methods+fundamental-handoff";
  }
  if (params.fundamentalHandoffs.length > 0) {
    return "fundamental-handoff-only";
  }
  return "methods-only";
}

function deriveUnifiedBlackoutStatus(params: {
  frontierSnapshots: FrontierSnapshot[];
  fundamentalHandoffs: FundamentalRiskSnapshot[];
}): string {
  if (params.frontierSnapshots.length > 0 && params.fundamentalHandoffs.length > 0) {
    return "mixed_research_no_asset_gate";
  }
  if (params.fundamentalHandoffs.length > 0) {
    return "fundamental_handoff_no_asset_gate";
  }
  if (params.frontierSnapshots.length > 0) {
    return "method_only_no_asset_gate";
  }
  return "no_frontier_input";
}

function deriveUnifiedSourceBranch(params: {
  frontierSnapshots: FrontierSnapshot[];
  fundamentalHandoffs: FundamentalRiskSnapshot[];
}): string {
  if (params.frontierSnapshots.length > 0 && params.fundamentalHandoffs.length > 0) {
    return "frontier_research_branch+fundamental_research_branch";
  }
  if (params.fundamentalHandoffs.length > 0) {
    return "fundamental_research_branch";
  }
  if (params.frontierSnapshots.length > 0) {
    return "frontier_research_branch";
  }
  return "none";
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
  fundamentalHandoffs: FundamentalRiskSnapshot[];
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
  const handoffSummary = summarizeFundamentalHandoffs(params.fundamentalHandoffs);
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
    `- fundamental_handoff: ready=${handoffSummary.readyTargets} partial=${handoffSummary.partialTargets} blocked=${handoffSummary.blockedTargets}`,
    "",
    "## Source Chains",
    "- session-memory",
    "- learning-review",
    "- frontier-research",
    ...(params.fundamentalHandoffs.length > 0 ? ["- fundamental-risk-handoff"] : []),
    "",
  ].join("\n");
}

function renderCurrentResearchLine(params: {
  nowIso: string;
  sessionSnapshots: SessionSnapshot[];
  learningSnapshots: LearningSnapshot[];
  frontierSnapshots: FrontierSnapshot[];
  fundamentalHandoffs: FundamentalRiskSnapshot[];
  reviewMemos: FundamentalReviewMemoSnapshot[];
  followUpTrackers: FundamentalFollowUpTrackerSnapshot[];
}) {
  const latestSession = params.sessionSnapshots[0];
  const latestLearning = params.learningSnapshots[0];
  const latestFrontier = params.frontierSnapshots[0];
  const latestMemo = params.reviewMemos[0];
  const latestTracker = params.followUpTrackers[0];
  const topUnifiedDecision = pickTopUnifiedDecision({
    frontierSnapshots: params.frontierSnapshots,
    fundamentalHandoffs: params.fundamentalHandoffs,
  });
  const workingMemory = deriveWorkingMemoryDiscipline({
    nowIso: params.nowIso,
    sessionSnapshots: params.sessionSnapshots,
    reviewMemos: params.reviewMemos,
    followUpTrackers: params.followUpTrackers,
  });

  let currentFocus = "session_only";
  let nextStep = latestSession?.intake ?? "No active research line captured yet.";
  if (latestTracker) {
    currentFocus =
      latestTracker.tracker.trackerStatus === "follow_up_active"
        ? "fundamental_follow_up"
        : latestTracker.tracker.trackerStatus === "manual_review_required"
          ? "fundamental_manual_review"
          : "fundamental_blocked";
    nextStep =
      latestTracker.tracker.nextCollectionPriorities[0] ??
      latestTracker.tracker.notes[0] ??
      nextStep;
  } else if (latestMemo) {
    currentFocus =
      latestMemo.memo.memoStatus === "ready_for_report_review"
        ? "fundamental_report_review"
        : latestMemo.memo.memoStatus === "follow_up_collection_needed"
          ? "fundamental_follow_up"
          : "fundamental_blocked";
    nextStep = latestMemo.memo.nextActions[0] ?? latestMemo.memo.notes[0] ?? nextStep;
  } else if (latestFrontier) {
    currentFocus = "frontier_method_review";
    nextStep = `${latestFrontier.verdict}: ${latestFrontier.title}`;
  } else if (latestLearning) {
    currentFocus = "learning_review";
    nextStep = latestLearning.microDrill;
  }

  return [
    "# Current Research Line",
    "",
    `- updated_at: ${params.nowIso}`,
    `- current_focus: ${currentFocus}`,
    `- top_decision: ${topUnifiedDecision}`,
    `- unified_risk_view_path: memory/unified-risk-view.md`,
    "",
    "## Current Session",
    ...(latestSession
      ? [
          `- source: ${latestSession.source}`,
          `- session_id: ${latestSession.sessionId}`,
          `- intake: ${latestSession.intake}`,
        ]
      : ["- none"]),
    "",
    "## Fundamental State",
    ...(latestMemo
      ? [
          `- review_memo_status: ${latestMemo.memo.memoStatus}`,
          `- review_memo_path: ${latestMemo.artifactPath}`,
          `- review_focus: ${latestMemo.memo.reviewFocus[0] ?? "none"}`,
        ]
      : ["- review_memo_status: none"]),
    ...(latestTracker
      ? [
          `- follow_up_tracker_status: ${latestTracker.tracker.trackerStatus}`,
          `- follow_up_tracker_path: ${latestTracker.artifactPath}`,
          `- top_follow_up: ${latestTracker.tracker.nextCollectionPriorities[0] ?? "none"}`,
        ]
      : ["- follow_up_tracker_status: none"]),
    "",
    "## Learning And Method Context",
    `- learning_focus: ${latestLearning?.topic ?? "none"}`,
    `- learning_principle: ${latestLearning?.corePrinciple ?? "none"}`,
    `- frontier_focus: ${latestFrontier?.title ?? "none"}`,
    `- frontier_verdict: ${latestFrontier?.verdict ?? "none"}`,
    "",
    "## Next Step",
    `- ${nextStep}`,
    "",
    "## Working Memory Discipline",
    `- freshness: ${workingMemory.freshness}`,
    `- primary_anchor: ${workingMemory.anchor}`,
    `- anchor_date: ${workingMemory.anchorDate}`,
    `- drill_down_only_before: ${workingMemory.drillDownOnlyBefore}`,
    "- recall_order: current-research-line -> primary_anchor -> unified-risk-view/review-memo -> older drill-down artifacts",
    "",
    "## Guardrails",
    "- Research-first operating memory only; this is not an execution approval surface.",
    "- Fundamental notes build screening and conviction, but hard risk gates still remain mandatory.",
    "",
  ].join("\n");
}

function renderRiskAuditSnapshot(params: {
  dateStr: string;
  frontierSnapshots: FrontierSnapshot[];
  fundamentalHandoffs: FundamentalRiskSnapshot[];
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
  const handoffSummary = summarizeFundamentalHandoffs(params.fundamentalHandoffs);
  const missingInputs = countTop(
    params.fundamentalHandoffs.flatMap((snapshot) =>
      snapshot.handoff.targetDecisions.flatMap((target) => target.missingCriticalInputs),
    ),
    5,
  );
  return [
    `# Risk Audit Snapshot: ${params.dateStr}`,
    "",
    `- **Top Decision**: ${pickTopUnifiedDecision(params)}`,
    `- **Risk Scope**: ${deriveRiskScope(params)}`,
    `- **Frontier Input Count**: ${params.frontierSnapshots.length}`,
    `- **Fundamental Handoff Count**: ${params.fundamentalHandoffs.length}`,
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
    "## Fundamental Handoff Decisions",
    ...(params.fundamentalHandoffs.length > 0
      ? params.fundamentalHandoffs.map(
          (snapshot) =>
            `- ${snapshot.handoff.requestTitle} | decision=${snapshot.handoff.handoffDecision} | ready=${snapshot.handoff.handoffSummary.readyTargets}/${snapshot.handoff.handoffSummary.totalTargets}`,
        )
      : ["- No fundamental handoff state captured yet."]),
    "",
    "## Fundamental Blocking Inputs",
    ...(missingInputs.length > 0
      ? missingInputs.map((entry) => `- ${entry.value} (${entry.count})`)
      : ["- No fundamental blockers captured yet."]),
    "",
    `- **Fundamental Ready Targets**: ${handoffSummary.readyTargets}`,
    `- **Fundamental Partial Targets**: ${handoffSummary.partialTargets}`,
    `- **Fundamental Blocked Targets**: ${handoffSummary.blockedTargets}`,
    "",
  ].join("\n");
}

function renderUnifiedRiskView(params: {
  dateStr: string;
  nowIso: string;
  frontierSnapshots: FrontierSnapshot[];
  fundamentalHandoffs: FundamentalRiskSnapshot[];
}) {
  const handoffSummary = summarizeFundamentalHandoffs(params.fundamentalHandoffs);
  return [
    "# Unified Risk View",
    "",
    `- top_decision: ${pickTopUnifiedDecision(params)}`,
    "- approved_assets: []",
    "- vetoed_assets: []",
    `- blackout_status: ${deriveUnifiedBlackoutStatus(params)}`,
    `- source_branch: ${deriveUnifiedSourceBranch(params)}`,
    `- risk_audit_path: memory/${params.dateStr}-risk-audit-snapshot.md`,
    `- updated_at: ${params.nowIso}`,
    "",
    "## Fundamental Handoffs",
    ...(params.fundamentalHandoffs.length > 0
      ? [
          `- artifacts: ${handoffSummary.totalArtifacts}`,
          `- ready_targets: ${handoffSummary.readyTargets}`,
          `- partial_targets: ${handoffSummary.partialTargets}`,
          `- blocked_targets: ${handoffSummary.blockedTargets}`,
        ]
      : ["- none"]),
    "",
    "## Notes",
    ...(params.fundamentalHandoffs.length > 0
      ? [
          "- This view combines frontier method signals with fundamental risk-handoff summaries.",
          "- Fundamental handoff targets are not asset approvals; they only indicate readiness for later controlled risk review.",
        ]
      : ["- This view is derived from frontier method cards only."]),
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
  fundamentalHandoffs: FundamentalRiskSnapshot[];
  reviewMemos: FundamentalReviewMemoSnapshot[];
  followUpTrackers: FundamentalFollowUpTrackerSnapshot[];
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
        fundamentalHandoffs: params.fundamentalHandoffs,
      }),
    },
    {
      filename: "current-research-line.md",
      content: renderCurrentResearchLine({
        nowIso: params.nowIso,
        sessionSnapshots:
          params.dailySessions.length > 0 ? params.dailySessions : params.weeklySessions,
        learningSnapshots:
          params.dailyLearning.length > 0 ? params.dailyLearning : params.weeklyLearning,
        frontierSnapshots:
          params.dailyFrontier.length > 0 ? params.dailyFrontier : params.weeklyFrontier,
        fundamentalHandoffs: params.fundamentalHandoffs,
        reviewMemos: params.reviewMemos,
        followUpTrackers: params.followUpTrackers,
      }),
    },
    {
      filename: `${params.dateStr}-risk-audit-snapshot.md`,
      content: renderRiskAuditSnapshot({
        dateStr: params.dateStr,
        frontierSnapshots: params.dailyFrontier,
        fundamentalHandoffs: params.fundamentalHandoffs,
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
        fundamentalHandoffs: params.fundamentalHandoffs,
      }),
    },
  ];
}

const saveOperatingLoopArtifacts: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir, sessionId, sessionFile } = await resolveMemorySessionContext({
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
    const [fundamentalHandoffs, reviewMemos, followUpTrackers] = await Promise.all([
      loadFundamentalRiskSnapshots(workspaceDir),
      loadFundamentalReviewMemoSnapshots(workspaceDir),
      loadFundamentalFollowUpTrackerSnapshots(workspaceDir),
    ]);
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
      fundamentalHandoffs.length === 0 &&
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
        fundamentalHandoffs,
        reviewMemos,
        followUpTrackers,
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
