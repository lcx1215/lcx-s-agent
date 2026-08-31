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
    strayGate: {
      ok: boolean;
      rule: string;
      unmatchedChangedFiles: string[];
      nextAction: string;
    };
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
    expect(payload.strayGate.ok).toBe(true);
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

  it("routes the bounded raw system shadow through the local-brain owner", async () => {
    const payload = await runPlan("scripts/dev/lcx-system-shadow.ts");

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["qwen_training_or_local_brain"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "local_brain_micro_surface",
          lane: "qwen_training_or_local_brain",
          matchedFiles: ["scripts/dev/lcx-system-shadow.ts"],
          commands: expect.arrayContaining([
            "pnpm vitest run test/local-brain-contracts.test.ts test/local-brain-training-plan.test.ts test/lcx-system-shadow.test.ts",
          ]),
        }),
      ]),
    );
  });

  it("fails the stray gate when a changed file has no owner lane", async () => {
    const payload = await runPlan("tmp/unknown-stray-output.txt");

    expect(payload.ok).toBe(false);
    expect(payload.unmatchedFiles).toEqual(["tmp/unknown-stray-output.txt"]);
    expect(payload.strayGate).toEqual(
      expect.objectContaining({
        ok: false,
        rule: "every changed file must match at least one owner lane",
        unmatchedChangedFiles: ["tmp/unknown-stray-output.txt"],
      }),
    );
    expect(payload.strayGate.nextAction).toContain("add an owner rule");
  });

  it("routes Python changes through the TS/Python boundary check", async () => {
    const payload = await runPlanArgs([
      "--files",
      "lobster_orchestrator.py",
      "scripts/branch_freshness.py",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["global_doctrine_and_runbook"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ts_python_boundary",
          lane: "global_doctrine_and_runbook",
          matchedFiles: ["lobster_orchestrator.py", "scripts/branch_freshness.py"],
          requiredChecks: ["ts-python-boundary"],
          commands: ["node --import tsx scripts/dev/lcx-ts-python-boundary.ts --json"],
        }),
      ]),
    );
  });

  it("classifies the external agent upgrade radar as architecture supervision", async () => {
    const payload = await runPlanArgs([
      "--files",
      "scripts/dev/lcx-external-agent-upgrade-radar.ts",
      "scripts/dev/lcx-github-cli-capability-inventory.ts",
      "test/lcx-github-cli-capability-inventory.test.ts",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.affectedLanes).toEqual(["global_doctrine_and_runbook", "test_surface"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "architecture_supervision_stack",
          lane: "global_doctrine_and_runbook",
          matchedFiles: [
            "scripts/dev/lcx-external-agent-upgrade-radar.ts",
            "scripts/dev/lcx-github-cli-capability-inventory.ts",
            "test/lcx-github-cli-capability-inventory.test.ts",
          ],
        }),
      ]),
    );
  });

  it("classifies SkillOpt-lite SOP training as architecture supervision", async () => {
    const payload = await runPlanArgs([
      "--files",
      "scripts/dev/lcx-skillopt-lite.ts",
      "scripts/dev/lcx-provider-council-acceleration.ts",
      "test/lcx-skillopt-lite.test.ts",
      "test/lcx-provider-council-acceleration.test.ts",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["global_doctrine_and_runbook", "test_surface"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "architecture_supervision_stack",
          lane: "global_doctrine_and_runbook",
          matchedFiles: [
            "scripts/dev/lcx-provider-council-acceleration.ts",
            "scripts/dev/lcx-skillopt-lite.ts",
            "test/lcx-provider-council-acceleration.test.ts",
            "test/lcx-skillopt-lite.test.ts",
          ],
          commands: expect.arrayContaining([
            expect.stringContaining("test/lcx-skillopt-lite.test.ts"),
          ]),
        }),
      ]),
    );
  });

  it("classifies the universe index as the global architecture inventory owner", async () => {
    const payload = await runPlanArgs([
      "--files",
      "scripts/dev/lcx-universe-index.ts",
      "test/lcx-universe-index.test.ts",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["global_doctrine_and_runbook", "test_surface"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "architecture_supervision_stack",
          lane: "global_doctrine_and_runbook",
          matchedFiles: ["scripts/dev/lcx-universe-index.ts", "test/lcx-universe-index.test.ts"],
          commands: expect.arrayContaining([
            expect.stringContaining("test/lcx-universe-index.test.ts"),
          ]),
        }),
      ]),
    );
  });

  it("classifies the live fadeout audit as architecture supervision", async () => {
    const payload = await runPlanArgs([
      "--files",
      "scripts/dev/lcx-live-fadeout-audit.ts",
      "test/lcx-live-fadeout-audit.test.ts",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["global_doctrine_and_runbook", "test_surface"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "architecture_supervision_stack",
          lane: "global_doctrine_and_runbook",
          matchedFiles: [
            "scripts/dev/lcx-live-fadeout-audit.ts",
            "test/lcx-live-fadeout-audit.test.ts",
          ],
          commands: expect.arrayContaining([
            expect.stringContaining("test/lcx-live-fadeout-audit.test.ts"),
          ]),
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

  it("routes SkillOpt runtime self-use hooks to the Lark visible reply lane", async () => {
    const payload = await runPlanArgs([
      "--files",
      "src/auto-reply/reply/get-reply-run.ts",
      "src/auto-reply/reply/skillopt-autocue.ts",
      "src/auto-reply/reply/skillopt-autocue.test.ts",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["lark_feishu_visible_reply", "test_surface"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "lark_feishu_visible_surface",
          lane: "lark_feishu_visible_reply",
          matchedFiles: [
            "src/auto-reply/reply/get-reply-run.ts",
            "src/auto-reply/reply/skillopt-autocue.test.ts",
            "src/auto-reply/reply/skillopt-autocue.ts",
          ],
          commands: expect.arrayContaining([
            "pnpm vitest run src/auto-reply/reply/skill-autocue.test.ts src/auto-reply/reply/skillopt-autocue.test.ts",
          ]),
        }),
        expect.objectContaining({
          id: "test_file_changed",
          lane: "test_surface",
          matchedFiles: ["src/auto-reply/reply/skillopt-autocue.test.ts"],
        }),
      ]),
    );
  });

  it("routes commercial visible answer quality owners to the Lark visible reply lane", async () => {
    const payload = await runPlanArgs([
      "--files",
      "scripts/dev/lcx-commercial-answer-pipeline.ts",
      "scripts/dev/lcx-visible-answer-quality-fuzzer.ts",
      "test/lcx-visible-answer-quality-fuzzer.test.ts",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["lark_feishu_visible_reply", "test_surface"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "lark_feishu_visible_surface",
          lane: "lark_feishu_visible_reply",
          matchedFiles: [
            "scripts/dev/lcx-commercial-answer-pipeline.ts",
            "scripts/dev/lcx-visible-answer-quality-fuzzer.ts",
          ],
          commands: expect.arrayContaining([
            "pnpm vitest run src/auto-reply/reply/skill-autocue.test.ts src/auto-reply/reply/skillopt-autocue.test.ts",
          ]),
        }),
        expect.objectContaining({
          id: "test_file_changed",
          lane: "test_surface",
          matchedFiles: ["test/lcx-visible-answer-quality-fuzzer.test.ts"],
        }),
      ]),
    );
  });

  it("routes owner dashboard observability files instead of leaving them unmatched", async () => {
    const payload = await runPlanArgs([
      "--files",
      "apps/web/lcx-agent-farm/index.html",
      "scripts/dev/lcx-farm-web-server.ts",
      "scripts/dev/lcx-owner-control-map.ts",
      "scripts/dev/lcx-real-cost-ledger.ts",
      "test/lcx-owner-control-map.test.ts",
      "test/lcx-real-cost-ledger.test.ts",
      "tmp-lcx-owner-dashboard.png",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["local_automation", "test_surface"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "owner_control_room_surface",
          lane: "local_automation",
          matchedFiles: [
            "apps/web/lcx-agent-farm/index.html",
            "scripts/dev/lcx-farm-web-server.ts",
            "scripts/dev/lcx-owner-control-map.ts",
            "scripts/dev/lcx-real-cost-ledger.ts",
            "test/lcx-owner-control-map.test.ts",
            "test/lcx-real-cost-ledger.test.ts",
            "tmp-lcx-owner-dashboard.png",
          ],
          safetyNotes: expect.arrayContaining([
            expect.stringContaining("screenshots should be deleted or explicitly kept"),
          ]),
        }),
      ]),
    );
  });

  it("routes macOS owner control-room files as local UI, not live proof", async () => {
    const payload = await runPlanArgs([
      "--files",
      "apps/macos/Sources/OpenClaw/LCXAgentControlRoom.swift",
      "apps/macos/Sources/OpenClaw/LCXAgentControlRoomView.swift",
      "apps/macos/StandaloneLCXAgentFarm/App.swift",
      "apps/macos/Tests/OpenClawIPCTests/LCXAgentControlRoomTests.swift",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["local_automation"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "macos_owner_control_room",
          lane: "local_automation",
          requiredChecks: ["macos-control-room-build-or-test"],
          safetyNotes: expect.arrayContaining([
            expect.stringContaining(
              "do not treat them as external-channel or legacy live Lark proof",
            ),
          ]),
        }),
      ]),
    );
  });

  it("routes local ignore hygiene through the runbook lane", async () => {
    const payload = await runPlan(".gitignore");

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["global_doctrine_and_runbook"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "doctrine_or_runbook",
          lane: "global_doctrine_and_runbook",
          matchedFiles: [".gitignore"],
        }),
      ]),
    );
  });
});
