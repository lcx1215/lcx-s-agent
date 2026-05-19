import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function runPlanArgs(args: string[]) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/dev/lcx-change-impact-plan.ts", "--json", ...args],
    {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as {
    ok: boolean;
    changedFiles: string[];
    affectedLanes: string[];
    impacts: Array<{
      id: string;
      lane: string;
      matchedFiles: string[];
      requiredChecks: string[];
      commands: string[];
    }>;
    unmatchedFiles: string[];
    recommendedFastCommands: string[];
    deferredCommands: string[];
    safetyNotes: string[];
  };
}

async function runPlan(changedFile: string) {
  return runPlanArgs(["--changed", changedFile]);
}

describe("lcx-change-impact-plan", () => {
  it("does not recommend heavy local-brain eval tests as fast commands while training may be active", async () => {
    const payload = await runPlan("scripts/dev/lcx-context-recovery-exam.ts");

    expect(payload.ok).toBe(true);
    expect(payload.affectedLanes).toEqual(["global_doctrine_and_runbook"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "architecture_supervision_stack",
          lane: "global_doctrine_and_runbook",
          requiredChecks: expect.arrayContaining(["architecture-supervision-tests"]),
        }),
      ]),
    );
    expect(payload.recommendedFastCommands.join("\n")).not.toContain(
      "test/local-brain-distill-eval.test.ts",
    );
    expect(payload.deferredCommands).toEqual(
      expect.arrayContaining(["pnpm vitest run test/local-brain-distill-eval.test.ts"]),
    );
    expect(payload.safetyNotes.join("\n")).toContain("no active guard/eval/MLX");
    expect(payload.safetyNotes.join("\n")).toContain("do not create overlapping heavy eval");
  });

  it("classifies flow graph changes as architecture supervision, not Qwen training work", async () => {
    const payload = await runPlan("scripts/dev/lcx-flow-graph.ts");

    expect(payload.ok).toBe(true);
    expect(payload.affectedLanes).toEqual(["global_doctrine_and_runbook"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "architecture_supervision_stack",
          lane: "global_doctrine_and_runbook",
          matchedFiles: ["scripts/dev/lcx-flow-graph.ts"],
        }),
      ]),
    );
    expect(payload.impacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "local_brain_micro_surface",
        }),
      ]),
    );
  });

  it("classifies the external agent upgrade radar as architecture supervision", async () => {
    const payload = await runPlan("scripts/dev/lcx-external-agent-upgrade-radar.ts");

    expect(payload.ok).toBe(true);
    expect(payload.affectedLanes).toEqual(["global_doctrine_and_runbook"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "architecture_supervision_stack",
          lane: "global_doctrine_and_runbook",
          matchedFiles: ["scripts/dev/lcx-external-agent-upgrade-radar.ts"],
        }),
      ]),
    );
  });

  it("treats --files as a batch file flag and routes live promotion work to the dev/live boundary", async () => {
    const payload = await runPlanArgs([
      "--files",
      "scripts/dev/lcx-promote-live.ts",
      "test/lcx-promote-live-status.test.ts",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.changedFiles).toEqual([
      "scripts/dev/lcx-promote-live.ts",
      "test/lcx-promote-live-status.test.ts",
    ]);
    expect(payload.changedFiles).not.toContain("--files");
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["dev_live_boundary", "test_surface"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "live_or_provider_boundary",
          lane: "dev_live_boundary",
          matchedFiles: ["scripts/dev/lcx-promote-live.ts", "test/lcx-promote-live-status.test.ts"],
          commands: expect.arrayContaining([
            "pnpm vitest run test/lcx-promote-live-status.test.ts",
            "node --import tsx scripts/dev/lcx-system-doctor.ts --json",
          ]),
        }),
        expect.objectContaining({
          id: "test_file_changed",
          lane: "test_surface",
          matchedFiles: ["test/lcx-promote-live-status.test.ts"],
        }),
      ]),
    );
  });
});
