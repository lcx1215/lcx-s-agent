import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { compactCommercialAcceptanceFailures } from "../scripts/operator/local-brain-training-plan.js";
import { recordAgentArtifact } from "../src/agents/artifact-result-recording.js";
import { buildCentralGovernanceInput } from "../src/agents/central-harness/governance-input.js";
import type { OpenClawConfig } from "../src/config/config.js";
import { ArtifactStore } from "../src/memory/artifact-store.js";
import {
  boundaryFromFlags,
  buildLcxRunReceipt,
  createLcxRunId,
  createLcxRunSnapshot,
  type LcxRunReceipt,
} from "../src/shared/lcx-run-receipt.js";

type Run = {
  id: string;
  parsed: boolean;
  ok: boolean | undefined;
  exitCode: number;
  payload?: Record<string, unknown>;
  compact: {
    artifactEvidence?: {
      status: string;
      id?: string;
      sha256?: string;
      reason: string;
      sourceTimeBasis: string;
    };
    sourceObservedAt?: string;
    changedFilesReadback?: unknown;
    strayGate?: unknown;
  };
  runReceipt: LcxRunReceipt;
};
type Harness = {
  runOwner: (
    command: { id: string; script: string; required: boolean },
    params: { snapshot: ReturnType<typeof createLcxRunSnapshot> },
  ) => Promise<Run>;
  ownerRunFromPayload: (
    command: { id: string; script: string; required: boolean },
    payload: Record<string, unknown>,
    params: Record<string, unknown>,
  ) => Run;
  captureOwnerRun: (run: Run, payload: Record<string, unknown>) => Promise<Run>;
  aggregate: (
    radar: Record<string, unknown>,
    acceptance: Record<string, unknown>,
  ) => Promise<Run[]>;
};
const source = await fs.readFile(
  path.resolve(import.meta.dirname, "../scripts/operator/lcx-governance-autopilot.ts"),
  "utf8",
);
const parsed = ts.createSourceFile("autopilot.ts", source, ts.ScriptTarget.ESNext, true);
const declarations = parsed.statements
  .filter(ts.isFunctionDeclaration)
  .map((node) => node.getText(parsed))
  .join("\n");
function variable(name: string): string {
  const node = parsed.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => declaration.name.getText(parsed) === name,
      ),
  );
  if (!node) {
    throw new Error(`missing original declaration: ${name}`);
  }
  return node.getText(parsed);
}
const originalAggregation = `${variable("problemRadarOwnerRun")}\n${variable("commercialAcceptanceOwnerRun")}`;
let workspace: string;
let dbPath: string;
let config: OpenClawConfig;
const snapshot = createLcxRunSnapshot({
  observedAt: "2026-10-07T01:00:00.000Z",
  authorityOwner: "test-original-owner",
  sourceCommit: "test-source",
  sourceBranch: "test-branch",
});
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-governance-capture-"));
  dbPath = path.join(workspace, "memory.sqlite");
  config = { agents: { defaults: { workspace, memorySearch: { store: { path: dbPath } } } } };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(workspace, { recursive: true, force: true });
});

