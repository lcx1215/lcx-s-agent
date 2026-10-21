import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type {
  WorkflowHandoffEvidence,
  WorkflowFieldRef,
} from "../../scripts/operator/lcx-flow-graph.js";
import type {
  ShadowExperimentReceipt,
  ShadowLatestSnapshot,
  ShadowOwnerObservation,
} from "../../scripts/operator/lcx-multi-agent-pattern-shadow.js";

const execute = promisify(execFile);
const filename = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(filename), "../..");
export type ShadowProbe = {
  receipt: ShadowExperimentReceipt;
  snapshot: ShadowLatestSnapshot;
  reused: ShadowExperimentReceipt;
  incompatible: ShadowExperimentReceipt;
  timeout: ShadowExperimentReceipt;
  reuseInvocations: number;
  incompatibleInvocations: number;
  retainedLedgerUnchanged: boolean;
  missingRecoveryErrors: string[];
  conflictingRecoveryErrors: string[];
  forgedPassErrors: string[];
  comparisonConflictErrors: string[];
  retainedLatestUnchanged: boolean;
  timeoutExecutorReleased: boolean;
  handoffEvidence: WorkflowHandoffEvidence;
  missingSource: {
    snapshot: ShadowLatestSnapshot;
    actionableClusters: string[];
    ownerNextAction?: string;
  };
  centralJudgments: {
    case: string;
    note: string | undefined;
    prompt: string;
    receiptPath: string;
    approvedActions: number;
    sourceSha256: unknown;
  }[];
};

