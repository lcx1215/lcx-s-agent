import type { Command } from "commander";
import {
  capabilitiesCommand,
  githubCapabilityIntakeCommand,
  larkLoopDiagnoseCommand,
  languageBrainLoopSmokeCommand,
} from "../commands/capabilities.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";

function runCapabilitiesCli(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action);
}

export function registerCapabilitiesCli(program: Command) {
  const capabilities = program
    .command("capabilities")
    .description("Show configured model capabilities and provider-native tool reality")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\nExamples:\n${formatHelpExamples([
          ["openclaw capabilities", "Show the bounded live capability surface."],
          ["openclaw capabilities --json", "Machine-readable capability surface."],
        ])}`,
    )
    .action(async (opts) => {
      await runCapabilitiesCli(async () => {
        await capabilitiesCommand({ json: Boolean(opts.json) }, defaultRuntime);
      });
    });

  const collectOption = (value: string, previous: string[] = []) => [...previous, value];

  capabilities
    .command("github-intake")
    .description("Map a GitHub project feature into an LCX Agent capability candidate")
    .requiredOption("--repo <name>", "Repository or project name")
    .option("--repo-url <url>", "Repository URL")
    .requiredOption("--feature <text>", "Selected feature to evaluate")
    .requiredOption("--summary <text>", "README/docs-level project summary")
    .option(
      "--mode <mode>",
      "Requested adoption mode: auto, skill, tool, routing, memory_rule, eval, research_source, defer, reject",
      "auto",
    )
    .option("--evidence <text>", "Evidence snippet (repeatable)", collectOption, [])
    .option("--tag <tag>", "Tag (repeatable)", collectOption, [])
    .option("--write-receipt", "Write a bounded intake receipt", false)
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\nExamples:\n${formatHelpExamples([
          [
            "openclaw capabilities github-intake --repo aider --feature 'repo map' --summary 'CLI coding assistant with repository map context'",
            "Classify one GitHub feature without fetching or executing repo code.",
          ],
          [
            "openclaw capabilities github-intake --repo some/repo --feature 'skills' --summary 'README says it packages reusable agent skills' --write-receipt --json",
            "Write a metadata-only receipt for later review.",
          ],
        ])}`,
    )
    .action(async (opts, command) => {
      await runCapabilitiesCli(async () => {
        await githubCapabilityIntakeCommand(
          {
            repoName: String(opts.repo),
            repoUrl: typeof opts.repoUrl === "string" ? opts.repoUrl : undefined,
            selectedFeature: String(opts.feature),
            projectSummary: String(opts.summary),
            requestedAdoptionMode: String(opts.mode ?? "auto"),
            evidenceSnippets: Array.isArray(opts.evidence) ? opts.evidence : [],
            tags: Array.isArray(opts.tag) ? opts.tag : [],
            writeReceipt: Boolean(opts.writeReceipt),
            json: Boolean(opts.json || command.parent?.opts().json),
          },
          defaultRuntime,
        );
      });
    });

  capabilities
    .command("language-brain-loop-smoke")
    .description("Run a local LCX language-brain-analysis-memory loop smoke")
    .option("--fixture-dir <dir>", "Fixture directory with local finance learning sources")
    .option("--workspace <dir>", "Workspace for smoke artifacts; defaults to a temp directory")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\nExamples:\n${formatHelpExamples([
          [
            "openclaw capabilities language-brain-loop-smoke --json",
            "Verify local language routing, learning retrieval, analysis apply, and receipt writing.",
          ],
          [
            "openclaw capabilities language-brain-loop-smoke --workspace /tmp/lcx-loop --json",
            "Write smoke artifacts to an explicit workspace for inspection.",
          ],
        ])}`,
    )
    .action(async (opts, command) => {
      await runCapabilitiesCli(async () => {
        await languageBrainLoopSmokeCommand(
          {
            fixtureDir: typeof opts.fixtureDir === "string" ? opts.fixtureDir : undefined,
            workspaceDir: typeof opts.workspace === "string" ? opts.workspace : undefined,
            json: Boolean(opts.json || command.parent?.opts().json),
          },
          defaultRuntime,
        );
      });
    });

  capabilities
    .command("lark-loop-diagnose")
    .description("Diagnose local LCX loop readiness and live Lark handoff receipt status")
    .option("--agent <id>", "Agent id whose workspace should be checked")
    .option("--workspace <dir>", "Workspace to inspect for live Lark handoff receipts")
    .option("--fixture-dir <dir>", "Fixture directory with local finance learning sources")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\nExamples:\n${formatHelpExamples([
          [
            "openclaw capabilities lark-loop-diagnose --json",
            "Run local loop smoke and report whether live Lark handoff receipts exist.",
          ],
          [
            "openclaw capabilities lark-loop-diagnose --workspace ~/.openclaw/workspace",
            "Inspect a specific live agent workspace.",
          ],
        ])}`,
    )
    .action(async (opts, command) => {
      await runCapabilitiesCli(async () => {
        await larkLoopDiagnoseCommand(
          {
            agent: typeof opts.agent === "string" ? opts.agent : undefined,
            workspaceDir: typeof opts.workspace === "string" ? opts.workspace : undefined,
            fixtureDir: typeof opts.fixtureDir === "string" ? opts.fixtureDir : undefined,
            json: Boolean(opts.json || command.parent?.opts().json),
          },
          defaultRuntime,
        );
      });
    });
}
