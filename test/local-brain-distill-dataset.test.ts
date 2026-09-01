import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function parseJsonl(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

describe("local brain distill dataset", () => {
  it("publishes dataset files only after atomic same-directory writes", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/local-brain-distill-dataset.ts"),
      "utf8",
    );

    expect(source).toContain("async function writeFileAtomic");
    expect(source).toContain('await fs.writeFile(tempPath, content, "utf8")');
    expect(source).toContain("await fs.rename(tempPath, filePath)");
    expect(source).toContain('const handle = await fs.open(tempPath, "w")');
    expect(source).toContain("for (const example of examples)");
    expect(source).toContain("async function collectExamplesFromFiles");
    expect(source).toContain("for (const filePath of files)");
    expect(source).not.toContain("Promise.all(files.map((filePath) => examplesFromFile");
  });

  it("teaches Qwen no-think compact JSON prompts in every generated dataset example", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/local-brain-distill-dataset.ts"),
      "utf8",
    );
    const contractSource = await fs.readFile(
      path.join(repoRoot, "scripts/operator/local-brain-training-contract.ts"),
      "utf8",
    );

    expect(source).toContain("buildLocalBrainTrainingPrompt");
    expect(contractSource).toContain("/no_think");
    expect(contractSource).toContain("Do not emit chain-of-thought, markdown, or <think> blocks");
    expect(contractSource).toContain("Keep the JSON compact");
    expect(contractSource).toContain("LOCAL_BRAIN_OUTPUT_CONTRACT_HINTS");
    expect(contractSource).toContain("Use this exact compact shape");
    expect(contractSource).toContain('risk_boundaries":["research_only"]');
  });

  it("includes current real-market stress families as high-weight Qwen curated seeds", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/local-brain-distill-dataset.ts"),
      "utf8",
    );

    expect(source).toContain("treasury_supply_term_premium_portfolio_risk");
    expect(source).toContain("private_credit_nonbank_leverage_stress_waterflow");
    expect(source).toContain("ai_capex_power_grid_index_concentration_risk");
    expect(source).toContain("energy_inflation_cross_asset_shock_risk");
    expect(source).toContain("treasury_issuance_refunding_and_auction_calendar");
    expect(source).toContain("nonbank_leverage_and_redemption_pressure_inputs");
    expect(source).toContain("data_center_power_grid_and_energy_constraint_inputs");
    expect(source).toContain("equity_bond_hedge_may_fail_under_supply_shock");
    expect(source).toContain("local_brain_sample_trust_accounting");
    expect(source).toContain("teacher_distillation_quality_control");
    expect(source).toContain("eval_family_expansion_after_training_material");
    expect(source).toContain("module_learning_receipt_truth_boundary");
  });

  it("writes parseable seed splits for downstream smoke checks", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-local-brain-dataset-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const outDir = path.join(fixtureRoot, "dataset");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        fs.writeFile(
          path.join(receiptsDir, `receipt-${index + 1}.md`),
          [
            "## User Ask",
            `- Decompose research-only portfolio risk task ${index + 1}: QQQ, TLT, NVDA, rates, dollar liquidity, and AI capex.`,
            "",
            "- **Surface**: control_room",
            "",
            "## Final Reply Summary",
            `- Split sample ${index + 1} across macro rates, credit liquidity, ETF regime, company fundamentals, portfolio risk, and review.`,
            "",
          ].join("\n"),
        ),
      ),
    );

    await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/local-brain-distill-dataset.ts",
        "--workspace",
        workspaceDir,
        "--out",
        outDir,
        "--json",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: fixtureRoot },
      },
    );

    await expect(parseJsonl(path.join(outDir, "train.jsonl"))).resolves.not.toHaveLength(0);
    await expect(parseJsonl(path.join(outDir, "valid.jsonl"))).resolves.not.toHaveLength(0);
    await expect(parseJsonl(path.join(outDir, "test.jsonl"))).resolves.not.toHaveLength(0);

    const manifest = JSON.parse(await fs.readFile(path.join(outDir, "manifest.json"), "utf8")) as {
      sampleTrust?: {
        sourceTrustTierCounts?: Record<string, number>;
        hardEvalProofSeparateFromTrainingSamples?: boolean;
      };
      sourceKinds?: Record<string, number>;
      teacherReviewQuality?: {
        total?: number;
        qualityTiers?: Record<string, number>;
        dedup?: { uniqueContent?: number; duplicateGroups?: number };
      };
    };
    expect(manifest.sampleTrust?.sourceTrustTierCounts?.gold_curated).toBeGreaterThan(0);
    expect(manifest.sampleTrust?.hardEvalProofSeparateFromTrainingSamples).toBe(true);
    expect(manifest.sourceKinds?.curated_seed).toBeGreaterThanOrEqual(300);
    expect(manifest.teacherReviewQuality?.dedup?.uniqueContent).toBeGreaterThanOrEqual(0);

    const trainExamples = await parseJsonl(path.join(outDir, "train.jsonl"));
    const canonicalQuantGap = trainExamples.some((entry) => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      const completion = JSON.parse((entry as { completion: string }).completion) as {
        missing_data?: string[];
      };
      return completion.missing_data?.includes("position_weights_and_return_series");
    });
    expect(canonicalQuantGap).toBe(true);
    for (const entry of trainExamples) {
      const completion = (entry as { completion?: unknown }).completion;
      expect(typeof completion).toBe("string");
      expect(completion).not.toContain("\n");
    }

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/local-brain-distill-smoke.ts",
        "--data",
        outDir,
        "--json",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: fixtureRoot },
      },
    );

    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      boundary: "local_auxiliary_thought_flow_only",
      liveTouched: false,
      providerConfigTouched: false,
    });
  });

  it("canonicalizes handoff safety text into machine-checkable risk boundaries", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-local-brain-handoff-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const outDir = path.join(fixtureRoot, "dataset");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    const handoffDir = path.join(
      workspaceDir,
      "memory",
      "lark-language-handoff-receipts",
      "2026-06-02",
    );
    await fs.mkdir(receiptsDir, { recursive: true });
    await fs.mkdir(handoffDir, { recursive: true });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        fs.writeFile(
          path.join(receiptsDir, `receipt-${index + 1}.md`),
          [
            "## User Ask",
            `- Decompose research-only portfolio workflow smoke filler ${index + 1}: QQQ, TLT, NVDA, rates, and risk gate.`,
            "",
            "- **Surface**: control_room",
            "",
            "## Final Reply Summary",
            `- Smoke filler ${index + 1} covers macro rates, ETF regime, company fundamentals, and portfolio risk.`,
            "",
          ].join("\n"),
        ),
      ),
    );
    await fs.writeFile(
      path.join(handoffDir, "handoff.json"),
      JSON.stringify({
        boundary: "language_handoff_only",
        generatedAt: "2026-06-02T00:00:00.000Z",
        userMessage: "加不加仓？",
        targetSurface: "technical_daily",
        noExecutionApproval: false,
        noFinanceLearningArtifact: false,
        handoff: {
          family: "position_risk_adjustment",
          apiCandidate: {
            family: "position_risk_adjustment",
            rationale: "用户问加不加仓但缺仓位和成本基础，按 research-only 风险检查。",
            workOrder: {
              objective: "对持仓标的进行加仓前风险研究检查，不执行交易",
              evidenceRequired: ["持仓标的是什么", "成本基础或资金权重"],
              safetyBoundaries: [
                "必须先问仓位和成本基础，未提供则block精确建议",
                "所有结论标记为研究参考而非执行授权",
              ],
            },
          },
        },
      }),
    );

    await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/local-brain-distill-dataset.ts",
        "--workspace",
        workspaceDir,
        "--out",
        outDir,
        "--json",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: fixtureRoot },
      },
    );

    const splitExamples = (
      await Promise.all(
        ["train.jsonl", "valid.jsonl", "test.jsonl"].map((fileName) =>
          parseJsonl(path.join(outDir, fileName)),
        ),
      )
    ).flat() as Array<{
      completion: string;
      meta?: { sourceKind?: string };
    }>;
    const handoffExample = splitExamples.find(
      (entry) => entry.meta?.sourceKind === "lark_language_handoff_receipt",
    );
    expect(handoffExample).toBeTruthy();
    const completion = JSON.parse(handoffExample?.completion ?? "{}") as {
      risk_boundaries?: string[];
    };
    expect(completion.risk_boundaries).toEqual(
      expect.arrayContaining(["research_only", "no_execution_authority"]),
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/local-brain-distill-smoke.ts",
        "--data",
        outDir,
        "--json",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: fixtureRoot },
      },
    );
    expect(JSON.parse(stdout)).toMatchObject({ ok: true });
  });

  it("sanitizes accepted review plans before dataset training output", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-local-brain-review-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const outDir = path.join(fixtureRoot, "dataset");
    const reviewDir = path.join(
      workspaceDir,
      "memory",
      "lark-brain-distillation-reviews",
      "2026-05-06",
    );
    await fs.mkdir(reviewDir, { recursive: true });
    await fs.writeFile(
      path.join(reviewDir, "review.json"),
      JSON.stringify({
        boundary: "brain_distillation_review",
        reviewedAt: "2026-05-06T00:00:00.000Z",
        noLanguageRoutingPromotion: true,
        acceptedCandidates: [
          {
            boundary: "brain_distillation_candidate",
            status: "accepted_brain_plan",
            review: { accepted: true },
            userMessage: "未来一个月看 QQQ、TLT 和 ETH 风险，先拆模块不要交易建议。",
            candidateText:
              "research-only macro liquidity plan; writes brain distillation only; no external channel sender, provider config, language corpus, protected memory, or finance doctrine change; no current market claim supplied.",
            proposedTaskFamily: "portfolio_regime",
            proposedPrimaryModules: ["macro_rates_inflation", "portfolio_risk_gates"],
            proposedSupportingModules: ["review_panel"],
            proposedRequiredTools: ["review_panel"],
            proposedMissingData: [
              "position_weights",
              "return_series_or_price_history",
              "fresh_market_data_snapshot",
            ],
            proposedRiskBoundaries: [
              "research_only",
              "no_execution_authority",
              "no_leverage_on_crypto",
              ...Array.from({ length: 50 }, (_, index) => `teacher_noise_boundary_${index}`),
            ],
            proposedNextStep:
              "Pull latest Fed rate expectations, USD liquidity indicators, ETF flow data, and ETH market structure metrics, then summarize.",
          },
        ],
      }),
    );

    await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/local-brain-distill-dataset.ts",
        "--workspace",
        workspaceDir,
        "--out",
        outDir,
        "--json",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: fixtureRoot },
      },
    );

    const trainExamples = await parseJsonl(path.join(outDir, "train.jsonl"));
    const reviewedExamples = trainExamples.filter((entry) => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      return (
        (entry as { meta?: { sourceKind?: string } }).meta?.sourceKind ===
        "brain_distillation_review"
      );
    }) as Array<{ completion: string; prompt: string }>;
    const reviewedExample = reviewedExamples[0];
    expect(reviewedExamples).toHaveLength(1);
    expect(reviewedExample).toBeTruthy();
    const completion = JSON.parse(reviewedExample?.completion ?? "{}") as {
      missing_data?: string[];
      next_step?: string;
      risk_boundaries?: string[];
    };
    expect(completion.missing_data).toContain("position_weights_and_return_series");
    expect(completion.risk_boundaries).toEqual(
      expect.arrayContaining([
        "no_language_corpus_modification",
        "no_unverified_current_market_data",
        "no_high_leverage_crypto",
      ]),
    );
    expect(completion.risk_boundaries?.length).toBeLessThanOrEqual(6);
    expect(completion.risk_boundaries).not.toContain("teacher_noise_boundary_49");
    expect(completion.next_step).not.toMatch(/pull latest|ETF flow data|ETH market/i);
    expect(completion.next_step).toContain("timestamped source evidence");
    expect(reviewedExample.prompt.length + reviewedExample.completion.length).toBeLessThan(6_000);
  });

  it("feeds module-learning plan and review receipts into Qwen training material without claiming absorption", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-local-brain-module-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const outDir = path.join(fixtureRoot, "dataset");
    const planDir = path.join(
      workspaceDir,
      "memory",
      "module-learning-pipeline-plan-receipts",
      "2026-05-20",
    );
    const reviewDir = path.join(workspaceDir, "memory", "module-learning-pipeline-reviews");
    await fs.mkdir(planDir, { recursive: true });
    await fs.mkdir(reviewDir, { recursive: true });

    const row = {
      receiptPath: "memory/module-learning-pipeline-plan-receipts/2026-05-20/options.json",
      targetModule: "options_volatility",
      moduleFamily: "finance_research",
      status: "application_ready",
      sourceUrlOrPath: "memory/research-sources/options.md",
      learningIntent:
        "Convert options volatility source learning into module-learning review without claiming eval absorption.",
      actualReadingScope: "Local source plus retrieval/apply receipts only.",
      moduleSpecificCapabilityRule:
        "Options learning must separate IV and gamma observation from trade recommendation.",
      requiredInputs: [
        "iv_term_structure_skew_gamma_inputs",
        "position_exposure_and_gap_risk_inputs",
      ],
      safetyBoundaries: ["research_only", "no_execution_authority", "no_trade_advice"],
      missingEvidence: [
        "training_or_eval_absorption_evidence",
        "fresh_adjacent_application_task",
        "keep_downrank_or_discard_decision",
      ],
      keepDownrankDiscardDecision: "not_decided",
      weak: true,
      failedReason: "application_ready",
    };

    await fs.writeFile(
      path.join(planDir, "options.json"),
      JSON.stringify({
        ok: true,
        boundary: "local_module_learning_pipeline_plan",
        ...row,
        applicationValidationTask:
          "Use options volatility learning on a fresh QQQ/TLT/NVDA portfolio-risk research task.",
        claimBoundary:
          "A module is not learned from storage alone; do not claim eval_absorbed without evidence.",
      }),
    );
    await fs.writeFile(
      path.join(reviewDir, "2026-05-20.json"),
      JSON.stringify({
        ok: true,
        boundary: "module_learning_pipeline_review_only",
        counts: { applicationReady: 1, evalAbsorbed: 0, weakModuleLearning: 1 },
        rows: [row],
      }),
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/local-brain-distill-dataset.ts",
        "--workspace",
        workspaceDir,
        "--out",
        outDir,
        "--json",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: fixtureRoot },
      },
    );

    const manifest = JSON.parse(stdout) as { sourceKinds?: Record<string, number> };
    expect(manifest.sourceKinds).toMatchObject({
      module_learning_plan_receipt: 1,
      module_learning_review_receipt: 1,
    });

    const trainExamples = (await parseJsonl(path.join(outDir, "train.jsonl"))) as Array<{
      completion: string;
      meta?: { sourceKind?: string };
    }>;
    const moduleExamples = trainExamples.filter((entry) =>
      entry.meta?.sourceKind?.startsWith("module_learning_"),
    );
    expect(moduleExamples).toHaveLength(2);
    for (const example of moduleExamples) {
      const completion = JSON.parse(example.completion) as {
        primary_modules?: string[];
        missing_data?: string[];
        risk_boundaries?: string[];
        next_step?: string;
      };
      expect(completion.primary_modules).toContain("options_volatility");
      expect(completion.primary_modules).toContain("source_registry");
      expect(completion.missing_data).toEqual(
        expect.arrayContaining([
          "training_or_eval_absorption_evidence",
          "fresh_adjacent_application_task",
          "keep_downrank_or_discard_decision",
        ]),
      );
      expect(completion.risk_boundaries).toContain("no_execution_authority");
      expect(completion.next_step).toMatch(/eval_absorption|keep_downrank/u);
    }
  });

  it("collects newest review artifacts before applying max file limits", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-local-brain-newest-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const outDir = path.join(fixtureRoot, "dataset");
    const reviewDir = path.join(
      workspaceDir,
      "memory",
      "lark-brain-distillation-reviews",
      "2026-05-08",
    );
    await fs.mkdir(reviewDir, { recursive: true });

    for (let index = 0; index < 5; index += 1) {
      const oldPath = path.join(reviewDir, `old-${index}.json`);
      await fs.writeFile(
        oldPath,
        JSON.stringify({
          boundary: "brain_distillation_review",
          reviewedAt: "2026-05-07T00:00:00.000Z",
          noLanguageRoutingPromotion: true,
          acceptedCandidates: [],
        }),
      );
      await fs.utimes(
        oldPath,
        new Date("2026-05-07T00:00:00.000Z"),
        new Date("2026-05-07T00:00:00.000Z"),
      );
    }

    const newestPath = path.join(reviewDir, "z-anthropic-financial-agent.json");
    await fs.writeFile(
      newestPath,
      JSON.stringify({
        boundary: "brain_distillation_review",
        reviewedAt: "2026-05-08T04:54:30.096Z",
        noLanguageRoutingPromotion: true,
        acceptedCandidates: [
          {
            boundary: "brain_distillation_candidate",
            status: "accepted_brain_plan",
            review: { accepted: true },
            userMessage:
              "Anthropic 上传了金融 agent，学习 market researcher 和 earnings reviewer 的 workflow pattern，不要改外部通道发送器。",
            candidateText: "external_financial_agent_pattern_distillation",
            proposedTaskFamily: "external_financial_agent_pattern_distillation",
            proposedPrimaryModules: [
              "finance_learning_memory",
              "skill_pattern_distillation",
              "agent_workflow_memory",
              "source_registry",
              "review_panel",
            ],
            proposedSupportingModules: ["control_room_summary"],
            proposedRequiredTools: ["source_registry", "review_panel"],
            proposedMissingData: [
              "source_repo_url_or_local_clone_path",
              "source_commit_or_version",
              "actual_reading_scope",
            ],
            proposedRiskBoundaries: [
              "research_only",
              "no_execution_authority",
              "no_provider_config_change",
              "no_external_channel_sender_change",
            ],
            proposedNextStep:
              "Distill pinned external financial-agent workflow boundaries before review.",
          },
        ],
      }),
    );
    await fs.utimes(
      newestPath,
      new Date("2026-05-08T04:54:30.096Z"),
      new Date("2026-05-08T04:54:30.096Z"),
    );

    await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/local-brain-distill-dataset.ts",
        "--workspace",
        workspaceDir,
        "--out",
        outDir,
        "--max-files",
        "2",
        "--json",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: fixtureRoot },
      },
    );

    const allExamples = [
      ...(await parseJsonl(path.join(outDir, "train.jsonl"))),
      ...(await parseJsonl(path.join(outDir, "valid.jsonl"))),
      ...(await parseJsonl(path.join(outDir, "test.jsonl"))),
    ];
    expect(JSON.stringify(allExamples)).toContain("external_financial_agent_pattern_distillation");
  });

  it("continues dataset generation when some directories are unreadable", async () => {
    if (process.platform === "win32") {
      return;
    }

    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-local-brain-unreadable-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const outDir = path.join(fixtureRoot, "dataset");
    const readableDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    const unreadableDir = path.join(workspaceDir, "private");
    await fs.mkdir(readableDir, { recursive: true });
    await fs.mkdir(unreadableDir, { recursive: true });
    await fs.writeFile(
      path.join(readableDir, "ok.md"),
      "## User Ask\n- Decompose the macro risk split\n\n## Final Reply Summary\n- check liquidity and flow with safe labels",
    );
    await fs.writeFile(path.join(unreadableDir, "blocked.md"), "blocked");
    await fs.chmod(unreadableDir, 0);

    try {
      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/operator/local-brain-distill-dataset.ts",
          "--workspace",
          workspaceDir,
          "--out",
          outDir,
          "--json",
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, HOME: fixtureRoot },
        },
      );
      const [trainExamples, validExamples, testExamples] = await Promise.all([
        parseJsonl(path.join(outDir, "train.jsonl")),
        parseJsonl(path.join(outDir, "valid.jsonl")),
        parseJsonl(path.join(outDir, "test.jsonl")),
      ]);

      expect(trainExamples.length + validExamples.length + testExamples.length).toBeGreaterThan(0);
    } finally {
      await fs.chmod(unreadableDir, 0o700);
    }
  });
});
