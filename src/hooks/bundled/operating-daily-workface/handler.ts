import fs from "node:fs/promises";
import path from "node:path";
import { listAgentIds } from "../../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  discoverAllSessions,
  loadCostUsageSummary,
  loadSessionCostSummary,
} from "../../../infra/session-cost-usage.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import {
  buildFeishuFinanceDoctrinePromotionCandidatesFilename,
  buildFeishuFinanceDoctrinePromotionReviewFilename,
  buildLobsterWorkfaceFilename,
  buildKnowledgeArtifactDir,
  extractIsoDateKey,
  isFeishuFinanceDoctrineCalibrationFilename,
  isFeishuFinanceDoctrinePromotionCandidatesFilename,
  isFeishuFinanceDoctrinePromotionReviewFilename,
  isFeishuWorkReceiptFilename,
  isLearningCouncilAdoptionLedgerFilename,
  parseFeishuFinanceDoctrineCalibrationArtifact,
  parseFeishuFinanceDoctrinePromotionCandidateArtifact,
  parseFeishuFinanceDoctrinePromotionReviewArtifact,
  parseFeishuSurfaceLanePanelArtifact,
  parseFeishuWorkReceiptArtifact,
  parseLearningCouncilAdoptionLedger,
  isLearningCouncilMemoryNoteFilename,
  isLearningReviewNoteFilename,
  isCorrectionNoteFilename,
  isKnowledgeValidationWeeklyArtifactFilename,
  isOperatingWeeklyArtifactFilename,
  parseKnowledgeValidationWeeklyArtifact,
  parseCodexEscalationArtifact,
  parseCorrectionNoteArtifact,
  parseCorrectionNoteFilename,
  parseLearningCouncilMemoryNote,
  parseLearningCouncilMemoryNoteFilename,
  parseLearningReviewMemoryNote,
  parseLearningReviewNoteFilename,
  parseLearningCouncilRuntimeArtifact,
  parsePortfolioAnswerScorecardArtifact,
  parseWatchtowerAnomalyRecord,
  renderFeishuFinanceDoctrinePromotionCandidateArtifact,
  renderFeishuFinanceDoctrinePromotionReviewArtifact,
  renderLearningCouncilAdoptionLedger,
  renderLobsterWorkfaceArtifact,
  buildWatchtowerArtifactDir,
} from "../lobster-brain-registry.js";
import { parseUtcDateKey, shiftUtcDays, toUtcDateKey, writeMemoryNotes } from "../weekly-memory.js";

const log = createSubsystemLogger("hooks/operating-daily-workface");
type LearningReview = {
  name: string;
  topic: string;
  principle: string;
  foundationTemplate: string;
};

type LearningCouncilArtifact = {
  name: string;
  generatedAt: string;
  status: string;
  userMessage: string;
  keeperLines: string[];
  discardLines: string[];
  lobsterImprovementLines: string[];
  rehearsalTriggerLines: string[];
  nextEvalCueLines: string[];
  adoptionLedgerSummary?: {
    adoptedNowCount: number;
    candidateForReuseCount: number;
    reusedLaterCount: number;
    downrankedOrFailedCount: number;
  };
};

type PortfolioScorecardSummary = {
  filename: string;
  averageScore: string;
  weakestDimension: string;
};

type KnowledgeValidationWeeklySummary = {
  filename: string;
  strongestDomain: string;
  weakestDomain: string;
  hallucinationDomain: string;
};

type CorrectionNote = {
  name: string;
  issueKey: string;
  foundationTemplate: string;
  whatWasWrong: string;
};

type OperationalAnomaly = {
  name: string;
  category: string;
  severity: string;
  source: string;
  problem: string;
  foundationTemplate: string;
};

type CodexEscalationPacket = {
  name: string;
  category: string;
  severity: string;
  source: string;
  problem: string;
  foundationTemplate: string;
};

type ModelUsageRow = {
  provider: string;
  model: string;
  tokens: number;
  cost: number;
};

type OperatingWeekView = {
  learningItems: number;
  correctionNotes: number;
  watchtowerSignals: number;
  codexEscalations: number;
  averageTokensPerDay: number;
  busiestTokenDay: string;
};

type FeishuSurfaceLanePanel = {
  activeLanes: number;
  laneMeter: string[];
};

type FeishuWorkReceipt = {
  name: string;
  handledAt: string;
  requestedAction: string;
  scope: string;
  timeframe: string;
  outputShape: string;
  repairDisposition: string;
  userMessage: string;
  finalReplySummary: string;
  financeDoctrineProof?: {
    consumer: string;
    doctrineFieldsUsed: string[];
  };
};

type FinanceDoctrineCalibration = {
  name: string;
  reviewDate: string;
  consumer: string;
  linkedReceipt: string;
  observedOutcome: string;
  scenarioClosestToOutcome: "base_case" | "bear_case" | "unclear";
  baseCaseDirectionallyCloser: "yes" | "no" | "unclear";
  changeMyMindTriggered: "yes" | "no" | "unclear";
  convictionLooksTooHighOrLow: "too_high" | "too_low" | "about_right" | "unclear";
};

type FinanceDoctrineCalibrationSummary = {
  totalCount: number;
  closestScenarioCounts: Record<"base_case" | "bear_case" | "unclear", number>;
  baseCaseDirectionallyCloserCounts: Record<"yes" | "no" | "unclear", number>;
  changeMyMindCounts: Record<"yes" | "no" | "unclear", number>;
  convictionCounts: Record<"too_high" | "too_low" | "about_right" | "unclear", number>;
};

type FinanceDoctrineCalibrationRollingSummary = FinanceDoctrineCalibrationSummary & {
  windowDays: number;
  windowStartDate: string;
  windowEndDate: string;
};

type FinanceDoctrinePromotionCandidate = {
  candidateKey: string;
  signal:
    | "closest_scenario"
    | "base_case_directionally_closer"
    | "change_my_mind_triggered"
    | "conviction_looks";
  observedValue: string;
  occurrences: number;
  reviewState: "unreviewed" | "deferred" | "rejected" | "ready_for_manual_promotion";
  reviewNotes?: string;
  candidateText: string;
  notEnoughForPromotion: string;
};

type FinanceDoctrinePromotionCandidateArtifactView = {
  generatedAt: string;
  consumer: string;
  windowDays: number;
  windowStartDate: string;
  windowEndDate: string;
  totalCalibrationNotes: number;
  candidates: FinanceDoctrinePromotionCandidate[];
};

type FinanceDoctrinePromotionReview = {
  reviewedAt: string;
  consumer: string;
  linkedCandidateArtifact: string;
  reviews: Array<{
    candidateKey: string;
    reviewState: FinanceDoctrinePromotionCandidate["reviewState"];
    reviewNotes?: string;
  }>;
};

function sanitizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function extractReplySectionBullets(content: string, heading: string, limit = 2): string[] {
  const lines = content.split(/\r?\n/u);
  const normalizedHeading = heading.trim().toLowerCase();
  let insideSection = false;
  const bullets: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^#{1,6}\s+(.+)$/u);
    if (sectionMatch) {
      const sectionHeading = sectionMatch[1].trim().toLowerCase();
      if (insideSection && sectionHeading !== normalizedHeading) {
        break;
      }
      insideSection = sectionHeading === normalizedHeading;
      continue;
    }
    if (!insideSection) {
      continue;
    }
    const bulletMatch = line.match(/^[-*]\s+(.+)$/u);
    if (!bulletMatch) {
      continue;
    }
    bullets.push(sanitizeInline(bulletMatch[1]));
    if (bullets.length >= limit) {
      break;
    }
  }

  return bullets;
}

function parseScorecardAverage(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/^([0-9]+(?:\.[0-9]+)?)/);
  const parsed = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function renderBar(value: number, max: number, width = 16): string {
  if (value <= 0 || max <= 0) {
    return "░".repeat(Math.max(4, Math.floor(width / 2)));
  }
  const filled = Math.max(1, Math.round((value / max) * width));
  return `${"█".repeat(Math.min(width, filled))}${"░".repeat(Math.max(0, width - filled))}`;
}

function renderGauge(params: {
  label: string;
  value: number;
  max: number;
  suffix: string;
  width?: number;
}): string {
  return `- ${params.label}: ${renderBar(params.value, params.max, params.width ?? 10)} ${params.suffix}`;
}

