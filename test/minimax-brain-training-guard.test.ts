import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const trainingAbsorptionContractVersion = "compact_teacher_review_v2";

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
  options: { parseRecoveredCount?: number } = {},
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
        parseRecoveredCaseIds: Array.from(
          { length: options.parseRecoveredCount ?? 0 },
          (_, index) => `recovered_case_${index}`,
        ),
        promotionReady: false,
      },
    },
  };
}

function datasetEvent(
  at: string,
  counts: { sourceFiles: number; examples: number; train: number },
  sourceKinds?: Record<string, number>,
) {
  return {
    at,
    event: "step_ok",
    name: "dataset",
    result: {
      ok: true,
      counts: {
        ...counts,
        valid: 13,
        test: 13,
      },
      ...(sourceKinds ? { sourceKinds } : {}),
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
    expect(source).toContain('reason: "teacher_sidecar_completed"');
    expect(source).toContain("teacher_sidecar_failed_fallback_to_serial_teacher");
    expect(source).toContain("scripts/dev/minimax-quota-brain-saturator.ts");
    expect(source).toContain("--adaptive");
    expect(source).toContain("--allow-partial-write");
    expect(source).toContain("--provider-cooldown-seconds");
    expect(source).toContain("--max-provider-instability-rounds");
    expect(source).toContain("--min-batch-limit");
    expect(source).toContain("--failure-focus");
    expect(source).toContain("MEDIUM_MINIMAX_SIDECAR_DURATION_MINUTES = 285");
    expect(source).toContain("shouldUpgradeToMediumMiniMaxWindow");
  });

  it("uses the shared balanced JSON output parser for guard and quota child steps", async () => {
    const guardSource = await fs.readFile(
      path.resolve(import.meta.dirname, "..", "scripts/dev/minimax-brain-training-guard.ts"),
      "utf8",
    );
    const quotaSource = await fs.readFile(
      path.resolve(import.meta.dirname, "..", "scripts/dev/minimax-quota-brain-saturator.ts"),
      "utf8",
    );

    expect(guardSource).toContain("parseJsonObjectFromOutput(stdout)");
    expect(quotaSource).toContain("parseJsonObjectFromOutput(stdout)");
    expect(guardSource).not.toContain("stdout.slice(index, end + 1)");
    expect(quotaSource).not.toContain("stdout.slice(start, end + 1)");
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

  it("backs off the guard loop when local MLX training is resource-gated", async () => {
    const source = await fs.readFile(
      path.resolve(import.meta.dirname, "..", "scripts/dev/minimax-brain-training-guard.ts"),
      "utf8",
    );

    expect(source).toContain("TRAIN_SKIP_BACKOFF_MS");
    expect(source).toContain('name: "train_skipped_resource_backoff"');
    expect(source).toContain("local_mlx_train_resource_guard_skip");
  });

  it("keeps a per-round evolution window instead of immediately pressuring the next round", async () => {
    const source = await fs.readFile(
      path.resolve(import.meta.dirname, "..", "scripts/dev/minimax-brain-training-guard.ts"),
      "utf8",
    );

    expect(source).toContain("DEFAULT_EVOLUTION_COOLDOWN_MINUTES = 10");
    expect(source).toContain("--evolution-cooldown-minutes");
    expect(source).toContain('event: "evolution_cooldown"');
    expect(source).toContain("work_then_evolve_window_before_next_heavy_round");
    expect(source).toContain("runEvolutionCooldown(options, round, deadline)");
  });

  it("trains local Qwen from a bounded balanced slice instead of the full noisy corpus", async () => {
    const source = await fs.readFile(
      path.resolve(import.meta.dirname, "..", "scripts/dev/minimax-brain-training-guard.ts"),
      "utf8",
    );

    expect(source).toContain("local-brain-distill-train-slice.ts");
    expect(source).toContain('"train_slice",');
    expect(source).toContain("trainSliceMaxReviewExamples");
    expect(source).toContain("trainDataDir");
    expect(source).toContain("--no-train-slice");
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
    expect(source).toContain('"training_seed_hardened_eval"');
    expect(source).toContain("currentAdapter");
    expect(source).toContain("allowFailure: true");
    expect(source).toContain("HARDENED_EVAL_STEP_TIMEOUT_MS");
    expect(source).toContain("HARDENED_EVAL_IDLE_TIMEOUT_MS");
  });

  it("bounds hardened eval child steps so a stuck candidate cannot stall training", async () => {
    const source = await fs.readFile(
      path.resolve(import.meta.dirname, "..", "scripts/dev/minimax-brain-training-guard.ts"),
      "utf8",
    );

    expect(source).toContain("timedOutStepResult");
    expect(source).toContain('? "step_timeout"');
    expect(source).toContain('"total_timeout"');
    expect(source).toContain('"idle_timeout"');
    expect(source).toContain("promotionReady: false");
    expect(source).toContain("HARDENED_EVAL_STEP_TIMEOUT_MS");
    expect(source).toContain("HARDENED_EVAL_IDLE_TIMEOUT_MS");
    expect(source).toContain("STABLE_EVAL_TIMEOUT_BACKOFF_MS");
    expect(source).toContain("STABLE_EVAL_NON_PASSING_BACKOFF_MS");
    expect(source).toContain("stableEvalBackoff");
    expect(source).toContain('"stable_eval_timeout_backoff"');
    expect(source).toContain('"stable_eval_non_passing_backoff"');
    expect(source).toContain('"stable_hardened_eval_timeout_continue_guard"');
    expect(source).toContain('"stable_hardened_eval_non_passing_continue_guard"');
    expect(source).toMatch(
      /"candidate_hardened_eval"[\s\S]*scripts\/dev\/local-brain-distill-eval\.ts[\s\S]*allowFailure: true[\s\S]*timeoutMs: HARDENED_EVAL_STEP_TIMEOUT_MS[\s\S]*idleTimeoutMs: HARDENED_EVAL_IDLE_TIMEOUT_MS/u,
    );
    expect(source).toMatch(
      /const evalName = currentAdapter \? "stable_hardened_eval"[\s\S]*runJsonStep\([\s\S]*evalName[\s\S]*allowFailure: true[\s\S]*const backoff = stableEvalBackoff\(stableEval\)[\s\S]*await sleep\(backoff\.durationMs\)[\s\S]*continue;/u,
    );
  });

  it("honors train-every when a best-effort training seed exists but no adapter is promotion-ready", async () => {
    const source = await fs.readFile(
      path.resolve(import.meta.dirname, "..", "scripts/dev/minimax-brain-training-guard.ts"),
      "utf8",
    );

    expect(source).toContain("function shouldTrainRound");
    expect(source).toContain("if (!seedAdapter)");
    expect(source).toContain("if (!currentAdapter && round === 1)");
    expect(source).toContain("return round % options.trainEvery === 0");
    expect(source).toContain(
      "shouldTrainRound(options, round, trainingResumeAdapter, currentAdapter)",
    );
    expect(source).toContain("seedEvalWouldDelayCandidateTrain");
    expect(source).toContain('reason: "train_round_candidate_eval_will_run"');
    expect(source).not.toContain(
      "!options.noTrain && (!currentAdapter || round % options.trainEvery === 0)",
    );
  });

  it("backs off local training when a candidate collapses to a near-zero eval score", async () => {
    const source = await fs.readFile(
      path.resolve(import.meta.dirname, "..", "scripts/dev/minimax-brain-training-guard.ts"),
      "utf8",
    );

    expect(source).toContain("CATASTROPHIC_CANDIDATE_MIN_CASES");
    expect(source).toContain("CATASTROPHIC_CANDIDATE_MAX_PASS_RATE");
    expect(source).toContain("function isCatastrophicCandidateScore");
    expect(source).toContain("resolveCatastrophicTrainingSeedBackoffs");
    expect(source).toContain('event: "candidate_catastrophic_eval_detected"');
    expect(source).toContain('event: "training_seed_catastrophic_backoff_active"');
    expect(source).toContain('reason: "catastrophic_training_seed_backoff"');
    expect(source).toContain('event: "training_resume_seed_selected"');
    expect(source).toContain('reason: "best_non_catastrophic_training_seed"');
    expect(source).toContain("excludedAdapters: catastrophicTrainingSeedBackoffs");
    expect(source).toContain('event: "training_resume_recovery_train_scheduled"');
    expect(source).toContain('reason: "catastrophic_eval_seed_has_safe_resume_seed"');
    expect(source).toContain(
      "const failedSeedAdapter = resumeAdapter ?? currentAdapter ?? trainingSeedAdapter",
    );
    expect(source).toContain("LOCAL_TRAINING_COLLAPSE_BACKOFF_SEED_LIMIT");
    expect(source).toContain("TRAINING_ABSORPTION_CONTRACT_VERSION");
    expect(source).toContain("shouldPauseLocalTrainingAfterCollapse");
    expect(source).toContain('event: "local_training_paused_after_repeated_collapse"');
    expect(source).toContain('reason: "local_training_paused_after_repeated_collapse"');
    expect(source).toContain('event: "local_training_paused_after_train_nan"');
    expect(source).toContain('reason: "train_loss_nan"');
    expect(source).toContain("TRAIN_NAN_PATTERN");
    expect(source).toContain("removedAdapterPath");
  });

  it("reports local training paused after repeated catastrophic seed backoffs", async () => {
    let firstSeed = "";
    let secondSeed = "";
    const fixture = await makeGuardFixture((adapterPrefix) => {
      firstSeed = `${adapterPrefix}-2026-05-07T12-04-09-522Z-r18`;
      secondSeed = `${adapterPrefix}-2026-05-07T11-24-32-133Z-r15`;
      const firstBadCandidate = `${adapterPrefix}-2026-05-09T14-08-52-247Z-r1`;
      const secondBadCandidate = `${adapterPrefix}-2026-05-09T15-12-39-464Z-r3`;
      return [
        nonPassingEval("2026-05-07T12:16:10.000Z", "candidate_hardened_eval", firstSeed, 53, 59),
        nonPassingEval("2026-05-07T11:30:10.000Z", "candidate_hardened_eval", secondSeed, 51, 59),
        nonPassingEval(
          "2026-05-09T14:39:01.830Z",
          "candidate_hardened_eval",
          firstBadCandidate,
          0,
          68,
        ),
        {
          at: "2026-05-09T14:39:01.873Z",
          event: "candidate_catastrophic_eval_detected",
          adapterPath: firstBadCandidate,
          trainingSeedAdapter: firstSeed,
          trainingAbsorptionContractVersion,
        },
        nonPassingEval(
          "2026-05-09T15:39:01.830Z",
          "candidate_hardened_eval",
          secondBadCandidate,
          0,
          68,
        ),
        {
          at: "2026-05-09T15:39:01.873Z",
          event: "candidate_catastrophic_eval_detected",
          adapterPath: secondBadCandidate,
          trainingSeedAdapter: secondSeed,
          trainingAbsorptionContractVersion,
        },
      ];
    });

    const { stdout } = await resolveCurrentAdapter(fixture, ["--bootstrap-if-missing"]);
    const parsed = JSON.parse(stdout) as {
      localTrainingPaused?: boolean;
      localTrainingPauseReason?: string;
      catastrophicTrainingSeedBackoffs?: string[];
      trainingResumeAdapter?: string;
    };

    expect(parsed.localTrainingPaused).toBe(true);
    expect(parsed.localTrainingPauseReason).toBe("repeated_catastrophic_training_seed_backoff");
    expect(parsed.catastrophicTrainingSeedBackoffs).toEqual(
      expect.arrayContaining([firstSeed, secondSeed]),
    );
    expect(parsed.trainingResumeAdapter).toBeUndefined();
  });

  it("recovers from repeated catastrophic seed backoffs when another safe seed exists", async () => {
    let firstSeed = "";
    let secondSeed = "";
    let safeSeed = "";
    const fixture = await makeGuardFixture((adapterPrefix) => {
      firstSeed = `${adapterPrefix}-2026-05-07T12-04-09-522Z-r18`;
      secondSeed = `${adapterPrefix}-2026-05-07T11-24-32-133Z-r15`;
      safeSeed = `${adapterPrefix}-2026-05-07T10-13-44-017Z-r12`;
      return [
        nonPassingEval("2026-05-07T12:16:10.000Z", "candidate_hardened_eval", firstSeed, 58, 68),
        nonPassingEval("2026-05-07T11:30:10.000Z", "candidate_hardened_eval", secondSeed, 57, 68),
        nonPassingEval("2026-05-07T10:18:10.000Z", "candidate_hardened_eval", safeSeed, 55, 68),
        {
          at: "2026-05-09T14:39:01.873Z",
          event: "candidate_catastrophic_eval_detected",
          adapterPath: `${adapterPrefix}-2026-05-09T14-08-52-247Z-r1`,
          trainingSeedAdapter: firstSeed,
          trainingAbsorptionContractVersion,
        },
        {
          at: "2026-05-09T15:39:01.873Z",
          event: "candidate_catastrophic_eval_detected",
          adapterPath: `${adapterPrefix}-2026-05-09T15-12-39-464Z-r3`,
          trainingSeedAdapter: secondSeed,
          trainingAbsorptionContractVersion,
        },
      ];
    });

    const { stdout } = await resolveCurrentAdapter(fixture, ["--bootstrap-if-missing"]);
    const parsed = JSON.parse(stdout) as {
      localTrainingPaused?: boolean;
      trainingSeedAdapter?: string;
      trainingResumeAdapter?: string;
      catastrophicTrainingSeedBackoffs?: string[];
    };

    expect(parsed.localTrainingPaused).toBe(false);
    expect(parsed.trainingSeedAdapter).toBe(safeSeed);
    expect(parsed.trainingResumeAdapter).toBe(safeSeed);
    expect(parsed.catastrophicTrainingSeedBackoffs).toEqual(
      expect.arrayContaining([firstSeed, secondSeed]),
    );
  });

  it("does not let pre-repair collapse logs pause the compact training contract", async () => {
    let firstSeed = "";
    let secondSeed = "";
    const fixture = await makeGuardFixture((adapterPrefix) => {
      firstSeed = `${adapterPrefix}-2026-05-07T12-04-09-522Z-r18`;
      secondSeed = `${adapterPrefix}-2026-05-07T11-24-32-133Z-r15`;
      return [
        nonPassingEval("2026-05-07T12:16:10.000Z", "candidate_hardened_eval", firstSeed, 53, 59),
        nonPassingEval("2026-05-07T11:30:10.000Z", "candidate_hardened_eval", secondSeed, 51, 59),
        {
          at: "2026-05-09T14:39:01.873Z",
          event: "candidate_catastrophic_eval_detected",
          adapterPath: `${adapterPrefix}-2026-05-09T14-08-52-247Z-r1`,
          trainingSeedAdapter: firstSeed,
        },
        {
          at: "2026-05-09T15:39:01.873Z",
          event: "candidate_catastrophic_eval_detected",
          adapterPath: `${adapterPrefix}-2026-05-09T15-12-39-464Z-r3`,
          trainingSeedAdapter: secondSeed,
        },
      ];
    });

    const { stdout } = await resolveCurrentAdapter(fixture, ["--bootstrap-if-missing"]);
    const parsed = JSON.parse(stdout) as {
      localTrainingPaused?: boolean;
      trainingResumeAdapter?: string;
    };

    expect(parsed.localTrainingPaused).toBe(false);
    expect(parsed.trainingResumeAdapter).toBe(firstSeed);
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

  it("penalizes parse-recovered candidate evals when choosing the next training seed", async () => {
    let cleanAdapter = "";
    let noisyAdapter = "";
    const fixture = await makeGuardFixture((adapterPrefix) => {
      cleanAdapter = `${adapterPrefix}-2026-05-11T06-29-32-873Z-r18`;
      noisyAdapter = `${adapterPrefix}-2026-05-11T14-26-44-214Z-r1`;
      return [
        nonPassingEval(
          "2026-05-11T06:43:41.325Z",
          "candidate_hardened_eval",
          cleanAdapter,
          68,
          68,
          { parseRecoveredCount: 5 },
        ),
        nonPassingEval(
          "2026-05-11T14:45:21.818Z",
          "candidate_hardened_eval",
          noisyAdapter,
          68,
          68,
          { parseRecoveredCount: 18 },
        ),
      ];
    });

    const { stdout } = await resolveCurrentAdapter(fixture, ["--bootstrap-if-missing"]);
    const parsed = JSON.parse(stdout) as {
      trainingSeedAdapter?: string;
      trainingSeed?: { passed?: number; total?: number; parseRecoveredCount?: number };
    };

    expect(parsed.trainingSeedAdapter).toBe(cleanAdapter);
    expect(parsed.trainingSeed).toMatchObject({
      passed: 68,
      total: 68,
      parseRecoveredCount: 5,
    });
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

  it("invalidates a passing adapter when a later hardened eval times out", async () => {
    const fixture = await makeGuardFixture((adapterPrefix) => {
      const adapter = `${adapterPrefix}-2026-05-11T19-59-45-470Z-r2`;
      return [
        passingEval("2026-05-11T20:12:34.085Z", "stable_hardened_eval", adapter, 72),
        {
          at: "2026-05-12T03:34:35.887Z",
          event: "step_timeout",
          name: "stable_hardened_eval",
          result: {
            adapterPath: adapter,
            timeoutReason: "idle_timeout",
            summary: { passed: 0, total: 0, failedCaseIds: [] },
          },
        },
      ];
    });

    await expect(resolveCurrentAdapter(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining("no promotion-ready adapter found"),
    });
  });

  it("reports source-stable dataset shrink in latest-passing resolution", async () => {
    const fixture = await makeGuardFixture((adapterPrefix) => {
      const adapter = `${adapterPrefix}-2026-05-11T19-59-45-470Z-r2`;
      return [
        datasetEvent("2026-05-11T20:00:00.000Z", {
          sourceFiles: 403,
          examples: 4104,
          train: 4078,
        }),
        passingEval("2026-05-11T20:12:34.085Z", "candidate_hardened_eval", adapter, 72),
        {
          at: "2026-05-11T20:12:34.089Z",
          event: "adapter_promoted_for_guard_session",
          adapterPath: adapter,
        },
        datasetEvent("2026-05-12T03:34:35.887Z", {
          sourceFiles: 403,
          examples: 3162,
          train: 3136,
        }),
        passingEval("2026-05-12T03:10:38.207Z", "stable_hardened_eval", adapter, 72),
      ];
    });

    const { stdout } = await resolveCurrentAdapter(fixture);
    const parsed = JSON.parse(stdout) as {
      selectedAdapter?: string;
      datasetPromotionRisk?: {
        status?: string;
        previousMaxTrain?: number;
        train?: number;
      };
    };
    expect(parsed.selectedAdapter).toContain("2026-05-11T19-59-45-470Z-r2");
    expect(parsed.datasetPromotionRisk).toMatchObject({
      status: "source_stable_dataset_shrink",
      previousMaxTrain: 4078,
      train: 3136,
    });
  });

  it("ignores malformed guard log lines when checking dataset promotion risk", async () => {
    const fixture = await makeGuardFixture((adapterPrefix) => {
      const adapter = `${adapterPrefix}-2026-05-11T19-59-45-470Z-r2`;
      return [
        "{not-json",
        datasetEvent("2026-05-11T20:00:00.000Z", {
          sourceFiles: 403,
          examples: 4104,
          train: 4078,
        }),
        passingEval("2026-05-11T20:12:34.085Z", "candidate_hardened_eval", adapter, 72),
        datasetEvent("2026-05-12T03:34:35.887Z", {
          sourceFiles: 403,
          examples: 3162,
          train: 3136,
        }),
      ];
    });

    const raw = await fs.readFile(fixture.logPath, "utf8");
    await fs.writeFile(fixture.logPath, raw.replace('"{not-json"', "{not-json"));

    const { stdout } = await resolveCurrentAdapter(fixture);
    const parsed = JSON.parse(stdout) as {
      datasetPromotionRisk?: {
        status?: string;
      };
    };
    expect(parsed.datasetPromotionRisk?.status).toBe("source_stable_dataset_shrink");
  });

  it("ignores incompatible legacy dataset history when checking dataset promotion risk", async () => {
    const fixture = await makeGuardFixture((adapterPrefix) => {
      const adapter = `${adapterPrefix}-2026-05-14T01-59-00-824Z-r10`;
      return [
        datasetEvent("2026-05-09T00:00:00.000Z", {
          sourceFiles: 403,
          examples: 9238,
          train: 71792,
        }),
        datasetEvent("2026-05-14T00:00:00.000Z", {
          sourceFiles: 403,
          examples: 4629,
          train: 4603,
        }),
        passingEval("2026-05-14T02:10:00.000Z", "candidate_hardened_eval", adapter, 77),
      ];
    });

    const { stdout } = await resolveCurrentAdapter(fixture);
    const parsed = JSON.parse(stdout) as {
      datasetPromotionRisk?: {
        status?: string;
        previousMaxTrain?: number;
        train?: number;
        ignoredIncompatibleHistory?: number;
      };
    };
    expect(parsed.datasetPromotionRisk).toMatchObject({
      status: "ok",
      previousMaxTrain: 4603,
      train: 4603,
      ignoredIncompatibleHistory: 1,
    });
  });

  it("does not report shrink across different dataset source-kind windows", async () => {
    const fixture = await makeGuardFixture((adapterPrefix) => {
      const adapter = `${adapterPrefix}-2026-05-14T01-59-00-824Z-r10`;
      return [
        datasetEvent(
          "2026-05-10T02:35:00.000Z",
          {
            sourceFiles: 403,
            examples: 9289,
            train: 9263,
          },
          {
            lark_language_handoff_receipt: 63,
            finance_learning_capability_apply_receipt: 14,
            feishu_work_receipt: 61,
            brain_distillation_review: 8991,
            curated_seed: 160,
          },
        ),
        datasetEvent(
          "2026-05-14T02:42:51.711Z",
          {
            sourceFiles: 403,
            examples: 4629,
            train: 4603,
          },
          {
            lark_language_handoff_receipt: 63,
            finance_learning_capability_apply_receipt: 14,
            feishu_work_receipt: 61,
            brain_distillation_review: 4331,
            curated_seed: 160,
          },
        ),
        passingEval("2026-05-14T02:28:51.088Z", "candidate_hardened_eval", adapter, 77),
      ];
    });

    const { stdout } = await resolveCurrentAdapter(fixture);
    const parsed = JSON.parse(stdout) as {
      datasetPromotionRisk?: {
        status?: string;
        previousMaxTrain?: number;
        train?: number;
        datasetSignature?: string;
      };
    };
    expect(parsed.datasetPromotionRisk).toMatchObject({
      status: "ok",
      previousMaxTrain: 4603,
      train: 4603,
    });
    expect(parsed.datasetPromotionRisk?.datasetSignature).toContain(
      "brain_distillation_review:4331",
    );
  });
});
