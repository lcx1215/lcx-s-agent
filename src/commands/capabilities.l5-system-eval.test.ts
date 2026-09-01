import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { l5SystemEvalCommand } from "./capabilities/l5-system-eval.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

describe("l5SystemEvalCommand", () => {
  it("scores the fixed L5 eval with local multi-reviewer arbitration", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-l5-eval-"));
    const runtime = createTestRuntime();

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
    expect(payload.score).toEqual({ passed: 11, total: 11 });
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
    const runtime = createTestRuntime();

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