function summarizeFinanceDoctrineCalibrations(
  entries: FinanceDoctrineCalibration[],
): FinanceDoctrineCalibrationSummary {
  const summary: FinanceDoctrineCalibrationSummary = {
    totalCount: entries.length,
    closestScenarioCounts: {
      base_case: 0,
      bear_case: 0,
      unclear: 0,
    },
    baseCaseDirectionallyCloserCounts: {
      yes: 0,
      no: 0,
      unclear: 0,
    },
    changeMyMindCounts: {
      yes: 0,
      no: 0,
      unclear: 0,
    },
    convictionCounts: {
      too_high: 0,
      too_low: 0,
      about_right: 0,
      unclear: 0,
    },
  };
  for (const entry of entries) {
    summary.closestScenarioCounts[entry.scenarioClosestToOutcome] += 1;
    summary.baseCaseDirectionallyCloserCounts[entry.baseCaseDirectionallyCloser] += 1;
    summary.changeMyMindCounts[entry.changeMyMindTriggered] += 1;
    summary.convictionCounts[entry.convictionLooksTooHighOrLow] += 1;
  }
  return summary;
}

function buildFinanceDoctrinePromotionCandidates(
  summary: FinanceDoctrineCalibrationRollingSummary | undefined,
): FinanceDoctrinePromotionCandidate[] {
  if (!summary) {
    return [];
  }
  const candidates: FinanceDoctrinePromotionCandidate[] = [];
  const notEnoughForPromotion =
    "repeated explicit calibration pattern only; no scoring, no second consumer, and no asset-specific follow-through yet";
  const pushCandidate = (
    signal: FinanceDoctrinePromotionCandidate["signal"],
    observedValue: string,
    occurrences: number,
  ) => {
    if (occurrences < 2 || observedValue === "unclear") {
      return;
    }
    candidates.push({
      candidateKey: `${signal}:${observedValue}`,
      signal,
      observedValue,
      occurrences,
      reviewState: "unreviewed",
      candidateText: `${signal} repeated ${observedValue} in ${occurrences}/${summary.totalCount} recent calibration notes`,
      notEnoughForPromotion,
    });
  };
  pushCandidate("closest_scenario", "base_case", summary.closestScenarioCounts.base_case);
  pushCandidate("closest_scenario", "bear_case", summary.closestScenarioCounts.bear_case);
  pushCandidate(
    "base_case_directionally_closer",
    "yes",
    summary.baseCaseDirectionallyCloserCounts.yes,
  );
  pushCandidate(
    "base_case_directionally_closer",
    "no",
    summary.baseCaseDirectionallyCloserCounts.no,
  );
  pushCandidate("change_my_mind_triggered", "yes", summary.changeMyMindCounts.yes);
  pushCandidate("change_my_mind_triggered", "no", summary.changeMyMindCounts.no);
  pushCandidate("conviction_looks", "too_high", summary.convictionCounts.too_high);
  pushCandidate("conviction_looks", "too_low", summary.convictionCounts.too_low);
  pushCandidate("conviction_looks", "about_right", summary.convictionCounts.about_right);
  return candidates;
}

async function loadExistingFinanceDoctrinePromotionCandidates(params: {
  memoryDir: string;
  targetDateKey: string;
}): Promise<FinanceDoctrinePromotionCandidateArtifactView | undefined> {
  const receiptsDir = path.join(params.memoryDir, "feishu-work-receipts");
  try {
    const entries = await fs.readdir(receiptsDir, { withFileTypes: true });
    const matching = entries.find(
      (entry) =>
        entry.isFile() &&
        isFeishuFinanceDoctrinePromotionCandidatesFilename(entry.name) &&
        entry.name.startsWith(`${params.targetDateKey}-`),
    );
    if (!matching) {
      return undefined;
    }
    const parsed = parseFeishuFinanceDoctrinePromotionCandidateArtifact(
      await fs.readFile(path.join(receiptsDir, matching.name), "utf-8"),
    );
    if (!parsed) {
      return undefined;
    }
    return {
      generatedAt: parsed.generatedAt,
      consumer: parsed.consumer,
      windowDays: parsed.windowDays,
      windowStartDate: parsed.windowStartDate,
      windowEndDate: parsed.windowEndDate,
      totalCalibrationNotes: parsed.totalCalibrationNotes,
      candidates: parsed.candidates.map((candidate) => ({
        candidateKey: candidate.candidateKey,
        signal: candidate.signal,
        observedValue: candidate.observedValue,
        occurrences: candidate.occurrences,
        reviewState: candidate.reviewState,
        reviewNotes: candidate.reviewNotes,
        candidateText: candidate.candidateText,
        notEnoughForPromotion: candidate.notEnoughForPromotion,
      })),
    };
  } catch {
    return undefined;
  }
}

async function loadExistingFinanceDoctrinePromotionReview(params: {
  memoryDir: string;
  targetDateKey: string;
}): Promise<FinanceDoctrinePromotionReview | undefined> {
  const receiptsDir = path.join(params.memoryDir, "feishu-work-receipts");
  try {
    const entries = await fs.readdir(receiptsDir, { withFileTypes: true });
    const matching = entries.find(
      (entry) =>
        entry.isFile() &&
        isFeishuFinanceDoctrinePromotionReviewFilename(entry.name) &&
        entry.name.startsWith(`${params.targetDateKey}-`),
    );
    if (!matching) {
      return undefined;
    }
    const parsed = parseFeishuFinanceDoctrinePromotionReviewArtifact(
      await fs.readFile(path.join(receiptsDir, matching.name), "utf-8"),
    );
    if (!parsed) {
      return undefined;
    }
    return {
      reviewedAt: parsed.reviewedAt,
      consumer: parsed.consumer,
      linkedCandidateArtifact: parsed.linkedCandidateArtifact,
      reviews: parsed.reviews.map((review) => ({
        candidateKey: review.candidateKey,
        reviewState: review.reviewState,
        reviewNotes: review.reviewNotes,
      })),
    };
  } catch {
    return undefined;
  }
}

function mergeFinanceDoctrinePromotionCandidates(params: {
  current: FinanceDoctrinePromotionCandidate[];
  previousReview?: FinanceDoctrinePromotionReview;
  previous?: FinanceDoctrinePromotionCandidateArtifactView;
}): FinanceDoctrinePromotionCandidate[] {
  const reviewByKey = new Map(
    params.previousReview?.reviews.map((review) => [review.candidateKey, review]) ?? [],
  );
  const previousByKey = new Map(
    params.previous?.candidates.map((candidate) => [candidate.candidateKey, candidate]) ?? [],
  );
  return params.current.map((candidate) => {
    const reviewed = reviewByKey.get(candidate.candidateKey);
    if (reviewed) {
      return {
        ...candidate,
        reviewState: reviewed.reviewState,
        reviewNotes: reviewed.reviewNotes,
      };
    }
    const previous = previousByKey.get(candidate.candidateKey);
    if (!previous) {
      return candidate;
    }
    return {
      ...candidate,
      reviewState: previous.reviewState,
      reviewNotes: previous.reviewNotes,
    };
  });
}

async function loadYesterdayLearningReviews(params: {
  memoryDir: string;
  targetDateKey: string;
}): Promise<LearningReview[]> {
  try {
    const entries = await fs.readdir(params.memoryDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isLearningReviewNoteFilename(entry.name))
        .map(async (entry): Promise<LearningReview | undefined> => {
          const content = await fs.readFile(path.join(params.memoryDir, entry.name), "utf-8");
          const parsedNote = parseLearningReviewMemoryNote({ filename: entry.name, content });
          if (!parsedNote || parsedNote.date !== params.targetDateKey) {
            return undefined;
          }
          return {
            name: parsedNote.name,
            topic: parsedNote.topic,
            principle: parsedNote.corePrinciple,
            foundationTemplate: parsedNote.foundationTemplate,
          } satisfies LearningReview;
        }),
    );
    return parsed.filter((entry): entry is LearningReview => Boolean(entry));
  } catch {
    return [];
  }
}

