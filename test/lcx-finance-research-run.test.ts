import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertIsoTimestamp,
  assertResearchAsk,
  buildFinanceResearchCommitteeRouting,
  buildFinanceResearchRegistryOptions,
  preflightFinanceResearchReceiptDestination,
  preflightLocalModelPythonRuntime,
} from "../scripts/operator/lcx-finance-research-run.ts";

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
    expect(plan.expectedJobCount).toBe(13);
    expect(plan.targetIds).toEqual(
      expect.arrayContaining([
        "crypto-btc",
        "us-equity-spy",
        "us-equity-qqq",
        // The directed daily brief's index-options task requires implied
        // volatility, term structure, and skew, so the prioritized default set
        // must collect an options chain instead of leaving it to all_registered.
        "us-index-options-chain",
      ]),
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
    try {
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
      if (process.platform !== "win32") {
        expect((await fs.stat(written.latestPath)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(written.datedPath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("normalizes ISO cutoffs, rejects path-like cutoffs, and forwards Yahoo opt-in", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-finance-research-"));
    try {
      await expect(
        runResearch(["--write", "--as-of", "../../2026-09-08T12:00:00.000Z"], {
          OPENCLAW_WORKSPACE_DIR: workspaceDir,
        }),
      ).rejects.toThrow("--as-of must be an ISO timestamp");
      expect(assertIsoTimestamp("2026-09-08T12:00:00.000Z")).toBe("2026-09-08T12:00:00.000Z");
      expect(() => assertIsoTimestamp("2026-02-31T12:00:00.000Z")).toThrow(
        "--as-of must be an ISO timestamp",
      );
      const options = buildFinanceResearchRegistryOptions(true, {});
      expect(options.realtimeRegistryOptions.includeYahooPublicSource).toBe(true);
      expect(options.collectionRegistryOptions.includeYahooPublicSources).toBe(true);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects oversized plan and live model bounds before execution", async () => {
    expect(() => assertResearchAsk("x".repeat(32_769))).toThrow(
      "--ask must be <= 32768 UTF-8 bytes",
    );
    await expect(runResearch(["--horizon-months", "121"])).rejects.toThrow(
      "--horizon-months must be a positive integer <= 120",
    );
    await expect(runResearch(["--max-tokens", "16385"])).rejects.toThrow(
      "--max-tokens must be a positive integer <= 16384",
    );
    await expect(runResearch(["--live", "--timeout-ms", "2147483648"])).rejects.toThrow(
      "--timeout-ms must be a positive integer <= 2147483647",
    );
    await expect(runResearch(["--source-timeout-ms", "2147483648"])).rejects.toThrow(
      "--source-timeout-ms must be a positive integer <= 2147483647",
    );
    await expect(runResearch(["--total-timeout-ms", "2147483648"])).rejects.toThrow(
      "--total-timeout-ms must be a positive integer <= 2147483647",
    );
    await expect(runResearch(["--live"])).rejects.toThrow(
      "--write is required with --live to persist the full research receipt",
    );
  });

  it("preflights live receipt destinations and the local Python runtime", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-finance-research-"));
    const blockedRoot = path.join(workspaceDir, "blocked-root");
    try {
      await preflightFinanceResearchReceiptDestination("2026-09-08T12:00:00.000Z", workspaceDir);
      await expect(
        fs.stat(path.join(workspaceDir, "state", "finance-research-runs", "2026-09-08")),
      ).resolves.toBeDefined();

      await fs.writeFile(blockedRoot, "not a directory");
      await expect(
        preflightFinanceResearchReceiptDestination("2026-09-08T12:00:00.000Z", blockedRoot),
      ).rejects.toThrow();
      await expect(
        preflightLocalModelPythonRuntime(path.join(workspaceDir, "missing-python")),
      ).rejects.toThrow("local model Python runtime cannot import mlx_lm");
      await expect(preflightLocalModelPythonRuntime(process.execPath)).rejects.toThrow(
        "local model Python runtime cannot import mlx_lm",
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("prints help successfully", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/operator/lcx-finance-research-run.ts", "--help"],
      { cwd: repoRoot, env: process.env, maxBuffer: 256 * 1024 },
    );
    expect(stdout).toContain(
      "Usage: node --import tsx scripts/operator/lcx-finance-research-run.ts",
    );
  });

  it("routes committee payloads through the quality-stage adapter contract", () => {
    const routing = buildFinanceResearchCommitteeRouting({
      adapterPath: "/tmp/adapter",
      modelId: "fixture-model",
      pythonPath: "/tmp/python",
      maxTokens: 384,
      timeoutMs: 10_000,
      allowNetwork: false,
    });
    expect(routing.defaultPolicy.requiredCapabilities).toEqual(["quality_harness"]);
    expect(routing.adapters[0]?.capabilities).toEqual(
      expect.arrayContaining(["quality_harness", "local_model_inference"]),
    );
  });
});