/** Compile the actual declarations only: importing the CLI would launch the entire resident audit. */
function harness(
  options: {
    exec?: (file: string, args: string[], options: unknown) => Promise<{ stdout: string }>;
    load?: () => OpenClawConfig;
    recorder?: typeof recordAgentArtifact;
  } = {},
): Harness {
  const body = `${variable("SAME_CYCLE_OWNER_PAYLOAD_IDS")}\n${variable("ownerArtifactRecordingConfig")}\n${declarations}
  async function aggregate(problemRadarPayload, commercialAcceptancePayload) {
    const problemRadarCommand = { id: "problemRadar", script: "radar.ts", required: true };
    const commercialAcceptanceCommand = { id: "commercialAcceptance", script: "acceptance.ts", required: true };
    const governanceRunId = "test-parent";
    const governanceSnapshot = snapshot;
    const builtCommercialAcceptance = commercialAcceptancePayload;
    const acceptanceDurationMs = 3;
    const acceptanceProbes = { durationMs: 1 };
    const acceptanceBuildDurationMs = 1;
    const acceptanceCoordinationWaitMs = 1;
    ${originalAggregation}
    return [problemRadarOwnerRun, commercialAcceptanceOwnerRun];
  }
  return { captureOwnerRun, ownerRunFromPayload, runOwner, aggregate };`;
  const compiled = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const factory = vm.runInThisContext(
    `(function(dependencies) { const { recordAgentArtifact, loadConfig, DEFAULT_WORKSPACE_DIR, execFileAsync, repoRoot, EXEC_MAX_BUFFER, compactCommercialAcceptanceFailures, readCommercialAcceptanceFeedback, GOVERNANCE_AUTOPILOT_LATEST_PATH, buildLcxRunReceipt, createLcxRunId, boundaryFromFlags, snapshot } = dependencies; ${compiled} })`,
  ) as (dependencies: Record<string, unknown>) => Harness;
  return factory({
    recordAgentArtifact: options.recorder ?? recordAgentArtifact,
    loadConfig: options.load ?? (() => config),
    DEFAULT_WORKSPACE_DIR: workspace,
    execFileAsync:
      options.exec ??
      (async () => {
        throw new Error("unexpected subprocess");
      }),
    repoRoot: workspace,
    EXEC_MAX_BUFFER: 1024,
    compactCommercialAcceptanceFailures,
    GOVERNANCE_AUTOPILOT_LATEST_PATH: path.join(workspace, "missing-prior-governance.json"),
    readCommercialAcceptanceFeedback: async () => ({
      status: "unavailable",
      reason: "private_fixture_no_prior_receipt",
    }),
    buildLcxRunReceipt,
    createLcxRunId,
    boundaryFromFlags,
    snapshot,
  });
}
function normalize(owner: string, payload: Record<string, unknown>, instance: Harness) {
  return instance.ownerRunFromPayload({ id: owner, script: "owner.ts", required: true }, payload, {
    commandText: "original owner",
    exitCode: 0,
    snapshot,
  });
}
async function assertOriginal(run: Run, payload: Record<string, unknown>, time: string) {
  const store = ArtifactStore.open({ dbPath, workspaceDir: workspace, readOnly: true });
  try {
    const found = store.search({ owner: run.id }).artifacts;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      owner: run.id,
      runId: run.runReceipt.runId,
      observedAt: time,
    });
    const read = await store.read(found[0].id);
    expect(JSON.parse(read.text!).value).toEqual(payload);
    const originalBytes = await fs.readFile(path.join(workspace, found[0].relativePath));
    expect(JSON.parse(originalBytes.toString("utf8")).value).toEqual(payload);
    expect(createHash("sha256").update(originalBytes).digest("hex")).toBe(found[0].sha256);
    expect(run.compact.artifactEvidence).toMatchObject({
      id: found[0].id,
      sha256: found[0].sha256,
    });
  } finally {
    store.close();
  }
}

it.each(["trainingPlan", "liveFadeoutAudit"])(
  "archives exact %s owner/run/source time with business metadata unchanged",
  async (owner) => {
    const payload = {
      ok: true,
      checkedAt: "2026-01-02T00:00:00Z",
      summary: { unusedDetail: "原始结论" },
      fullResults: { protectedMeasurement: null },
      artifactEvidence: { status: "business-original" },
    };
    const original = structuredClone(payload);
    const instance = harness();
    const normalized = normalize(owner, payload, instance);
    const run = await instance.captureOwnerRun(normalized, payload);
    expect(run.runReceipt).toEqual(normalized.runReceipt);
    expect(payload).toEqual(original);
    expect(run.compact.artifactEvidence?.sourceTimeBasis).toBe("payload.checkedAt");
    await assertOriginal(run, payload, "2026-01-02T00:00:00.000Z");
  },
);

