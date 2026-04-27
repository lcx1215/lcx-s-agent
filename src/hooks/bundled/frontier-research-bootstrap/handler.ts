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
  FRONTIER_BOOTSTRAP_PRIORITY_SECTIONS,
  FRONTIER_RESEARCH_CARD_PREFIX,
} from "../lobster-brain-registry.js";

const HOOK_KEY = "frontier-research-bootstrap";
const log = createSubsystemLogger("frontier-research-bootstrap");

const frontierResearchBootstrapHook: HookHandler = async (event) => {
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
    const notesByName = new Map(
      await Promise.all(
        FRONTIER_BOOTSTRAP_PRIORITY_SECTIONS.map(async ({ noteName }) => [
          noteName,
          await loadNewestMemoryNote({
            workspaceDir: context.workspaceDir,
            includes: noteName,
          }),
        ]),
      ),
    );
    const cards = await loadRecentMemoryNotes({
      workspaceDir: context.workspaceDir,
      recentCount,
      includes: FRONTIER_RESEARCH_CARD_PREFIX,
      excludes: FRONTIER_BOOTSTRAP_PRIORITY_SECTIONS.map((section) => section.noteName),
    });
    const latestWorkface = await loadNewestMemoryNote({
      workspaceDir: context.workspaceDir,
      includes: "lobster-workface",
    });
    const latestWorkfaceCue = buildLobsterWorkfaceLearningCarryoverCue(latestWorkface?.content);
    if (
      [...notesByName.values()].every((note) => !note) &&
      cards.length === 0 &&
      !latestWorkfaceCue
    ) {
      return;
    }

    context.bootstrapFiles = filterBootstrapFilesForSession(
      [
        ...context.bootstrapFiles,
        buildSyntheticMemoryContext({
          title: "Recent Frontier Research",
          intro: [
            "Use these notes before reviewing new papers, methods, or replication ideas.",
            "Read the frontier upgrade first, then the weekly review, then the replication backlog, then recent raw research cards if you need detail.",
          ],
          sections: [
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
            ...FRONTIER_BOOTSTRAP_PRIORITY_SECTIONS.map(({ noteName, heading, maxChars }) => ({
              heading,
              note: notesByName.get(noteName),
              maxChars,
            })),
          ],
          recentNotes: cards,
          recentHeading: (note) => `## ${note.name}`,
          recentMaxChars: 500,
          outputFilename: "_frontier-research-bootstrap.md",
        }),
      ],
      context.sessionKey,
    );
  } catch (err) {
    log.warn(`failed: ${String(err)}`);
  }
};

export default frontierResearchBootstrapHook;
