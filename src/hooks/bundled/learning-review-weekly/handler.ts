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
  foundationTemplateForTopic,
  inferTopic,
  reviewHintsForTopic,
} from "../learning-review/handler.js";
import {
  buildLearningRecallFilename,
  isLearningReviewNoteFilename,
  isLearningCouncilMemoryNoteFilename,
  LEARNING_WEEKLY_MEMORY_NOTES,
  parseLearningReviewMemoryNote,
  parseLearningCouncilMemoryNote,
  type LearningRecallMemoryNote,
} from "../lobster-brain-registry.js";
import { renderUpgradePrompt } from "../upgrade-memory.js";
import {
  countTop,
  formatIsoWeek,
  type MemoryNote,
  toUtcDateOnly,
  writeMemoryNotes,
} from "../weekly-memory.js";

const log = createSubsystemLogger("hooks/learning-review-weekly");

type ParsedReview = {
  name: string;
  date: string;
  topic: string;
  foundationTemplate: string;
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
  const parsedNote = parseLearningReviewMemoryNote({ filename: name, content });
  if (!parsedNote) {
    return undefined;
  }
  return {
    name: parsedNote.name,
    date: parsedNote.date,
    topic: parsedNote.topic,
    foundationTemplate: parsedNote.foundationTemplate,
    mistakePattern: parsedNote.mistakePattern,
    corePrinciple: parsedNote.corePrinciple,
    microDrill: parsedNote.microDrill,
    transferHint: parsedNote.transferHint,
  };
}

