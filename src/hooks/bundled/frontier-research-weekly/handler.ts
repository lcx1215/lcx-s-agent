import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveStateDir } from "../../../config/paths.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import type { HookHandler } from "../../hooks.js";
import {
  buildFrontierRecallFilename,
  FRONTIER_RESEARCH_CARD_PREFIX,
  FRONTIER_WEEKLY_MEMORY_NOTES,
  parseFrontierResearchCardArtifact,
} from "../lobster-brain-registry.js";
import { renderUpgradePrompt } from "../upgrade-memory.js";
import {
  countTop,
  formatIsoWeek,
  type MemoryNote,
  toUtcDateOnly,
  writeMemoryNotes,
} from "../weekly-memory.js";

const log = createSubsystemLogger("hooks/frontier-research-weekly");
const RESEARCH_FILE_RE = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-${FRONTIER_RESEARCH_CARD_PREFIX}.+\\.md$`);

type ParsedResearchCard = NonNullable<ReturnType<typeof parseFrontierResearchCardArtifact>> & {
  leakage: string;
  overfitting: string;
  adoptableIdea: string;
};

async function loadRecentResearchCards(
  memoryDir: string,
  now: Date,
): Promise<ParsedResearchCard[]> {
  const weekStart = toUtcDateOnly(now);
  weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && RESEARCH_FILE_RE.test(entry.name))
        .map(async (entry) => {
          const content = await fs.readFile(path.join(memoryDir, entry.name), "utf-8");
          const parsed = parseFrontierResearchCardArtifact({ filename: entry.name, content });
          return parsed
            ? {
                ...parsed,
                leakage: parsed.possibleLeakagePoints,
                overfitting: parsed.overfittingRisks,
                adoptableIdea: parsed.adoptableIdeas,
              }
            : undefined;
        }),
    );

    return parsed
      .filter((card): card is ParsedResearchCard => Boolean(card))
      .filter((card) => {
        const date = new Date(`${card.date}T00:00:00.000Z`);
        return date >= weekStart && date <= toUtcDateOnly(now);
      })
      .toSorted((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}

function renderWeeklyMethodsReview(params: {
  cards: ParsedResearchCard[];
  sessionKey: string;
  weekKey: string;
  rangeLabel: string;
}): string {
  const verdicts = countTop(
    params.cards.map((card) => card.verdict),
    4,
  );
  const families = countTop(params.cards.map((card) => card.methodFamily));
  const adoptableIdeas = countTop(
    params.cards.map((card) => card.adoptableIdea),
    3,
  );
  const foundationTemplates = countTop(
    params.cards.map((card) => card.foundationTemplate),
    4,
  );
  const leakageRisks = countTop(
    params.cards.map((card) => card.leakage),
    3,
  );
  const overfittingRisks = countTop(
    params.cards.map((card) => card.overfitting),
    3,
  );
  const evaluationProtocols = countTop(
    params.cards.map((card) => card.evaluationProtocol),
    3,
  );

  const cardsByVerdict = (verdict: string) =>
    params.cards.filter((card) => card.verdict === verdict).map((card) => `- ${card.title}`);

  return [
    `# Weekly Methods Review: ${params.weekKey}`,
    "",
    `- **Window**: ${params.rangeLabel}`,
    `- **Session Key**: ${params.sessionKey}`,
    `- **Cards Reviewed**: ${params.cards.length}`,
    "",
    "## Verdict Counts",
    ...verdicts.map((entry) => `- ${entry.value} (${entry.count})`),
    "",
    "## Method Families",
    ...families.map((entry) => `- ${entry.value} (${entry.count})`),
    "",
    "## Worth Reproducing",
    ...(cardsByVerdict("worth_reproducing").length > 0
      ? cardsByVerdict("worth_reproducing")
      : ["- None this week."]),
    "",
    "## Watch For Followup",
    ...(cardsByVerdict("watch_for_followup").length > 0
      ? cardsByVerdict("watch_for_followup")
      : ["- None this week."]),
    "",
    "## Archive For Knowledge",
    ...(cardsByVerdict("archive_for_knowledge").length > 0
      ? cardsByVerdict("archive_for_knowledge")
      : ["- None this week."]),
    "",
    "## Ignore",
    ...(cardsByVerdict("ignore").length > 0 ? cardsByVerdict("ignore") : ["- None this week."]),
    "",
    "## Cross-Paper Patterns",
    ...leakageRisks.map((entry) => `- leakage: ${entry.value} (${entry.count})`),
    ...overfittingRisks.map((entry) => `- overfitting: ${entry.value} (${entry.count})`),
    ...evaluationProtocols.map((entry) => `- evaluation: ${entry.value} (${entry.count})`),
    "",
    "## Methods To Transfer",
    ...adoptableIdeas.map((entry) => `- ${entry.value} (${entry.count})`),
    "",
    "## Foundation Template Focus",
    ...foundationTemplates.map((entry) => `- ${entry.value} (${entry.count})`),
    "",
    "## Replication Backlog",
    ...(cardsByVerdict("worth_reproducing").length > 0
      ? cardsByVerdict("worth_reproducing")
      : ["- No reproduction candidate yet."]),
    "",
    "## Source Cards",
    ...params.cards.map((card) => `- ${card.date}: ${card.name}`),
    "",
  ].join("\n");
}