/** Separate process: native path constants must bind to the private home before imports. */
export async function probeOriginalShadow(directory: string): Promise<ShadowProbe> {
  await fs.mkdir(directory, { recursive: true });
  const config = path.join(directory, "config.json");
  await fs.writeFile(config, "{}\n");
  const result = await execute(process.execPath, ["--import", "tsx", filename, directory], {
    cwd: repository,
    env: {
      ...process.env,
      LCX_USER_HOME: directory,
      OPENCLAW_STATE_DIR: path.join(directory, "state"),
      OPENCLAW_CONFIG_PATH: config,
      LCX_MODEL_TRAJECTORY: "false",
    },
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(result.stdout) as ShadowProbe;
}

async function runPrivateProbe(directory: string): Promise<ShadowProbe> {
  const owner = await import("../../scripts/operator/lcx-multi-agent-pattern-shadow.js");
  const paths = await import("../../scripts/operator/lcx-local-paths.js");
  const counter = path.join(directory, "executor-invocations.jsonl");
  const wrapper = path.join(directory, "executor.mjs");
  const fixturePath = path.join(
    repository,
    "test/fixtures/lcx-multi-agent-pattern-shadow-executor.ts",
  );
  const fixture = pathToFileURL(fixturePath).href;
  await fs.writeFile(
    wrapper,
    `import fs from 'node:fs'; import {buildFixtureResponse} from ${JSON.stringify(fixture)};\n` +
      `const request=JSON.parse(fs.readFileSync(0,'utf8'));\n` +
      `fs.appendFileSync(${JSON.stringify(counter)},JSON.stringify({taskId:request.taskId})+'\\n');\n` +
      `process.stdout.write(JSON.stringify(buildFixtureResponse(request)));\n`,
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} --import tsx ${quote(wrapper)}`;
  // The controlled local fixture explicitly binds its wrapper and the source
  // owners that define its protocol/response. This is not a provider identity.
  const executorIdentityFiles = [
    wrapper,
    fixturePath,
    path.join(repository, "scripts/operator/lcx-multi-agent-pattern-shadow.ts"),
    path.join(repository, "src/shared/lcx-ontology.ts"),
  ];
  const options = {
    executorIdentityFiles,
    experimentId: "offline-original-shadow-handoff",
    patterns: ["manager" as const],
    repetitions: 1,
    executorCommand: command,
    childTimeoutMs: 3000,
    rootTimeoutMs: 15_000,
  };
  // Use the real CLI writer, then the real latest reader and cached-result consumer.
  await execute(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/operator/lcx-multi-agent-pattern-shadow.ts",
      "--mode",
      "isolated-executor",
      "--pattern",
      "manager",
      "--repetitions",
      "1",
      "--experiment-id",
      options.experimentId,
      "--executor-command",
      command,
      ...executorIdentityFiles.flatMap((file) => ["--executor-identity-file", file]),
      "--child-timeout-ms",
      "3000",
      "--root-timeout-ms",
      "15000",
      "--json",
    ],
    { cwd: repository, env: process.env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const receipt = JSON.parse(
    await fs.readFile(paths.MULTI_AGENT_PATTERN_SHADOW_LATEST_PATH, "utf8"),
  ) as ShadowExperimentReceipt;
  const snapshot = await owner.readLatestShadowSnapshot();
  const retainedLatest = await fs.readFile(paths.MULTI_AGENT_PATTERN_SHADOW_LATEST_PATH, "utf8");
  const retained = await fs.readFile(paths.MULTI_AGENT_PATTERN_SHADOW_JSONL_PATH, "utf8");
  const count = async () => (await fs.readFile(counter, "utf8")).trim().split("\n").length;
  const beforeReuse = await count();
  const observed: Partial<Record<ShadowOwnerObservation["stage"], ShadowOwnerObservation>> = {};
  const observer = (value: ShadowOwnerObservation) => {
    observed[value.stage] = { ...observed[value.stage], ...value };
  };
  const reused = await owner.buildIsolatedExecutorExperiment({ ...options, observer });
  const observedReceipt = path.join(directory, "observed-original-owner-receipt.json");
  await fs.writeFile(observedReceipt, JSON.stringify(reused));
  owner.classifyShadowLatestReceipt(
    JSON.parse(await fs.readFile(observedReceipt, "utf8")),
    new Date().toISOString(),
    observer,
  );
  const stageFiles: Record<string, string> = {};
  for (const [stage, value] of Object.entries(observed)) {
    const file = path.join(directory, `actual-original-stage-${stage}.json`);
    await fs.writeFile(file, JSON.stringify(value, null, 2));
    stageFiles[stage] = file;
  }
  const ref = async (stage: string, pointer: string): Promise<WorkflowFieldRef> => ({
    path: stageFiles[stage],
    pointer,
    sha256: createHash("sha256")
      .update(await fs.readFile(stageFiles[stage]))
      .digest("hex"),
  });
  const handoffEvidence: WorkflowHandoffEvidence = {
    scenarioId: "multi_agent_pattern_shadow_evaluation_waterflow",
    environment: "offline_fixture",
    nodes: [
      {
        nodeId: "multi_agent_pattern_intake",
        scope: await ref("intake", "/experimentId"),
        output: await ref("intake", "/output"),
      },
      {
        nodeId: "shadow_replay",
        scope: await ref("replay", "/experimentId"),
        output: await ref("replay", "/output"),
        inputs: [{ from: "multi_agent_pattern_intake", value: await ref("replay", "/input") }],
      },
      {
        nodeId: "shadow_isolated_executor",
        scope: await ref("isolated", "/experimentId"),
        output: await ref("isolated", "/output"),
        inputs: [{ from: "shadow_replay", value: await ref("isolated", "/input") }],
      },
      {
        nodeId: "interruption_recovery_probe",
        scope: await ref("recovery", "/experimentId"),
        output: await ref("recovery", "/output"),
        inputs: [{ from: "shadow_isolated_executor", value: await ref("recovery", "/input") }],
      },
      {
        nodeId: "pattern_comparison",
        scope: await ref("comparison", "/experimentId"),
        output: await ref("comparison", "/output"),
        inputs: [
          { from: "shadow_isolated_executor", value: await ref("comparison", "/input/normal") },
          {
            from: "interruption_recovery_probe",
            value: await ref("comparison", "/input/recovery"),
          },
        ],
      },
      {
        nodeId: "review_panel",
        scope: await ref("review", "/experimentId"),
        output: await ref("review", "/output"),
        inputs: [{ from: "pattern_comparison", value: await ref("review", "/input") }],
      },
      {
        nodeId: "acceptance_eval",
        scope: await ref("acceptance", "/experimentId"),
        output: await ref("acceptance", "/output"),
        inputs: [
          { from: "review_panel", value: await ref("acceptance", "/input/summary/trialDecision") },
        ],
      },
    ],
  };
  const afterReuse = await count();
  const retainedLedgerUnchanged =
    retained === (await fs.readFile(paths.MULTI_AGENT_PATTERN_SHADOW_JSONL_PATH, "utf8"));
  // Corrupt only this private test ledger; preserve the original evidence separately.
  await fs.writeFile(path.join(directory, "retained-ledger-before.jsonl"), retained);
  const wrong = retained
    .trim()
    .split("\n")
    .map((line) => {
      const run = JSON.parse(line);
      return { ...run, caseId: "another_case", mode: "replay", executionPhase: "replay" };
    });
  await fs.writeFile(
    paths.MULTI_AGENT_PATTERN_SHADOW_JSONL_PATH,
    wrong.map((run) => JSON.stringify(run)).join("\n") + "\n",
  );
  const incompatible = await owner.buildIsolatedExecutorExperiment(options);
  const afterIncompatible = await count();
  const missing = structuredClone(receipt);
  missing.runs = missing.runs.filter((run) => run.fixture !== "interruption");
  const conflicting = structuredClone(receipt);
  const recovery = conflicting.runs.find((run) => run.fixture === "interruption");
  if (!recovery) {
    throw new Error("native fixture did not produce recovery evidence");
  }
  recovery.caseId = "another_case";
  const forged = structuredClone(receipt);
  forged.summary.trialDecision = "pass";
  const comparisonConflict = structuredClone(receipt);
  const manager = comparisonConflict.summary.patternComparisons.manager;
  if (!manager) {
    throw new Error("native comparison missing");
  }
  manager.usageBasis = "exact";
  manager.medianEvidenceCoverage = 9;
  const hangingExecutor = path.join(directory, "hanging-executor.mjs");
  const hangingPid = path.join(directory, "hanging-executor.pid");
  await fs.writeFile(
    hangingExecutor,
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(hangingPid)},String(process.pid)); setInterval(() => {}, 1000);\n`,
  );
  const timeout = await owner.buildIsolatedExecutorExperiment({
    ...options,
    experimentId: "offline-shadow-actual-timeout",
    executorCommand: `${quote(process.execPath)} ${quote(hangingExecutor)}`,
    childTimeoutMs: 300,
    rootTimeoutMs: 1000,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  let timeoutExecutorReleased = false;
  const pid = Number(await fs.readFile(hangingPid, "utf8"));
  try {
    process.kill(pid, 0);
  } catch (error) {
    timeoutExecutorReleased = (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  const { probeOriginalCentral } = await import("./lcx-waterflow-central-probe.js");
  const centralJudgments: ShadowProbe["centralJudgments"] = [];
  for (const [name, source] of [
    ["missing_cost", receipt],
    ["timeout", timeout],
  ] as const) {
    const result = await probeOriginalCentral({
      directory: path.join(directory, "central", name),
      seed: 2,
      shadowReceipt: source,
    });
    centralJudgments.push({
      case: name,
      note: result.receipts[0].brainCall.note,
      prompt: result.trace.httpRequests[0].prompt,
      receiptPath: result.cyclePaths[0],
      approvedActions: result.receipts[0].actionsApproved,
      sourceSha256: result.trace.perceptionCalls[0].governance.sourceSha256,
    });
  }
  // Actual source disappearance reaches the existing downstream owner, with no rerun.
  await fs.unlink(paths.MULTI_AGENT_PATTERN_SHADOW_LATEST_PATH);
  const missingSnapshot = await owner.readLatestShadowSnapshot();
  const { buildProblemClusterRadar } =
    await import("../../scripts/operator/lcx-problem-cluster-radar.js");
  const radar = buildProblemClusterRadar({
    multiAgentPatternShadow: {
      ok: false,
      owner: "lcx-multi-agent-pattern-shadow",
      command: "read private native latest",
      payload: { ...missingSnapshot },
    },
  });
  await fs.writeFile(paths.MULTI_AGENT_PATTERN_SHADOW_LATEST_PATH, retainedLatest);
  return {
    receipt,
    snapshot,
    reused,
    incompatible,
    timeout,
    reuseInvocations: afterReuse - beforeReuse,
    incompatibleInvocations: afterIncompatible - afterReuse,
    retainedLedgerUnchanged,
    missingRecoveryErrors: owner.validateShadowLatestReceipt(missing),
    conflictingRecoveryErrors: owner.validateShadowLatestReceipt(conflicting),
    forgedPassErrors: owner.validateShadowLatestReceipt(forged),
    comparisonConflictErrors: owner.validateShadowLatestReceipt(comparisonConflict),
    retainedLatestUnchanged:
      retainedLatest === (await fs.readFile(paths.MULTI_AGENT_PATTERN_SHADOW_LATEST_PATH, "utf8")),
    timeoutExecutorReleased,
    centralJudgments,
    handoffEvidence,
    missingSource: {
      snapshot: missingSnapshot,
      actionableClusters: radar.actionableClusters,
      ownerNextAction: radar.clusters.find(
        (cluster) => cluster.id === "multi_agent_pattern_shadow_cluster",
      )?.nextAction,
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  const directory = process.argv[2];
  if (!directory) {
    throw new Error("private probe directory is required");
  }
  process.stdout.write(JSON.stringify(await runPrivateProbe(directory)));
}