it("captures both original same-cycle aggregate statements and keeps radar payload reuse", async () => {
  const instance = harness();
  const radar = {
    ok: true,
    observedAt: "2026-01-03T00:00:00Z",
    actionableClusters: ["original-question"],
    originalDetails: { unknown: null },
  };
  const acceptance = {
    ok: false,
    generatedAt: "2026-01-04T00:00:00Z",
    summary: { failed: 1 },
    failedGates: ["original-gate"],
    ownerSnapshotReuse: { sameCycleOwners: ["radar"] },
    fullEvidence: ["complete"],
  };
  const [a, b] = await instance.aggregate(radar, acceptance);
  expect(a.payload).toBe(radar);
  expect(b.ok).toBe(false);
  expect(b.runReceipt.status).toBe("blocked");
  await assertOriginal(a, radar, "2026-01-03T00:00:00.000Z");
  await assertOriginal(b, acceptance, "2026-01-04T00:00:00.000Z");
});

it.each([
  [0, true],
  [1, false],
  [1, true],
] as const)(
  "original subprocess exit%s / ok=%s retains parsed complete output independently of verdict",
  async (exitCode, ok) => {
    const payload = {
      ok,
      checkedAt: "2026-01-05T00:00:00Z",
      fullHiddenEvidence: ["specific"],
    };
    const instance = harness({
      exec: async () => {
        if (exitCode) {
          throw { code: exitCode, stdout: JSON.stringify(payload), stderr: "business failure" };
        }
        return { stdout: JSON.stringify(payload) };
      },
    });
    const run = await instance.runOwner(
      { id: "trainingPlan", script: "owner.ts", required: true },
      { snapshot },
    );
    expect(run).toMatchObject({ parsed: true, ok: payload.ok, exitCode });
    expect(run.runReceipt.status).toBe(!ok ? "blocked" : exitCode ? "failed" : "passed");
    await assertOriginal(
      run,
      {
        ...payload,
        acceptanceFeedback: { status: "unavailable", reason: "private_fixture_no_prior_receipt" },
      },
      "2026-01-05T00:00:00.000Z",
    );
  },
);

it("uses the original run observation time for malformed/missing source time, never freshens it", async () => {
  const payload = { ok: true, checkedAt: "invalid" };
  const instance = harness();
  const run = await instance.captureOwnerRun(normalize("trainingPlan", payload, instance), payload);
  expect(run.compact).toMatchObject({
    sourceObservedAt: snapshot.observedAt,
    artifactEvidence: { sourceTimeBasis: "runReceipt.checkedAt" },
  });
  await assertOriginal(run, payload, snapshot.observedAt);
});

it.each(["disabled", "config_failure", "recorder_throw"])(
  "recording %s remains an explicit gap and cannot change the owner verdict",
  async (reason) => {
    const instance = harness({
      load: () => {
        if (reason === "config_failure") {
          throw new Error("isolated config failure");
        }
        return reason === "disabled"
          ? { agents: { defaults: { memorySearch: { enabled: false } } } }
          : config;
      },
      recorder:
        reason === "recorder_throw"
          ? async () => {
              throw new Error("isolated recorder failure");
            }
          : recordAgentArtifact,
    });
    const payload = { ok: true };
    const normalized = normalize("trainingPlan", payload, instance);
    const run = await instance.captureOwnerRun(normalized, payload);
    expect(run.runReceipt).toEqual(normalized.runReceipt);
    expect(run.ok).toBe(true);
    expect(run.compact.artifactEvidence?.status).toBe("unavailable");
  },
);

it("a recording throw cannot be mistaken for a failed child process", async () => {
  const instance = harness({
    exec: async () => ({ stdout: JSON.stringify({ ok: true, summary: "original" }) }),
    recorder: async () => {
      throw new Error("recording failure");
    },
  });
  const run = await instance.runOwner(
    { id: "trainingPlan", script: "owner.ts", required: true },
    { snapshot },
  );
  expect(run).toMatchObject({ ok: true, exitCode: 0, parsed: true });
  expect(run.compact.artifactEvidence?.status).toBe("unavailable");
});

it("malformed stdout creates no fabricated payload, while central keeps its original archive owner", async () => {
  const recorder = vi.fn<typeof recordAgentArtifact>(recordAgentArtifact);
  const instance = harness({ exec: async () => ({ stdout: "invalid-json" }), recorder });
  const failed = await instance.runOwner(
    { id: "trainingPlan", script: "owner.ts", required: true },
    { snapshot },
  );
  expect(failed.parsed).toBe(false);
  expect(recorder).not.toHaveBeenCalled();
  const central = normalize("centralAgent", { ok: true }, instance);
  expect(await instance.captureOwnerRun(central, { ok: true })).toBe(central);
  expect(recorder).not.toHaveBeenCalled();
});