function renderReplicationBacklog(params: {
  cards: ParsedResearchCard[];
  weekKey: string;
  rangeLabel: string;
}): string {
  const candidates = params.cards.filter((card) => card.verdict === "worth_reproducing");
  return [
    `# Frontier Replication Backlog: ${params.weekKey}`,
    "",
    `- **Window**: ${params.rangeLabel}`,
    `- **Candidate Count**: ${candidates.length}`,
    "",
    ...(candidates.length > 0
      ? candidates.flatMap((card) => [
          `## ${card.title}`,
          `- method_family: ${card.methodFamily}`,
          `- replication_cost: ${card.replicationCost}`,
          `- data_setup: ${card.dataSetup}`,
          `- evaluation_protocol: ${card.evaluationProtocol}`,
          `- key_results: ${card.keyResults}`,
          `- leakage_check_first: ${card.leakage}`,
          `- overfitting_check_first: ${card.overfitting}`,
          `- first_adoptable_idea: ${card.adoptableIdea}`,
          "",
        ])
      : ["- No frontier method is ready for reproduction yet.", ""]),
  ].join("\n");
}

function renderFrontierUpgrade(params: {
  cards: ParsedResearchCard[];
  weekKey: string;
  rangeLabel: string;
}): string {
  const primaryCandidate =
    params.cards.find((card) => card.verdict === "worth_reproducing") ??
    params.cards.find((card) => card.verdict === "watch_for_followup") ??
    params.cards[0];
  const topLeakage =
    primaryCandidate?.leakage ??
    countTop(
      params.cards.map((card) => card.leakage),
      1,
    )[0]?.value;
  const topEvaluation =
    primaryCandidate?.evaluationProtocol ??
    countTop(
      params.cards.map((card) => card.evaluationProtocol),
      1,
    )[0]?.value;
  const topIdea =
    primaryCandidate?.adoptableIdea ??
    countTop(
      params.cards.map((card) => card.adoptableIdea),
      1,
    )[0]?.value;
  const topFoundation =
    primaryCandidate?.foundationTemplate ??
    countTop(
      params.cards.map((card) => card.foundationTemplate),
      1,
    )[0]?.value;

  return renderUpgradePrompt({
    heading: `Frontier Upgrade Prompt: ${params.weekKey}`,
    intro: "Read this before starting another paper, whitepaper, or method-heavy research session.",
    rangeLabel: params.rangeLabel,
    bullets: [
      {
        label: "Primary Research Candidate",
        value: primaryCandidate?.title ?? "No candidate captured yet.",
      },
      {
        label: "Primary Verdict",
        value: primaryCandidate?.verdict ?? "watch_for_followup",
      },
      {
        label: "Main Leakage Check",
        value: topLeakage ?? "No leakage risk captured yet.",
      },
      {
        label: "Default Evaluation Standard",
        value: topEvaluation ?? "No evaluation standard captured yet.",
      },
      {
        label: "Method To Reuse",
        value: topIdea ?? "No reusable method note captured yet.",
      },
      {
        label: "Replication Cost Bias",
        value: primaryCandidate?.replicationCost ?? "medium",
      },
      {
        label: "Primary Foundation Transfer",
        value: topFoundation ?? "No foundation transfer captured yet.",
      },
    ],
    cueBody: `Before forming a verdict, check ${topLeakage ?? "the main leakage path"}, require ${topEvaluation ?? "a leakage-safe evaluation protocol"}, and ask whether the method really strengthens ${topFoundation ?? "a durable decision foundation"} before trusting reported gains.`,
  });
}

function buildMemoryNotes(params: {
  cards: ParsedResearchCard[];
  sessionKey: string;
  weekKey: string;
  rangeLabel: string;
}): MemoryNote[] {
  const contentByNoteName = {
    "frontier-methods-weekly-review": renderWeeklyMethodsReview(params),
    "frontier-upgrade": renderFrontierUpgrade(params),
    "frontier-replication-backlog": renderReplicationBacklog(params),
  } as const satisfies Record<(typeof FRONTIER_WEEKLY_MEMORY_NOTES)[number], string>;
  return FRONTIER_WEEKLY_MEMORY_NOTES.map((noteName) => ({
    filename: buildFrontierRecallFilename(params.weekKey, noteName),
    content: contentByNoteName[noteName],
  }));
}

const saveFrontierResearchWeeklyReview: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const cfg = event.context?.cfg as OpenClawConfig | undefined;
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
    const workspaceDir = cfg
      ? resolveAgentWorkspaceDir(cfg, agentId)
      : path.join(resolveStateDir(process.env, os.homedir), "workspace");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    const now = new Date(event.timestamp);
    const cards = await loadRecentResearchCards(memoryDir, now);
    if (cards.length === 0) {
      return;
    }

    const { weekKey, rangeLabel } = formatIsoWeek(now);
    const notes = buildMemoryNotes({
      cards,
      sessionKey: event.sessionKey,
      weekKey,
      rangeLabel,
    });
    await writeMemoryNotes(memoryDir, notes);

    log.info(
      `Frontier weekly review saved to ${path.join(memoryDir, notes[0].filename).replace(os.homedir(), "~")}`,
    );
  } catch (err) {
    log.error("Failed to save frontier weekly review", { error: String(err) });
  }
};

export default saveFrontierResearchWeeklyReview;
