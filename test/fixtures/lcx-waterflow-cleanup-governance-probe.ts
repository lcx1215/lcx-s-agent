import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import {
  auditWorkflowHandoffs,
  type WorkflowHandoffEvidence,
} from "../../scripts/operator/lcx-flow-graph.js";
import { recordAgentArtifact } from "../../src/agents/artifact-result-recording.js";
import {
  compactCleanupReview,
  reviewCleanupBeforeDecision,
} from "../../src/agents/central-harness/cleanup-review-handoff.js";
import {
  boundaryFromFlags,
  buildLcxRunReceipt,
  createLcxRunId,
} from "../../src/shared/lcx-run-receipt.js";
import {
  buildCleanupReviewProbe,
  type CleanupReviewFault,
} from "./lcx-waterflow-cleanup-review-probe.js";

const execute = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Execute only the original join/recapture statement and its pure helpers; never import governance. */
export async function probeOriginalCleanupGovernance(
  root: string,
  fault?: CleanupReviewFault,
  signal?: AbortSignal,
) {
  const stages: { id: string; durationMs: number; status: string }[] = [];
  const stage = async <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      signal?.throwIfAborted();
      const result = await work();
      signal?.throwIfAborted();
      stages.push({ id, durationMs: Math.round(performance.now() - started), status: "completed" });
      return result;
    } catch (error) {
      stages.push({
        id,
        durationMs: Math.round(performance.now() - started),
        status: signal?.aborted ? "aborted" : "failed",
      });
      // AbortSignal.timeout throws a DOMException with a read-only message.
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nprivate_cleanup_stages=${JSON.stringify(stages)}`,
        { cause: error },
      );
    }
  };
  const fixture = await stage("prepare_original_sources", () =>
    buildCleanupReviewProbe(root, fault, undefined, true),
  );
  const source = await fs.readFile(
    path.join(repoRoot, "scripts/operator/lcx-governance-autopilot.ts"),
    "utf8",
  );
  const ast = ts.createSourceFile("original-governance.ts", source, ts.ScriptTarget.Latest, true);
  const names = new Set([
    "recordValue",
    "arrayValue",
    "stringArray",
    "decisionIds",
    "compactOwner",
    "ownerRunStatus",
    "ownerNextAction",
    "ownerBoundary",
    "ownerEvidence",
    "buildOwnerRunReceipt",
    "ownerRunFromPayload",
    "captureOwnerRun",
  ]);
  const functions = ast.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ""),
  );
  assert.equal(functions.length, names.size);
  const join = ast.statements.find(
    (node) =>
      ts.isIfStatement(node) && node.getText(ast).includes("await reviewCleanupBeforeDecision"),
  );
  assert.ok(join);
  const config = {
    agents: {
      defaults: {
        memorySearch: {
          enabled: true,
          store: { path: path.join(root, "private-artifacts.sqlite") },
        },
      },
    },
  };
  const commands = [
    {
      id: "changeImpact",
      script: "scripts/operator/lcx-change-impact-plan.ts",
      args: ["--json"],
      required: true,
    },
  ];
  const context: Record<string, unknown> = {
    Date,
    String,
    Set,
    Map,
    Object,
    recordAgentArtifact,
    compactCleanupReview,
    reviewCleanupBeforeDecision,
    boundaryFromFlags,
    buildLcxRunReceipt,
    createLcxRunId,
    DEFAULT_WORKSPACE_DIR: root,
    ownerArtifactRecordingConfig: config,
    SAME_CYCLE_OWNER_PAYLOAD_IDS: new Set(["changeImpact"]),
    governanceRunId: fixture.host.parentRunId,
    governanceSnapshot: fixture.governance.snapshot,
    repoRoot,
    OWNER_COMMANDS: commands,
    directOwnerCommands: commands,
  };
  // Execute exact isolated declarations in the host realm; foreign VM object
  // prototypes would change the original artifact serializer contract.
  const declarations = ts.transpile(functions.map((node) => node.getText(ast)).join("\n"), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None,
  });
  const isolated = vm.compileFunction(
    `${declarations}\nreturn { ownerRunFromPayload, captureOwnerRun };`,
    Object.keys(context),
  )(...Object.values(context)) as Record<string, unknown>;
  Object.assign(context, isolated);
  const makeRun = context.ownerRunFromPayload as (
    command: unknown,
    payload: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Record<string, unknown>;
  const capture = context.captureOwnerRun as (
    run: Record<string, unknown>,
    payload: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  const response = await stage("original_change_impact_cli", async () => {
    const pending = execute(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/lcx-change-impact-plan.ts",
        "--json",
        "--files",
        "src/agents/central-harness/cleanup-review-handoff.ts",
      ],
      { cwd: repoRoot, timeout: 10_000, maxBuffer: 1024 * 1024, signal },
    );
    const closed = new Promise<void>((resolve) => pending.child.once("close", () => resolve()));
    try {
      return await pending;
    } finally {
      await closed;
    }
  });
  const payload = JSON.parse(response.stdout) as Record<string, unknown>;
  const sourceRun = await stage("capture_original_source", () =>
    capture(
      makeRun(commands[0], payload, {
        commandText: "offline original change-impact CLI",
        exitCode: 0,
        parentRunId: fixture.host.parentRunId,
        snapshot: fixture.governance.snapshot,
      }),
      payload,
    ),
  );
  const directOwners = [
    ...fixture.governance.ownerCommands.map((row) => ({
      ...row,
      compact: fixture.governance.owners[row.id],
    })),
    sourceRun,
  ];
  context.directOwners = directOwners;
  context.changeImpactIndex = directOwners.length - 1;
  context.impactRun = sourceRun;
  const joinCode = ts.transpile(`return (async () => { ${join.getText(ast)} })();`, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None,
  });
  await stage(
    "original_join_and_recapture",
    () =>
      vm.compileFunction(
        joinCode,
        Object.keys(context),
      )(...Object.values(context)) as Promise<unknown>,
  );
  const received = directOwners[directOwners.length - 1] as typeof sourceRun;
  const receivedPayload = received.payload as Record<string, unknown>;
  const review = receivedPayload.cleanupReview as {
    scope: { parentRunId: string };
    sourceReads: Array<{ pointer: string; value: unknown }>;
    status: string;
    reason: string;
  };
  assert.ok(review);
  assert.deepEqual(receivedPayload.impactSourceRunReceipt, sourceRun.runReceipt);
  const receiptFile = path.join(root, "original-recaptured-impact.json");
  await fs.writeFile(receiptFile, JSON.stringify(received, null, 2) + "\n");
  const reviewFile = path.join(root, "original-review-result.json");
  await fs.writeFile(
    reviewFile,
    JSON.stringify(
      {
        review,
        boundary: "offline_source_io_substitutes_original_statement_and_original_change_impact_cli",
      },
      null,
      2,
    ) + "\n",
  );
  const predecision = receivedPayload.cleanupReviewInputArtifact as {
    relativePath: string;
    sha256: string;
  };
  assert.ok(predecision.relativePath, JSON.stringify(predecision));
  const inputPath = path.join(root, predecision.relativePath);
  const ownerRef = { path: inputPath, sha256: predecision.sha256 };
  const reviewRef = { path: reviewFile, sha256: hash(await fs.readFile(reviewFile)) };
  const receiptRef = { path: receiptFile, sha256: hash(await fs.readFile(receiptFile)) };
  const producers = [
    ["universeIndex", "universe_index"],
    ["mindModel", "mind_model"],
    ["flowGraph", "flow_graph"],
    ["contextRecovery", "fixed_evidence_recovery"],
  ] as const;
  const evidence: WorkflowHandoffEvidence = {
    scenarioId: "universe_index_total_coverage_waterflow",
    environment: "offline_fixture",
    nodes: producers.map(([id, nodeId]) => ({
      nodeId,
      scope: { ...ownerRef, pointer: "/value/parentRunId" },
      output: { ...ownerRef, pointer: `/value/byOwner/${id}/runReceipt` },
    })),
  };
  evidence.nodes.push({
    nodeId: "cleanup_candidate_review",
    scope: { ...reviewRef, pointer: "/review/scope/parentRunId" },
    output: { ...reviewRef, pointer: "/review" },
    inputs: producers.flatMap(([id, nodeId]) => {
      const index = review.sourceReads.findIndex(
        (read) => read.pointer === `/value/byOwner/${id}/runReceipt`,
      );
      return index < 0
        ? []
        : [
            {
              from: nodeId,
              value: { ...reviewRef, pointer: `/review/sourceReads/${index}/value` },
            },
          ];
    }),
  });
  evidence.nodes.push({
    nodeId: "change_impact_plan",
    scope: { ...receiptRef, pointer: "/runReceipt/parentRunId" },
    output: { ...receiptRef, pointer: "/payload/affectedLanes" },
    inputs: [
      {
        from: "cleanup_candidate_review",
        value: { ...receiptRef, pointer: "/payload/cleanupReview" },
      },
    ],
  });
  const audit = (await auditWorkflowHandoffs([evidence])).find(
    (item) => item.scenarioId === evidence.scenarioId,
  )!;
  return {
    fixture,
    stages,
    originalSourceSha256: hash(source),
    sourceRun,
    received,
    review,
    evidence,
    audit,
    producerBoundary:
      "Original source owner IO substitutes plus actual safe change-impact CLI; no Universe/mind/flow/recovery stack dispatched",
    missingOriginalPhases: ["repo_inventory", "artifact_inventory", "owner_coverage_map"],
    naturalAdoption: "not_proven",
  };
}
