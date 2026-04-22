import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";

const capabilitiesCommand = vi.fn().mockResolvedValue(undefined);

vi.mock("../commands/capabilities.js", () => ({
  capabilitiesCommand,
}));

describe("capabilities cli", () => {
  let registerCapabilitiesCli: (typeof import("./capabilities-cli.js"))["registerCapabilitiesCli"];

  beforeAll(async () => {
    ({ registerCapabilitiesCli } = await import("./capabilities-cli.js"));
  });

  beforeEach(() => {
    capabilitiesCommand.mockClear();
  });

  it("registers a top-level capabilities command", () => {
    const program = new Command();
    registerCapabilitiesCli(program);
    expect(program.commands.find((command) => command.name() === "capabilities")).toBeTruthy();
  });

  it("passes --json through to the command", async () => {
    await runRegisteredCli({
      register: registerCapabilitiesCli as (program: Command) => void,
      argv: ["capabilities", "--json"],
    });
    expect(capabilitiesCommand).toHaveBeenCalledWith(
      expect.objectContaining({ json: true }),
      expect.any(Object),
    );
  });
});
