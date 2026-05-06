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
});