it.each(["git_status_failed", "git_status_timed_out"])(
  "keeps %s visible through the original collector and central input",
  async (reason) => {
    const payload = {
      ok: false,
      checkedAt: snapshot.observedAt,
      boundary: "local_change_impact_plan_only",
      changedFiles: [],
      changedFilesReadback: { source: "git", status: "unavailable", reason },
      strayGate: { ok: false, unmatchedChangedFiles: [], nextAction: "restore Git evidence" },
      affectedLanes: [],
      unmatchedFiles: [],
    };
    const instance = harness({ exec: async () => ({ stdout: JSON.stringify(payload) }) });
    const run = await instance.runOwner(
      { id: "changeImpact", script: "scripts/operator/lcx-change-impact-plan.ts", required: true },
      { snapshot },
    );
    expect(run.runReceipt.status).toBe("blocked");
    expect(run.compact.changedFilesReadback).toEqual(payload.changedFilesReadback);
    expect(run.compact.strayGate).toEqual(payload.strayGate);
    const centralInput = buildCentralGovernanceInput([run], {
      parentRunId: "private-governance-parent",
      snapshot,
    });
    expect(centralInput.byOwner.changeImpact).toMatchObject({
      ok: false,
      compact: {
        changedFilesReadback: payload.changedFilesReadback,
        strayGate: payload.strayGate,
      },
    });
    await assertOriginal(run, payload, snapshot.observedAt);
    if (process.env.LCX_CHANGE_IMPACT_GOVERNANCE_PROOF_DIR) {
      await fs.mkdir(process.env.LCX_CHANGE_IMPACT_GOVERNANCE_PROOF_DIR, { recursive: true });
      await fs.writeFile(
        path.join(process.env.LCX_CHANGE_IMPACT_GOVERNANCE_PROOF_DIR, `${reason}.json`),
        JSON.stringify({ payload, run, centralInput, modelCalled: false }, null, 2) + "\n",
      );
    }
  },
);

it.skipIf(!process.env.LCX_CHANGE_IMPACT_NATIVE_PROOF_PATH)(
  "consumes the retained original change-impact failure body into central input",
  async () => {
    const inputPath = process.env.LCX_CHANGE_IMPACT_NATIVE_PROOF_PATH!;
    const bytes = await fs.readFile(inputPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(sha256).toBe(process.env.LCX_CHANGE_IMPACT_NATIVE_PROOF_SHA256);
    const payload = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    expect(payload.changedFilesReadback).toMatchObject({ source: "git", status: "unavailable" });
    const instance = harness({ exec: async () => ({ stdout: bytes.toString("utf8") }) });
    const run = await instance.runOwner(
      { id: "changeImpact", script: "scripts/operator/lcx-change-impact-plan.ts", required: true },
      { snapshot },
    );
    const centralInput = buildCentralGovernanceInput([run], {
      parentRunId: "private-governance-parent",
      snapshot,
    });
    expect(run.runReceipt.status).toBe("blocked");
    expect(centralInput.byOwner.changeImpact.compact.changedFilesReadback).toEqual(
      payload.changedFilesReadback,
    );
    expect(centralInput.byOwner.changeImpact.compact.strayGate).toEqual(payload.strayGate);
    if (process.env.LCX_CHANGE_IMPACT_GOVERNANCE_PROOF_DIR) {
      await fs.writeFile(
        path.join(
          process.env.LCX_CHANGE_IMPACT_GOVERNANCE_PROOF_DIR,
          "native-source-to-central.json",
        ),
        JSON.stringify(
          {
            producer: { path: inputPath, sha256 },
            actualProducerPayload: payload,
            run,
            centralInput,
            boundary:
              "retained_original_CLI_output_at_lowest_exec_IO_original_collector_and_Central_input_no_model_cycle",
          },
          null,
          2,
        ) + "\n",
      );
    }
  },
);
