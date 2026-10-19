import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import type { OwnerControlMap } from "../../scripts/operator/lcx-owner-control-map.js";
import { recordAgentArtifact } from "../../src/agents/artifact-result-recording.js";
import { projectCleanupReview } from "../../src/agents/central-harness/cleanup-review-handoff.js";
import { fitGovernanceDigest } from "../../src/agents/central-harness/governance-digest-budget.js";
import {
  buildCentralGovernanceInput,
  projectFlowHandoff,
} from "../../src/agents/central-harness/governance-input.js";
import { boundPerception } from "../../src/agents/central-harness/harness-loop.js";
import type { OpenClawConfig } from "../../src/config/config.js";
import { readFileWithinRoot } from "../../src/infra/fs-safe.js";
import {
  boundaryFromFlags,
  buildLcxRunReceipt,
  createLcxRunId,
  createLcxRunSnapshot,
  LCX_RUN_STATUSES,
  type LcxRunReceipt,
} from "../../src/shared/lcx-run-receipt.js";
import { probeOriginalSelfRepairFeedback } from "./lcx-waterflow-self-repair-feedback-probe.js";

const repo = path.resolve(import.meta.dirname, "../..");
const exec = promisify(execFile);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
type Row = Record<string, unknown>;
export type FeedbackReadbackCase =
  | "read"
  | "blocked"
  | "blocked_restored"
  | "legacy"
  | "source_changed"
  | "source_missing"
  | "request_missing"
  | "expired"
  | "crowded";
type OwnerRun = {
  id: string;
  ok?: boolean;
  compact: Row;
  runReceipt: LcxRunReceipt;
};

function originalFunctions(ast: ts.SourceFile) {
  return ast.statements
    .filter(ts.isFunctionDeclaration)
    .map((node) => node.getText(ast).replace(/^export\s+/u, ""))
    .join("\n");
}

