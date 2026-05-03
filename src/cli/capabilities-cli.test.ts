import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";

const capabilitiesCommand = vi.fn().mockResolvedValue(undefined);
const githubCapabilityIntakeCommand = vi.fn().mockResolvedValue(undefined);
const l4SystemDoctorCommand = vi.fn().mockResolvedValue(undefined);
const l5SystemEvalCommand = vi.fn().mockResolvedValue(undefined);
const languageBrainLoopSmokeCommand = vi.fn().mockResolvedValue(undefined);
const larkLoopDiagnoseCommand = vi.fn().mockResolvedValue(undefined);

vi.mock("../commands/capabilities.js", () => ({
  capabilitiesCommand,
  githubCapabilityIntakeCommand,
  languageBrainLoopSmokeCommand,
}));

vi.mock("../commands/capabilities/l4-system-doctor.js", () => ({
  l4SystemDoctorCommand,
}));

vi.mock("../commands/capabilities/l5-system-eval.js", () => ({
  l5SystemEvalCommand,
}));

vi.mock("../commands/capabilities/lark-loop-diagnose.js", () => ({
  larkLoopDiagnoseCommand,
}));

describe("capabilities cli", () => {
  let registerCapabilitiesCli: (typeof import("./capabilities-cli.js"))["registerCapabilitiesCli"];

  beforeAll(async () => {
    ({ registerCapabilitiesCli } = await import("./capabilities-cli.js"));
  });

  beforeEach(() => {
    capabilitiesCommand.mockClear();
    githubCapabilityIntakeCommand.mockClear();
    l4SystemDoctorCommand.mockClear();
    l5SystemEvalCommand.mockClear();
    languageBrainLoopSmokeCommand.mockClear();
    larkLoopDiagnoseCommand.mockClear();
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

  it("registers GitHub capability intake as a CLI subcommand", async () => {
    await runRegisteredCli({
      register: registerCapabilitiesCli as (program: Command) => void,
      argv: [
        "capabilities",
        "github-intake",
        "--repo",
        "owner/project",
        "--feature",
        "skills marketplace",
        "--summary",
        "README describes reusable agent skills and installable packs.",
        "--evidence",
        "skills are packaged as folders",
        "--tag",
        "skills",
        "--write-receipt",
        "--json",
      ],
    });
    expect(githubCapabilityIntakeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        repoName: "owner/project",
        selectedFeature: "skills marketplace",
        projectSummary: "README describes reusable agent skills and installable packs.",
        evidenceSnippets: ["skills are packaged as folders"],
        tags: ["skills"],
        writeReceipt: true,
        json: true,
      }),
      expect.any(Object),
    );
  });

  it("registers language brain loop smoke as a CLI subcommand", async () => {
    await runRegisteredCli({
      register: registerCapabilitiesCli as (program: Command) => void,
      argv: ["capabilities", "language-brain-loop-smoke", "--workspace", "/tmp/lcx-loop", "--json"],
    });
    expect(languageBrainLoopSmokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/lcx-loop",
        json: true,
      }),
      expect.any(Object),
    );
  });

  it("registers L4 system doctor as a CLI subcommand", async () => {
    await runRegisteredCli({
      register: registerCapabilitiesCli as (program: Command) => void,
      argv: ["capabilities", "l4-system-doctor", "--workspace", "/tmp/lcx-live", "--json"],
    });
    expect(l4SystemDoctorCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/lcx-live",
        json: true,
      }),
      expect.any(Object),
    );
  });

  it("registers L5 system eval as a CLI subcommand", async () => {
    await runRegisteredCli({
      register: registerCapabilitiesCli as (program: Command) => void,
      argv: ["capabilities", "l5-system-eval", "--workspace", "/tmp/lcx-live", "--json"],
    });
    expect(l5SystemEvalCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/lcx-live",
        json: true,
      }),
      expect.any(Object),
    );
  });

  it("registers lark loop diagnose as a CLI subcommand", async () => {
    await runRegisteredCli({
      register: registerCapabilitiesCli as (program: Command) => void,
      argv: ["capabilities", "lark-loop-diagnose", "--workspace", "/tmp/lcx-live", "--json"],
    });
    expect(larkLoopDiagnoseCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/lcx-live",
        json: true,
      }),
      expect.any(Object),
    );
  });
});