async function loadYesterdayLearningCouncilArtifacts(params: {
  workspaceDir: string;
  memoryDir: string;
  targetDateKey: string;
}): Promise<LearningCouncilArtifact[]> {
  const adoptionLedgers = await loadYesterdayLearningCouncilAdoptionLedgers({
    memoryDir: params.memoryDir,
    targetDateKey: params.targetDateKey,
  });
  if (adoptionLedgers.length > 0) {
    return adoptionLedgers;
  }
  const artifactDir = path.join(params.workspaceDir, buildKnowledgeArtifactDir("learningCouncils"));
  try {
    const entries = await fs.readdir(artifactDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry): Promise<LearningCouncilArtifact | undefined> => {
          const content = parseLearningCouncilRuntimeArtifact(
            await fs.readFile(path.join(artifactDir, entry.name), "utf-8"),
          );
          if (!content || content.generatedDateKey !== params.targetDateKey) {
            return undefined;
          }
          return {
            name: entry.name,
            generatedAt: content.generatedAt,
            status: content.status ?? "unknown",
            userMessage: sanitizeInline(content.userMessage ?? "unknown topic"),
            keeperLines:
              content.runPacket?.keepLines.length && content.runPacket.keepLines.length > 0
                ? content.runPacket.keepLines.slice(0, 2)
                : extractReplySectionBullets(content.finalReply, "Keep"),
            discardLines:
              content.runPacket?.discardLines.length && content.runPacket.discardLines.length > 0
                ? content.runPacket.discardLines.slice(0, 2)
                : extractReplySectionBullets(content.finalReply, "Discard or downrank"),
            lobsterImprovementLines:
              content.runPacket?.lobsterImprovementLines.length &&
              content.runPacket.lobsterImprovementLines.length > 0
                ? content.runPacket.lobsterImprovementLines.slice(0, 2)
                : extractReplySectionBullets(content.finalReply, "Lobster improvement feedback"),
            rehearsalTriggerLines:
              content.runPacket?.replayTriggerLines.length &&
              content.runPacket.replayTriggerLines.length > 0
                ? content.runPacket.replayTriggerLines.slice(0, 2)
                : extractReplySectionBullets(content.finalReply, "Rehearsal triggers"),
            nextEvalCueLines:
              content.runPacket?.nextEvalCueLines.length &&
              content.runPacket.nextEvalCueLines.length > 0
                ? content.runPacket.nextEvalCueLines.slice(0, 2)
                : extractReplySectionBullets(content.finalReply, "Next eval cue"),
          } satisfies LearningCouncilArtifact;
        }),
    );
    return parsed
      .filter((entry): entry is LearningCouncilArtifact => Boolean(entry))
      .toSorted((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  } catch {
    return loadYesterdayLearningCouncilMemoryNotes({
      memoryDir: params.memoryDir,
      targetDateKey: params.targetDateKey,
    });
  }
}

async function loadYesterdayLearningCouncilAdoptionLedgers(params: {
  memoryDir: string;
  targetDateKey: string;
}): Promise<LearningCouncilArtifact[]> {
  try {
    const entries = await fs.readdir(params.memoryDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isLearningCouncilAdoptionLedgerFilename(entry.name))
        .map(async (entry): Promise<LearningCouncilArtifact | undefined> => {
          const content = await fs.readFile(path.join(params.memoryDir, entry.name), "utf-8");
          const parsedLedger = parseLearningCouncilAdoptionLedger({
            filename: entry.name,
            content,
          });
          if (!parsedLedger || parsedLedger.date !== params.targetDateKey) {
            return undefined;
          }
          const activeEntries = parsedLedger.entries.filter(
            (item) => item.adoptedState !== "ignored" && !item.downrankedOrFailed,
          );
          const linesForCue = (
            cueType: "keep" | "discard" | "lobster_improvement" | "replay_trigger" | "next_eval",
          ) =>
            activeEntries
              .filter((item) => item.cueType === cueType)
              .map((item) => sanitizeInline(item.text))
              .filter(Boolean)
              .slice(0, 2);
          return {
            name: entry.name,
            generatedAt: parsedLedger.generatedAt,
            status: parsedLedger.status,
            userMessage: sanitizeInline(parsedLedger.userMessage) || "unknown topic",
            keeperLines: linesForCue("keep"),
            discardLines: linesForCue("discard"),
            lobsterImprovementLines: linesForCue("lobster_improvement"),
            rehearsalTriggerLines: linesForCue("replay_trigger"),
            nextEvalCueLines: linesForCue("next_eval"),
            adoptionLedgerSummary: {
              adoptedNowCount: parsedLedger.entries.filter(
                (item) => item.adoptedState === "adopted_now",
              ).length,
              candidateForReuseCount: parsedLedger.entries.filter(
                (item) => item.adoptedState === "candidate_for_reuse",
              ).length,
              reusedLaterCount: parsedLedger.entries.filter((item) => item.reusedLater).length,
              downrankedOrFailedCount: parsedLedger.entries.filter(
                (item) => item.downrankedOrFailed,
              ).length,
            },
          } satisfies LearningCouncilArtifact;
        }),
    );
    return parsed
      .filter((entry): entry is LearningCouncilArtifact => Boolean(entry))
      .toSorted((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  } catch {
    return [];
  }
}

function buildReusedLaterCueMap(entries: LearningCouncilArtifact[]): Map<string, Set<string>> {
  const cueMap = new Map<string, Set<string>>();
  const add = (cueType: string, line?: string) => {
    const normalized = sanitizeInline(line ?? "");
    if (!normalized) {
      return;
    }
    const existing = cueMap.get(cueType);
    if (existing) {
      existing.add(normalized);
      return;
    }
    cueMap.set(cueType, new Set([normalized]));
  };
  for (const entry of entries) {
    add("keep", entry.keeperLines[0]);
    add("discard", entry.discardLines[0]);
    add("lobster_improvement", entry.lobsterImprovementLines[0]);
    add("replay_trigger", entry.rehearsalTriggerLines[0]);
    add("next_eval", entry.nextEvalCueLines[0]);
  }
  return cueMap;
}

async function markReusedLearningCouncilAdoptionLedgerEntries(params: {
  memoryDir: string;
  targetDateKey: string;
  learningCouncilArtifacts: LearningCouncilArtifact[];
}): Promise<void> {
  if (params.learningCouncilArtifacts.length === 0) {
    return;
  }
  const reusedCueMap = buildReusedLaterCueMap(params.learningCouncilArtifacts);
  if (reusedCueMap.size === 0) {
    return;
  }
  const entries = await fs.readdir(params.memoryDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !isLearningCouncilAdoptionLedgerFilename(entry.name)) {
      continue;
    }
    const filePath = path.join(params.memoryDir, entry.name);
    const content = await fs.readFile(filePath, "utf-8");
    const parsedLedger = parseLearningCouncilAdoptionLedger({
      filename: entry.name,
      content,
    });
    if (!parsedLedger || parsedLedger.date !== params.targetDateKey) {
      continue;
    }
    let changed = false;
    const nextEntries = parsedLedger.entries.map((ledgerEntry) => {
      if (ledgerEntry.reusedLater || ledgerEntry.downrankedOrFailed) {
        return ledgerEntry;
      }
      const reusableTexts = reusedCueMap.get(ledgerEntry.cueType);
      if (!reusableTexts || !reusableTexts.has(sanitizeInline(ledgerEntry.text))) {
        return ledgerEntry;
      }
      changed = true;
      return {
        ...ledgerEntry,
        reusedLater: true,
      };
    });
    if (!changed) {
      continue;
    }
    await writeMemoryNotes(params.memoryDir, [
      {
        filename: entry.name,
        content: renderLearningCouncilAdoptionLedger({
          stem: parsedLedger.noteSlug,
          generatedAt: parsedLedger.generatedAt,
          status: parsedLedger.status,
          userMessage: parsedLedger.userMessage,
          sourceArtifact: parsedLedger.sourceArtifact,
          entries: nextEntries,
        }),
      },
    ]);
  }
}

