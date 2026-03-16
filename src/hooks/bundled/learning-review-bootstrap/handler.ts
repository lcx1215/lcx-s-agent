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

const HOOK_KEY = "learning-review-bootstrap";
const log = createSubsystemLogger("learning-review-bootstrap");

function extractBullet(content: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`- \\*\\*${escaped}\\*\\*: (.+)`));
  return match?.[1]?.trim();
}

function buildImmediateStudyCue(upgradeContent?: string): string | undefined {
  if (!upgradeContent) {
    return undefined;
  }
  const avoid = extractBullet(upgradeContent, "Main Failure To Avoid");
  const apply = extractBullet(upgradeContent, "Default Method To Apply");
  const doNow = extractBullet(upgradeContent, "Do Now");
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
    const upgradePrompt = await loadNewestMemoryNote({
      workspaceDir: context.workspaceDir,
      includes: "learning-upgrade",
    });
    const immediateCue = buildImmediateStudyCue(upgradePrompt?.content);
    const weeklySummary = await loadNewestMemoryNote({
      workspaceDir: context.workspaceDir,
      includes: "learning-weekly-review",
    });
    const reviews = await loadRecentMemoryNotes({
      workspaceDir: context.workspaceDir,
      recentCount,
      includes: "-review-",
      excludes: ["learning-weekly-review"],
    });
    if (reviews.length === 0 && !weeklySummary && !upgradePrompt) {
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
              heading: "Priority Learning Upgrade",
              note: upgradePrompt,
              maxChars: 500,
            },
            {
              heading: "Latest Weekly Summary",
              note: weeklySummary,
            },
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
