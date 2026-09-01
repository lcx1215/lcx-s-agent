import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function runBrief(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/operator/lcx-directed-daily-research-brief.ts", ...args, "--json"],
    {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("lcx-directed-daily-research-brief", () => {
  it("defines a focused daily research product instead of relying on open-ended Q&A", async () => {
    const payload = await runBrief(["--date", "2026-06-01"]);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "local_directed_daily_research_brief_only",
        productMode: "focused_daily_research_product_not_open_ended_chat",
        date: "2026-06-01",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.focus).toEqual(
      expect.objectContaining({
        primary: "index_options_and_semiconductor_ai_compute_chain",
        cadence: "daily_low_frequency_research",
      }),
    );
    expect(payload.universe).toEqual(
      expect.objectContaining({
        indexOptions: expect.arrayContaining(["SPX", "NDX", "QQQ", "VIX"]),
        semiconductorAiCompute: expect.arrayContaining(["NVDA", "AMD", "AVGO", "TSM", "ASML"]),
        arbitrageResearch: expect.arrayContaining([
          "cross_venue_relative_value",
          "cross_border_fx_basis",
        ]),
      }),
    );
    expect(payload.outputContract).toEqual(
      expect.objectContaining({
        requiredEvidence: expect.arrayContaining([
          "source_timestamp",
          "field_definition",
          "provider_role",
          "conflict_or_missing_data_status",
        ]),
        forbiddenVisibleOutputs: expect.arrayContaining([
          "buy_sell_add_reduce_instruction",
          "position_percentage",
          "options_bet_instruction",
        ]),
      }),
    );
    expect(payload.learningContract).toEqual(
      expect.objectContaining({
        sourceNameAndPathRequired: true,
        terminalDecision: "application_ready_or_failedReason",
      }),
    );
    expect(String(payload.visibleBrief)).toContain("指数期权");
    expect(String(payload.visibleBrief)).toContain("半导体/AI 算力链");
    expect(String(payload.visibleBrief)).toContain("套利研究类别");
    expect(String(payload.visibleBrief)).toContain("research-only");
  });

  it("writes latest owner-visible state when explicitly requested", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-daily-"));
    const payload = await runBrief(["--write", "--date", "2026-06-01"], {
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
    });

    const written = payload.written as Record<string, string>;
    expect(written.latestJsonPath).toBe(
      path.join(workspaceDir, "state", "lcx-directed-daily-research-brief-latest.json"),
    );
    expect(written.latestMarkdownPath).toBe(
      path.join(workspaceDir, "state", "lcx-directed-daily-research-brief-latest.md"),
    );
    await expect(fs.readFile(written.latestMarkdownPath, "utf8")).resolves.toContain(
      "每天固定产出",
    );
    await expect(fs.readFile(written.latestJsonPath, "utf8")).resolves.toContain(
      "focused_daily_research_product_not_open_ended_chat",
    );
  });
});
