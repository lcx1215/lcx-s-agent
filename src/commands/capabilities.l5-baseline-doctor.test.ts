import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { l5BaselineDoctorCommand } from "./capabilities/l5-baseline-doctor.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

describe("l5BaselineDoctorCommand", () => {
  it("reports the local baseline and keeps external delivery unprobed", async () => {
    const runtime = createTestRuntime();
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-l5-baseline-doctor-"));

    await l5BaselineDoctorCommand({ workspaceDir: workspace, json: true }, runtime);

    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
      ok: boolean;
      level: string;
      gates: Array<{ id: string; status: string; evidence: string }>;
      loop: { workspaceDir: string; receiptPath: string };
      brain: { primaryModules: string[]; requiredTools: string[]; boundaries: string[] };
      boundaries: {
        doctorIsReadOnly: boolean;
        liveProbeNotPerformed: boolean;
        noExecutionAuthority: boolean;
      };
      nextBlocker: string;
    };

    expect(payload.ok).toBe(true);
    expect(payload.level).toBe("l5_baseline_ready");
    expect(payload.nextBlocker).toBe("none");
    expect(payload.loop.workspaceDir).toBe(workspace);
    expect(payload.loop.receiptPath).toBeTruthy();
    expect(payload.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "local_language_brain_loop", status: "pass" }),
        expect.objectContaining({ id: "finance_brain_orchestration", status: "pass" }),
        expect.objectContaining({ id: "risk_and_math_boundaries", status: "pass" }),
        expect.objectContaining({ id: "local_receipt_integrity", status: "pass" }),
        expect.objectContaining({ id: "external_channel_boundary", status: "pass" }),
      ]),
    );
    expect(payload.brain.primaryModules).toEqual(
      expect.arrayContaining(["etf_regime", "portfolio_risk_gates", "quant_math", "causal_map"]),
    );
    expect(payload.brain.requiredTools).toEqual(
      expect.arrayContaining(["finance_learning_capability_apply", "quant_math", "review_panel"]),
    );
    expect(payload.brain.boundaries).toEqual(
      expect.arrayContaining(["research_only", "no_execution_authority", "no_model_math_guessing"]),
    );
    expect(payload.boundaries).toMatchObject({
      doctorIsReadOnly: true,
      liveProbeNotPerformed: true,
      noExecutionAuthority: true,
    });
  });
});
