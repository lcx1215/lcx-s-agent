import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLarkPendingRoutingCandidate } from "../../extensions/feishu/src/lark-routing-candidate-corpus.js";
import { l5BaselineDoctorCommand } from "./capabilities/l5-baseline-doctor.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const runtime = createTestRuntime();

async function seedL5BaselineReadyWorkspace(workspace: string) {
  const receiptDir = path.join(workspace, "memory", "lark-language-handoff-receipts", "2026-05-03");
  await fs.mkdir(receiptDir, { recursive: true });
  await fs.writeFile(
    path.join(receiptDir, "l5_baseline_ready.json"),
    JSON.stringify({
      generatedAt: "2026-05-03T12:00:00.000Z",
      boundary: "language_handoff_only",
      userMessage: "学习一套很好的量化因子择时策略，保留 receipt 和 research-only 风险边界。",
      handoff: {
        family: "market_capability_learning_intake",
        source: "api",
      },
      financeBrainOrchestration: {
        primaryModules: ["etf_regime", "portfolio_risk_gates", "quant_math", "causal_map"],
        supportingModules: ["finance_learning_memory"],
        requiredTools: [
          "finance_learning_capability_apply",
          "finance_framework_core_inspect",
          "quant_math",
          "review_tier",
          "review_panel",
        ],
        reviewTools: ["review_tier", "review_panel"],
        boundaries: ["research_only", "no_execution_authority", "no_model_math_guessing"],
      },
    }),
    "utf8",
  );

  const candidateDir = path.join(
    workspace,
    "memory",
    "lark-language-routing-candidates",
    "2026-05-03",
  );
  await fs.mkdir(candidateDir, { recursive: true });
  const candidate = createLarkPendingRoutingCandidate({
    source: "lark_user_utterance",
    payload: "去学习世界顶级大学前沿金融论文",
    createdAt: "2026-05-03T12:01:00.000Z",
  });
  await fs.writeFile(
    path.join(candidateDir, "l5_baseline_language.json"),
    JSON.stringify({
      schemaVersion: 1,
      boundary: "language_routing_only",
      generatedAt: "2026-05-03T12:01:00.000Z",
      candidates: [candidate],
      evaluation: {
        schemaVersion: 1,
        boundary: "language_routing_only",
        evaluatedAt: "2026-05-03T12:01:01.000Z",
        evaluations: [
          {
            reason: "accepted_language_case",
            candidate,
          },
        ],
        acceptedCases: [],
        counts: {
          total: 1,
          accepted: 1,
          rejected: 0,
          discarded: 0,
        },
      },
    }),
    "utf8",
  );
}

describe("l5BaselineDoctorCommand", () => {
  it("reports L5 baseline ready when language, brain, finance, math, safety, and Lark receipts pass", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-l5-baseline-doctor-"));
    await seedL5BaselineReadyWorkspace(workspace);

    await l5BaselineDoctorCommand({ workspaceDir: workspace, json: true }, runtime);

    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
      ok: boolean;
      level: string;
      gates: Array<{ id: string; status: string; evidence: string }>;
      lark: {
        liveReceiptCount: number;
        currentReplayCandidateCount: number;
        currentReplayRejectedCount: number;
      };
      brain: {
        primaryModules: string[];
        requiredTools: string[];
        boundaries: string[];
      };
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
    expect(payload.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "local_language_brain_loop", status: "pass" }),
        expect.objectContaining({ id: "finance_brain_orchestration", status: "pass" }),
        expect.objectContaining({ id: "risk_and_math_boundaries", status: "pass" }),
        expect.objectContaining({ id: "language_candidate_replay", status: "pass" }),
        expect.objectContaining({ id: "live_lark_handoff_receipts", status: "pass" }),
      ]),
    );
    expect(payload.lark).toMatchObject({
      liveReceiptCount: 1,
      currentReplayCandidateCount: 1,
      currentReplayRejectedCount: 0,
    });
    expect(payload.brain.primaryModules).toEqual(
      expect.arrayContaining(["etf_regime", "portfolio_risk_gates", "quant_math", "causal_map"]),
    );
    expect(payload.brain.requiredTools).toEqual(
      expect.arrayContaining([
        "finance_learning_capability_apply",
        "quant_math",
        "review_tier",
        "review_panel",
      ]),
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