async function loadYesterdayLearningCouncilMemoryNotes(params: {
  memoryDir: string;
  targetDateKey: string;
}): Promise<LearningCouncilArtifact[]> {
  try {
    const entries = await fs.readdir(params.memoryDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isLearningCouncilMemoryNoteFilename(entry.name))
        .map(async (entry): Promise<LearningCouncilArtifact | undefined> => {
          const content = await fs.readFile(path.join(params.memoryDir, entry.name), "utf-8");
          const parsedNote = parseLearningCouncilMemoryNote({ filename: entry.name, content });
          if (!parsedNote || parsedNote.date !== params.targetDateKey) {
            return undefined;
          }
          return {
            name: entry.name,
            generatedAt: parsedNote.generatedAt,
            status: parsedNote.status,
            userMessage: sanitizeInline(parsedNote.userMessage) || "unknown topic",
            keeperLines: parsedNote.keeperLines.slice(0, 2),
            discardLines: parsedNote.discardLines.slice(0, 2),
            lobsterImprovementLines: parsedNote.lobsterImprovementLines.slice(0, 2),
            rehearsalTriggerLines: parsedNote.rehearsalTriggerLines.slice(0, 2),
            nextEvalCueLines: parsedNote.nextEvalCueLines.slice(0, 2),
          } satisfies LearningCouncilArtifact;
        }),
    );
    return parsed
      .filter((entry): entry is LearningCouncilArtifact => Boolean(entry))
      .toSorted((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  } catch {
    return [];
  }
}

async function loadYesterdayCorrectionNotes(params: {
  memoryDir: string;
  targetDateKey: string;
}): Promise<CorrectionNote[]> {
  try {
    const entries = await fs.readdir(params.memoryDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isCorrectionNoteFilename(entry.name))
        .map(async (entry): Promise<CorrectionNote | undefined> => {
          const parsedName = parseCorrectionNoteFilename(entry.name);
          if (!parsedName || parsedName.dateStr !== params.targetDateKey) {
            return undefined;
          }
          const content = await fs.readFile(path.join(params.memoryDir, entry.name), "utf-8");
          const parsedNote = parseCorrectionNoteArtifact(content);
          return {
            name: entry.name,
            issueKey: parsedNote?.issueKey ?? "unknown",
            foundationTemplate: parsedNote?.foundationTemplate ?? "general",
            whatWasWrong: parsedNote?.whatWasWrong ?? "No correction summary captured.",
          } satisfies CorrectionNote;
        }),
    );
    return parsed.filter((entry): entry is CorrectionNote => Boolean(entry));
  } catch {
    return [];
  }
}

async function loadYesterdayFeishuWorkReceipts(params: {
  memoryDir: string;
  targetDateKey: string;
}): Promise<FeishuWorkReceipt[]> {
  const receiptsDir = path.join(params.memoryDir, "feishu-work-receipts");
  try {
    const entries = await fs.readdir(receiptsDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isFeishuWorkReceiptFilename(entry.name))
        .map(async (entry): Promise<FeishuWorkReceipt | undefined> => {
          const content = await fs.readFile(path.join(receiptsDir, entry.name), "utf-8");
          const parsedReceipt = parseFeishuWorkReceiptArtifact(content);
          if (
            !parsedReceipt ||
            extractIsoDateKey(parsedReceipt.handledAt) !== params.targetDateKey
          ) {
            return undefined;
          }
          return {
            name: entry.name,
            handledAt: parsedReceipt.handledAt,
            requestedAction: parsedReceipt.requestedAction,
            scope: parsedReceipt.scope,
            timeframe: parsedReceipt.timeframe,
            outputShape: parsedReceipt.outputShape,
            repairDisposition: parsedReceipt.repairDisposition,
            userMessage: sanitizeInline(parsedReceipt.userMessage),
            finalReplySummary: sanitizeInline(parsedReceipt.finalReplySummary),
            financeDoctrineProof: parsedReceipt.financeDoctrineProof
              ? {
                  consumer: parsedReceipt.financeDoctrineProof.consumer,
                  doctrineFieldsUsed: parsedReceipt.financeDoctrineProof.doctrineFieldsUsed,
                }
              : undefined,
          } satisfies FeishuWorkReceipt;
        }),
    );
    return parsed
      .filter((entry): entry is FeishuWorkReceipt => Boolean(entry))
      .toSorted((a, b) => a.handledAt.localeCompare(b.handledAt));
  } catch {
    return [];
  }
}

async function loadYesterdayFinanceDoctrineCalibrations(params: {
  memoryDir: string;
  targetDateKey: string;
}): Promise<FinanceDoctrineCalibration[]> {
  const receiptsDir = path.join(params.memoryDir, "feishu-work-receipts");
  try {
    const entries = await fs.readdir(receiptsDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isFeishuFinanceDoctrineCalibrationFilename(entry.name))
        .map(async (entry) => {
          const content = await fs.readFile(path.join(receiptsDir, entry.name), "utf-8");
          const parsedCalibration = parseFeishuFinanceDoctrineCalibrationArtifact(content);
          if (
            !parsedCalibration ||
            extractIsoDateKey(parsedCalibration.reviewDate) !== params.targetDateKey
          ) {
            return undefined;
          }
          return {
            name: entry.name,
            reviewDate: parsedCalibration.reviewDate,
            consumer: parsedCalibration.consumer,
            linkedReceipt: parsedCalibration.linkedReceipt,
            observedOutcome: sanitizeInline(parsedCalibration.observedOutcome),
            scenarioClosestToOutcome: parsedCalibration.scenarioClosestToOutcome,
            baseCaseDirectionallyCloser: parsedCalibration.baseCaseDirectionallyCloser,
            changeMyMindTriggered: parsedCalibration.changeMyMindTriggered,
            convictionLooksTooHighOrLow: parsedCalibration.convictionLooksTooHighOrLow,
          } satisfies FinanceDoctrineCalibration;
        }),
    );
    return parsed
      .filter((entry): entry is FinanceDoctrineCalibration => Boolean(entry))
      .toSorted((a, b) => a.reviewDate.localeCompare(b.reviewDate));
  } catch {
    return [];
  }
}

async function loadRecentFinanceDoctrineCalibrationSummary(params: {
  memoryDir: string;
  targetDateKey: string;
  windowDays: number;
}): Promise<FinanceDoctrineCalibrationRollingSummary | undefined> {
  const receiptsDir = path.join(params.memoryDir, "feishu-work-receipts");
  const targetDate = parseUtcDateKey(params.targetDateKey);
  if (!targetDate) {
    return undefined;
  }
  const allowedDateKeys = new Set<string>();
  for (let offset = 0; offset < params.windowDays; offset += 1) {
    allowedDateKeys.add(toUtcDateKey(shiftUtcDays(targetDate, -offset)));
  }
  try {
    const entries = await fs.readdir(receiptsDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isFeishuFinanceDoctrineCalibrationFilename(entry.name))
        .map(async (entry) => {
          const content = await fs.readFile(path.join(receiptsDir, entry.name), "utf-8");
          const parsedCalibration = parseFeishuFinanceDoctrineCalibrationArtifact(content);
          if (
            !parsedCalibration ||
            !allowedDateKeys.has(extractIsoDateKey(parsedCalibration.reviewDate))
          ) {
            return undefined;
          }
          return {
            name: entry.name,
            reviewDate: parsedCalibration.reviewDate,
            consumer: parsedCalibration.consumer,
            linkedReceipt: parsedCalibration.linkedReceipt,
            observedOutcome: sanitizeInline(parsedCalibration.observedOutcome),
            scenarioClosestToOutcome: parsedCalibration.scenarioClosestToOutcome,
            baseCaseDirectionallyCloser: parsedCalibration.baseCaseDirectionallyCloser,
            changeMyMindTriggered: parsedCalibration.changeMyMindTriggered,
            convictionLooksTooHighOrLow: parsedCalibration.convictionLooksTooHighOrLow,
          } satisfies FinanceDoctrineCalibration;
        }),
    );
    const calibrations = parsed.filter((entry): entry is FinanceDoctrineCalibration =>
      Boolean(entry),
    );
    if (calibrations.length === 0) {
      return undefined;
    }
    return {
      ...summarizeFinanceDoctrineCalibrations(calibrations),
      windowDays: params.windowDays,
      windowStartDate: toUtcDateKey(shiftUtcDays(targetDate, -(params.windowDays - 1))),
      windowEndDate: params.targetDateKey,
    };
  } catch {
    return undefined;
  }
}

