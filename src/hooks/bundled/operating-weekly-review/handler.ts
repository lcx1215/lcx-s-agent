import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import {
  buildOperatingWeeklyArtifactFilename,
  buildWatchtowerArtifactDir,
  parseCodexEscalationArtifact,
  parseCorrectionNoteArtifact,
  parseWatchtowerAnomalyRecord,
  parseRepairTicketArtifact,
  parseCorrectionNoteFilename,
  renderPortfolioAnswerScorecardArtifact,
} from "../lobster-brain-registry.js";
import { formatIsoWeek, isWithinTrailingUtcDays, writeMemoryNotes } from "../weekly-memory.js";

const log = createSubsystemLogger("hooks/operating-weekly-review");

type CorrectionNote = {
  name: string;
  date: string;
  issueKey: string;
  foundationTemplate: string;
  whatWasWrong: string;
};

type RepairTicket = {
  name: string;
  issueKey: string;
  category: string;
  foundationTemplate: string;
  occurrences: number;
  lastSeenDate: string;
  problem: string;
};

type OperationalAnomaly = {
  name: string;
  category: string;
  source: string;
  foundationTemplate: string;
  occurrenceCount: number;
  lastSeenAt: string;
  problem: string;
};

type CodexEscalation = {
  name: string;
  category: string;
  source: string;
  severity: string;
  foundationTemplate: string;
  occurrences: number;
  generatedAt: string;
  generatedDateKey: string;
  problem: string;
};

async function loadRecentCorrectionNotes(memoryDir: string, now: Date): Promise<CorrectionNote[]> {
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && Boolean(parseCorrectionNoteFilename(entry.name)))
        .map(async (entry) => {
          const parsedName = parseCorrectionNoteFilename(entry.name);
          if (!parsedName) {
            return undefined;
          }
          const content = await fs.readFile(path.join(memoryDir, entry.name), "utf-8");
          const parsedNote = parseCorrectionNoteArtifact(content);
          return {
            name: entry.name,
            date: parsedName.dateStr,
            issueKey: parsedNote?.issueKey ?? "unknown",
            foundationTemplate: parsedNote?.foundationTemplate ?? "general",
            whatWasWrong: parsedNote?.whatWasWrong ?? "No correction summary captured.",
          } satisfies CorrectionNote;
        }),
    );
    return parsed
      .filter((entry): entry is CorrectionNote => Boolean(entry))
      .filter((entry) => isWithinTrailingUtcDays(entry.date, now, 7))
      .toSorted((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}

async function loadActiveRepairTickets(workspaceDir: string, now: Date): Promise<RepairTicket[]> {
  const ticketsDir = path.join(workspaceDir, buildWatchtowerArtifactDir("repairTickets"));
  try {
    const entries = await fs.readdir(ticketsDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map(async (entry) => {
          const content = await fs.readFile(path.join(ticketsDir, entry.name), "utf-8");
          const parsedTicket = parseRepairTicketArtifact(content);
          if (!parsedTicket) {
            return undefined;
          }
          return {
            name: entry.name,
            issueKey: parsedTicket.issueKey,
            category: parsedTicket.category,
            foundationTemplate: parsedTicket.foundationTemplate,
            occurrences: parsedTicket.occurrences,
            lastSeenDate: parsedTicket.lastSeenDateKey,
            problem: parsedTicket.problem,
          } satisfies RepairTicket;
        }),
    );
    return parsed
      .filter((entry): entry is RepairTicket => Boolean(entry))
      .filter((entry) => !entry.lastSeenDate || isWithinTrailingUtcDays(entry.lastSeenDate, now, 7))
      .toSorted(
        (a, b) =>
          b.occurrences - a.occurrences ||
          b.lastSeenDate.localeCompare(a.lastSeenDate) ||
          a.issueKey.localeCompare(b.issueKey),
      );
  } catch {
    return [];
  }
}

async function loadRecentOperationalAnomalies(
  workspaceDir: string,
  now: Date,
): Promise<OperationalAnomaly[]> {
  const anomaliesDir = path.join(workspaceDir, buildWatchtowerArtifactDir("anomalies"));
  try {
    const entries = await fs.readdir(anomaliesDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const content = parseWatchtowerAnomalyRecord(
            await fs.readFile(path.join(anomaliesDir, entry.name), "utf-8"),
          );
          if (!content) {
            return undefined;
          }
          return {
            name: entry.name,
            category: content.category,
            source: content.source,
            foundationTemplate: content.foundationTemplate,
            occurrenceCount: content.occurrenceCount,
            lastSeenAt: content.lastSeenAt,
            problem: content.problem,
          } satisfies OperationalAnomaly;
        }),
    );
    return parsed
      .filter((entry): entry is OperationalAnomaly => Boolean(entry))
      .filter(
        (entry) =>
          !entry.lastSeenAt || isWithinTrailingUtcDays(entry.lastSeenAt.slice(0, 10), now, 7),
      )
      .toSorted(
        (a, b) =>
          b.occurrenceCount - a.occurrenceCount ||
          b.lastSeenAt.localeCompare(a.lastSeenAt) ||
          a.category.localeCompare(b.category),
      );
  } catch {
    return [];
  }
}

