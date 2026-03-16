import {
  filterBootstrapFilesForSession,
} from "../../../agents/workspace.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";
import {
  buildSyntheticMemoryContext,
  loadNewestMemoryNote,
  loadRecentMemoryNotes,
  resolveRecentCount,
} from "../bootstrap-memory.js";

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
    const frontierUpgrade = await loadNewestMemoryNote({
      workspaceDir: context.workspaceDir,
      includes: "frontier-upgrade",
    });
    const weeklyReview = await loadNewestMemoryNote({
      workspaceDir: context.workspaceDir,
      includes: "frontier-methods-weekly-review",
    });
    const replicationBacklog = await loadNewestMemoryNote({
      workspaceDir: context.workspaceDir,
      includes: "frontier-replication-backlog",
    });
    const cards = await loadRecentMemoryNotes({
      workspaceDir: context.workspaceDir,
      recentCount,
      includes: "frontier-research-",
      excludes: ["frontier-methods-weekly-review"],
    });
    if (!frontierUpgrade && !weeklyReview && !replicationBacklog && cards.length === 0) {
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
              heading: "Priority Frontier Upgrade",
              note: frontierUpgrade,
              maxChars: 500,
            },
            {
              heading: "Latest Weekly Methods Review",
              note: weeklyReview,
              maxChars: 600,
            },
            {
              heading: "Latest Replication Backlog",
              note: replicationBacklog,
              maxChars: 600,
            },
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