async function ensureFeishuWorkReceiptArtifacts(memoryDir: string): Promise<void> {
  const receiptsDir = path.join(memoryDir, "feishu-work-receipts");
  await fs.mkdir(receiptsDir, { recursive: true });

  const indexPath = path.join(receiptsDir, "index.md");
  const repairQueuePath = path.join(receiptsDir, "repair-queue.md");
  const emptyIndex = [
    "# Feishu Work Receipt Index",
    "",
    "- **Tracked Receipts**: 0",
    "",
    "## Recent Receipts",
    "- No Feishu work receipts are recorded yet.",
    "",
  ].join("\n");
  const emptyRepairQueue = [
    "# Feishu Work Repair Queue",
    "",
    "- **Active Repair Clusters**: 0",
    "",
    "## Next Priority Self-Repair",
    "- No repair-minded work receipts are queued right now.",
    "",
    "## Active Repair Queue",
    "- No repair-minded work receipts are queued right now.",
    "",
  ].join("\n");

  await fs.access(indexPath).catch(async () => {
    await fs.writeFile(indexPath, emptyIndex, "utf-8");
  });
  await fs.access(repairQueuePath).catch(async () => {
    await fs.writeFile(repairQueuePath, emptyRepairQueue, "utf-8");
  });
}

async function loadYesterdayOperationalAnomalies(params: {
  workspaceDir: string;
  targetDateKey: string;
}): Promise<OperationalAnomaly[]> {
  const anomaliesDir = path.join(params.workspaceDir, buildWatchtowerArtifactDir("anomalies"));
  try {
    const entries = await fs.readdir(anomaliesDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const content = parseWatchtowerAnomalyRecord(
            await fs.readFile(path.join(anomaliesDir, entry.name), "utf-8"),
          );
          if (!content || content.lastSeenDateKey !== params.targetDateKey) {
            return undefined;
          }
          return {
            name: entry.name,
            category: content.category,
            severity: content.severity,
            source: content.source,
            problem: content.problem,
            foundationTemplate: content.foundationTemplate,
          } satisfies OperationalAnomaly;
        }),
    );
    return parsed.filter((entry): entry is OperationalAnomaly => Boolean(entry));
  } catch {
    return [];
  }
}

async function loadYesterdayCodexEscalations(params: {
  workspaceDir: string;
  targetDateKey: string;
}): Promise<CodexEscalationPacket[]> {
  const packetDir = path.join(params.workspaceDir, buildWatchtowerArtifactDir("codexEscalations"));
  try {
    const entries = await fs.readdir(packetDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map(async (entry) => {
          const content = parseCodexEscalationArtifact(
            await fs.readFile(path.join(packetDir, entry.name), "utf-8"),
          );
          if (!content || content.generatedDateKey !== params.targetDateKey) {
            return undefined;
          }
          return {
            name: entry.name,
            category: content.category,
            severity: content.severity,
            source: content.source,
            problem: content.problem,
            foundationTemplate: content.foundationTemplate,
          } satisfies CodexEscalationPacket;
        }),
    );
    return parsed.filter((entry): entry is CodexEscalationPacket => Boolean(entry));
  } catch {
    return [];
  }
}

async function loadLatestPortfolioScorecard(
  memoryDir: string,
): Promise<PortfolioScorecardSummary | undefined> {
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    const latest = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          isOperatingWeeklyArtifactFilename(entry.name, "portfolio-answer-scorecard"),
      )
      .map((entry) => entry.name)
      .toSorted()
      .at(-1);
    if (!latest) {
      return undefined;
    }
    const content = await fs.readFile(path.join(memoryDir, latest), "utf-8");
    const parsed = parsePortfolioAnswerScorecardArtifact(content);
    if (!parsed) {
      return undefined;
    }
    return {
      filename: latest,
      averageScore: parsed.averageScore,
      weakestDimension: parsed.improveTarget,
    };
  } catch {
    return undefined;
  }
}

async function loadLatestKnowledgeValidationWeekly(
  memoryDir: string,
): Promise<KnowledgeValidationWeeklySummary | undefined> {
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    const latest = entries
      .filter((entry) => entry.isFile() && isKnowledgeValidationWeeklyArtifactFilename(entry.name))
      .map((entry) => entry.name)
      .toSorted()
      .at(-1);
    if (!latest) {
      return undefined;
    }
    const content = await fs.readFile(path.join(memoryDir, latest), "utf-8");
    const parsed = parseKnowledgeValidationWeeklyArtifact(content);
    if (!parsed) {
      return undefined;
    }
    return {
      filename: latest,
      strongestDomain: parsed.strongestDomain,
      weakestDomain: parsed.weakestDomain,
      hallucinationDomain: parsed.hallucinationDomain,
    };
  } catch {
    return undefined;
  }
}

async function loadYesterdayTokenStats(params: {
  cfg?: OpenClawConfig;
  targetDateKey: string;
}): Promise<{
  totalTokens: number;
  totalCost: number;
  byModel: ModelUsageRow[];
  sevenDayDaily: Array<{ date: string; tokens: number }>;
}> {
  const cfg = params.cfg ?? ({} as OpenClawConfig);
  const targetDate = parseUtcDateKey(params.targetDateKey);
  const startMs = targetDate.getTime();
  const endMs = shiftUtcDays(targetDate, 1).getTime() - 1;
  const sevenDayStartMs = shiftUtcDays(targetDate, -6).getTime();
  const agentIds = listAgentIds(cfg);

  const dailyMap = new Map<string, number>();
  const modelMap = new Map<string, ModelUsageRow>();
  let totalTokens = 0;
  let totalCost = 0;

  for (const agentId of agentIds) {
    const usageSummary = await loadCostUsageSummary({
      startMs: sevenDayStartMs,
      endMs,
      config: cfg,
      agentId,
    });
    for (const daily of usageSummary.daily) {
      dailyMap.set(daily.date, (dailyMap.get(daily.date) ?? 0) + daily.totalTokens);
      if (daily.date === params.targetDateKey) {
        totalTokens += daily.totalTokens;
        totalCost += daily.totalCost;
      }
    }

    const sessions = await discoverAllSessions({ agentId, startMs, endMs });
    for (const session of sessions) {
      const summary = await loadSessionCostSummary({
        sessionFile: session.sessionFile,
        config: cfg,
        agentId,
        startMs,
        endMs,
      });
      for (const row of summary?.dailyModelUsage ?? []) {
        if (row.date !== params.targetDateKey) {
          continue;
        }
        const provider = row.provider ?? "unknown";
        const model = row.model ?? "unknown";
        const key = `${provider}::${model}`;
        const existing = modelMap.get(key) ?? { provider, model, tokens: 0, cost: 0 };
        existing.tokens += row.tokens;
        existing.cost += row.cost;
        modelMap.set(key, existing);
      }
    }
  }

  const sevenDayDaily = Array.from({ length: 7 }, (_, index) => {
    const date = toUtcDateKey(shiftUtcDays(targetDate, -(6 - index)));
    return { date, tokens: dailyMap.get(date) ?? 0 };
  });

  return {
    totalTokens,
    totalCost,
    byModel: Array.from(modelMap.values()).toSorted((a, b) => b.tokens - a.tokens),
    sevenDayDaily,
  };
}

