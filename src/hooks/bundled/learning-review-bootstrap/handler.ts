import { filterBootstrapFilesForSession } from "../../../agents/workspace.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";
import {
  buildSyntheticMemoryContext,
  loadNewestMemoryNote,
  loadRecentMemoryNotes,
  resolveRecentCount,
} from "../bootstrap-memory.js";
import {
  buildLobsterWorkfaceLearningCarryoverCue,
  LEARNING_BOOTSTRAP_PRIORITY_SECTIONS,
  LEARNING_RECALL_MEMORY_NOTES,
  parseLearningDurableSkillsArtifact,
  parseLearningRehearsalQueueArtifact,
  parseLearningRelevanceGateArtifact,
  parseLearningTransferBridgesArtifact,
  parseLearningTriggerMapArtifact,
  parseLearningUpgradeArtifact,
  type LearningRecallMemoryNote,
} from "../lobster-brain-registry.js";

const HOOK_KEY = "learning-review-bootstrap";
const log = createSubsystemLogger("learning-review-bootstrap");
type LoadedMemoryNote = Awaited<ReturnType<typeof loadNewestMemoryNote>>;

function buildImmediateStudyCue(upgradeContent?: string): string | undefined {
  if (!upgradeContent) {
    return undefined;
  }
  const parsed = parseLearningUpgradeArtifact(upgradeContent);
  const avoid = parsed?.mainFailureToAvoid;
  const apply = parsed?.defaultMethodToApply;
  const doNow = parsed?.doNow;
  const lines = [
    avoid ? `- avoid: ${avoid}` : undefined,
    apply ? `- apply: ${apply}` : undefined,
    doNow ? `- do now: ${doNow}` : undefined,
  ].filter((line): line is string => Boolean(line));
  if (lines.length === 0) {
    return undefined;
  }
  return lines.join("\n");
}

function buildDurableSkillCue(durableSkillsContent?: string): string | undefined {
  if (!durableSkillsContent) {
    return undefined;
  }
  const parsed = parseLearningDurableSkillsArtifact(durableSkillsContent);
  const lines = [
    parsed?.defaultTopic ? `- default topic: ${parsed.defaultTopic}` : undefined,
    parsed?.defaultMethod ? `- default method: ${parsed.defaultMethod}` : undefined,
    parsed?.commonFailure ? `- common failure: ${parsed.commonFailure}` : undefined,
  ].filter((line): line is string => Boolean(line));
  if (lines.length === 0) {
    return undefined;
  }
  return lines.join("\n");
}

function buildTriggerCue(triggerMapContent?: string): string | undefined {
  if (!triggerMapContent) {
    return undefined;
  }
  const parsed = parseLearningTriggerMapArtifact(triggerMapContent);
  const lines = [
    parsed?.whenYouSee ? `- when you see: ${parsed.whenYouSee}` : undefined,
    parsed?.apply ? `- apply: ${parsed.apply}` : undefined,
    parsed?.avoid ? `- avoid: ${parsed.avoid}` : undefined,
  ].filter((line): line is string => Boolean(line));
  if (lines.length === 0) {
    return undefined;
  }
  return lines.join("\n");
}

function buildRehearsalCue(rehearsalQueueContent?: string): string | undefined {
  if (!rehearsalQueueContent) {
    return undefined;
  }
  const parsed = parseLearningRehearsalQueueArtifact(rehearsalQueueContent);
  if (!parsed?.doNowLine) {
    return undefined;
  }
  return parsed.doNowLine;
}

function buildTransferCue(transferBridgesContent?: string): string | undefined {
  if (!transferBridgesContent) {
    return undefined;
  }
  const parsed = parseLearningTransferBridgesArtifact(transferBridgesContent);
  const lines = [
    parsed?.transferTo ? `- transfer to: ${parsed.transferTo}` : undefined,
    parsed?.reuseRule ? `- reuse rule: ${parsed.reuseRule}` : undefined,
  ].filter((line): line is string => Boolean(line));
  if (lines.length === 0) {
    return undefined;
  }
  return lines.join("\n");
}

function buildRelevanceCue(relevanceGateContent?: string): string | undefined {
  if (!relevanceGateContent) {
    return undefined;
  }
  return parseLearningRelevanceGateArtifact(relevanceGateContent)?.primaryCall || undefined;
}

