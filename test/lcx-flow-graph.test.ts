import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const EXEC_MAX_BUFFER = 20 * 1024 * 1024;

async function runJsonScript(script: string) {
  try {
    return await execFileAsync(process.execPath, ["--import", "tsx", script, "--json"], {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: EXEC_MAX_BUFFER,
    });
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      [
        details.message ?? String(error),
        `stdout=${details.stdout ?? ""}`,
        `stderr=${details.stderr ?? ""}`,
      ].join("\n"),
      { cause: error },
    );
  }
}

describe("LCX flow graph exam", () => {
  it("passes current task waterflow contracts", async () => {
    const { stdout } = await runJsonScript("scripts/dev/lcx-flow-graph.ts");
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      boundary: string;
      summary: {
        failed: number;
        total: number;
        scenarios: number;
        nodes: number;
        filters: number;
      };
      checks: Array<{ id: string; ok: boolean; evidence?: unknown }>;
      scenarios: Array<{
        id: string;
        requiredFilters: string[];
        feedbackEdgeCount: number;
        receipts: string[];
      }>;
      liveTouched: boolean;
      providerConfigTouched: boolean;
      protectedMemoryTouched: boolean;
    };

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_flow_graph_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.summary.failed).toBe(0);
    expect(payload.summary.total).toBeGreaterThanOrEqual(7);
    expect(payload.summary.scenarios).toBeGreaterThanOrEqual(6);
    expect(payload.summary.nodes).toBeGreaterThanOrEqual(40);
    expect(payload.summary.filters).toBeGreaterThanOrEqual(18);
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "flow_graph_integrity", ok: true }),
        expect.objectContaining({ id: "flow_graph_filters_required", ok: true }),
        expect.objectContaining({ id: "flow_graph_feedback_is_bounded", ok: true }),
        expect.objectContaining({ id: "flow_graph_illegal_shortcuts_absent", ok: true }),
      ]),
    );
    expect(payload.scenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "lark_finance_research_waterflow",
          requiredFilters: expect.arrayContaining([
            "source_evidence_gate",
            "no_trade_advice",
            "no_unverified_current_market_data",
          ]),
        }),
        expect.objectContaining({
          id: "module_learning_internalization_waterflow",
          requiredFilters: expect.arrayContaining([
            "stored_only_is_not_learning",
            "retrieval_apply_eval_review_required",
          ]),
        }),
        expect.objectContaining({
          id: "training_failure_feedback_waterflow",
          feedbackEdgeCount: 2,
          requiredFilters: expect.arrayContaining([
            "training_overlap_guard",
            "parse_recovered_no_promotion",
            "promotion_ready_required",
          ]),
        }),
        expect.objectContaining({
          id: "dev_to_live_lark_waterflow",
          requiredFilters: expect.arrayContaining([
            "dev_ready_not_live_user_seen",
            "real_lark_inbound_required",
          ]),
        }),
      ]),
    );
  });

  it("is visible from doctor, mind model, head-tail, and runbook surfaces", async () => {
    const [doctorSource, mindModelSource, headTailSource, agents, runbook] = await Promise.all([
      fs.readFile(path.join(repoRoot, "scripts/dev/lcx-system-doctor.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "scripts/dev/lcx-mind-model.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "scripts/dev/lcx-head-tail-consistency.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "AGENTS.md"), "utf8"),
      fs.readFile(path.join(repoRoot, "ops/local-brain/README.md"), "utf8"),
    ]);

    expect(doctorSource).toContain('name: "flow-graph-exam"');
    expect(doctorSource).toContain("scripts/dev/lcx-flow-graph.ts");
    expect(mindModelSource).toContain("flow_graph");
    expect(headTailSource).toContain("flow_graph_boundary");
    expect(agents).toContain("LCX Agent Flow Graph");
    expect(agents).toContain("wrong-flow");
    expect(runbook).toContain("LCX Agent Flow Graph");
    expect(runbook).toContain("flow_graph_exam");
  });
});