async function loadOperatingWeekView(params: {
  memoryDir: string;
  workspaceDir: string;
  tokenStats: {
    sevenDayDaily: Array<{ date: string; tokens: number }>;
  };
}): Promise<OperatingWeekView> {
  const endDateKey = params.tokenStats.sevenDayDaily.at(-1)?.date ?? toUtcDateKey(new Date());
  const endDate = parseUtcDateKey(endDateKey);
  const allowedDates = new Set(
    Array.from({ length: 7 }, (_, index) => toUtcDateKey(shiftUtcDays(endDate, -index))),
  );

  const memoryEntries = await fs.readdir(params.memoryDir, { withFileTypes: true }).catch(() => []);
  const learningItems = memoryEntries.filter((entry) => {
    if (!entry.isFile()) {
      return false;
    }
    const reviewMatch = parseLearningReviewNoteFilename(entry.name);
    const councilMatch = parseLearningCouncilMemoryNoteFilename(entry.name);
    return Boolean(
      (reviewMatch && allowedDates.has(reviewMatch.dateStr)) ||
      (councilMatch && allowedDates.has(councilMatch.dateStr)),
    );
  }).length;
  const correctionNotes = memoryEntries.filter((entry) => {
    if (!entry.isFile()) {
      return false;
    }
    const parsed = parseCorrectionNoteFilename(entry.name);
    return Boolean(parsed && allowedDates.has(parsed.dateStr));
  }).length;

  const anomaliesDir = path.join(params.workspaceDir, buildWatchtowerArtifactDir("anomalies"));
  const anomalyEntries = await fs.readdir(anomaliesDir, { withFileTypes: true }).catch(() => []);
  const packetDir = path.join(params.workspaceDir, buildWatchtowerArtifactDir("codexEscalations"));
  const packetEntries = await fs.readdir(packetDir, { withFileTypes: true }).catch(() => []);
  let watchtowerSignals = 0;
  let codexEscalations = 0;
  for (const entry of anomalyEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      const content = parseWatchtowerAnomalyRecord(
        await fs.readFile(path.join(anomaliesDir, entry.name), "utf-8"),
      );
      if (content?.lastSeenDateKey && allowedDates.has(content.lastSeenDateKey)) {
        watchtowerSignals += 1;
      }
    } catch {}
  }
  for (const entry of packetEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    try {
      const content = parseCodexEscalationArtifact(
        await fs.readFile(path.join(packetDir, entry.name), "utf-8"),
      );
      if (content?.generatedDateKey && allowedDates.has(content.generatedDateKey)) {
        codexEscalations += 1;
      }
    } catch {}
  }

  const total7dTokens = params.tokenStats.sevenDayDaily.reduce(
    (sum, entry) => sum + entry.tokens,
    0,
  );
  const busiest = params.tokenStats.sevenDayDaily.toSorted((a, b) => b.tokens - a.tokens)[0];

  return {
    learningItems,
    correctionNotes,
    watchtowerSignals,
    codexEscalations,
    averageTokensPerDay: total7dTokens / 7,
    busiestTokenDay: busiest ? `${busiest.date} (${formatNumber(busiest.tokens)})` : "n/a",
  };
}

async function loadFeishuSurfaceLanePanel(
  memoryDir: string,
): Promise<FeishuSurfaceLanePanel | undefined> {
  const panelPath = path.join(memoryDir, "feishu-surface-lines", "index.md");
  try {
    const content = await fs.readFile(panelPath, "utf-8");
    const parsed = parseFeishuSurfaceLanePanelArtifact(content);
    if (!parsed) {
      return undefined;
    }
    return {
      activeLanes: parsed.activeLanes ?? parsed.laneMeterLines.length,
      laneMeter: parsed.laneMeterLines,
    };
  } catch {
    return undefined;
  }
}

