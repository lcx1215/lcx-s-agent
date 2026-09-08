import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function runResearch(args: string[], env: NodeJS.ProcessEnv = {}) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/operator/lcx-finance-research-run.ts", ...args, "--json"],
    {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("lcx-finance-research-run", () => {
  it("executes a dry plan for the natural finance ask without network or model resolution", async () => {
    const payload = await runResearch([
      "--ask",
      "分析过去六个月加密货币和美股的市场情绪，并考虑美国中期选举。",
      "--as-of",
      "2026-09-08T12:00:00.000Z",
      "--horizon-months",
      "6",
    ]);

    expect(payload).toEqual(
      expect.objectContaining({
        boundary: "local_finance_research_run_only",
        status: "planned",
        answerDecision: "return_failed_reason",
        notTouched: expect.arrayContaining([
          "provider_config",
          "external_channel_sender",
          "trading_execution",
        ]),
      }),
    );
    expect(payload.batch).toBeUndefined();
    const plan = payload.plan as Record<string, unknown>;
    expect(plan.expectedJobCount).toBe(12);
    expect(plan.targetIds).toEqual(
      expect.arrayContaining(["crypto-btc", "us-equity-spy", "us-equity-qqq"]),
    );
    expect((plan.orchestration as Record<string, unknown>).primaryModules).toEqual(
      expect.arrayContaining(["event_driven", "cross_asset_liquidity"]),
    );
    expect(
      (payload.gates as readonly Record<string, unknown>[]).every((gate) => gate.passed === false),
    ).toBe(true);
  });

  it("writes an explicit dry receipt only when requested", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-finance-research-"));
    const payload = await runResearch(["--write", "--as-of", "2026-09-08T12:00:00.000Z"], {
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
    });
    const written = payload.written as Record<string, string>;
    expect(written.latestPath).toBe(
      path.join(workspaceDir, "state", "lcx-finance-research-run-latest.json"),
    );
    await expect(fs.readFile(written.latestPath, "utf8")).resolves.toContain(
      "lcx_finance_research_run_v1",
    );
  });
});
