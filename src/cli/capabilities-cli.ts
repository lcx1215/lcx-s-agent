import type { Command } from "commander";
import { capabilitiesCommand } from "../commands/capabilities.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";

function runCapabilitiesCli(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action);
}

export function registerCapabilitiesCli(program: Command) {
  program
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
}
