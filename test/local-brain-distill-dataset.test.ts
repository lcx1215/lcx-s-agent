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
            candidateText: "research-only macro liquidity plan",
            proposedTaskFamily: "portfolio_regime",
            proposedPrimaryModules: ["macro_rates_inflation", "portfolio_risk_gates"],
            proposedSupportingModules: ["review_panel"],
            proposedRequiredTools: ["review_panel"],
            proposedMissingData: [
              "position_weights",
              "return_series_or_price_history",
              "fresh_market_data_snapshot",
            ],
            proposedRiskBoundaries: ["research_only", "no_execution_authority"],
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
    const reviewedExample = trainExamples.find((entry) => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      return (
        (entry as { meta?: { sourceKind?: string } }).meta?.sourceKind ===
        "brain_distillation_review"
      );
    }) as { completion: string } | undefined;
    expect(reviewedExample).toBeTruthy();
    const completion = JSON.parse(reviewedExample?.completion ?? "{}") as {
      missing_data?: string[];
      next_step?: string;
    };
    expect(completion.missing_data).toContain("position_weights_and_return_series");
    expect(completion.next_step).not.toMatch(/pull latest|ETF flow data|ETH market/i);
    expect(completion.next_step).toContain("timestamped source evidence");
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
});