async function loadActiveCodexEscalations(
  workspaceDir: string,
  now: Date,
): Promise<CodexEscalation[]> {
  const escalationsDir = path.join(workspaceDir, buildWatchtowerArtifactDir("codexEscalations"));
  try {
    const entries = await fs.readdir(escalationsDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map(async (entry) => {
          const parsedPacket = parseCodexEscalationArtifact(
            await fs.readFile(path.join(escalationsDir, entry.name), "utf-8"),
          );
          if (!parsedPacket) {
            return undefined;
          }
          return {
            name: entry.name,
            category: parsedPacket.category,
            source: parsedPacket.source,
            severity: parsedPacket.severity,
            foundationTemplate: parsedPacket.foundationTemplate,
            occurrences: parsedPacket.occurrences,
            generatedAt: parsedPacket.generatedAt,
            generatedDateKey: parsedPacket.generatedDateKey,
            problem: parsedPacket.problem,
          } satisfies CodexEscalation;
        }),
    );
    return parsed
      .filter((entry): entry is CodexEscalation => Boolean(entry))
      .filter(
        (entry) =>
          !entry.generatedDateKey || isWithinTrailingUtcDays(entry.generatedDateKey, now, 7),
      )
      .toSorted(
        (a, b) =>
          b.occurrences - a.occurrences ||
          b.generatedAt.localeCompare(a.generatedAt) ||
          a.category.localeCompare(b.category),
      );
  } catch {
    return [];
  }
}

async function findWeeklyCompanions(memoryDir: string, weekKey: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          (entry.name === `${weekKey}-learning-weekly-review.md` ||
            entry.name === `${weekKey}-frontier-methods-weekly-review.md`),
      )
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    return [];
  }
}

function countSignalsForFoundations(
  values: string[],
  foundations: string[],
  extraKeywords: string[] = [],
): number {
  return values.filter((value) => {
    const normalized = value.toLowerCase();
    return (
      foundations.some((foundation) => normalized.includes(foundation.toLowerCase())) ||
      extraKeywords.some((keyword) => normalized.includes(keyword.toLowerCase()))
    );
  }).length;
}

function toScore(signalCount: number): number {
  if (signalCount <= 0) {
    return 5;
  }
  if (signalCount === 1) {
    return 4;
  }
  if (signalCount === 2) {
    return 3;
  }
  if (signalCount === 3) {
    return 2;
  }
  return 1;
}

function renderScoreLine(params: {
  label: string;
  score: number;
  signalCount: number;
  focus: string;
}): string {
  return `- ${params.label}: ${params.score}/5 (${params.signalCount} recent signal${params.signalCount === 1 ? "" : "s"}) - focus: ${params.focus}`;
}

