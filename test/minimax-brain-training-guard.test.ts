import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function makeGuardFixture(logLinesForPrefix: (adapterPrefix: string) => unknown[]) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-minimax-guard-"));
  const adapterRoot = path.join(home, ".openclaw", "local-brain-trainer", "adapters");
  const logDir = path.join(home, ".openclaw", "workspace", "logs");
  const adapterPrefix = path.join(adapterRoot, "thought-flow-v1-qwen3-0.6b-minimax-guard");
  const logLines = logLinesForPrefix(adapterPrefix);
  await fs.mkdir(logDir, { recursive: true });
  const adapterPaths = new Set<string>();
  for (const line of logLines) {
    const payload = line as { adapterPath?: unknown; currentAdapter?: unknown; result?: unknown };
    if (typeof payload.adapterPath === "string") {
      adapterPaths.add(payload.adapterPath);
    }
    if (typeof payload.currentAdapter === "string") {
      adapterPaths.add(payload.currentAdapter);
    }
    const result = payload.result as { adapterPath?: unknown } | undefined;
    if (typeof result?.adapterPath === "string") {
      adapterPaths.add(result.adapterPath);
    }
  }
  for (const adapterPath of adapterPaths) {
    await fs.mkdir(adapterPath, { recursive: true });
    await fs.writeFile(path.join(adapterPath, "adapter_config.json"), "{}\n");
    await fs.writeFile(path.join(adapterPath, "adapters.safetensors"), "mock weights\n");
  }
  const logPath = path.join(logDir, "minimax-brain-training-guard-test.jsonl");
  await fs.writeFile(logPath, `${logLines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return { home, adapterPrefix, logPath };
}

function passingEval(at: string, name: string, adapterPath: string, total = 50) {
  return {
    at,
    event: "step_ok",
    name,
    result: {
      adapterPath,
      summary: { passed: total, total, passRate: 1, failedCaseIds: [], promotionReady: true },
    },
  };
}

function nonPassingEval(
  at: string,
  name: string,
  adapterPath: string,
  passed: number,
  total: number,
) {
  return {
    at,
    event: "step_non_passing",
    name,
    result: {
      adapterPath,
      summary: {
        passed,
        total,
        passRate: passed / total,
        failedCaseIds: Array.from({ length: total - passed }, (_, index) => `case_${index}`),
        promotionReady: false,
      },
    },
  };
}

async function resolveCurrentAdapter(
  fixture: Awaited<ReturnType<typeof makeGuardFixture>>,
  extraArgs: string[] = [],
) {
  return execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/dev/minimax-brain-training-guard.ts",
      "--resolve-current-adapter",
      "--model",
      "Qwen/Qwen3-0.6B",
      "--adapter-prefix",
      fixture.adapterPrefix,
      ...extraArgs,
      "--log",
      fixture.logPath,
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, HOME: fixture.home },
    },
  );
}

describe("minimax brain training guard adapter resolution", () => {
  it("keeps MiniMax teacher generation decoupled from slow Qwen eval/train work", async () => {
    const source = await fs.readFile(
      path.resolve(import.meta.dirname, "..", "scripts/dev/minimax-brain-training-guard.ts"),
      "utf8",
    );

    expect(source).toContain("teacherSidecar: true");
    expect(source).toContain('event: "teacher_sidecar_started"');
    expect(source).toContain('reason: "teacher_sidecar_active"');
    expect(source).toContain("scripts/dev/minimax-quota-brain-saturator.ts");
    expect(source).toContain("--adaptive");
    expect(source).toContain("--allow-partial-write");
    expect(source).toContain("--provider-cooldown-seconds");
    expect(source).toContain("--max-provider-instability-rounds");
    expect(source).toContain("--min-batch-limit");
    expect(source).toContain("MEDIUM_MINIMAX_SIDECAR_DURATION_MINUTES = 285");
    expect(source).toContain("shouldUpgradeToMediumMiniMaxWindow");
  });

  it("backs off MiniMax sidecar pressure on transport instability, not only rate limits", async () => {
    const source = await fs.readFile(
      path.resolve(import.meta.dirname, "..", "scripts/dev/minimax-quota-brain-saturator.ts"),
      "utf8",
    );

    expect(source).toContain("provider_transport_instability");
    expect(source).toContain("adaptive_provider_instability_backoff");
    expect(source).toContain("TypeError: fetch failed".toLowerCase());
    expect(source).toContain("TimeoutError".toLowerCase());
    expect(source).toContain("consecutiveProviderUnstableRounds");
  });

  it("continues local Qwen training from an existing adapter instead of restarting from base", async () => {
    const source = await fs.readFile(
      path.resolve(import.meta.dirname, "..", "scripts/dev/minimax-brain-training-guard.ts"),
      "utf8",
    );

    expect(source).toContain("--resume-adapter-file");
    expect(source).toContain("trainingSeedAdapter");
    expect(source).toContain('event: "best_effort_training_seed_selected"');
    expect(source).toContain('event: "candidate_retained_as_training_seed"');
    expect(source).toContain('event: "candidate_not_retained_as_training_seed"');
    expect(source).toContain("resolveBestTrainingSeedAdapter");
  });

  it("uses the highest scoring non-promotion candidate as the next training seed", async () => {
    let strongAdapter = "";
    let weakAdapter = "";
    const fixture = await makeGuardFixture((adapterPrefix) => {
      strongAdapter = `${adapterPrefix}-2026-05-07T12-04-09-522Z-r18`;
      weakAdapter = `${adapterPrefix}-2026-05-07T12-32-22-742Z-r20`;
      return [
        nonPassingEval(
          "2026-05-06T17:07:14.388Z",
          "candidate_hardened_eval",
          `${adapterPrefix}-2026-05-06T16-44-28-657Z-r3`,
          50,
          50,
        ),
        nonPassingEval(
          "2026-05-07T12:16:10.000Z",
          "candidate_hardened_eval",
          strongAdapter,
          53,
          59,
        ),
        nonPassingEval("2026-05-07T12:40:10.000Z", "candidate_hardened_eval", weakAdapter, 14, 59),
      ];
    });

    const { stdout } = await resolveCurrentAdapter(fixture, ["--bootstrap-if-missing"]);
    const parsed = JSON.parse(stdout) as {
      selectedAdapter?: string;
      trainingSeedAdapter?: string;
      trainingSeed?: { passed?: number; total?: number; passRate?: number };
    };

    expect(parsed.selectedAdapter).toBeUndefined();
    expect(parsed.trainingSeedAdapter).toBe(strongAdapter);
    expect(parsed.trainingSeed?.passed).toBe(53);
    expect(parsed.trainingSeed?.total).toBe(59);
    expect(parsed.trainingSeed?.passRate).toBeCloseTo(53 / 59);
  });

  it("does not select an adapter after a newer failed hardened eval", async () => {
    const fixture = await makeGuardFixture((adapterPrefix) => {
      const adapter = `${adapterPrefix}-2026-05-05T16-27-05-938Z-r6`;
      return [
        passingEval("2026-05-05T18:13:51.800Z", "stable_hardened_eval", adapter, 50),
        {
          at: "2026-05-05T20:17:29.886Z",
          event: "guard_failed",
          currentAdapter: adapter,
          error:
            'Error: node --import tsx scripts/dev/local-brain-distill-eval.ts --hardened exited 1\n{"summary":{"passed":48,"total":50,"failedCaseIds":["source_coverage_actual_reading_scope"],"promotionReady":false}}',
        },
      ];
    });

    await expect(resolveCurrentAdapter(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining("no promotion-ready adapter found"),
    });
  });

  it("does not treat weak old eval coverage as promotion-ready", async () => {
    const fixture = await makeGuardFixture((adapterPrefix) => {
      const adapter = `${adapterPrefix}-2026-05-05T16-27-05-938Z-r6`;
      return [
        passingEval("2026-05-05T18:13:51.800Z", "candidate_hardened_eval", adapter, 13),
        {
          at: "2026-05-05T18:13:52.000Z",
          event: "adapter_promoted_for_guard_session",
          adapterPath: adapter,
        },
      ];
    });

    await expect(resolveCurrentAdapter(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining("no promotion-ready adapter found"),
    });
  });

  it("does not fall back to the legacy seed adapter for latest-passing resolution", async () => {
    const fixture = await makeGuardFixture(() => []);
    const seedAdapter = path.join(
      fixture.home,
      ".openclaw",
      "local-brain-trainer",
      "adapters",
      "thought-flow-v1-qwen3-0.6b-teacher-v7",
    );
    await fs.mkdir(seedAdapter, { recursive: true });
    await fs.writeFile(path.join(seedAdapter, "adapter_config.json"), "{}\n");

    await expect(resolveCurrentAdapter(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining("no promotion-ready adapter found"),
    });
  });
});
