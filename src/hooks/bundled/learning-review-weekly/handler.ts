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
  countTop,
  formatIsoWeek,
  type MemoryNote,
  toUtcDateOnly,
  writeMemoryNotes,
} from "../weekly-memory.js";

const log = createSubsystemLogger("hooks/learning-review-weekly");
const REVIEW_FILE_RE = /^(\d{4}-\d{2}-\d{2})-review-.*\.md$/;

type ParsedReview = {
  name: string;
  date: string;
  topic: string;
  mistakePattern: string;
  corePrinciple: string;
  microDrill: string;
  transferHint: string;
};

type TopicRollup = {
  topic: string;
  count: number;
  lastSeen: string;
  mistakePatterns: string[];
  corePrinciples: string[];
  microDrills: string[];
  transferHints: string[];
};

type TopicState = "stable" | "fragile" | "new";
type LearningPriority = "do-now" | "do-next" | "park";

function parseReviewContent(name: string, content: string): ParsedReview | undefined {
  const fileMatch = name.match(REVIEW_FILE_RE);
  if (!fileMatch) {
    return undefined;
  }
  const extract = (pattern: RegExp, fallback: string) => content.match(pattern)?.[1]?.trim() || fallback;
  return {
    name,
    date: fileMatch[1],
    topic: extract(/\*\*Topic\*\*:\s*([^\n]+)/, "unknown"),
    mistakePattern: extract(/^- mistake_pattern:\s*(.+)$/m, "No recurring mistake captured."),
    corePrinciple: extract(/^- core_principle:\s*(.+)$/m, "No core principle captured."),
    microDrill: extract(/^- micro_drill:\s*(.+)$/m, "No micro-drill captured."),
    transferHint: extract(/^- transfer_hint:\s*(.+)$/m, "No transfer hint captured."),
  };
}

function buildTopicRollups(reviews: ParsedReview[]): TopicRollup[] {
  const rollups = new Map<string, TopicRollup>();
  for (const review of reviews) {
    const existing = rollups.get(review.topic);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = existing.lastSeen > review.date ? existing.lastSeen : review.date;
      existing.mistakePatterns.push(review.mistakePattern);
      existing.corePrinciples.push(review.corePrinciple);
      existing.microDrills.push(review.microDrill);
      existing.transferHints.push(review.transferHint);
      continue;
    }
    rollups.set(review.topic, {
      topic: review.topic,
      count: 1,
      lastSeen: review.date,
      mistakePatterns: [review.mistakePattern],
      corePrinciples: [review.corePrinciple],
      microDrills: [review.microDrill],
      transferHints: [review.transferHint],
    });
  }

  return [...rollups.values()].sort(
    (a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen) || a.topic.localeCompare(b.topic),
  );
}

function formatRollupLine(rollup: TopicRollup): string {
  const topPrinciple = countTop(rollup.corePrinciples, 1)[0]?.value ?? "no repeated principle yet";
  return `- ${rollup.topic} (${rollup.count}, last seen ${rollup.lastSeen}) - anchor: ${topPrinciple}`;
}

function classifyTopicState(rollup: TopicRollup, newestReviewDate: string): TopicState {
  if (rollup.count >= 2) {
    return "stable";
  }
  return rollup.lastSeen === newestReviewDate ? "new" : "fragile";
}

function formatStatefulRollupLine(rollup: TopicRollup, state: TopicState): string {
  return `${formatRollupLine(rollup)} - state: ${state}`;
}

function toPriority(state: TopicState): LearningPriority {
  switch (state) {
    case "fragile":
      return "do-now";
    case "new":
      return "do-next";
    default:
      return "park";
  }
}

function formatPriorityLine(params: {
  rollup: TopicRollup;
  state: TopicState;
  priority: LearningPriority;
}): string {
  const drill = countTop(params.rollup.microDrills, 1)[0]?.value ?? "repeat one short drill";
  return `- ${params.rollup.topic} (${params.priority}, ${params.state}) - next drill: ${drill}`;
}

function nextWeekFocus(rollups: TopicRollup[]): string[] {
  const weakTopics = rollups.filter((rollup) => rollup.count === 1);
  const source = weakTopics.length > 0 ? weakTopics : rollups.slice(0, 2);
  return source.map((rollup) => {
    const drill = countTop(rollup.microDrills, 1)[0]?.value ?? "repeat the topic with one short drill";
    return `- ${rollup.topic}: ${drill}`;
  });
}