function parseLearningCouncilContent(name: string, content: string): ParsedReview | undefined {
  const parsedNote = parseLearningCouncilMemoryNote({ filename: name, content });
  if (!parsedNote) {
    return undefined;
  }
  const topic = inferTopic([
    { role: "user", text: parsedNote.userMessage },
    { role: "assistant", text: parsedNote.finalReplySnapshot },
  ]);
  const hints = reviewHintsForTopic(topic);
  return {
    name,
    date: parsedNote.date,
    topic,
    foundationTemplate: foundationTemplateForTopic(topic),
    mistakePattern: parsedNote.discardLines[0] ?? hints.mistake,
    corePrinciple: parsedNote.keeperLines[0] ?? hints.principle,
    microDrill: parsedNote.nextEvalCueLines[0] ?? hints.drill,
    transferHint: parsedNote.rehearsalTriggerLines[0] ?? hints.transfer,
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

  return [...rollups.values()].toSorted(
    (a, b) =>
      b.count - a.count || b.lastSeen.localeCompare(a.lastSeen) || a.topic.localeCompare(b.topic),
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
    const drill =
      countTop(rollup.microDrills, 1)[0]?.value ?? "repeat the topic with one short drill";
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
  const topMistake = countTop(
    params.reviews.map((review) => review.mistakePattern),
    1,
  )[0]?.value;
  const topPrinciple = countTop(
    params.reviews.map((review) => review.corePrinciple),
    1,
  )[0]?.value;
  const topTransfer = countTop(
    params.reviews.map((review) => review.transferHint),
    1,
  )[0]?.value;
  const topFoundation = countTop(
    params.reviews.map((review) => review.foundationTemplate),
    1,
  )[0]?.value;
  const nextDrill = weakTopic
    ? countTop(weakTopic.microDrills, 1)[0]?.value
    : countTop(
        params.reviews.map((review) => review.microDrill),
        1,
      )[0]?.value;

  return renderUpgradePrompt({
    heading: `Learning Upgrade Prompt: ${params.weekKey}`,
    intro: "Read this before starting another math, study, proof, or derivation-heavy session.",
    rangeLabel: params.rangeLabel,
    bullets: [
      {
        label: "Main Failure To Avoid",
        value: topMistake ?? "No recurring failure captured yet.",
      },
      {
        label: "Default Method To Apply",
        value: topPrinciple ?? "No default method captured yet.",
      },
      {
        label: "Stable Topic To Reuse",
        value: `${stableTopic?.topic ?? "No stable topic yet."} (${stableTopic ? classifyTopicState(stableTopic, newestReviewDate) : "stable"})`,
      },
      {
        label: "Top Topic To Reinforce",
        value: `${weakTopic?.topic ?? stableTopic?.topic ?? "No topic captured yet."} (${weakTopic ? classifyTopicState(weakTopic, newestReviewDate) : "new"})`,
      },
      {
        label: "Do Now",
        value: `${doNowTopic?.topic ?? "No priority topic yet."} (do-now)`,
      },
      {
        label: "Do Next",
        value: `${doNextTopic?.topic ?? "No next topic yet."} (do-next)`,
      },
      {
        label: "Park",
        value: `${parkTopic?.topic ?? "No parked topic yet."} (park)`,
      },
      {
        label: "Next Micro-Drill",
        value: nextDrill ?? "Repeat the latest topic with one short drill.",
      },
      {
        label: "Transfer Reminder",
        value: topTransfer ?? "No transfer reminder captured yet.",
      },
      {
        label: "Dominant Foundation Template",
        value: topFoundation ?? "No foundation template captured yet.",
      },
    ],
    cueBody: `Before solving, explicitly apply ${topPrinciple ?? "the strongest known principle"}, route the work through ${topFoundation ?? "the dominant foundation template"}, and avoid ${topMistake ?? "the last observed failure mode"}.`,
  });
}

async function loadRecentReviews(memoryDir: string, now: Date): Promise<ParsedReview[]> {
  const parsed = await loadAllReviews(memoryDir);
  const weekStart = toUtcDateOnly(now);
  weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  return parsed
    .filter((review) => {
      const date = new Date(`${review.date}T00:00:00.000Z`);
      return date >= weekStart && date <= toUtcDateOnly(now);
    })
    .toSorted((a, b) => b.date.localeCompare(a.date));
}

async function loadAllReviews(memoryDir: string): Promise<ParsedReview[]> {
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() &&
            (isLearningReviewNoteFilename(entry.name) ||
              isLearningCouncilMemoryNoteFilename(entry.name)),
        )
        .map(async (entry) => {
          const content = await fs.readFile(path.join(memoryDir, entry.name), "utf-8");
          return isLearningReviewNoteFilename(entry.name)
            ? parseReviewContent(entry.name, content)
            : parseLearningCouncilContent(entry.name, content);
        }),
    );
    return parsed
      .filter((review): review is ParsedReview => Boolean(review))
      .toSorted((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}

function renderLongTermCatalog(params: {
  reviews: ParsedReview[];
  weekKey: string;
  rangeLabel: string;
  sessionKey: string;
}): string {
  const rollups = buildTopicRollups(params.reviews);
  const newestReviewDate = rollups[0]?.lastSeen ?? "";
  const stableTopics = rollups.filter(
    (rollup) => classifyTopicState(rollup, newestReviewDate) === "stable",
  );
  const fragileTopics = rollups.filter(
    (rollup) => classifyTopicState(rollup, newestReviewDate) === "fragile",
  );
  const newTopics = rollups.filter(
    (rollup) => classifyTopicState(rollup, newestReviewDate) === "new",
  );

  return [
    `# Learning Long-Term Catalog: ${params.weekKey}`,
    "",
    `- **As Of**: ${params.rangeLabel}`,
    `- **Session Key**: ${params.sessionKey}`,
    `- **Total Review Count**: ${params.reviews.length}`,
    `- **Tracked Topic Count**: ${rollups.length}`,
    `- **Stable Topic Count**: ${stableTopics.length}`,
    `- **Fragile Topic Count**: ${fragileTopics.length}`,
    `- **New Topic Count**: ${newTopics.length}`,
    "",
    "## Catalog Rule",
    "- this file is broad coverage memory: it keeps all learned topics visible for later retrieval, even when they are not yet strong enough to become primary working-memory anchors.",
    "- stable topics are reusable by default; fragile and new topics are searchable but should stay provisional until reinforced.",
    "",
    "## All Tracked Topics",
    ...(rollups.length > 0
      ? rollups.map((rollup) => {
          const state = classifyTopicState(rollup, newestReviewDate);
          const priority = toPriority(state);
          const anchor =
            countTop(rollup.corePrinciples, 1)[0]?.value ?? "no repeated principle yet";
          const drill = countTop(rollup.microDrills, 1)[0]?.value ?? "repeat one short drill";
          return `- ${rollup.topic} (${rollup.count}, last seen ${rollup.lastSeen}) - state: ${state} - priority: ${priority} - anchor: ${anchor} - next drill: ${drill}`;
        })
      : ["- No learning topics have been captured yet."]),
    "",
  ].join("\n");
}

function renderWeeklySummary(params: {
  reviews: ParsedReview[];
  sessionKey: string;
  weekKey: string;
  rangeLabel: string;
}): string {
  const topicRollups = buildTopicRollups(params.reviews);
  const newestReviewDate = topicRollups[0]?.lastSeen ?? "";
  const stableTopics = topicRollups.filter(
    (rollup) => classifyTopicState(rollup, newestReviewDate) === "stable",
  );
  const fragileTopics = topicRollups.filter(
    (rollup) => classifyTopicState(rollup, newestReviewDate) === "fragile",
  );
  const newTopics = topicRollups.filter(
    (rollup) => classifyTopicState(rollup, newestReviewDate) === "new",
  );
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
  const transfers = countTop(
    params.reviews.map((review) => review.transferHint),
    2,
  );
  const nextFocus = nextWeekFocus(topicRollups);
  const foundationTemplates = countTop(params.reviews.map((review) => review.foundationTemplate));
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
    "## Foundation Template Focus",
    ...foundationTemplates.map((entry) => `- ${entry.value} (${entry.count})`),
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

function renderDurableSkillMemory(params: {
  reviews: ParsedReview[];
  weekKey: string;
  rangeLabel: string;
  sessionKey: string;
}): string {
  const rollups = buildTopicRollups(params.reviews);
  return [
    `# Learning Durable Skills: ${params.weekKey}`,
    "",
    `- **As Of**: ${params.rangeLabel}`,
    `- **Session Key**: ${params.sessionKey}`,
    `- **Tracked Skill Topics**: ${rollups.length}`,
    "",
    "## Contract",
    "- math, quant, and coding lessons should stay durable once learned; update them with correction notes and stronger methods instead of letting them disappear from long-term reuse.",
    "- this file is for reusable application memory: each entry keeps the default method, common failure, next drill, and transfer surface together.",
    "",
    "## Reusable Skill Entries",
    ...(rollups.length > 0
      ? rollups.flatMap((rollup) => {
          const defaultMethod =
            countTop(rollup.corePrinciples, 1)[0]?.value ?? "no default method captured yet";
          const commonFailure =
            countTop(rollup.mistakePatterns, 1)[0]?.value ?? "no common failure captured yet";
          const nextDrill = countTop(rollup.microDrills, 1)[0]?.value ?? "repeat one short drill";
          const transferSurface =
            countTop(rollup.transferHints, 1)[0]?.value ?? "no transfer surface captured yet";
          return [
            `### ${rollup.topic}`,
            `- learned_count: ${rollup.count}`,
            `- last_seen: ${rollup.lastSeen}`,
            `- default_method: ${defaultMethod}`,
            `- common_failure: ${commonFailure}`,
            `- next_drill: ${nextDrill}`,
            `- transfer_surface: ${transferSurface}`,
            "",
          ];
        })
      : ["- No durable skill topic has been captured yet.", ""]),
  ].join("\n");
}

function inferTriggerSurface(topic: string): string {
  switch (topic) {
    case "quant-modeling":
      return "backtest, factor, alpha, ranking, Sharpe, OOS, leakage, or parameter-fragility questions";
    case "time-series-and-volatility":
      return "GARCH, LSTM, ARIMA, volatility, realized vol, regime, or time-series forecast questions";
    case "coding-and-systems":
      return "code, debugging, patch, routing, shared-state, memory, or system architecture work";
    case "probability-and-statistics":
      return "probability, Bayes, expectation, variance, uncertainty, or evidence-weighting tasks";
    case "linear-algebra":
      return "matrix, eigenvalue, PCA, regression geometry, or state-transition work";
    case "calculus":
      return "derivative, integral, sensitivity, rate-of-change, or continuous-time tasks";
    case "optimization":
      return "objective, constraint, feasible-set, sizing, ranking, or search problems";
    case "proof-technique":
      return "proof, derivation, logical validation, or method-audit tasks";
    default:
      return "study-heavy work that needs a default method before improvisation";
  }
}

function renderLearningTriggerMap(params: {
  reviews: ParsedReview[];
  weekKey: string;
  rangeLabel: string;
  sessionKey: string;
}): string {
  const rollups = buildTopicRollups(params.reviews);
  return [
    `# Learning Trigger Map: ${params.weekKey}`,
    "",
    `- **As Of**: ${params.rangeLabel}`,
    `- **Session Key**: ${params.sessionKey}`,
    `- **Trigger Topic Count**: ${rollups.length}`,
    "",
    "## Contract",
    "- this file turns learned skills into default trigger cues so later tasks can pull the right method before improvising from scratch.",
    "",
    "## Trigger Entries",
    ...(rollups.length > 0
      ? rollups.flatMap((rollup) => {
          const defaultMethod =
            countTop(rollup.corePrinciples, 1)[0]?.value ?? "no default method captured yet";
          const commonFailure =
            countTop(rollup.mistakePatterns, 1)[0]?.value ?? "no common failure captured yet";
          const transferSurface =
            countTop(rollup.transferHints, 1)[0]?.value ?? "no transfer surface captured yet";
          return [
            `### ${rollup.topic}`,
            `- when_you_see: ${inferTriggerSurface(rollup.topic)}`,
            `- apply: ${defaultMethod}`,
            `- avoid: ${commonFailure}`,
            `- transfer_to: ${transferSurface}`,
            "",
          ];
        })
      : ["- No trigger entry has been captured yet.", ""]),
  ].join("\n");
}

function renderLearningRehearsalQueue(params: {
  reviews: ParsedReview[];
  weekKey: string;
  rangeLabel: string;
  sessionKey: string;
}): string {
  const rollups = buildTopicRollups(params.reviews);
  const newestReviewDate = rollups[0]?.lastSeen ?? "";
  const doNowTopics = rollups.filter(
    (rollup) => toPriority(classifyTopicState(rollup, newestReviewDate)) === "do-now",
  );
  const doNextTopics = rollups.filter(
    (rollup) => toPriority(classifyTopicState(rollup, newestReviewDate)) === "do-next",
  );
  const parkTopics = rollups.filter(
    (rollup) => toPriority(classifyTopicState(rollup, newestReviewDate)) === "park",
  );

  const formatQueueLine = (rollup: TopicRollup) => {
    const state = classifyTopicState(rollup, newestReviewDate);
    const drill = countTop(rollup.microDrills, 1)[0]?.value ?? "repeat one short drill";
    const method = countTop(rollup.corePrinciples, 1)[0]?.value ?? "no default method captured yet";
    return `- ${rollup.topic} (${state}) - drill: ${drill} - apply: ${method}`;
  };

  return [
    `# Learning Rehearsal Queue: ${params.weekKey}`,
    "",
    `- **As Of**: ${params.rangeLabel}`,
    `- **Session Key**: ${params.sessionKey}`,
    "",
    "## Contract",
    "- learning only becomes durable skill if the method gets reused again; this queue is the weekly repetition plan.",
    "",
    "## Do Now",
    ...(doNowTopics.length > 0
      ? doNowTopics.map(formatQueueLine)
      : ["- no urgent rehearsal topic right now."]),
    "",
    "## Do Next",
    ...(doNextTopics.length > 0
      ? doNextTopics.map(formatQueueLine)
      : ["- no queued next rehearsal topic right now."]),
    "",
    "## Park",
    ...(parkTopics.length > 0 ? parkTopics.map(formatQueueLine) : ["- nothing to park right now."]),
    "",
  ].join("\n");
}

function renderLearningTransferBridges(params: {
  reviews: ParsedReview[];
  weekKey: string;
  rangeLabel: string;
  sessionKey: string;
}): string {
  const rollups = buildTopicRollups(params.reviews);
  return [
    `# Learning Transfer Bridges: ${params.weekKey}`,
    "",
    `- **As Of**: ${params.rangeLabel}`,
    `- **Session Key**: ${params.sessionKey}`,
    "",
    "## Contract",
    "- use this file to carry learned methods across domains instead of leaving them trapped inside the original study topic.",
    "",
    "## Bridge Entries",
    ...(rollups.length > 0
      ? rollups.flatMap((rollup) => {
          const defaultMethod =
            countTop(rollup.corePrinciples, 1)[0]?.value ?? "no default method captured yet";
          const transferSurface =
            countTop(rollup.transferHints, 1)[0]?.value ?? "no transfer surface captured yet";
          const commonFailure =
            countTop(rollup.mistakePatterns, 1)[0]?.value ?? "no common failure captured yet";
          return [
            `### ${rollup.topic}`,
            `- transfer_to: ${transferSurface}`,
            `- reuse_rule: ${defaultMethod}`,
            `- invalid_if: ${commonFailure}`,
            "",
          ];
        })
      : ["- No transfer bridge has been captured yet.", ""]),
  ].join("\n");
}

type RelevanceTier = "primary-call" | "secondary-call" | "reference-only";

function toRelevanceTier(rollup: TopicRollup, newestReviewDate: string): RelevanceTier {
  const state = classifyTopicState(rollup, newestReviewDate);
  if (state === "stable") {
    return "primary-call";
  }
  if (state === "new" && rollup.lastSeen === newestReviewDate) {
    return "secondary-call";
  }
  return "reference-only";
}

function renderLearningRelevanceGate(params: {
  reviews: ParsedReview[];
  weekKey: string;
  rangeLabel: string;
  sessionKey: string;
}): string {
  const rollups = buildTopicRollups(params.reviews);
  const newestReviewDate = rollups[0]?.lastSeen ?? "";
  const primary = rollups.filter(
    (rollup) => toRelevanceTier(rollup, newestReviewDate) === "primary-call",
  );
  const secondary = rollups.filter(
    (rollup) => toRelevanceTier(rollup, newestReviewDate) === "secondary-call",
  );
  const referenceOnly = rollups.filter(
    (rollup) => toRelevanceTier(rollup, newestReviewDate) === "reference-only",
  );
  const formatLine = (rollup: TopicRollup) => {
    const method = countTop(rollup.corePrinciples, 1)[0]?.value ?? "no default method captured yet";
    return `- ${rollup.topic} (${rollup.count}, last seen ${rollup.lastSeen}) - default method: ${method}`;
  };

  return [
    `# Learning Relevance Gate: ${params.weekKey}`,
    "",
    `- **As Of**: ${params.rangeLabel}`,
    `- **Session Key**: ${params.sessionKey}`,
    "",
    "## Contract",
    "- use this file to decide how strongly a learned skill should be pulled into new tasks.",
    "- primary-call topics should be used by default when the task matches.",
    "- secondary-call topics should be checked next when the task is adjacent but not identical.",
    "- reference-only topics stay searchable but should not dominate the answer unless explicitly needed.",
    "",
    "## Primary Call",
    ...(primary.length > 0 ? primary.map(formatLine) : ["- no primary-call topic yet."]),
    "",
    "## Secondary Call",
    ...(secondary.length > 0 ? secondary.map(formatLine) : ["- no secondary-call topic yet."]),
    "",
    "## Reference Only",
    ...(referenceOnly.length > 0
      ? referenceOnly.map(formatLine)
      : ["- no reference-only topic yet."]),
    "",
  ].join("\n");
}

function buildMemoryNotes(params: {
  reviews: ParsedReview[];
  allReviews: ParsedReview[];
  sessionKey: string;
  weekKey: string;
  rangeLabel: string;
}): MemoryNote[] {
  const renderers: Record<LearningRecallMemoryNote, () => string> = {
    "learning-weekly-review": () => renderWeeklySummary(params),
    "learning-upgrade": () => buildUpgradePrompt(params),
    "learning-long-term-catalog": () =>
      renderLongTermCatalog({
        reviews: params.allReviews,
        sessionKey: params.sessionKey,
        weekKey: params.weekKey,
        rangeLabel: params.rangeLabel,
      }),
    "learning-durable-skills": () =>
      renderDurableSkillMemory({
        reviews: params.allReviews,
        sessionKey: params.sessionKey,
        weekKey: params.weekKey,
        rangeLabel: params.rangeLabel,
      }),
    "learning-trigger-map": () =>
      renderLearningTriggerMap({
        reviews: params.allReviews,
        sessionKey: params.sessionKey,
        weekKey: params.weekKey,
        rangeLabel: params.rangeLabel,
      }),
    "learning-rehearsal-queue": () =>
      renderLearningRehearsalQueue({
        reviews: params.allReviews,
        sessionKey: params.sessionKey,
        weekKey: params.weekKey,
        rangeLabel: params.rangeLabel,
      }),
    "learning-transfer-bridges": () =>
      renderLearningTransferBridges({
        reviews: params.allReviews,
        sessionKey: params.sessionKey,
        weekKey: params.weekKey,
        rangeLabel: params.rangeLabel,
      }),
    "learning-relevance-gate": () =>
      renderLearningRelevanceGate({
        reviews: params.allReviews,
        sessionKey: params.sessionKey,
        weekKey: params.weekKey,
        rangeLabel: params.rangeLabel,
      }),
  };

  return LEARNING_WEEKLY_MEMORY_NOTES.map((noteName) => ({
    filename: buildLearningRecallFilename(params.weekKey, noteName),
    content: renderers[noteName](),
  }));
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
    const allReviews = await loadAllReviews(memoryDir);
    if (reviews.length === 0) {
      return;
    }

    const { weekKey, rangeLabel } = formatIsoWeek(now);
    const notes = buildMemoryNotes({
      reviews,
      allReviews,
      sessionKey: event.sessionKey,
      weekKey,
      rangeLabel,
    });
    await writeMemoryNotes(memoryDir, notes);

    log.info(
      `Weekly learning review saved to ${path.join(memoryDir, notes[0].filename).replace(os.homedir(), "~")}`,
    );
  } catch (err) {
    log.error("Failed to save weekly learning review", { error: String(err) });
  }
};

export default saveWeeklyLearningReview;