const learningReviewBootstrapHook: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const context = event.context;
  const hookConfig = resolveHookConfig(context.cfg, HOOK_KEY);
  if (!hookConfig || hookConfig.enabled === false) {
    return;
  }

  const recentCount = resolveRecentCount(hookConfig as Record<string, unknown>);
  try {
    const learningNotes = new Map<LearningRecallMemoryNote, LoadedMemoryNote>();
    for (const noteName of LEARNING_RECALL_MEMORY_NOTES) {
      learningNotes.set(
        noteName,
        await loadNewestMemoryNote({
          workspaceDir: context.workspaceDir,
          includes: noteName,
        }),
      );
    }
    const upgradePrompt = learningNotes.get("learning-upgrade");
    const durableSkills = learningNotes.get("learning-durable-skills");
    const triggerMap = learningNotes.get("learning-trigger-map");
    const rehearsalQueue = learningNotes.get("learning-rehearsal-queue");
    const transferBridges = learningNotes.get("learning-transfer-bridges");
    const relevanceGate = learningNotes.get("learning-relevance-gate");
    const latestWorkface = await loadNewestMemoryNote({
      workspaceDir: context.workspaceDir,
      includes: "lobster-workface",
    });
    const immediateCue = buildImmediateStudyCue(upgradePrompt?.content);
    const durableSkillCue = buildDurableSkillCue(durableSkills?.content);
    const triggerCue = buildTriggerCue(triggerMap?.content);
    const rehearsalCue = buildRehearsalCue(rehearsalQueue?.content);
    const transferCue = buildTransferCue(transferBridges?.content);
    const relevanceCue = buildRelevanceCue(relevanceGate?.content);
    const latestWorkfaceCue = buildLobsterWorkfaceLearningCarryoverCue(latestWorkface?.content);
    const reviews = await loadRecentMemoryNotes({
      workspaceDir: context.workspaceDir,
      recentCount,
      includes: "-review-",
      excludes: ["learning-weekly-review"],
    });
    if (
      reviews.length === 0 &&
      [...learningNotes.values()].every((note) => !note) &&
      !latestWorkfaceCue
    ) {
      return;
    }

    context.bootstrapFiles = filterBootstrapFilesForSession(
      [
        ...context.bootstrapFiles,
        buildSyntheticMemoryContext({
          title: "Recent Learning Reviews",
          intro: [
            "Use these notes as recent study memory before solving similar problems again.",
            "Read the learning upgrade first, then the weekly summary, then the raw review notes if you need detail.",
          ],
          sections: [
            {
              heading: "Immediate Study Cue",
              note: immediateCue
                ? {
                    name: "derived-immediate-study-cue.md",
                    path: "_derived-immediate-study-cue.md",
                    content: immediateCue,
                  }
                : undefined,
              maxChars: 220,
            },
            {
              heading: "Latest Learning Carryover Cue",
              note: latestWorkfaceCue
                ? {
                    name: "derived-latest-learning-carryover-cue.md",
                    path: "_derived-latest-learning-carryover-cue.md",
                    content: latestWorkfaceCue,
                  }
                : undefined,
              maxChars: 360,
            },
            {
              heading: "Durable Skill Cue",
              note: durableSkillCue
                ? {
                    name: "derived-durable-skill-cue.md",
                    path: "_derived-durable-skill-cue.md",
                    content: durableSkillCue,
                  }
                : undefined,
              maxChars: 260,
            },
            {
              heading: "Learning Trigger Cue",
              note: triggerCue
                ? {
                    name: "derived-learning-trigger-cue.md",
                    path: "_derived-learning-trigger-cue.md",
                    content: triggerCue,
                  }
                : undefined,
              maxChars: 260,
            },
            {
              heading: "Learning Rehearsal Cue",
              note: rehearsalCue
                ? {
                    name: "derived-learning-rehearsal-cue.md",
                    path: "_derived-learning-rehearsal-cue.md",
                    content: rehearsalCue,
                  }
                : undefined,
              maxChars: 260,
            },
            {
              heading: "Learning Transfer Cue",
              note: transferCue
                ? {
                    name: "derived-learning-transfer-cue.md",
                    path: "_derived-learning-transfer-cue.md",
                    content: transferCue,
                  }
                : undefined,
              maxChars: 260,
            },
            {
              heading: "Learning Relevance Cue",
              note: relevanceCue
                ? {
                    name: "derived-learning-relevance-cue.md",
                    path: "_derived-learning-relevance-cue.md",
                    content: relevanceCue,
                  }
                : undefined,
              maxChars: 260,
            },
            ...LEARNING_BOOTSTRAP_PRIORITY_SECTIONS.map((section) => ({
              heading: section.heading,
              note: learningNotes.get(section.noteName),
              maxChars: section.maxChars,
            })),
          ],
          recentNotes: reviews,
          recentHeading: (note) => `## ${note.name}`,
          outputFilename: "_learning-review-bootstrap.md",
        }),
      ],
      context.sessionKey,
    );
  } catch (err) {
    log.warn(`failed: ${String(err)}`);
  }
};

export default learningReviewBootstrapHook;