function buildUpgradePrompt(params: {
  reviews: ParsedReview[];
  weekKey: string;
  rangeLabel: string;
}): string {
  const topicRollups = buildTopicRollups(params.reviews);
  const newestReviewDate = topicRollups[0]?.lastSeen ?? "";
  const weakTopic = topicRollups.find((rollup) => rollup.count === 1) ?? topicRollups[0];
  const stableTopic = topicRollups.find((rollup) => rollup.count >= 2) ?? topicRollups[0];
  const doNowTopic =
    topicRollups.find((rollup) => classifyTopicState(rollup, newestReviewDate) === "fragile") ??
    topicRollups.find((rollup) => classifyTopicState(rollup, newestReviewDate) === "new") ??
    stableTopic;
  const doNextTopic =
    topicRollups.find((rollup) => classifyTopicState(rollup, newestReviewDate) === "new") ??
    stableTopic ??
    weakTopic;
  const parkTopic =
    topicRollups.find((rollup) => classifyTopicState(rollup, newestReviewDate) === "stable") ??
    weakTopic;
  const topMistake = countTop(params.reviews.map((review) => review.mistakePattern), 1)[0]?.value;
  const topPrinciple = countTop(params.reviews.map((review) => review.corePrinciple), 1)[0]?.value;
  const topTransfer = countTop(params.reviews.map((review) => review.transferHint), 1)[0]?.value;
  const nextDrill = weakTopic
    ? countTop(weakTopic.microDrills, 1)[0]?.value
    : countTop(params.reviews.map((review) => review.microDrill), 1)[0]?.value;

  return [
    `# Learning Upgrade Prompt: ${params.weekKey}`,
    "",
    "Read this before starting another math, study, proof, or derivation-heavy session.",
    "",
    `- **Window**: ${params.rangeLabel}`,
    `- **Main Failure To Avoid**: ${topMistake ?? "No recurring failure captured yet."}`,
    `- **Default Method To Apply**: ${topPrinciple ?? "No default method captured yet."}`,
    `- **Stable Topic To Reuse**: ${stableTopic?.topic ?? "No stable topic yet."} (${stableTopic ? classifyTopicState(stableTopic, newestReviewDate) : "stable"})`,
    `- **Top Topic To Reinforce**: ${weakTopic?.topic ?? stableTopic?.topic ?? "No topic captured yet."} (${weakTopic ? classifyTopicState(weakTopic, newestReviewDate) : "new"})`,
    `- **Do Now**: ${doNowTopic?.topic ?? "No priority topic yet."} (do-now)`,
    `- **Do Next**: ${doNextTopic?.topic ?? "No next topic yet."} (do-next)`,
    `- **Park**: ${parkTopic?.topic ?? "No parked topic yet."} (park)`,
    `- **Next Micro-Drill**: ${nextDrill ?? "Repeat the latest topic with one short drill."}`,
    `- **Transfer Reminder**: ${topTransfer ?? "No transfer reminder captured yet."}`,
    "",
    "## Default Upgrade Cue",
    `Before solving, explicitly apply ${topPrinciple ?? "the strongest known principle"} and avoid ${topMistake ?? "the last observed failure mode"}.`,
    "",
  ].join("\n");
}

