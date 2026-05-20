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
      path.join(repoRoot, "scripts/dev/local-brain-distill-dataset.ts"),
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
      path.join(repoRoot, "scripts/dev/local-brain-distill-dataset.ts"),
      "utf8",
    );

    expect(source).toContain("/no_think");
    expect(source).toContain("Do not emit chain-of-thought, markdown, or <think> blocks");
    expect(source).toContain("Keep the JSON compact");
    expect(source).toContain("LOCAL_BRAIN_OUTPUT_CONTRACT_HINTS");
    expect(source).toContain("Use this exact compact shape");
    expect(source).toContain('risk_boundaries":["research_only"]');
  });

  it("includes current real-market stress families as high-weight Qwen curated seeds", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/dev/local-brain-distill-dataset.ts"),
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
        "scripts/dev/local-brain-distill-dataset.ts",
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
      ["--import", "tsx", "scripts/dev/local-brain-distill-smoke.ts", "--data", outDir, "--json"],
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
              "research-only macro liquidity plan; writes brain distillation only; no live sender, provider config, language corpus, protected memory, or finance doctrine change; no current market claim supplied.",
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
        "scripts/dev/local-brain-distill-dataset.ts",
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
              "Anthropic 上传了金融 agent，学习 market researcher 和 earnings reviewer 的 workflow pattern，不要改 live sender。",
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
              "no_live_sender_change",
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
        "scripts/dev/local-brain-distill-dataset.ts",
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
          "scripts/dev/local-brain-distill-dataset.ts",
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