function renderWorkface(params: {
  targetDateKey: string;
  sessionKey: string;
  learningReviews: LearningReview[];
  learningCouncilArtifacts: LearningCouncilArtifact[];
  workReceipts: FeishuWorkReceipt[];
  financeDoctrineCalibrations: FinanceDoctrineCalibration[];
  recentFinanceDoctrineCalibrationSummary?: FinanceDoctrineCalibrationRollingSummary;
  financeDoctrinePromotionCandidates: FinanceDoctrinePromotionCandidate[];
  correctionNotes: CorrectionNote[];
  anomalies: OperationalAnomaly[];
  codexEscalations: CodexEscalationPacket[];
  scorecard?: PortfolioScorecardSummary;
  validationWeekly?: KnowledgeValidationWeeklySummary;
  operatingWeekView: OperatingWeekView;
  surfaceLanePanel?: FeishuSurfaceLanePanel;
  tokenStats: {
    totalTokens: number;
    totalCost: number;
    byModel: ModelUsageRow[];
    sevenDayDaily: Array<{ date: string; tokens: number }>;
  };
}): string {
  const maxDailyTokens = Math.max(
    ...params.tokenStats.sevenDayDaily.map((entry) => entry.tokens),
    1,
  );
  const learningCount = params.learningReviews.length + params.learningCouncilArtifacts.length;
  const scorecardAverage = parseScorecardAverage(params.scorecard?.averageScore);
  const repairReceipts = params.workReceipts.filter((entry) => entry.repairDisposition !== "none");
  const financeDoctrineCalibrationSummary = summarizeFinanceDoctrineCalibrations(
    params.financeDoctrineCalibrations,
  );
  const unreviewedPromotionCandidates = params.financeDoctrinePromotionCandidates.filter(
    (candidate) => candidate.reviewState === "unreviewed",
  );
  const deferredPromotionCandidates = params.financeDoctrinePromotionCandidates.filter(
    (candidate) => candidate.reviewState === "deferred",
  );
  const rejectedPromotionCandidates = params.financeDoctrinePromotionCandidates.filter(
    (candidate) => candidate.reviewState === "rejected",
  );
  const readyPromotionCandidates = params.financeDoctrinePromotionCandidates.filter(
    (candidate) => candidate.reviewState === "ready_for_manual_promotion",
  );
  const reviewedPromotionCandidates = [
    ...readyPromotionCandidates,
    ...deferredPromotionCandidates,
    ...rejectedPromotionCandidates,
  ];

  return renderLobsterWorkfaceArtifact({
    targetDateKey: params.targetDateKey,
    sessionKey: params.sessionKey,
    learningItems: learningCount,
    correctionNotes: params.correctionNotes.length,
    watchtowerSignals: params.anomalies.length,
    codexEscalations: params.codexEscalations.length,
    activeSurfaceLanes: params.surfaceLanePanel?.activeLanes,
    portfolioScorecard: params.scorecard?.averageScore,
    totalTokens: formatNumber(params.tokenStats.totalTokens),
    estimatedCost: formatUsd(params.tokenStats.totalCost),
    dashboardSnapshotLines: [
      renderGauge({
        label: "Learning Flow",
        value: learningCount,
        max: 6,
        suffix: `${learningCount} item${learningCount === 1 ? "" : "s"}`,
      }),
      renderGauge({
        label: "Correction Load",
        value: params.correctionNotes.length,
        max: 4,
        suffix: `${params.correctionNotes.length} note${params.correctionNotes.length === 1 ? "" : "s"}`,
      }),
      renderGauge({
        label: "Watchtower Noise",
        value: params.anomalies.length,
        max: 4,
        suffix: `${params.anomalies.length} signal${params.anomalies.length === 1 ? "" : "s"}`,
      }),
      renderGauge({
        label: "Codex Escalations",
        value: params.codexEscalations.length,
        max: 3,
        suffix: `${params.codexEscalations.length} packet${params.codexEscalations.length === 1 ? "" : "s"}`,
      }),
      ...(scorecardAverage !== undefined
        ? [
            renderGauge({
              label: "Answer Quality",
              value: scorecardAverage,
              max: 5,
              suffix: params.scorecard?.averageScore ?? "n/a",
            }),
          ]
        : ["- Answer Quality: n/a"]),
      renderGauge({
        label: "Token Load",
        value: params.tokenStats.totalTokens,
        max: maxDailyTokens,
        suffix: `${formatNumber(params.tokenStats.totalTokens)} / ${formatNumber(maxDailyTokens)} daily peak`,
        width: 12,
      }),
    ],
    validationRadarLines: params.validationWeekly
      ? [
          `- Latest Weekly Validation: ${params.validationWeekly.filename}`,
          `- Strongest Domain: ${params.validationWeekly.strongestDomain}`,
          `- Weakest Domain: ${params.validationWeekly.weakestDomain}`,
          `- Hallucination Watch: ${params.validationWeekly.hallucinationDomain}`,
        ]
      : ["- No weekly validation radar is available yet."],
    feishuLanePanelLines: params.surfaceLanePanel
      ? [
          `- Active Lanes: ${params.surfaceLanePanel.activeLanes}`,
          ...params.surfaceLanePanel.laneMeter,
        ]
      : ["- No active Feishu surface lanes are recorded yet."],
    sevenDayOperatingViewLines: [
      `- Learning Items (7d): ${params.operatingWeekView.learningItems}`,
      `- Correction Notes (7d): ${params.operatingWeekView.correctionNotes}`,
      `- Watchtower Signals (7d): ${params.operatingWeekView.watchtowerSignals}`,
      `- Codex Escalations (7d): ${params.operatingWeekView.codexEscalations}`,
      `- Average Tokens / Day (7d): ${formatNumber(params.operatingWeekView.averageTokensPerDay)}`,
      `- Busiest Token Day: ${params.operatingWeekView.busiestTokenDay}`,
    ],
    yesterdayLearnedLines: [
      ...(params.learningReviews.length > 0
        ? params.learningReviews.map(
            (entry) =>
              `- review / ${entry.topic}: ${entry.principle} (foundation ${entry.foundationTemplate})`,
          )
        : ["- No learning-review note was captured yesterday."]),
      ...(params.learningCouncilArtifacts.length > 0
        ? [
            "",
            "### Learning Council Runs",
            ...params.learningCouncilArtifacts.flatMap((entry) => [
              `- ${entry.status}: ${entry.userMessage}`,
              ...(entry.adoptionLedgerSummary
                ? [
                    `  - adoption ledger: adopted now ${entry.adoptionLedgerSummary.adoptedNowCount} / candidate ${entry.adoptionLedgerSummary.candidateForReuseCount} / reused ${entry.adoptionLedgerSummary.reusedLaterCount} / downranked ${entry.adoptionLedgerSummary.downrankedOrFailedCount}`,
                  ]
                : []),
              ...(entry.keeperLines[0] ? [`  - keep: ${entry.keeperLines[0]}`] : []),
              ...(entry.discardLines[0] ? [`  - discard: ${entry.discardLines[0]}`] : []),
              ...(entry.lobsterImprovementLines[0]
                ? [`  - improve lobster: ${entry.lobsterImprovementLines[0]}`]
                : []),
              ...(entry.rehearsalTriggerLines[0]
                ? [`  - replay: ${entry.rehearsalTriggerLines[0]}`]
                : []),
              ...(entry.nextEvalCueLines[0] ? [`  - next eval: ${entry.nextEvalCueLines[0]}`] : []),
            ]),
          ]
        : []),
    ],
    yesterdayWorkReceiptLines:
      params.workReceipts.length > 0 ||
      params.financeDoctrineCalibrations.length > 0 ||
      params.recentFinanceDoctrineCalibrationSummary ||
      params.financeDoctrinePromotionCandidates.length > 0
        ? [
            ...params.workReceipts
              .slice(-4)
              .flatMap((entry) => [
                `- ${entry.requestedAction} / ${entry.scope} / ${entry.timeframe} / ${entry.outputShape}: ${entry.userMessage}`,
                `  - reply: ${entry.finalReplySummary}`,
                `  - repair: ${entry.repairDisposition}`,
                ...(entry.financeDoctrineProof
                  ? [
                      `  - finance doctrine proof: ${entry.financeDoctrineProof.consumer} -> ${entry.financeDoctrineProof.doctrineFieldsUsed.join(" / ")}`,
                    ]
                  : []),
              ]),
            ...(params.financeDoctrineCalibrations.length > 0 ||
            params.recentFinanceDoctrineCalibrationSummary
              ? [
                  "",
                  "### Finance Doctrine Calibration",
                  ...(params.recentFinanceDoctrineCalibrationSummary
                    ? [
                        `- recent ${params.recentFinanceDoctrineCalibrationSummary.windowDays}d (${params.recentFinanceDoctrineCalibrationSummary.windowStartDate} to ${params.recentFinanceDoctrineCalibrationSummary.windowEndDate}): ${params.recentFinanceDoctrineCalibrationSummary.totalCount} notes / closest scenario base_case ${params.recentFinanceDoctrineCalibrationSummary.closestScenarioCounts.base_case}, bear_case ${params.recentFinanceDoctrineCalibrationSummary.closestScenarioCounts.bear_case}, unclear ${params.recentFinanceDoctrineCalibrationSummary.closestScenarioCounts.unclear}`,
                        `- recent ${params.recentFinanceDoctrineCalibrationSummary.windowDays}d base closer: yes ${params.recentFinanceDoctrineCalibrationSummary.baseCaseDirectionallyCloserCounts.yes}, no ${params.recentFinanceDoctrineCalibrationSummary.baseCaseDirectionallyCloserCounts.no}, unclear ${params.recentFinanceDoctrineCalibrationSummary.baseCaseDirectionallyCloserCounts.unclear}`,
                        `- recent ${params.recentFinanceDoctrineCalibrationSummary.windowDays}d change-my-mind triggered: yes ${params.recentFinanceDoctrineCalibrationSummary.changeMyMindCounts.yes}, no ${params.recentFinanceDoctrineCalibrationSummary.changeMyMindCounts.no}, unclear ${params.recentFinanceDoctrineCalibrationSummary.changeMyMindCounts.unclear}`,
                        `- recent ${params.recentFinanceDoctrineCalibrationSummary.windowDays}d conviction looked: too_high ${params.recentFinanceDoctrineCalibrationSummary.convictionCounts.too_high}, too_low ${params.recentFinanceDoctrineCalibrationSummary.convictionCounts.too_low}, about_right ${params.recentFinanceDoctrineCalibrationSummary.convictionCounts.about_right}, unclear ${params.recentFinanceDoctrineCalibrationSummary.convictionCounts.unclear}`,
                      ]
                    : []),
                  ...(params.financeDoctrinePromotionCandidates.length > 0
                    ? [
                        `- promotion candidates: unreviewed ${unreviewedPromotionCandidates.length}, ready ${readyPromotionCandidates.length}, defer ${deferredPromotionCandidates.length}, reject ${rejectedPromotionCandidates.length}`,
                        ...reviewedPromotionCandidates
                          .slice(0, 2)
                          .flatMap((candidate) => [
                            `  - reviewed: ${candidate.reviewState} / ${candidate.candidateText}`,
                            ...(candidate.reviewNotes
                              ? [`    - note: ${candidate.reviewNotes}`]
                              : []),
                          ]),
                        ...(reviewedPromotionCandidates.length === 0
                          ? unreviewedPromotionCandidates
                              .slice(0, 2)
                              .map((candidate) => `  - unreviewed: ${candidate.candidateText}`)
                          : []),
                      ]
                    : []),
                  `- summary: ${financeDoctrineCalibrationSummary.totalCount} notes / closest scenario base_case ${financeDoctrineCalibrationSummary.closestScenarioCounts.base_case}, bear_case ${financeDoctrineCalibrationSummary.closestScenarioCounts.bear_case}, unclear ${financeDoctrineCalibrationSummary.closestScenarioCounts.unclear}`,
                  `- change-my-mind triggered: yes ${financeDoctrineCalibrationSummary.changeMyMindCounts.yes}, no ${financeDoctrineCalibrationSummary.changeMyMindCounts.no}, unclear ${financeDoctrineCalibrationSummary.changeMyMindCounts.unclear}`,
                  `- conviction looked: too_high ${financeDoctrineCalibrationSummary.convictionCounts.too_high}, too_low ${financeDoctrineCalibrationSummary.convictionCounts.too_low}, about_right ${financeDoctrineCalibrationSummary.convictionCounts.about_right}, unclear ${financeDoctrineCalibrationSummary.convictionCounts.unclear}`,
                  ...params.financeDoctrineCalibrations.flatMap((entry) => [
                    `- ${entry.consumer}: closest ${entry.scenarioClosestToOutcome} / base closer ${entry.baseCaseDirectionallyCloser} / change-my-mind ${entry.changeMyMindTriggered} / conviction ${entry.convictionLooksTooHighOrLow}`,
                    `  - observed outcome: ${entry.observedOutcome}`,
                    `  - linked receipt: ${entry.linkedReceipt}`,
                  ]),
                ]
              : []),
          ]
        : undefined,
    selfRepairSignalLines:
      repairReceipts.length > 0
        ? repairReceipts
            .slice(-4)
            .flatMap((entry) => [
              `- ${entry.repairDisposition}: ${entry.userMessage}`,
              `  - action: ${entry.requestedAction} / ${entry.scope}`,
              `  - last reply: ${entry.finalReplySummary}`,
            ])
        : undefined,
    yesterdayCorrectedLines:
      params.correctionNotes.length > 0
        ? params.correctionNotes.map(
            (entry) =>
              `- ${entry.issueKey}: ${entry.whatWasWrong} (foundation ${entry.foundationTemplate})`,
          )
        : ["- No correction note was captured yesterday."],
    yesterdayWatchtowerLines:
      params.anomalies.length > 0
        ? params.anomalies.map(
            (entry) =>
              `- ${entry.severity} / ${entry.category}: ${entry.problem} (source ${entry.source}, foundation ${entry.foundationTemplate})`,
          )
        : ["- No watchtower anomaly was recorded yesterday."],
    codexEscalationLines:
      params.codexEscalations.length > 0
        ? params.codexEscalations.map(
            (entry) =>
              `- ${entry.severity} / ${entry.category}: ${entry.problem} (source ${entry.source}, foundation ${entry.foundationTemplate})`,
          )
        : ["- No Codex escalation packet was recorded yesterday."],
    portfolioAnswerScorecardLines: params.scorecard
      ? [
          `- latest: ${params.scorecard.filename}`,
          `- average score: ${params.scorecard.averageScore}`,
          `- weakest current dimension: ${params.scorecard.weakestDimension}`,
        ]
      : ["- No portfolio-answer scorecard is available yet."],
    tokenDashboardLeadLine: `- Yesterday total: ${formatNumber(params.tokenStats.totalTokens)} tokens / ${formatUsd(params.tokenStats.totalCost)}`,
    tokenDashboardModelLines:
      params.tokenStats.byModel.length > 0
        ? [
            "",
            "### By Model",
            ...params.tokenStats.byModel
              .slice(0, 5)
              .map(
                (entry) =>
                  `- ${entry.provider}/${entry.model}: ${formatNumber(entry.tokens)} tokens (${formatUsd(entry.cost)})`,
              ),
          ]
        : ["", "### By Model", "- No model usage rows were recorded yesterday."],
    tokenTrendLines: params.tokenStats.sevenDayDaily.map(
      (entry) =>
        `- ${entry.date}: ${renderBar(entry.tokens, maxDailyTokens)} ${formatNumber(entry.tokens)}`,
    ),
    readingGuideLines: [
      "- Active brain path: read memory/current-research-line.md first, then MEMORY.md, then memory/unified-risk-view.md when present, then the latest carryover and correction notes before drilling into older artifacts.",
      "- Keep one brain, not two: the distillation chain serves both Lobster's general agent meta-capability and the full finance research pipeline.",
      "- Treat memory/local-memory/*.md as reusable durable cards; treat ops/live-handoff/*.md as drill-down or migration history, not as the first active brain to read.",
      "- If learning count is high but correction count is also high, Lobster is learning but not transferring cleanly enough yet.",
      "- If token use rises without stronger learning or correction quality, the system is burning context without enough improvement.",
      "- Use this artifact to supervise daily usefulness, not to reward activity theater.",
    ],
  });
}