function buildPortfolioAnswerScorecard(params: {
  weekKey: string;
  rangeLabel: string;
  sessionKey: string;
  correctionNotes: CorrectionNote[];
  repairTickets: RepairTicket[];
  anomalies: OperationalAnomaly[];
}): string {
  const correctionTexts = params.correctionNotes.map(
    (note) => `${note.foundationTemplate} ${note.whatWasWrong}`,
  );
  const watchtowerTexts = [...params.repairTickets, ...params.anomalies].map(
    (entry) => `${entry.foundationTemplate} ${entry.problem}`,
  );
  const allSignals = [...correctionTexts, ...watchtowerTexts];

  const stanceSignals = countSignalsForFoundations(
    allSignals,
    ["portfolio-sizing-discipline", "outcome-review"],
    ["stance", "hold", "reduce", "do not add", "add", "仓位", "减仓", "持有"],
  );
  const triggerSignals = countSignalsForFoundations(
    allSignals,
    ["catalyst-map", "execution-hygiene"],
    ["trigger", "催化", "earnings", "event", "review trigger", "wait"],
  );
  const riskSignals = countSignalsForFoundations(
    allSignals,
    ["risk-transmission", "business-quality", "portfolio-sizing-discipline"],
    ["cross-asset", "risk", "transmission", "concentration", "护城河", "定价权"],
  );
  const confidenceSignals = countSignalsForFoundations(
    allSignals,
    ["outcome-review", "behavior-error-correction"],
    ["confidence", "freshness", "hallucination", "overconfident", "证据", "置信"],
  );
  const waitSignals = countSignalsForFoundations(
    allSignals,
    ["execution-hygiene", "behavior-error-correction", "catalyst-map"],
    ["wait", "urgency", "fomo", "追涨", "冲动", "event risk", "liquidity"],
  );

  const dimensions = [
    {
      label: "Stance Clarity",
      score: toScore(stanceSignals),
      signalCount: stanceSignals,
      focus: "one clear hold/watch/reduce/do-not-add stance",
    },
    {
      label: "Trigger Quality",
      score: toScore(triggerSignals),
      signalCount: triggerSignals,
      focus: "separate add / reduce / wait with real catalysts",
    },
    {
      label: "Risk Framing",
      score: toScore(riskSignals),
      signalCount: riskSignals,
      focus: "name the transmission path, concentration risk, and structural risk",
    },
    {
      label: "Confidence Calibration",
      score: toScore(confidenceSignals),
      signalCount: confidenceSignals,
      focus: "match confidence to evidence freshness and quality",
    },
    {
      label: "Wait Discipline",
      score: toScore(waitSignals),
      signalCount: waitSignals,
      focus: "say wait when event risk, liquidity, or volatility makes action premature",
    },
  ];

  const averageScore =
    dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / dimensions.length;
  const weakest = [...dimensions].toSorted(
    (a, b) => a.score - b.score || b.signalCount - a.signalCount,
  );

  return renderPortfolioAnswerScorecardArtifact({
    weekKey: params.weekKey,
    rangeLabel: params.rangeLabel,
    sessionKey: params.sessionKey,
    signalsReviewed: allSignals.length,
    averageScore: `${averageScore.toFixed(1)} / 5.0`,
    dimensionScoreLines: dimensions.map((dimension) => renderScoreLine(dimension)),
    mainFailureModeLines:
      weakest.filter((dimension) => dimension.signalCount > 0).length > 0
        ? weakest
            .filter((dimension) => dimension.signalCount > 0)
            .slice(0, 3)
            .map(
              (dimension) =>
                `- ${dimension.label}: ${dimension.signalCount} recent signal${dimension.signalCount === 1 ? "" : "s"} pushed this below a clean answer standard.`,
            )
        : ["- No meaningful position-answer drift signal was captured this week."],
    nextUpgradeFocusLines: weakest[0]
      ? [
          `- do-now: improve ${weakest[0].label.toLowerCase()} before trying to sound smarter elsewhere.`,
          "- use this scorecard to judge whether Lobster is answering like a portfolio assistant or hiding behind market commentary.",
        ]
      : [
          "- do-now: keep using the fixed position-answer contract.",
          "- use this scorecard to judge whether Lobster is answering like a portfolio assistant or hiding behind market commentary.",
        ],
  });
}