async function loadRecentReviews(memoryDir: string, now: Date): Promise<ParsedReview[]> {
  const weekStart = toUtcDateOnly(now);
  weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && REVIEW_FILE_RE.test(entry.name))
        .map(async (entry) => {
          const content = await fs.readFile(path.join(memoryDir, entry.name), "utf-8");
          return parseReviewContent(entry.name, content);
        }),
    );
    return parsed
      .filter((review): review is ParsedReview => Boolean(review))
      .filter((review) => {
        const date = new Date(`${review.date}T00:00:00.000Z`);
        return date >= weekStart && date <= toUtcDateOnly(now);
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}

function renderWeeklySummary(params: {
  reviews: ParsedReview[];
  sessionKey: string;
  weekKey: string;
  rangeLabel: string;
}): string {
  const topicRollups = buildTopicRollups(params.reviews);
  const newestReviewDate = topicRollups[0]?.lastSeen ?? "";
  const stableTopics = topicRollups.filter((rollup) => classifyTopicState(rollup, newestReviewDate) === "stable");
  const fragileTopics = topicRollups.filter((rollup) => classifyTopicState(rollup, newestReviewDate) === "fragile");
  const newTopics = topicRollups.filter((rollup) => classifyTopicState(rollup, newestReviewDate) === "new");
  const doNowTopics = topicRollups.filter(
    (rollup) => toPriority(classifyTopicState(rollup, newestReviewDate)) === "do-now",
  );
  const doNextTopics = topicRollups.filter(
    (rollup) => toPriority(classifyTopicState(rollup, newestReviewDate)) === "do-next",
  );
  const parkTopics = topicRollups.filter(
    (rollup) => toPriority(classifyTopicState(rollup, newestReviewDate)) === "park",
  );
  const topics = countTop(params.reviews.map((review) => review.topic));
  const mistakes = countTop(params.reviews.map((review) => review.mistakePattern));
  const principles = countTop(params.reviews.map((review) => review.corePrinciple));
  const drills = countTop(params.reviews.map((review) => review.microDrill));
  const transfers = countTop(params.reviews.map((review) => review.transferHint), 2);
  const nextFocus = nextWeekFocus(topicRollups);
  const upgradePrompt = buildUpgradePrompt(params)
    .split("\n")
    .filter((line) => line.startsWith("- **"));

  return [
    `# Weekly Learning Review: ${params.weekKey}`,
    "",
    `- **Window**: ${params.rangeLabel}`,
    `- **Session Key**: ${params.sessionKey}`,
    `- **Review Count**: ${params.reviews.length}`,
    `- **Stable Topic Count**: ${stableTopics.length}`,
    `- **Fragile Topic Count**: ${fragileTopics.length}`,
    `- **New Topic Count**: ${newTopics.length}`,
    "",
    "## Stable Topics",
    ...(stableTopics.length > 0
      ? stableTopics.map((rollup) => formatStatefulRollupLine(rollup, "stable"))
      : ["- None yet. Keep accumulating repeated reviews before calling a topic stable."]),
    "",
    "## Fragile Topics",
    ...(fragileTopics.length > 0
      ? fragileTopics.map((rollup) => formatStatefulRollupLine(rollup, "fragile"))
      : ["- None this week. No older one-off topics are currently slipping."]),
    "",
    "## New Topics",
    ...(newTopics.length > 0
      ? newTopics.map((rollup) => formatStatefulRollupLine(rollup, "new"))
      : ["- None this week. No newly introduced single-touch topics detected."]),
    "",
    "## Learning Priorities",
    "### Do Now",
    ...(doNowTopics.length > 0
      ? doNowTopics.map((rollup) =>
          formatPriorityLine({
            rollup,
            state: classifyTopicState(rollup, newestReviewDate),
            priority: "do-now",
          }),
        )
      : ["- Nothing urgent right now."]),
    "",
    "### Do Next",
    ...(doNextTopics.length > 0
      ? doNextTopics.map((rollup) =>
          formatPriorityLine({
            rollup,
            state: classifyTopicState(rollup, newestReviewDate),
            priority: "do-next",
          }),
        )
      : ["- No queued next topics right now."]),
    "",
    "### Park",
    ...(parkTopics.length > 0
      ? parkTopics.map((rollup) =>
          formatPriorityLine({
            rollup,
            state: classifyTopicState(rollup, newestReviewDate),
            priority: "park",
          }),
        )
      : ["- Nothing to park right now."]),
    "",
    "## Topic Coverage Snapshot",
    ...topics.map((entry) => `- ${entry.value} (${entry.count})`),
    "",
    "## Recurring Mistake Patterns",
    ...mistakes.map((entry) => `- ${entry.value} (${entry.count})`),
    "",
    "## Reinforced Core Principles",
    ...principles.map((entry) => `- ${entry.value} (${entry.count})`),
    "",
    "## Next Micro-Drills",
    ...drills.map((entry) => `- ${entry.value} (${entry.count})`),
    "",
    "## Transfer Priorities",
    ...transfers.map((entry) => `- ${entry.value} (${entry.count})`),
    "",
    "## Next Week Focus",
    ...nextFocus,
    "",
    "## Upgrade Prompt",
    ...upgradePrompt,
    "",
    "## Source Reviews",
    ...params.reviews.map((review) => `- ${review.date}: ${review.name}`),
    "",
  ].join("\n");
}

function buildMemoryNotes(params: {
  reviews: ParsedReview[];
  sessionKey: string;
  weekKey: string;
  rangeLabel: string;
}): MemoryNote[] {
  return [
    {
      filename: `${params.weekKey}-learning-weekly-review.md`,
      content: renderWeeklySummary(params),
    },
    {
      filename: `${params.weekKey}-learning-upgrade.md`,
      content: buildUpgradePrompt(params),
    },
  ];
}

const saveWeeklyLearningReview: HookHandler = async (event) => {
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
    const reviews = await loadRecentReviews(memoryDir, now);
    if (reviews.length === 0) {
      return;
    }

    const { weekKey, rangeLabel } = formatIsoWeek(now);
    const notes = buildMemoryNotes({
      reviews,
      sessionKey: event.sessionKey,
      weekKey,
      rangeLabel,
    });
    await writeMemoryNotes(memoryDir, notes);

    log.info(
      `Weekly learning review saved to ${path.join(memoryDir, notes[0]!.filename).replace(os.homedir(), "~")}`,
    );
  } catch (err) {
    log.error("Failed to save weekly learning review", { error: String(err) });
  }
};

export default saveWeeklyLearningReview;