const handler: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir, displaySessionKey, cfg } = await resolveMemorySessionContext({
      event,
    });
    await ensureFeishuWorkReceiptArtifacts(memoryDir);
    const now = new Date(event.timestamp ?? Date.now());
    const targetDateKey = toUtcDateKey(shiftUtcDays(now, -1));

    const [
      learningReviews,
      initialLearningCouncilArtifacts,
      workReceipts,
      financeDoctrineCalibrations,
      recentFinanceDoctrineCalibrationSummary,
      correctionNotes,
      anomalies,
      codexEscalations,
      scorecard,
      tokenStats,
    ] = await Promise.all([
      loadYesterdayLearningReviews({ memoryDir, targetDateKey }),
      loadYesterdayLearningCouncilArtifacts({ workspaceDir, memoryDir, targetDateKey }),
      loadYesterdayFeishuWorkReceipts({ memoryDir, targetDateKey }),
      loadYesterdayFinanceDoctrineCalibrations({ memoryDir, targetDateKey }),
      loadRecentFinanceDoctrineCalibrationSummary({
        memoryDir,
        targetDateKey,
        windowDays: 7,
      }),
      loadYesterdayCorrectionNotes({ memoryDir, targetDateKey }),
      loadYesterdayOperationalAnomalies({ workspaceDir, targetDateKey }),
      loadYesterdayCodexEscalations({ workspaceDir, targetDateKey }),
      loadLatestPortfolioScorecard(memoryDir),
      loadYesterdayTokenStats({ cfg, targetDateKey }),
    ]);
    await markReusedLearningCouncilAdoptionLedgerEntries({
      memoryDir,
      targetDateKey,
      learningCouncilArtifacts: initialLearningCouncilArtifacts,
    });
    const learningCouncilArtifacts = await loadYesterdayLearningCouncilArtifacts({
      workspaceDir,
      memoryDir,
      targetDateKey,
    });
    const [validationWeekly, operatingWeekView] = await Promise.all([
      loadLatestKnowledgeValidationWeekly(memoryDir),
      loadOperatingWeekView({
        memoryDir,
        workspaceDir,
        tokenStats,
      }),
    ]);
    const surfaceLanePanel = await loadFeishuSurfaceLanePanel(memoryDir);
    const existingFinanceDoctrinePromotionReview = await loadExistingFinanceDoctrinePromotionReview(
      {
        memoryDir,
        targetDateKey,
      },
    );
    const existingFinanceDoctrinePromotionCandidates =
      await loadExistingFinanceDoctrinePromotionCandidates({
        memoryDir,
        targetDateKey,
      });
    const financeDoctrinePromotionCandidates = mergeFinanceDoctrinePromotionCandidates({
      current: buildFinanceDoctrinePromotionCandidates(recentFinanceDoctrineCalibrationSummary),
      previousReview: existingFinanceDoctrinePromotionReview,
      previous: existingFinanceDoctrinePromotionCandidates,
    });

    const hasSignals =
      learningReviews.length > 0 ||
      learningCouncilArtifacts.length > 0 ||
      workReceipts.length > 0 ||
      financeDoctrineCalibrations.length > 0 ||
      Boolean(recentFinanceDoctrineCalibrationSummary) ||
      correctionNotes.length > 0 ||
      anomalies.length > 0 ||
      codexEscalations.length > 0 ||
      Boolean(validationWeekly) ||
      Boolean(surfaceLanePanel) ||
      Boolean(scorecard) ||
      tokenStats.totalTokens > 0;
    if (!hasSignals) {
      return;
    }

    await writeMemoryNotes(memoryDir, [
      {
        filename: buildLobsterWorkfaceFilename(targetDateKey),
        content: renderWorkface({
          targetDateKey,
          sessionKey: displaySessionKey,
          learningReviews,
          learningCouncilArtifacts,
          workReceipts,
          financeDoctrineCalibrations,
          recentFinanceDoctrineCalibrationSummary,
          financeDoctrinePromotionCandidates,
          correctionNotes,
          anomalies,
          codexEscalations,
          scorecard,
          validationWeekly,
          operatingWeekView,
          surfaceLanePanel,
          tokenStats,
        }),
      },
      ...(recentFinanceDoctrineCalibrationSummary
        ? [
            {
              filename: path.join(
                "feishu-work-receipts",
                buildFeishuFinanceDoctrinePromotionCandidatesFilename(targetDateKey),
              ),
              content: renderFeishuFinanceDoctrinePromotionCandidateArtifact({
                generatedAt: now.toISOString(),
                consumer: "holdings_thesis_revalidation",
                windowDays: recentFinanceDoctrineCalibrationSummary.windowDays,
                windowStartDate: recentFinanceDoctrineCalibrationSummary.windowStartDate,
                windowEndDate: recentFinanceDoctrineCalibrationSummary.windowEndDate,
                totalCalibrationNotes: recentFinanceDoctrineCalibrationSummary.totalCount,
                candidates: financeDoctrinePromotionCandidates,
              }),
            },
            {
              filename: path.join(
                "feishu-work-receipts",
                buildFeishuFinanceDoctrinePromotionReviewFilename(targetDateKey),
              ),
              content: renderFeishuFinanceDoctrinePromotionReviewArtifact({
                reviewedAt: existingFinanceDoctrinePromotionReview?.reviewedAt ?? now.toISOString(),
                consumer: "holdings_thesis_revalidation",
                linkedCandidateArtifact: `memory/feishu-work-receipts/${buildFeishuFinanceDoctrinePromotionCandidatesFilename(targetDateKey)}`,
                reviews: financeDoctrinePromotionCandidates.map((candidate) => ({
                  candidateKey: candidate.candidateKey,
                  reviewState: candidate.reviewState,
                  reviewNotes: candidate.reviewNotes,
                })),
              }),
            },
          ]
        : []),
    ]);
  } catch (error) {
    log.error("Failed to write operating daily workface", { error: String(error) });
  }
};

export default handler;