function renderWeeklyReview(params: {
  weekKey: string;
  rangeLabel: string;
  sessionKey: string;
  correctionNotes: CorrectionNote[];
  repairTickets: RepairTicket[];
  anomalies: OperationalAnomaly[];
  codexEscalations: CodexEscalation[];
  companionFiles: string[];
}): string {
  const topCorrections = params.correctionNotes.slice(0, 5);
  const topTickets = params.repairTickets.slice(0, 5);
  const topAnomalies = params.anomalies.slice(0, 5);
  const topEscalations = params.codexEscalations.slice(0, 5);
  const strongestTicket = topTickets[0];
  const foundationSummary = Array.from(
    params.correctionNotes.reduce((acc, note) => {
      acc.set(note.foundationTemplate, (acc.get(note.foundationTemplate) ?? 0) + 1);
      return acc;
    }, new Map<string, number>()),
  ).toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const watchtowerFoundationSummary = Array.from(
    [...params.repairTickets, ...params.anomalies].reduce((acc, entry) => {
      acc.set(entry.foundationTemplate, (acc.get(entry.foundationTemplate) ?? 0) + 1);
      return acc;
    }, new Map<string, number>()),
  ).toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return [
    `# Lobster Weekly Review: ${params.weekKey}`,
    "",
    `- **Window**: ${params.rangeLabel}`,
    `- **Session Key**: ${params.sessionKey}`,
    `- **Correction Notes**: ${params.correctionNotes.length}`,
    `- **Active Repair Tickets**: ${params.repairTickets.length}`,
    `- **Active Codex Escalations**: ${params.codexEscalations.length}`,
    "",
    "## What Improved",
    ...(topCorrections.length > 0
      ? topCorrections.map(
          (note) => `- correction ${note.issueKey}: ${note.whatWasWrong} (${note.date})`,
        )
      : ["- No correction notes were captured this week."]),
    "",
    "## Drift Areas By Foundation",
    ...(foundationSummary.length > 0
      ? foundationSummary.map(
          ([template, count]) => `- ${template}: ${count} correction note${count === 1 ? "" : "s"}`,
        )
      : ["- No foundation-template drift area was captured this week."]),
    "",
    "## What Still Drifts",
    ...(topTickets.length > 0
      ? topTickets.map(
          (ticket) =>
            `- ${ticket.category} / ${ticket.issueKey}: ${ticket.problem} (occurrences ${ticket.occurrences})`,
        )
      : ["- No active repair-ticket candidates this week."]),
    "",
    "## Active Anomalies",
    ...(topAnomalies.length > 0
      ? topAnomalies.map(
          (anomaly) =>
            `- ${anomaly.category} / ${anomaly.source}: ${anomaly.problem} (foundation ${anomaly.foundationTemplate}, occurrences ${anomaly.occurrenceCount})`,
        )
      : ["- No active watchtower anomalies captured this week."]),
    "",
    "## Active Codex Escalations",
    ...(topEscalations.length > 0
      ? topEscalations.map(
          (packet) =>
            `- ${packet.severity} / ${packet.category} / ${packet.source}: ${packet.problem} (foundation ${packet.foundationTemplate}, occurrences ${packet.occurrences})`,
        )
      : ["- No active Codex escalation packet this week."]),
    "",
    "## Watchtower Foundation Impact",
    ...(watchtowerFoundationSummary.length > 0
      ? watchtowerFoundationSummary.map(
          ([template, count]) =>
            `- ${template}: ${count} active watchtower signal${count === 1 ? "" : "s"}`,
        )
      : ["- No active foundation-linked watchtower signal this week."]),
    "",
    "## Learning Inputs To Reuse",
    ...(params.companionFiles.length > 0
      ? params.companionFiles.map((file) => `- ${file}`)
      : ["- No weekly learning or frontier review artifact found for this window."]),
    "",
    "## Active Brain Spine",
    "- Read memory/current-research-line.md first, then MEMORY.md, then memory/unified-risk-view.md when present, then the newest carryover and correction notes before older drill-down artifacts.",
    "- Keep one brain, not two: the distillation chain serves both Lobster's general meta-capability and the full finance research pipeline.",
    "- Treat memory/local-memory/*.md as reusable durable cards; treat ops/live-handoff/*.md as drill-down or migration history, not as the first active brain to read.",
    "",
    "## Next Repair Priorities",
    ...(strongestTicket
      ? [
          `- do-now: inspect ${strongestTicket.category} / ${strongestTicket.issueKey}`,
          "- keep the patch bounded; do not broaden providers, memory architecture, or doctrine without explicit approval",
        ]
      : ["- do-now: keep operating and wait for a concrete recurring issue before patching."]),
    "",
    "## Operator Note",
    "- This artifact is for supervision and long-horizon improvement. It is not a trading decision artifact.",
    "",
  ].join("\n");
}

const saveOperatingWeeklyReview: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir, displaySessionKey } = await resolveMemorySessionContext({
      event,
    });
    const now = new Date(event.timestamp);
    const { weekKey, rangeLabel } = formatIsoWeek(now);
    const [correctionNotes, repairTickets, anomalies, codexEscalations, companionFiles] =
      await Promise.all([
        loadRecentCorrectionNotes(memoryDir, now),
        loadActiveRepairTickets(workspaceDir, now),
        loadRecentOperationalAnomalies(workspaceDir, now),
        loadActiveCodexEscalations(workspaceDir, now),
        findWeeklyCompanions(memoryDir, weekKey),
      ]);

    if (
      correctionNotes.length === 0 &&
      repairTickets.length === 0 &&
      anomalies.length === 0 &&
      codexEscalations.length === 0 &&
      companionFiles.length === 0
    ) {
      return;
    }

    await writeMemoryNotes(memoryDir, [
      {
        filename: buildOperatingWeeklyArtifactFilename(weekKey, "lobster-weekly-review"),
        content: renderWeeklyReview({
          weekKey,
          rangeLabel,
          sessionKey: displaySessionKey,
          correctionNotes,
          repairTickets,
          anomalies,
          codexEscalations,
          companionFiles,
        }),
      },
      {
        filename: buildOperatingWeeklyArtifactFilename(weekKey, "portfolio-answer-scorecard"),
        content: buildPortfolioAnswerScorecard({
          weekKey,
          rangeLabel,
          sessionKey: displaySessionKey,
          correctionNotes,
          repairTickets,
          anomalies,
        }),
      },
    ]);

    log.info("Operating weekly review saved", {
      weekKey,
      correctionCount: correctionNotes.length,
      repairTicketCount: repairTickets.length,
      anomalyCount: anomalies.length,
      codexEscalationCount: codexEscalations.length,
      companionCount: companionFiles.length,
    });
  } catch (err) {
    if (err instanceof Error) {
      log.error("Failed to save operating weekly review", {
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
      });
      return;
    }
    log.error("Failed to save operating weekly review", { error: String(err) });
  }
};

export default saveOperatingWeeklyReview;
