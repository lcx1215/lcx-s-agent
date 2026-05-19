import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function runPlan(changedFile: string) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/dev/lcx-change-impact-plan.ts",
      "--json",
      "--changed",
      changedFile,
    ],
    {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as {
    ok: boolean;
    affectedLanes: string[];
    impacts: Array<{
      id: string;
      lane: string;
      matchedFiles: string[];
      requiredChecks: string[];
    }>;
    recommendedFastCommands: string[];
    deferredCommands: string[];
    safetyNotes: string[];
  };
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
});