async function invokeCli(workspace: string, write = false) {
  const argv = [
    "--import",
    "tsx",
    path.join(repo, "scripts/operator/lcx-self-repair-hands.ts"),
    "--workspace-dir",
    workspace,
    "--json",
    ...(write ? ["--write", "--signal-key", "original-legacy-no-feedback"] : []),
  ];
  try {
    const result = await exec(process.execPath, argv, { cwd: repo, timeout: 30000 });
    return { argv, ...result, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      argv,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

export async function consumeGovernance(
  payload: Row,
  cli: Awaited<ReturnType<typeof invokeCli>>,
  workspace: string,
  crowded: boolean,
  nativeOwnerArgs?: string[],
) {
  const sourcePath = path.join(repo, "scripts/operator/lcx-governance-autopilot.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const declarations = ast.statements
    .filter(ts.isVariableStatement)
    .flatMap((node) => node.declarationList.declarations);
  const cycleIds = declarations.find(
    (node) => ts.isIdentifier(node.name) && node.name.text === "SAME_CYCLE_OWNER_PAYLOAD_IDS",
  );
  const receipt = declarations.find(
    (node) => ts.isIdentifier(node.name) && node.name.text === "receipt",
  );
  assert.ok(cycleIds?.initializer);
  assert.ok(receipt?.initializer && ts.isObjectLiteralExpression(receipt.initializer));
  const receiptObject = receipt.initializer;
  const properties = ["owners", "ownerCommands"].map((name) => {
    const found = receiptObject.properties.find(
      (node) => ts.isPropertyAssignment(node) && node.name.getText(ast) === name,
    );
    assert.ok(found && ts.isPropertyAssignment(found));
    return `${name}: ${found.initializer.getText(ast)}`;
  });
  const compiled = ts.transpileModule(
    `let ownerArtifactRecordingConfig = privateArtifactConfig;\nconst SAME_CYCLE_OWNER_PAYLOAD_IDS = ${cycleIds.initializer.getText(ast)};\n${originalFunctions(ast)}\n({runOwner,ownerRunFromPayload,project: (owners) => ({${properties.join(",")}})})`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const originals = vm.runInNewContext(compiled, {
    JSON,
    Date,
    Object,
    Set,
    boundaryFromFlags,
    buildLcxRunReceipt,
    createLcxRunId,
    privateArtifactConfig: {
      agents: {
        defaults: {
          workspace,
          memorySearch: {
            enabled: true,
            store: { path: path.join(workspace, "state/private-artifacts.sqlite") },
          },
        },
      },
    } satisfies OpenClawConfig,
    recordAgentArtifact,
    DEFAULT_WORKSPACE_DIR: workspace,
    execFileAsync: exec,
    process,
    performance,
    repoRoot: repo,
    EXEC_MAX_BUFFER: 48 * 1024 * 1024,
  }) as {
    runOwner: (
      command: { id: string; script: string; args: string[]; required: boolean },
      host: { parentRunId: string; snapshot: ReturnType<typeof createLcxRunSnapshot> },
    ) => Promise<OwnerRun>;
    ownerRunFromPayload: (
      command: { id: string; script: string; args: string[]; required: boolean },
      value: Row,
      host: {
        commandText: string;
        exitCode: number;
        parentRunId: string;
        snapshot: ReturnType<typeof createLcxRunSnapshot>;
      },
    ) => OwnerRun;
    project: (owners: OwnerRun[]) => Row;
  };
  const gitCommit = await exec("git", ["rev-parse", "HEAD"], { cwd: repo });
  const gitBranch = await exec("git", ["branch", "--show-current"], { cwd: repo });
  const snapshot = createLcxRunSnapshot({
    observedAt: new Date().toISOString(),
    sourceCommit: gitCommit.stdout.trim(),
    sourceBranch: gitBranch.stdout.trim() || "detached",
    authorityOwner: "lcx-governance-autopilot",
  });
  const parentRunId = createLcxRunId({
    checkedAt: snapshot.observedAt,
    owner: "lcx-governance-autopilot",
    key: `${workspace}:readback`,
  });
  const command = {
    id: "selfRepairHands",
    script: "scripts/operator/lcx-self-repair-hands.ts",
    args: nativeOwnerArgs ?? ["--json", "--workspace-dir", workspace],
    required: true,
  };
  const owner = nativeOwnerArgs
    ? await originals.runOwner(command, { parentRunId, snapshot })
    : originals.ownerRunFromPayload(command, payload, {
        commandText: `node ${cli.argv.join(" ")}`,
        exitCode: cli.exitCode,
        parentRunId,
        snapshot,
      });
  let projection = originals.project([owner]);
  let governancePath: string | undefined;
  if (nativeOwnerArgs) {
    const initializer = (name: string) => {
      const found = declarations.find(
        (node) => ts.isIdentifier(node.name) && node.name.text === name,
      );
      assert.ok(found?.initializer, `original ${name} missing`);
      return found.initializer.getText(ast);
    };
    const names = [
      "requiredParseFailures",
      "activeTrainingOrEval",
      "structuralOwnerFailures",
      "structuralOwnerExecutionFailures",
      "universeIndexGovernanceIncomplete",
      "releaseBlocked",
      "governanceCheckedAt",
      "governanceRunStatus",
      "governanceNextAction",
      "governanceRunReceipt",
    ];
    const keys = [
      "ok",
      "boundary",
      "checkedAt",
      "snapshot",
      "runId",
      "runReceipt",
      "ownerCommands",
      "owners",
      "liveTouched",
      "providerConfigTouched",
      "protectedMemoryTouched",
    ];
    const originalProperties = keys.map((key) => {
      const found = receiptObject.properties.find(
        (node) => ts.isPropertyAssignment(node) && node.name.getText(ast) === key,
      );
      assert.ok(found && ts.isPropertyAssignment(found));
      return `${key}: ${found.initializer.getText(ast)}`;
    });
    projection = vm.runInNewContext(
      ts.transpileModule(
        `${originalFunctions(ast)}\nconst OWNER_COMMANDS = [command];\nconst byOwner = ownerMap(owners);\n${names.map((name) => `const ${name} = ${initializer(name)};`).join("\n")}\n({${originalProperties.join(",")}})`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
      ).outputText,
      {
        JSON,
        Date,
        Object,
        Set,
        command,
        owners: [owner],
        governanceRunId: parentRunId,
        governanceSnapshot: snapshot,
        boundaryFromFlags,
        buildLcxRunReceipt,
      },
    ) as Row;
    governancePath = path.join(workspace, "state/same-attempt-governance.json");
    const publication = ast.statements.find(
      (node) =>
        ts.isExpressionStatement(node) &&
        ts.isAwaitExpression(node.expression) &&
        ts.isCallExpression(node.expression.expression) &&
        node.expression.expression.expression.getText(ast) === "writeEvidence" &&
        node.expression.expression.arguments[0]?.getText(ast) === '"governanceAutopilotLatest"',
    );
    assert.ok(
      publication &&
        ts.isExpressionStatement(publication) &&
        ts.isAwaitExpression(publication.expression) &&
        ts.isCallExpression(publication.expression.expression),
    );
    const callback = publication.expression.expression.arguments[1];
    assert.ok(callback && ts.isArrowFunction(callback));
    const write = vm.runInNewContext(
      ts.transpileModule(`(${callback.getText(ast)})`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      { fs, path, JSON, receipt: projection, GOVERNANCE_AUTOPILOT_LATEST_PATH: governancePath },
    ) as () => Promise<void>;
    await write();
  }
  const mapSourcePath = path.join(repo, "scripts/operator/lcx-owner-control-map.ts");
  const mapSource = await fs.readFile(mapSourcePath, "utf8");
  const mapAst = ts.createSourceFile(mapSourcePath, mapSource, ts.ScriptTarget.Latest, true);
  const originalMap = vm.runInNewContext(
    ts.transpileModule(
      `${originalFunctions(mapAst)}\n({buildOwnerControlMap,writeOwnerControlMap})`,
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      },
    ).outputText,
    {
      JSON,
      Date,
      Object,
      Set,
      fs,
      path,
      OWNER_CONTROL_MAP_LATEST_JSON_PATH: path.join(
        workspace,
        "state/readback-observation-map.json",
      ),
      OWNER_CONTROL_MAP_LATEST_MARKDOWN_PATH: path.join(
        workspace,
        "state/readback-observation-map.md",
      ),
    },
  ) as {
    buildOwnerControlMap: (value: Row) => OwnerControlMap;
    writeOwnerControlMap: (map: OwnerControlMap) => Promise<void>;
  };
  const map = originalMap.buildOwnerControlMap({
    checkedAt: snapshot.observedAt,
    snapshot,
    governance: projection,
    localFailureTrace: {},
    paths: {
      latestJsonPath: path.join(workspace, "state/readback-observation-map.json"),
      latestMarkdownPath: path.join(workspace, "state/readback-observation-map.md"),
      sourcePaths: [path.join(workspace, "state/lcx-self-repair-hands-latest.json")],
    },
  });
  if (nativeOwnerArgs) {
    await originalMap.writeOwnerControlMap(map);
  }
  const centralInput = buildCentralGovernanceInput([{ ...owner, ok: owner.ok }], {
    parentRunId,
    snapshot,
  });
  const centralSource = await fs.readFile(
    path.join(repo, "scripts/operator/lcx-central-agent.ts"),
    "utf8",
  );
  const centralAst = ts.createSourceFile(
    "central-agent.ts",
    centralSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const centralOriginals = vm.runInNewContext(
    ts.transpileModule(
      `${originalFunctions(centralAst)}\n({readCentralGovernanceInput,projectGovernanceDigest})`,
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      },
    ).outputText,
    {
      JSON,
      Object,
      Set,
      Buffer,
      Date,
      path,
      createHash,
      readFileWithinRoot,
      LCX_RUN_STATUSES,
      fitGovernanceDigest,
      projectCleanupReview,
      projectFlowHandoff,
    },
  ) as {
    readCentralGovernanceInput: (filePath: string) => Promise<Row>;
    projectGovernanceDigest: (value: Row) => Row;
  };
  const centralInputPath = path.join(workspace, "state/readback-central-input.json");
  await fs.writeFile(centralInputPath, `${JSON.stringify(centralInput)}\n`);
  const centralRead = await centralOriginals.readCentralGovernanceInput(centralInputPath);
  const owners = centralRead.owners as Row;
  // Only capacity adversaries are synthetic here; the selfRepair owner and its feedback remain real.
  const capacityInput = crowded
    ? {
        ...centralRead,
        multiAgentPatternShadow: {
          reason: "capacity adversary 字符串".repeat(500),
          trialDecisionReason: "capacity adversary UTF8".repeat(500),
        },
        owners: {
          ...owners,
          flowGraph: {
            flowHandoff: { status: "unavailable", reason: "capacity adversary flow".repeat(500) },
          },
          changeImpact: {
            cleanupReview: {
              status: "blocked",
              reason: "capacity adversary cleanup".repeat(500),
              missingChecks: ["capacity adversary only; no actual cleanup observation"],
            },
          },
        },
      }
    : undefined;
  const digestProjection = centralOriginals.projectGovernanceDigest(capacityInput ?? centralRead);
  const bounded = boundPerception({
    observedAt: snapshot.observedAt,
    ownerTotals: {},
    controlRoom: { governanceDigest: digestProjection },
    backlog: [],
    boundaries: ["private original projection; semantic truth not proven"],
  });
  return {
    owner,
    projection,
    governancePath,
    map,
    snapshot,
    parentRunId,
    centralInput,
    centralInputPath,
    centralRead,
    bounded,
    capacityInput,
    digestProjection,
    sourceHashes: { governance: sha(source), map: sha(mapSource), central: sha(centralSource) },
  };
}

/** New downstream proof reuses the frozen actual producer; every consumer executes original functions. */
export async function probeOriginalSelfRepairFeedbackReadback(options: {
  directory: string;
  scenario: FeedbackReadbackCase;
}) {
  const producerDir = path.join(options.directory, "producer");
  await fs.mkdir(producerDir, { recursive: true });
  const produced = await probeOriginalSelfRepairFeedback({
    directory: producerDir,
    fault:
      options.scenario === "blocked"
        ? "hash"
        : options.scenario === "blocked_restored"
          ? "changed_before_write"
          : undefined,
  });
  const workspace = path.join(producerDir, "producer/workspace");
  let legacyWrite: Awaited<ReturnType<typeof invokeCli>> | undefined;
  if (options.scenario === "legacy") {
    legacyWrite = await invokeCli(workspace, true);
    assert.equal(legacyWrite.exitCode, 0);
  }
  const rootPath = path.join(workspace, "state/lcx-self-repair-hands-latest.json");
  if (options.scenario === "request_missing" || options.scenario === "expired") {
    // Deliberate negative input on real originally written bytes, never a positive producer.
    const mutated = JSON.parse(await fs.readFile(rootPath, "utf8")) as Row;
    if (options.scenario === "request_missing") {
      delete mutated.diagnosticFeedbackRequest;
    } else {
      const request = mutated.diagnosticFeedbackRequest as { request: unknown; host: Row };
      request.host.maxAgeMs = 0;
    }
    await fs.writeFile(rootPath, `${JSON.stringify(mutated, null, 2)}\n`);
  }
  const beforeRootBytes = await fs.readFile(rootPath, "utf8");
  const mapPath = path.join(workspace, produced.request.map.path);
  if (options.scenario === "blocked_restored") {
    assert.equal(produced.initialFeedback?.status, "read");
    assert.equal(produced.persisted.status, "blocked");
    assert.equal(sha(await fs.readFile(mapPath, "utf8")), produced.request.map.sha256);
  }
  if (options.scenario === "source_changed") {
    await fs.appendFile(mapPath, "\n");
  } else if (options.scenario === "source_missing") {
    await fs.unlink(mapPath);
  }
  const cli = await invokeCli(workspace);
  assert.ok(cli.stdout.trim(), `original CLI readback had no JSON: ${cli.stderr}`);
  const readback = JSON.parse(cli.stdout) as Row;
  const consumed = await consumeGovernance(
    readback,
    cli,
    workspace,
    options.scenario === "crowded",
  );
  const proof = {
    scenario: options.scenario,
    produced,
    legacyWrite,
    beforeRootBytes,
    afterRootBytes: await fs.readFile(rootPath, "utf8"),
    persistedRootSha256: sha(beforeRootBytes),
    cli,
    readback,
    ...consumed,
    selfRepairSourceSha256: sha(
      await fs.readFile(path.join(repo, "scripts/operator/lcx-self-repair-hands.ts"), "utf8"),
    ),
    selectedItem: consumed.map.items.find(
      (item) => item.id === "self_repair_memory_and_training_candidate_hands",
    ),
    boundary:
      "Original private producer/explicit CLI writer (blocked_restored uses actual API writer with source change/restoration) -> actual original default dry-run CLI -> original AST ownerRunFromPayload/compactOwner -> original ownerCommands/owners partial projection -> original map. Original Central input builder -> private transport serialization -> original safe file reader -> original digest/fit -> original boundPerception; not a model cycle or semantic decision. New governance observation identity is separate from stored feedback source identity. Only private filesystem/process IO; original runOwner no deadline; no scheduler/provider/trainer/protected memory/full governance. Read and valid hashes do not prove semantic source truth or reuse.",
  };
  await fs.writeFile(
    path.join(options.directory, "readback-proof.json"),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
  return proof;
}
