import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLarkPendingRoutingCandidate } from "../../extensions/feishu/src/lark-routing-candidate-corpus.js";
import { l5SystemEvalCommand } from "./capabilities/l5-system-eval.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const runtime = createTestRuntime();

async function seedL5EvalWorkspace(workspace: string) {
  const receiptDir = path.join(workspace, "memory", "lark-language-handoff-receipts", "2026-05-03");
  await fs.mkdir(receiptDir, { recursive: true });
  await fs.writeFile(
    path.join(receiptDir, "l5_eval.json"),
    JSON.stringify({
      generatedAt: "2026-05-03T12:00:00.000Z",
      boundary: "language_handoff_only",
      userMessage: "学习 ETF 风险和量化数学，给出 research-only 结论。",
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
    path.join(candidateDir, "l5_language.json"),
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

describe("l5SystemEvalCommand", () => {
  it("scores the fixed L5 eval with local multi-reviewer arbitration", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-l5-eval-"));
    await seedL5EvalWorkspace(workspace);

    runtime.log.mockClear();
    await l5SystemEvalCommand({ workspaceDir: workspace, json: true }, runtime);

    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
      ok: boolean;
      level: string;
      score: { passed: number; total: number };
      gates: Array<{ id: string; status: string; evidence: string }>;
      nextBlocker: string;
      receipt: {
        written: boolean;
        path: string | null;
        boundary: string;
      };
      boundaries: {
        evalUsesTempLoopWorkspace: boolean;
        liveProbeNotPerformed: boolean;
        noRemoteFetchOccurred: boolean;
        noExecutionAuthority: boolean;
        protectedMemoryUntouched: boolean;
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.level).toBe("l5_ready");
    expect(payload.score).toEqual({ passed: 12, total: 12 });
    expect(payload.nextBlocker).toBe("none");
    expect(payload.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "l5_baseline_doctor_clean", status: "pass" }),
        expect.objectContaining({ id: "eval_scope_isolation", status: "pass" }),
        expect.objectContaining({ id: "natural_language_to_work_order", status: "pass" }),
        expect.objectContaining({ id: "autonomous_learning_application_loop", status: "pass" }),
        expect.objectContaining({ id: "finance_module_orchestration", status: "pass" }),
        expect.objectContaining({ id: "deterministic_finance_math", status: "pass" }),
        expect.objectContaining({ id: "memory_artifact_trace", status: "pass" }),
        expect.objectContaining({ id: "loop_receipt_integrity", status: "pass" }),
        expect.objectContaining({ id: "lark_operability_receipts", status: "pass" }),
        expect.objectContaining({ id: "safety_boundaries", status: "pass" }),
        expect.objectContaining({
          id: "multi_reviewer_arbitration",
          status: "pass",
          evidence: expect.stringContaining("localArbitration=passed"),
        }),
        expect.objectContaining({
          id: "review_receipt_integrity",
          status: "pass",
          evidence: expect.stringContaining("providerCallsMade=false"),
        }),
      ]),
    );
    expect(payload.boundaries).toMatchObject({
      evalUsesTempLoopWorkspace: true,
      liveProbeNotPerformed: true,
      noRemoteFetchOccurred: true,
      noExecutionAuthority: true,
      protectedMemoryUntouched: true,
    });
    expect(payload.receipt).toEqual({
      written: false,
      path: null,
      boundary: "l5_system_eval_receipt",
    });
  });

  it("writes an L5 eval receipt when explicitly requested", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-l5-eval-receipt-"));
    await seedL5EvalWorkspace(workspace);

    runtime.log.mockClear();
    await l5SystemEvalCommand({ workspaceDir: workspace, json: true, writeReceipt: true }, runtime);

    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
      ok: boolean;
      receipt: {
        written: boolean;
        path: string | null;
        boundary: string;
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.receipt).toMatchObject({
      written: true,
      boundary: "l5_system_eval_receipt",
    });
    expect(payload.receipt.path).toMatch(
      /^memory\/l5-system-eval-receipts\/\d{4}-\d{2}-\d{2}\/.+__l5-system-eval\.json$/u,
    );
    const receiptPath = path.join(workspace, payload.receipt.path ?? "");
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as {
      schemaVersion: number;
      boundary: string;
      result: {
        ok: boolean;
        receipt: {
          written: boolean;
          path: string | null;
        };
      };
    };
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.boundary).toBe("l5_system_eval_receipt");
    expect(receipt.result.ok).toBe(true);
    expect(receipt.result.receipt).toEqual(payload.receipt);
  });
});
