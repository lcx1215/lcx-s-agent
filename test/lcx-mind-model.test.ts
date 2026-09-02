import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const EXEC_MAX_BUFFER = 20 * 1024 * 1024;
const lcxUserHome = process.env.LCX_USER_HOME ?? "/Users/liuchengxu";
const localOperatorPath = path.join(lcxUserHome, ".openclaw", "bin", "lcx-local-operator-loop.sh");

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

describe("LCX mind model god-view architecture check", () => {
  it("passes current macro workflow closure surfaces", async () => {
    const { stdout } = await runJsonScript("scripts/operator/lcx-mind-model.ts");
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      boundary: string;
      summary: {
        failed: number;
        total: number;
        laneTotal: number;
        invariantTotal: number;
        roleCounts: {
          coreArchitecture: number;
          observedImplementation: number;
        };
        coreMasterLanes: string[];
        observedImplementationLanes: string[];
        masterLanes: string[];
        invariantCategories: string[];
      };
      lanes: Array<{ id: string; ok: boolean; missing: unknown[] }>;
      invariants: Array<{ id: string; ok: boolean; category: string; missing: unknown[] }>;
      missingSurfaceFiles: string[];
      liveTouched: boolean;
      providerConfigTouched: boolean;
      protectedMemoryTouched: boolean;
      globalEvidenceProjection: {
        contractVersion: string;
        ontologyVersion?: string;
        mode: string;
        capabilities: Array<{
          id: string;
          coverage: string;
          maturity: string;
          adaptability: string;
          role?: string;
        }>;
        delivery: {
          adapterId: string | null;
          state: string;
        };
        boundaries: {
          scope: string;
          externalSender: string;
          training: string;
          providerConfig: string;
          protectedMemory: string;
        };
      };
      ontologyAudit: {
        ok: boolean;
        ontologyVersion: string;
        canonicalSource: string;
        errors: string[];
      };
    };

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "local_mind_model_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.summary.failed).toBe(0);
    expect(payload.ontologyAudit).toEqual(
      expect.objectContaining({
        ok: true,
        ontologyVersion: "lcx_ontology_v1",
        canonicalSource: "src/shared/lcx-ontology.ts",
        errors: [],
      }),
    );
    expect(payload.summary.laneTotal).toBeGreaterThanOrEqual(9);
    expect(payload.summary.invariantTotal).toBeGreaterThanOrEqual(8);
    expect(payload.summary.total).toBe(payload.summary.laneTotal + payload.summary.invariantTotal);
    expect(payload.summary.roleCounts).toEqual(
      expect.objectContaining({
        coreArchitecture: expect.any(Number),
        observedImplementation: 1,
      }),
    );
    expect(payload.summary.coreMasterLanes).not.toContain("qwen_training");
    expect(payload.summary.observedImplementationLanes).toEqual(["qwen_training"]);
    expect(payload.missingSurfaceFiles).toEqual([]);
    expect(payload.globalEvidenceProjection).toEqual(
      expect.objectContaining({
        contractVersion: "global_evidence_projection_v1",
        ontologyVersion: "lcx_ontology_v1",
        mode: "read_only_shadow",
        delivery: { adapterId: null, state: "unknown", evidenceRefs: [] },
        boundaries: {
          scope: "projection_only",
          externalSender: "not_touched_by_projection",
          training: "not_touched_by_projection",
          providerConfig: "not_touched_by_projection",
          protectedMemory: "not_touched_by_projection",
        },
      }),
    );
    expect(payload.globalEvidenceProjection.capabilities).toHaveLength(payload.summary.laneTotal);
    expect(payload.globalEvidenceProjection.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mind_model_self_supervision",
          coverage: "complete",
          maturity: "structural",
          adaptability: "adapter_neutral",
        }),
        expect.objectContaining({
          id: "external_message_adapter_boundary",
          coverage: "complete",
          maturity: "structural",
          adaptability: "adapter_neutral",
        }),
        expect.objectContaining({
          id: "local_brain_training",
          role: "observed_implementation",
        }),
        expect.objectContaining({
          id: "canonical_ontology_registry",
          role: "core_architecture",
        }),
      ]),
    );
    expect(payload.summary.masterLanes).toEqual(
      expect.arrayContaining([
        "global_doctrine_and_runbook",
        "qwen_training",
        "finance_research_capability",
        "local_live_boundary",
      ]),
    );
    expect(payload.summary.invariantCategories).toEqual(
      expect.arrayContaining(["workflow", "content", "boundary", "automation", "testing"]),
    );
    expect(payload.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "mind_model_self_supervision", ok: true }),
        expect.objectContaining({
          id: "local_brain_training",
          role: "observed_implementation",
          ok: true,
        }),
        expect.objectContaining({ id: "canonical_ontology_registry", ok: true }),
        expect.objectContaining({ id: "module_learning_memory", ok: true }),
        expect.objectContaining({ id: "self_repair_hands", ok: true }),
        expect.objectContaining({ id: "external_message_channel_boundary", ok: true }),
        expect.objectContaining({ id: "flow_graph_waterflow_supervision", ok: true }),
        expect.objectContaining({ id: "skillopt_runtime_self_use", ok: true }),
        expect.objectContaining({ id: "universe_index_total_coverage", ok: true }),
        expect.objectContaining({ id: "world_class_agent_architecture", ok: true }),
        expect.objectContaining({ id: "external_agent_upgrade_distillation", ok: true }),
        expect.objectContaining({ id: "multi_agent_pattern_shadow", ok: true }),
      ]),
    );
    expect(payload.invariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "compressed_recovery_requires_fresh_operator_state",
          ok: true,
        }),
        expect.objectContaining({
          id: "test_home_drift_cannot_hide_real_operator_state",
          ok: true,
        }),
        expect.objectContaining({
          id: "content_claims_need_source_or_unverified_flag",
          ok: true,
        }),
        expect.objectContaining({
          id: "visible_reply_hides_internal_runtime_details",
          ok: true,
        }),
        expect.objectContaining({
          id: "module_learning_cannot_be_stored_only",
          ok: true,
        }),
        expect.objectContaining({
          id: "skillopt_preflight_is_not_absorption_or_live_proof",
          ok: true,
        }),
        expect.objectContaining({
          id: "universe_index_is_inventory_not_delete_authority",
          ok: true,
        }),
        expect.objectContaining({
          id: "task_waterflows_have_filters_and_receipts",
          ok: true,
        }),
        expect.objectContaining({
          id: "world_class_agent_architecture_is_operational_not_slogan",
          ok: true,
        }),
        expect.objectContaining({
          id: "external_agent_projects_cannot_be_parallel_systems",
          ok: true,
        }),
      ]),
    );
  });

  it("is wired into the main doctor and head-tail gate", async () => {
    const [doctorSource, headTailSource, runbook, localOperator] = await Promise.all([
      fs.readFile(path.join(repoRoot, "scripts/operator/lcx-system-doctor.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "scripts/operator/lcx-head-tail-consistency.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "ops/local-brain/README.md"), "utf8"),
      fs.readFile(localOperatorPath, "utf8").catch(() => ""),
    ]);

    expect(doctorSource).toContain('name: "mind-model-consistency"');
    expect(doctorSource).toContain('name: "flow-graph-exam"');
    expect(doctorSource).toContain('name: "context-recovery-exam"');
    expect(doctorSource).toContain("scripts/operator/lcx-mind-model.ts");
    expect(doctorSource).toContain("scripts/operator/lcx-flow-graph.ts");
    expect(doctorSource).toContain("scripts/operator/lcx-governance-autopilot.ts");
    expect(doctorSource).toContain("scripts/operator/lcx-context-recovery-exam.ts");
    expect(headTailSource).toContain("mind_model_boundary");
    expect(headTailSource).toContain("flow_graph_boundary");
    expect(headTailSource).toContain("MIND_MODEL_LANES");
    expect(headTailSource).toContain("compressedContextRecovered");
    expect(runbook).toContain("LCX Agent Mind Model");
    expect(runbook).toContain("Canonical Ontology");
    expect(runbook).toContain("LCX Agent Flow Graph");
    expect(runbook).toContain("World-class agent architecture");
    expect(runbook).toContain("single factual owner");
    expect(runbook).toContain("workflow closure");
    expect(runbook).toContain("lcx-context-recovery-exam");
    if (localOperator) {
      expect(localOperator).toContain("mind_file");
      expect(localOperator).toContain("governance_file");
      expect(localOperator).toContain("governanceAutopilot");
      expect(localOperator).toContain("context_recovery_file");
      expect(localOperator).toContain("mindModel");
      expect(localOperator).toContain("contextRecovery");
      expect(localOperator).toContain("scripts/operator/lcx-system-doctor.ts");
      expect(localOperator).toContain("scripts/operator/lcx-governance-autopilot.ts");
      expect(localOperator).toContain("LCX_LOCAL_OPERATOR_SKIP_CLEANUP");
      expect(localOperator).toContain("LCX_LOCAL_OPERATOR_SKIP_TRAINING_RESTART");
      expect(localOperator).not.toContain("scripts/dev/");
      expect(localOperator).not.toContain("dev_local_observability_only");
    }
  });

  it("does not let a temporary HOME hide the real operator files", async () => {
    const testHome = path.join(repoRoot, ".tmp", "openclaw-test-home");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/operator/lcx-mind-model.ts", "--json"],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: testHome },
        maxBuffer: EXEC_MAX_BUFFER,
      },
    );
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      missingSurfaceFiles: string[];
      invariants: Array<{ id: string; ok: boolean }>;
      surfaceFiles: { workflow: string[] };
    };

    expect(payload.ok).toBe(true);
    expect(payload.missingSurfaceFiles).toEqual([]);
    expect(payload.surfaceFiles.workflow).toEqual(
      expect.arrayContaining([
        path.join(lcxUserHome, ".openclaw", "bin", "lcx-local-operator-loop.sh"),
        path.join(lcxUserHome, ".openclaw", "bin", "codex-archive-lcx-automation-threads.sh"),
      ]),
    );
    expect(payload.surfaceFiles.workflow.join("\n")).not.toContain("openclaw-test-home");
    expect(payload.invariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "test_home_drift_cannot_hide_real_operator_state",
          ok: true,
        }),
      ]),
    );
  });
});
