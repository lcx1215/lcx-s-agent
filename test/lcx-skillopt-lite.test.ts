import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type SkillOptResult = Record<string, unknown> & {
  trainCases: string[];
  validationCases: string[];
  regressionCases: string[];
  proofChain: {
    targetedEval: {
      status: string;
      contractDiagnosticCommand: string | null;
      caseGroups: { train: string[]; validation: string[]; regression: string[] };
      registryValidation: { ok: boolean; reason: string | null; caseIds: string[] };
      candidateIdentities: { path: string; sha256: string; materialized: boolean }[];
    };
  };
};

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts/operator/lcx-skillopt-lite.ts");

async function seedAutopilot(workspaceDir: string) {
  const statePath = path.join(workspaceDir, "state", "lcx-governance-autopilot-latest.json");
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    `${JSON.stringify(
      {
        checkedAt: "2026-05-26T10:00:00.000Z",
        owners: {
          trainingPlan: {
            activeProcessCount: 3,
            selectedCleanAdapter: "/adapters/clean-r2",
            latestCandidateEval: {
              adapterPath: "/adapters/candidate-r6",
              promotionReady: false,
              failedCaseIds: [],
              parseErrorCaseIds: [],
              parseRecoveredCaseIds: [
                "full_stack_finance_stress_with_red_team",
                "a_share_policy_flow_us_tech_spillover",
                "single_stock_curve_technical_timing_preflight",
                "adversarial_data_conflict_06",
              ],
            },
            externalChannelBinding: {
              status: "deferred_active_training_or_eval",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function runCli(args: string[], workspaceDir: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, "--workspace", workspaceDir, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
}

type CandidateFeedbackResult = SkillOptResult & {
  candidatePath: string;
  receiptPath: string;
  latestReceiptPath: string;
  bestSkillPath: string;
  sourceAutopilotSha256: string;
  candidateFeedback: {
    status: string;
    candidateEditPaused: boolean;
    deferredTrainCases: string[];
    consumedReceiptPath: string | null;
    consumedReceiptSha256: string | null;
    gaps: string[];
  };
};
const candidateArgs = [
  "--skill",
  "single_stock_curve_technical_timing_preflight",
  "--candidate-edit",
  "--json",
];
function candidateResult(workspaceDir: string): CandidateFeedbackResult {
  const result = runCli(candidateArgs, workspaceDir);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as CandidateFeedbackResult;
}
async function replacePriorReceipt(
  workspaceDir: string,
  prior: CandidateFeedbackResult,
  edit: (receipt: CandidateFeedbackResult) => void,
) {
  const receipt = JSON.parse(
    await fs.readFile(path.join(workspaceDir, prior.latestReceiptPath), "utf8"),
  ) as CandidateFeedbackResult;
  edit(receipt);
  const bytes = JSON.stringify(receipt, null, 2) + "\n";
  await fs.writeFile(path.join(workspaceDir, prior.latestReceiptPath), bytes);
  await fs.writeFile(path.join(workspaceDir, prior.receiptPath), bytes);
}

describe("lcx-skillopt-lite CLI", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("consumes immutable prior candidate feedback and durably pauses unchanged edits across two subsequent runs", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skillopt-feedback-"));
    await seedAutopilot(workspaceDir);
    const first = candidateResult(workspaceDir);
    const firstBytes = await fs.readFile(path.join(workspaceDir, first.receiptPath), "utf8");
    const candidateBytes = await fs.readFile(path.join(workspaceDir, first.candidatePath), "utf8");
    const root = path.dirname(path.join(workspaceDir, first.candidatePath));
    expect(first.accepted).toBe(true);
    for (const previous of [first, undefined]) {
      const result = candidateResult(workspaceDir);
      expect(result).toMatchObject({
        accepted: false,
        status: "preflight_only_no_candidate_edit",
        trainCases: [],
        staticGateOk: true,
        candidatePath: first.candidatePath,
        candidateFeedback: {
          status: "paired_eval_required",
          candidateEditPaused: true,
          deferredTrainCases: first.trainCases,
        },
      });
      expect(result.proofChain.targetedEval).toMatchObject({
        status: "blocked_candidate_injection_unsupported",
        behaviorAccepted: false,
      });
      if (previous) {
        expect(result.candidateFeedback.consumedReceiptPath).toBe(
          path.join(workspaceDir, first.receiptPath),
        );
        expect(result.candidateFeedback.consumedReceiptSha256).toBe(
          createHash("sha256").update(firstBytes).digest("hex"),
        );
      }
      const persisted = JSON.parse(
        await fs.readFile(path.join(workspaceDir, result.latestReceiptPath), "utf8"),
      );
      expect(persisted.candidateFeedback).toEqual(result.candidateFeedback);
      expect(await fs.readFile(path.join(workspaceDir, first.bestSkillPath), "utf8")).toBe(
        candidateBytes,
      );
      expect(await fs.readdir(root)).toHaveLength(1);
    }
    expect(await fs.readFile(path.join(workspaceDir, first.receiptPath), "utf8")).toBe(firstBytes);
  });

  it.each([
    ["missing_receipt", "previous_receipt_missing"],
    ["immutable_conflict", "previous_receipt_bytes_conflict"],
    ["missing_candidate", "previous_candidate_missing_or_unreadable"],
    ["changed_candidate", "previous_candidate_hash_conflict"],
    ["changed_best", "previous_best_skill_hash_conflict"],
    ["cross_skill", "previous_receipt_scope_conflict"],
    ["missing_source_hash", "previous_source_hash_missing"],
    ["future_receipt", "previous_receipt_source_time_conflict"],
    ["unknown_eval", "previous_evaluation_status_unsupported_or_unknown"],
    ["candidate_identity_conflict", "previous_candidate_identity_conflict"],
    ["cross_scope_path", "previous_receipt_path_scope_conflict"],
    ["missing_immutable", "previous_immutable_receipt_missing_or_unreadable"],
    ["symlink_candidate", "previous_receipt_or_candidate_realpath_scope_conflict"],
  ])("does not attribute %s as valid prior feedback", async (fault, gap) => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skillopt-feedback-"));
    await seedAutopilot(workspaceDir);
    const first = candidateResult(workspaceDir);
    if (fault === "missing_receipt") {
      await fs.rm(path.join(workspaceDir, first.latestReceiptPath));
    }
    if (fault === "immutable_conflict") {
      await fs.appendFile(path.join(workspaceDir, first.receiptPath), " ");
    }
    if (fault === "missing_candidate") {
      await fs.rm(path.join(workspaceDir, first.candidatePath));
    }
    if (fault === "changed_candidate") {
      await fs.appendFile(path.join(workspaceDir, first.candidatePath), "changed");
    }
    if (fault === "changed_best") {
      await fs.appendFile(path.join(workspaceDir, first.bestSkillPath), "changed");
    }
    if (fault === "cross_skill") {
      await replacePriorReceipt(workspaceDir, first, (prior) => {
        prior.skillId = "another_skill";
      });
    }
    if (fault === "missing_source_hash") {
      await replacePriorReceipt(workspaceDir, first, (prior) => {
        delete (prior as Record<string, unknown>).sourceAutopilotSha256;
      });
    }
    if (fault === "future_receipt") {
      await replacePriorReceipt(workspaceDir, first, (prior) => {
        prior.checkedAt = "2099-01-01T00:00:00.000Z";
      });
    }
    if (fault === "unknown_eval") {
      await replacePriorReceipt(workspaceDir, first, (prior) => {
        prior.proofChain.targetedEval.status = "accepted_from_unverified_schema";
      });
    }
    if (fault === "candidate_identity_conflict") {
      await replacePriorReceipt(workspaceDir, first, (prior) => {
        prior.proofChain.targetedEval.candidateIdentities.push({
          ...prior.proofChain.targetedEval.candidateIdentities[0],
        });
      });
    }
    if (fault === "cross_scope_path") {
      await replacePriorReceipt(workspaceDir, first, (prior) => {
        prior.candidatePath = "../another-workspace/candidate.md";
      });
    }
    if (fault === "missing_immutable") {
      await fs.rm(path.join(workspaceDir, first.receiptPath));
    }
    if (fault === "symlink_candidate") {
      const candidate = path.join(workspaceDir, first.candidatePath);
      const outsideScope = path.join(workspaceDir, "candidate-outside-skill.md");
      await fs.copyFile(candidate, outsideScope);
      await fs.rm(candidate);
      await fs.symlink(outsideScope, candidate);
    }
    const result = candidateResult(workspaceDir);
    expect(result.candidateFeedback).toMatchObject({
      status: "unverified",
      candidateEditPaused: false,
      gaps: [gap],
    });
    expect(result.proofChain.targetedEval).toMatchObject({ behaviorAccepted: false });
  });

  it.each(["source_bytes_same_timestamp", "source_time", "curriculum_limit"])(
    "records %s as changed input rather than suppressing a new candidate",
    async (change) => {
      workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skillopt-feedback-"));
      await seedAutopilot(workspaceDir);
      const first = candidateResult(workspaceDir);
      const statePath = path.join(workspaceDir, "state", "lcx-governance-autopilot-latest.json");
      if (change === "source_bytes_same_timestamp") {
        await fs.appendFile(statePath, " ");
      }
      if (change === "source_time") {
        const snapshot = JSON.parse(await fs.readFile(statePath, "utf8"));
        snapshot.checkedAt = "2026-05-26T11:00:00.000Z";
        await fs.writeFile(statePath, JSON.stringify(snapshot));
      }
      const result = runCli(
        [...candidateArgs, ...(change === "curriculum_limit" ? ["--max-train-cases", "1"] : [])],
        workspaceDir,
      );
      expect(result.status, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout) as CandidateFeedbackResult;
      expect(parsed.candidateFeedback).toMatchObject({
        status: "input_changed",
        candidateEditPaused: false,
      });
      expect(parsed.accepted).toBe(true);
      expect(parsed.candidatePath).not.toBe(first.candidatePath);
      expect(parsed.proofChain.targetedEval).toMatchObject({ behaviorAccepted: false });
    },
  );

  it("blocks behavior attribution even when every case is registered", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skillopt-lite-"));
    await seedAutopilot(workspaceDir);
    const statePath = path.join(workspaceDir, "state", "lcx-governance-autopilot-latest.json");
    const snapshot = JSON.parse(await fs.readFile(statePath, "utf8"));
    snapshot.owners.trainingPlan.latestCandidateEval.parseRecoveredCaseIds = [
      "single_stock_curve_technical_timing_preflight",
    ];
    await fs.writeFile(statePath, JSON.stringify(snapshot));
    const result = runCli(
      [
        "--skill",
        "single_stock_curve_technical_timing_preflight",
        "--candidate-edit",
        "--no-write",
        "--json",
      ],
      workspaceDir,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as SkillOptResult;
    expect(parsed.proofChain.targetedEval).toMatchObject({
      status: "blocked_candidate_injection_unsupported",
      behaviorAccepted: false,
      registryValidation: { ok: true },
    });
    expect(parsed.proofChain.targetedEval.contractDiagnosticCommand).toContain("--contract-only");
    expect(parsed.nextIdleCommand).toBeNull();
  });

  it("rejects historical case IDs before offering a model eval command", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skillopt-lite-"));
    await seedAutopilot(workspaceDir);
    const statePath = path.join(workspaceDir, "state", "lcx-governance-autopilot-latest.json");
    const snapshot = JSON.parse(await fs.readFile(statePath, "utf8"));
    snapshot.owners.trainingPlan.latestCandidateEval.parseRecoveredCaseIds = [
      "short_lark_commodity_scope_01",
    ];
    await fs.writeFile(statePath, JSON.stringify(snapshot));
    const result = runCli(
      [
        "--skill",
        "external_channel_boundary_preflight",
        "--candidate-edit",
        "--no-write",
        "--json",
      ],
      workspaceDir,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as SkillOptResult;
    expect(parsed.proofChain.targetedEval.status).toBe("blocked_invalid_eval_cases");
    expect(parsed.proofChain.targetedEval.registryValidation.reason).toContain(
      "unknown eval case id",
    );
    expect(parsed.nextIdleCommand).toBeNull();
    expect(parsed.proofChain.targetedEval.candidateIdentities[0].materialized).toBe(false);
  });

  it("builds a dry-run SkillOpt-lite split from latest governance truth", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skillopt-lite-"));
    await seedAutopilot(workspaceDir);

    const result = runCli(
      [
        "--skill",
        "single_stock_curve_technical_timing_preflight",
        "--no-write",
        "--json",
        "--max-train-cases",
        "2",
      ],
      workspaceDir,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as SkillOptResult;

    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "local_skillopt_lite_only",
        updated: false,
        skillId: "single_stock_curve_technical_timing_preflight",
        activeProcessCount: 3,
        latestCandidateAdapter: "/adapters/candidate-r6",
        parseRecoveredCount: 4,
        trainCaseCount: 2,
        validationCaseCount: 2,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(parsed.trainCases).toEqual([
      "full_stack_finance_stress_with_red_team",
      "a_share_policy_flow_us_tech_spillover",
    ]);
    expect(parsed.regressionCases).toEqual(
      expect.arrayContaining(["single_stock_curve_technical_timing_preflight"]),
    );
    await expect(
      fs.stat(
        path.join(
          workspaceDir,
          "memory/skillopt-lite/single_stock_curve_technical_timing_preflight/best_skill.md",
        ),
      ),
    ).rejects.toThrow();
  });

  it("writes a bootstrap best_skill seed and receipt under workspace memory", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skillopt-lite-"));
    await seedAutopilot(workspaceDir);

    const result = runCli(["--json"], workspaceDir);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as SkillOptResult;

    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        updated: true,
        status: "bootstrap_best_skill_seed_ready",
        staticGateOk: true,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );

    const bestSkill = await fs.readFile(
      path.join(
        workspaceDir,
        "memory/skillopt-lite/single_stock_curve_technical_timing_preflight/best_skill.md",
      ),
      "utf8",
    );
    expect(bestSkill).toContain("technical_timing");
    expect(bestSkill).toContain("company_fundamentals_value");
    expect(bestSkill).toContain("portfolio_risk_gates");
    expect(bestSkill).toContain("source_registry");
    expect(bestSkill).toContain("data_provenance_quality");
    expect(bestSkill).toContain("direct_buy_sell_answer");
    expect(bestSkill).toContain("technical_timing_as_standalone_alpha");

    await expect(
      fs.stat(
        path.join(
          workspaceDir,
          "memory/skillopt-lite/single_stock_curve_technical_timing_preflight/skillopt-lite-latest.json",
        ),
      ),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(
        path.join(
          workspaceDir,
          "memory/skillopt-lite/finance_data_provenance_preflight/best_skill.md",
        ),
      ),
    ).resolves.toBeTruthy();
  });

  it("accepts a bounded candidate edit only as pending eval evidence", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skillopt-lite-"));
    await seedAutopilot(workspaceDir);

    expect(runCli(["--json"], workspaceDir).status).toBe(0);
    const result = runCli(
      ["--phase", "candidate-edit", "--json", "--max-train-cases", "3"],
      workspaceDir,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as SkillOptResult;

    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        phase: "candidate-edit",
        accepted: true,
        status: "candidate_edit_static_accepted_pending_eval",
        trainCaseCount: 4,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(parsed.matchedSkillIds).toEqual(
      expect.arrayContaining([
        "single_stock_curve_technical_timing_preflight",
        "finance_data_provenance_preflight",
      ]),
    );
    expect(parsed.proofChain).toEqual(
      expect.objectContaining({
        boundary: "local_skillopt_proof_chain_only",
      }),
    );
    expect(parsed.nextIdleCommand).toBeNull();
    expect(parsed.proofChain.targetedEval).toMatchObject({
      command: null,
      candidateInjectionSupported: false,
      behaviorAccepted: false,
    });
    expect(parsed.proofChain.targetedEval.caseGroups).toEqual({
      train: parsed.trainCases,
      validation: parsed.validationCases,
      regression: parsed.regressionCases,
    });
    const requestedIds = parsed.proofChain.targetedEval.registryValidation.caseIds;
    for (const id of [...parsed.trainCases, ...parsed.validationCases, ...parsed.regressionCases]) {
      expect(requestedIds).toContain(id);
    }
    for (const identity of parsed.proofChain.targetedEval.candidateIdentities) {
      const bytes = await fs.readFile(identity.path);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(identity.sha256);
      expect(identity.materialized).toBe(true);
    }
    expect(parsed.absorptionPlan).toEqual(
      expect.objectContaining({
        status: "not_absorbed_until_training_and_promotion_truth",
      }),
    );

    const bestSkill = await fs.readFile(
      path.join(
        workspaceDir,
        "memory/skillopt-lite/single_stock_curve_technical_timing_preflight/best_skill.md",
      ),
      "utf8",
    );
    expect(bestSkill).toContain("## Candidate Edit: Adjacent Failure Transfer");
    expect(bestSkill).toContain("pending_eval_acceptance");
    expect(bestSkill).toContain("macro/cross-asset context");
    expect(bestSkill).toContain("accept this candidate edit only after targeted eval improves");

    const candidatePath = parsed.candidatePath as string;
    await expect(fs.stat(path.join(workspaceDir, candidatePath))).resolves.toBeTruthy();
  });

  it("refreshes stale external-channel boundary skill contracts before scoring candidate edits", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skillopt-lite-"));
    await seedAutopilot(workspaceDir);
    const skillRoot = path.join(
      workspaceDir,
      "memory/skillopt-lite/external_channel_boundary_preflight",
    );
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "best_skill.md"),
      [
        "# External External Channel Boundary Preflight",
        "",
        "boundary: local_skillopt_lite_only",
        "",
        "## Purpose",
        "Old external-channel proof text requires selected clean adapter and fresh real inbound/outbound evidence.",
      ].join("\n"),
      "utf8",
    );

    const result = runCli(
      [
        "--skill",
        "external_channel_boundary_preflight",
        "--phase",
        "candidate-edit",
        "--json",
        "--max-train-cases",
        "2",
      ],
      workspaceDir,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as SkillOptResult;

    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        staticGateOk: true,
        staticGateMissingTokens: [],
        status: "candidate_edit_static_accepted_pending_eval",
      }),
    );

    const bestSkill = await fs.readFile(path.join(skillRoot, "best_skill.md"), "utf8");
    expect(bestSkill).toContain("## Current Static Contract Terms");
    expect(bestSkill).toContain("external_message_channel_binding");
    expect(bestSkill).toContain("local_ready_not_user_visible_observed");
    expect(bestSkill).toContain("channel_probe_as_user_visible_observed");
    expect(bestSkill).toContain("dirty_candidate_external_channel_binding");
    expect(bestSkill).toContain("external_channel_source_drift_zero_after_selected_adapter");
    expect(bestSkill).toContain(
      "external_message_channel_gateway_restarted_after_selected_adapter",
    );
    expect(bestSkill).toContain("external_message_channel_status_ok_after_restart");
    expect(bestSkill).toContain("fresh_real_external_inbound_and_outbound_user_visible_observed");
  });

  it("builds an immediate deterministic preflight packet without claiming absorption or user-visible proof", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skillopt-lite-"));
    await seedAutopilot(workspaceDir);

    const result = runCli(
      ["--no-write", "--json", "--task", "最新价格和供应商数据冲突，哪个能信？"],
      workspaceDir,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as SkillOptResult;
    const instantPreflight = parsed.instantPreflight as Record<string, unknown>;

    expect(instantPreflight).toEqual(
      expect.objectContaining({
        status: "ready_for_context_injection",
        boundary: "local_skillopt_preflight_only",
        canUseImmediately: true,
        modelWeightAbsorbed: false,
        externalChannelApplied: false,
      }),
    );
    expect(instantPreflight.matchedSkillIds).toEqual(
      expect.arrayContaining(["finance_data_provenance_preflight"]),
    );
    expect(String(instantPreflight.promptInjection)).toContain("Finance Data Provenance Preflight");
    expect(parsed.externalChannelProofPlan).toEqual(
      expect.objectContaining({
        status: "blocked_by_active_training_or_eval",
      }),
    );
  });
});
