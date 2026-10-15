import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  auditWorkflowHandoffs,
  type WorkflowHandoffEvidence,
} from "../../scripts/operator/lcx-flow-graph.js";
import {
  buildSelfRepairHandsReceipt,
  writeSelfRepairHandsReceipt,
  writeSelfRepairContentReviewReceipt,
} from "../../scripts/operator/lcx-self-repair-hands.js";
import type { ArtifactRecordingReceipt } from "../../src/agents/artifact-result-recording.js";
import { createCentralToolRegistry } from "../../src/agents/central-harness/tool-registry.js";
import {
  readSelfRepairCandidateReviewInput,
  reviewSelfRepairCandidate,
} from "../../src/agents/self-repair-candidate-review.js";
import { readSelfRepairOwnerMapFeedback } from "../../src/agents/self-repair-owner-map-feedback.js";
import type { OpenClawConfig } from "../../src/config/config.js";
import { consumeGovernance } from "./lcx-waterflow-self-repair-feedback-readback-probe.js";

const repo = path.resolve(import.meta.dirname, "../..");
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const exec = promisify(execFile);
export type PrewriteRecallFault =
  | "missing_memory"
  | "artifact_hash"
  | "missing_host"
  | "account_scope"
  | "run_scope"
  | "old_file_changed"
  | "partial_range"
  | "old_source_missing"
  | "downstream_host_missing"
  | "downstream_artifact_hash"
  | "oversized_selection";
export type HistoricalRecallFault =
  | "old_rule_mismatch"
  | "old_future"
  | "old_invalid_time"
  | "current_stale"
  | "current_missing";
type Reference = { path: string; sha256: string };
type MemoryRecallInput = {
  memoryRecall: {
    previousReceipt: Reference;
    correction: Reference;
    artifact: { id: string; sha256: string };
    from: number;
    lines: number;
  };
  expectedMemoryScope?: { accountId: string; runId: string };
  artifactStorePath: string;
};

/** Actual original writer and registered tools; no model, search manager or owner process. */
export async function produceOriginalPrewriteRecall(options: {
  directory: string;
  fault?: PrewriteRecallFault;
  before?: boolean;
  sameContent?: boolean;
  useCli?: boolean;
  historicalFault?: HistoricalRecallFault;
  withPriorClock?: <T>(operation: () => Promise<T>) => Promise<T>;
}) {
  const workspaceDir = path.join(options.directory, "workspace");
  await fs.mkdir(path.join(workspaceDir, "state"), { recursive: true });
  const scope = { accountId: "private-prewrite-paper", runId: "private-old-rule-run" };
  const currentScope = { accountId: scope.accountId, runId: "private-current-rule-attempt" };
  const oldRule = "Do not reuse a rule without current source evidence.";
  const currentRule = options.sameContent
    ? oldRule
    : "Treat a cached rule as sufficient proof even when its source is missing.";
  const writeCandidate = async (
    selectedScope: typeof scope,
    rule: string,
    name: string,
    memoryRecallInput?: MemoryRecallInput,
  ) => {
    const relativeSource = `state/${name}-source.json`;
    const sourceBytes = `${JSON.stringify({
      scope: selectedScope,
      observedAt: new Date(
        Date.now() -
          (name === "current" && options.historicalFault === "current_stale"
            ? 8 * 24 * 60 * 60 * 1000
            : 1000),
      ).toISOString(),
      replacementRule: rule,
      sourceTruth: "private synthetic source; reference consistency only",
    })}\n`;
    await fs.writeFile(path.join(workspaceDir, relativeSource), sourceBytes);
    if (name === "current" && options.historicalFault === "current_missing") {
      await fs.unlink(path.join(workspaceDir, relativeSource));
    }
    let receipt = buildSelfRepairHandsReceipt({
      checkedAt: new Date().toISOString(),
      workspaceDir,
      signalKey: selectedScope.runId,
      issue: "private-prewrite-conflict-probe",
      observedFailure:
        name === "prior" && options.fault === "oversized_selection"
          ? `Original private prior long failure evidence: ${"x".repeat(70 * 1024)}`
          : "A prior rule and current proposed rule require source/conflict review.",
      replacementRule: rule,
      domain: "private_prewrite_probe",
      write: true,
      sourceReview: {
        schemaVersion: 1,
        source: { path: relativeSource, sha256: sha(sourceBytes) },
        expectedScope: selectedScope,
        ...memoryRecallInput,
      },
    });
    let cli: { argv: string[]; stdout: string; stderr: string } | undefined;
    if (name === "current" && options.useCli && memoryRecallInput) {
      const manifestPath = path.join(workspaceDir, "state/current-source-review-manifest.json");
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: 1,
          source: { path: relativeSource, sha256: sha(sourceBytes) },
          memoryRecall: memoryRecallInput.memoryRecall,
        }),
      );
      assert.ok(memoryRecallInput.expectedMemoryScope);
      const argv = [
        "--import",
        "tsx",
        path.join(repo, "scripts/operator/lcx-self-repair-hands.ts"),
        "--workspace-dir",
        workspaceDir,
        "--json",
        "--write",
        "--source-review",
        manifestPath,
        "--review-account-id",
        selectedScope.accountId,
        "--review-run-id",
        selectedScope.runId,
        "--memory-source-run-id",
        memoryRecallInput.expectedMemoryScope.runId,
        "--artifact-store-path",
        memoryRecallInput.artifactStorePath,
        "--replacement-rule",
        rule,
        "--signal-key",
        selectedScope.runId,
        "--issue",
        "private-prewrite-conflict-probe",
        "--domain",
        "private_prewrite_probe",
      ];
      const output = await exec(process.execPath, argv, { cwd: repo, timeout: 30000 });
      cli = { argv, ...output };
      receipt = JSON.parse(cli.stdout) as typeof receipt;
    } else {
      await writeSelfRepairHandsReceipt(receipt);
    }
    const receiptBytes = await fs.readFile(receipt.latestJsonPath, "utf8");
    const archivedReceiptPath = `state/${name}-native-root.json`;
    // Preserve exact original producer bytes before original latest is refreshed.
    await fs.writeFile(path.join(workspaceDir, archivedReceiptPath), receiptBytes);
    return {
      receipt,
      cli,
      receiptBytes,
      receiptRef: { path: archivedReceiptPath, sha256: sha(receiptBytes) },
      sourceBytes,
      sourceRef: { path: relativeSource, sha256: sha(sourceBytes) },
    };
  };
  const prior = options.withPriorClock
    ? await options.withPriorClock(() => writeCandidate(scope, oldRule, "prior"))
    : await writeCandidate(scope, oldRule, "prior");
  assert.equal(prior.receipt.sourceReview.status, "verified_reference_candidate_only");
  if (options.historicalFault?.startsWith("old_")) {
    // Explicit adversarial bytes: repin the negative input so rule/time validation, not
    // a coincidental hash failure, must reject it. Never fabricate a positive producer.
    await fs.writeFile(
      path.join(workspaceDir, "state/prior-untampered-root.json"),
      prior.receiptBytes,
    );
    await fs.writeFile(
      path.join(workspaceDir, "state/prior-untampered-source.json"),
      prior.sourceBytes,
    );
    const source = JSON.parse(prior.sourceBytes) as Record<string, unknown>;
    if (options.historicalFault === "old_rule_mismatch") {
      source.replacementRule = "A different historical rule than the native candidate.";
    } else if (options.historicalFault === "old_future") {
      source.observedAt = new Date(Date.now() + 60_000).toISOString();
    } else {
      source.observedAt = "invalid historical timestamp";
    }
    prior.sourceBytes = `${JSON.stringify(source)}\n`;
    prior.sourceRef.sha256 = sha(prior.sourceBytes);
    await fs.writeFile(path.join(workspaceDir, prior.sourceRef.path), prior.sourceBytes);
    const native = JSON.parse(prior.receiptBytes) as typeof prior.receipt;
    native.sourceReview.source = prior.sourceRef;
    prior.receiptBytes = `${JSON.stringify(native, null, 2)}\n`;
    prior.receiptRef.sha256 = sha(prior.receiptBytes);
    await fs.writeFile(path.join(workspaceDir, prior.receiptRef.path), prior.receiptBytes);
  }
  const correctionPath = prior.receipt.hands.memoryCleaner.relativePath.split(path.sep).join("/");
  const correctionBytes = await fs.readFile(prior.receipt.hands.memoryCleaner.path, "utf8");
  const correctionRef = { path: correctionPath, sha256: sha(correctionBytes) };
  if (options.fault === "missing_memory") {
    await fs.unlink(prior.receipt.hands.memoryCleaner.path);
  }
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          enabled: true,
          store: { path: path.join(workspaceDir, "state/private-artifacts.sqlite") },
        },
      },
    },
  };
  const registry = createCentralToolRegistry({ workspaceDir, config });
  const memoryGet = registry.get("memory_get");
  const recall = registry.get("artifact_memory_recall");
  assert.ok(memoryGet && recall, "actual original read tools must be registered");
  const readArgs = {
    path: correctionPath,
    from: 1,
    lines: options.fault === "partial_range" ? 2 : 80,
  };
  assert.equal(memoryGet.approve(readArgs).ok, true);
  // A real private host observation, separate from the old source and candidate account runs.
  const memoryObservationRunId = `private-memory-observation-${randomUUID()}`;
  const memoryResult = await memoryGet.execute(readArgs, new AbortController().signal, {
    runId: memoryObservationRunId,
  });
  const artifact = memoryResult.artifactEvidence as ArtifactRecordingReceipt;
  assert.equal(artifact.status, "registered");
  assert.ok(artifact.id && artifact.sha256 && artifact.relativePath);
  const artifactOriginalBytes = await fs.readFile(path.join(workspaceDir, artifact.relativePath));
  if (options.fault === "artifact_hash") {
    await fs.appendFile(path.join(workspaceDir, artifact.relativePath), "\n");
  }
  const recallArgs = { action: "read", id: artifact.id, field: "/value/text" };
  assert.equal(recall.approve(recallArgs).ok, true);
  const deliveredRecall = await recall.execute(recallArgs, new AbortController().signal);
  if (options.fault === "old_file_changed") {
    await fs.appendFile(prior.receipt.hands.memoryCleaner.path, "\n");
  } else if (options.fault === "old_source_missing") {
    await fs.unlink(path.join(workspaceDir, prior.sourceRef.path));
  }
  const memoryRecallInput: MemoryRecallInput = {
    memoryRecall: {
      previousReceipt: prior.receiptRef,
      correction: correctionRef,
      artifact: { id: artifact.id, sha256: artifact.sha256 },
      from: readArgs.from,
      lines: readArgs.lines,
    },
    expectedMemoryScope:
      options.fault === "missing_host"
        ? undefined
        : {
            accountId:
              options.fault === "account_scope" ? "different-private-account" : scope.accountId,
            runId: options.fault === "run_scope" ? "different-old-rule-run" : scope.runId,
          },
    artifactStorePath: "state/private-artifacts.sqlite",
  };
  const current = await writeCandidate(
    currentScope,
    currentRule,
    "current",
    options.before ? undefined : memoryRecallInput,
  );
  const oldReferences = [
    prior.receiptRef,
    prior.sourceRef,
    correctionRef,
    { path: artifact.relativePath, sha256: artifact.sha256 },
  ];
  const bodyReads = await Promise.all(
    [
      current.receipt.hands.memoryCleaner.path,
      current.receipt.hands.trainingCaseBuilder.path,
      current.receipt.hands.patchCandidateBuilder.path,
    ].map(async (bodyPath) => ({
      path: bodyPath,
      bytes: await fs.readFile(bodyPath, "utf8").catch(() => undefined),
    })),
  );
  let reviewInput: Awaited<ReturnType<typeof readSelfRepairCandidateReviewInput>> | undefined;
  let reviewReadError: string | undefined;
  if (!options.before && current.receipt.status === "write_completed") {
    if (options.fault === "downstream_artifact_hash") {
      await fs.appendFile(path.join(workspaceDir, artifact.relativePath), "\n");
    }
    try {
      reviewInput = await readSelfRepairCandidateReviewInput({
        workspaceDir,
        receipt: current.receiptRef,
        scope: currentScope,
        expectedMemoryScope:
          options.fault === "downstream_host_missing"
            ? undefined
            : memoryRecallInput.expectedMemoryScope,
        artifactStorePath: memoryRecallInput.artifactStorePath,
      });
    } catch (error) {
      reviewReadError = error instanceof Error ? error.message : String(error);
    }
  }
  const oldReferenceReadback = await Promise.all(
    oldReferences.map(async (reference) => ({
      ...reference,
      actualSha256: await fs
        .readFile(path.join(workspaceDir, reference.path))
        .then(sha)
        .catch(() => undefined),
    })),
  );
  const sourcePaths = [
    "scripts/operator/lcx-self-repair-hands.ts",
    "src/agents/self-repair-source-review.ts",
    "src/agents/self-repair-candidate-review.ts",
    "src/agents/central-harness/tool-registry.ts",
    "src/agents/artifact-result-recording.ts",
    "src/agents/tools/memory-tool.ts",
    "src/agents/tools/artifact-memory-recall-tool.ts",
    "src/memory/artifact-store.ts",
  ];
  const sourcePins = await Promise.all(
    sourcePaths.map(async (sourcePath) => ({
      path: sourcePath,
      sha256: sha(await fs.readFile(path.join(repo, sourcePath))),
    })),
  );
  const proof = {
    fault: options.fault,
    historicalFault: options.historicalFault,
    phase: options.before ? "before_missing_consumer" : "after_original_prewrite_consumer",
    workspaceDir,
    oldRule,
    currentRule,
    scope,
    currentScope,
    prior,
    correctionRef,
    correctionBytes,
    toolRegistration: [memoryGet.ownerId, recall.ownerId],
    readArgs,
    memoryObservationRunId,
    memoryResult,
    artifact,
    artifactOriginalBytes: artifactOriginalBytes.toString("utf8"),
    artifactActualSha256: sha(artifactOriginalBytes),
    recallArgs,
    deliveredRecall,
    memoryRecallInput,
    current,
    oldReferences,
    oldReferenceReadback,
    bodyReads,
    reviewInput,
    reviewReadError,
    currentReceiptBytesAfterReview: await fs.readFile(current.receipt.latestJsonPath, "utf8"),
    sourcePins,
    boundary:
      "Actual original source-bound private candidate writer -> actual registered memory_get (host-only direct filesystem read) -> original registration wrapper recordAgentArtifact -> actual registered artifact_memory_recall /value/text. Before invokes current writer without the missing prewrite consumer; after passes explicit original sourceReview optional recall refs and independent old host scope to actual original writer, then actual candidate quality input reader. No model/quality execution or semantic adjudication. Account/source-run/current-attempt are distinct private fixture host inputs; hashes/reference checks never prove source truth or which rule is correct. No provider/search index initialization/real protected memory/automation/owner stack.",
  };
  await fs.writeFile(
    path.join(options.directory, "prewrite-proof.json"),
    JSON.stringify(proof, null, 2),
  );
  return proof;
}

/** Actual failed no-adapter review writer followed by the original default safe CLI reader. */
export async function readOriginalPrewriteContentReview(
  proof: Awaited<ReturnType<typeof produceOriginalPrewriteRecall>>,
  reviewOptions?: Pick<
    Parameters<typeof reviewSelfRepairCandidate>[0],
    "qualityOptions" | "timeoutMs"
  >,
) {
  const host = {
    workspaceDir: proof.workspaceDir,
    receipt: {
      path: path.relative(proof.workspaceDir, proof.current.receipt.latestJsonPath),
      sha256: sha(proof.current.receiptBytes),
    },
    scope: proof.currentScope,
    expectedMemoryScope: proof.memoryRecallInput.expectedMemoryScope,
    artifactStorePath: proof.memoryRecallInput.artifactStorePath,
  };
  const reviewed = await reviewSelfRepairCandidate({ ...host, ...reviewOptions });
  await writeSelfRepairContentReviewReceipt(host, reviewed);
  const sidecarPath = path.join(
    proof.workspaceDir,
    "state/lcx-self-repair-content-review-latest.json",
  );
  const sidecarBefore = await fs.readFile(sidecarPath, "utf8");
  const baseArgv = [
    "--import",
    "tsx",
    path.join(repo, "scripts/operator/lcx-self-repair-hands.ts"),
    "--workspace-dir",
    proof.workspaceDir,
    "--json",
    "--review-account-id",
    proof.currentScope.accountId,
    "--review-run-id",
    proof.currentScope.runId,
  ];
  assert.ok(host.expectedMemoryScope);
  const completeArgv = [
    ...baseArgv,
    "--memory-source-run-id",
    host.expectedMemoryScope.runId,
    "--artifact-store-path",
    host.artifactStorePath,
  ];
  const complete = await exec(process.execPath, completeArgv, { cwd: repo, timeout: 30_000 });
  const missingHost = await exec(process.execPath, baseArgv, { cwd: repo, timeout: 30_000 });
  const result = {
    host,
    reviewed,
    sidecarBefore,
    complete: {
      argv: completeArgv,
      ...complete,
      parsed: JSON.parse(complete.stdout) as {
        contentReview: { status: string; gaps: string[]; receiptPath: string };
      },
    },
    missingHost: {
      argv: baseArgv,
      ...missingHost,
      parsed: JSON.parse(missingHost.stdout) as {
        contentReview: { status: string; gaps: string[]; receiptPath: string };
      },
    },
    sidecarAfter: await fs.readFile(sidecarPath, "utf8"),
    rootAfter: await fs.readFile(proof.current.receipt.latestJsonPath, "utf8"),
    boundary:
      "Actual no-adapter quality failure, original review writer, two original readonly CLI host modes; no provider/model/config or semantic adoption claim.",
  };
  await fs.writeFile(
    path.join(path.dirname(proof.workspaceDir), "content-review-readback-proof.json"),
    JSON.stringify(result, null, 2),
  );
  return result;
}

/** One private attempt's original prewrite, review, governance observation and diagnostic return.
 * The old memory source run, current candidate attempt and governance observation remain distinct.
 */
export async function probeOriginalSelfRepairSameAttempt(options: {
  directory: string;
  scenario: "read" | "missing_memory" | "review_timeout";
  observeNextFeedback?: boolean;
}) {
  const produced = await produceOriginalPrewriteRecall({
    directory: options.directory,
    fault: options.scenario === "missing_memory" ? "missing_memory" : undefined,
    useCli: options.scenario !== "missing_memory",
  });
  const reviewCalls: Array<{ request: unknown; abortObserved: boolean }> = [];
  let reviewed: Awaited<ReturnType<typeof readOriginalPrewriteContentReview>> | undefined;
  if (produced.current.receipt.status === "write_completed") {
    reviewed = await readOriginalPrewriteContentReview(
      produced,
      options.scenario === "review_timeout"
        ? {
            timeoutMs: 25,
            qualityOptions: {
              modelInvoker: async (request, signal) => {
                const call = { request, abortObserved: signal.aborted };
                reviewCalls.push(call);
                signal.addEventListener(
                  "abort",
                  () => {
                    call.abortObserved = true;
                  },
                  { once: true },
                );
                // Only this lowest model response seam is uncooperative. No fake quality receipt.
                await new Promise<void>((resolve) => setTimeout(resolve, 75));
                return {};
              },
            },
          }
        : undefined,
    );
  }
  const args = [
    "--workspace-dir",
    produced.workspaceDir,
    "--json",
    "--review-account-id",
    produced.currentScope.accountId,
    "--review-run-id",
    produced.currentScope.runId,
    "--memory-source-run-id",
    produced.scope.runId,
    "--artifact-store-path",
    produced.memoryRecallInput.artifactStorePath,
  ];
  const argv = [
    "--import",
    "tsx",
    path.join(repo, "scripts/operator/lcx-self-repair-hands.ts"),
    ...args,
  ];
  const cliOutput = await exec(process.execPath, argv, { cwd: repo, timeout: 30_000 });
  const cli = { argv, ...cliOutput, exitCode: 0 };
  const readback = JSON.parse(cli.stdout) as Record<string, unknown>;
  const consumed = await consumeGovernance(readback, cli, produced.workspaceDir, false, args);
  assert.ok(consumed.governancePath);
  const mapPath = path.join(produced.workspaceDir, "state/readback-observation-map.json");
  const mapBytes = await fs.readFile(mapPath, "utf8");
  const governanceBytes = await fs.readFile(consumed.governancePath, "utf8");
  const request = {
    schemaVersion: 1,
    map: { path: path.relative(produced.workspaceDir, mapPath), sha256: sha(mapBytes) },
    governance: {
      path: path.relative(produced.workspaceDir, consumed.governancePath),
      sha256: sha(governanceBytes),
    },
    itemId: "self_repair_memory_and_training_candidate_hands",
  };
  const host = {
    schemaVersion: 1,
    sourceRunId: consumed.parentRunId,
    snapshot: consumed.snapshot,
    nowMs: Date.now(),
  };
  const requestPath = path.join(produced.workspaceDir, "state/same-attempt-feedback-request.json");
  const hostPath = path.join(produced.workspaceDir, "state/same-attempt-feedback-host.json");
  await fs.writeFile(requestPath, JSON.stringify(request, null, 2) + "\n");
  await fs.writeFile(hostPath, JSON.stringify(host, null, 2) + "\n");
  const feedbackArgv = [
    "--import",
    "tsx",
    path.join(repo, "scripts/operator/lcx-self-repair-hands.ts"),
    "--workspace-dir",
    produced.workspaceDir,
    "--json",
    "--signal-key",
    "explicit-same-attempt-diagnostic-observation",
    "--observed-failure",
    "Observe this attempt's original diagnostic without authorizing candidate reuse.",
    "--replacement-rule",
    produced.currentRule,
    "--owner-map-feedback",
    requestPath,
    "--feedback-host",
    hostPath,
  ];
  const feedback = await exec(process.execPath, feedbackArgv, { cwd: repo, timeout: 30_000 });
  let nextFeedback:
    | {
        receipt: { path: string; sha256: string; pointer: string };
        completed: ReturnType<typeof buildSelfRepairHandsReceipt>;
      }
    | undefined;
  if (options.observeNextFeedback) {
    const currentRootBytes = await fs.readFile(produced.current.receipt.latestJsonPath);
    const diagnostic = await readSelfRepairOwnerMapFeedback(produced.workspaceDir, request, host);
    assert.equal(diagnostic.status, "read");
    const next = buildSelfRepairHandsReceipt({
      checkedAt: new Date().toISOString(),
      workspaceDir: produced.workspaceDir,
      signalKey: `private-next-diagnostic-${randomUUID()}`,
      issue: "next_candidate_consumes_original_owner_diagnostic",
      observedFailure: `Explicit next diagnostic candidate.\n${diagnostic.diagnostic}`,
      replacementRule: produced.currentRule,
      domain: "private_diagnostic_feedback",
      write: true,
      diagnosticFeedback: diagnostic,
      diagnosticFeedbackRequest: { request, host },
    });
    // Only private publication paths are isolated; the original writer and allowlist run unchanged.
    next.latestJsonPath = path.join(produced.workspaceDir, "state/next-diagnostic-latest.json");
    next.latestMarkdownPath = path.join(produced.workspaceDir, "state/next-diagnostic-latest.md");
    next.jsonlPath = path.join(produced.workspaceDir, "logs/next-diagnostic.jsonl");
    await writeSelfRepairHandsReceipt(next);
    const nextBytes = await fs.readFile(next.latestJsonPath);
    assert.deepEqual(await fs.readFile(produced.current.receipt.latestJsonPath), currentRootBytes);
    assert.equal(await fs.readFile(mapPath, "utf8"), mapBytes);
    assert.equal(await fs.readFile(consumed.governancePath, "utf8"), governanceBytes);
    nextFeedback = {
      receipt: { path: next.latestJsonPath, sha256: sha(nextBytes), pointer: "" },
      completed: next,
    };
  }
  const rootAfter = await fs.readFile(produced.current.receipt.latestJsonPath, "utf8");
  const reviewAfter = reviewed
    ? await fs.readFile(
        path.join(produced.workspaceDir, "state/lcx-self-repair-content-review-latest.json"),
        "utf8",
      )
    : undefined;
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  const cliPath = path.join(options.directory, "same-attempt-cli-readback.json");
  const feedbackPath = path.join(options.directory, "same-attempt-feedback-readback.json");
  await fs.writeFile(cliPath, cli.stdout);
  await fs.writeFile(feedbackPath, feedback.stdout);
  const ref = async (filePath: string, pointer: string) => ({
    path: filePath,
    sha256: sha(await fs.readFile(filePath, "utf8")),
    pointer,
  });
  const nativeRoot = produced.current.receipt.latestJsonPath;
  assert.ok(produced.artifact.relativePath, "original registered artifact path missing");
  const artifactPath = path.join(produced.workspaceDir, produced.artifact.relativePath);
  const latest = (pointer: string) => ref(nativeRoot, pointer);
  const currentScope = await latest("/sourceReview/scope");
  const mapRef = (pointer: string) => ref(mapPath, pointer);
  const governanceRef = (pointer: string) => ref(consumed.governancePath!, pointer);
  const nodes: WorkflowHandoffEvidence["nodes"] = [
    {
      nodeId: "memory_recall",
      scope: await ref(artifactPath, "/runId"),
      output: await ref(artifactPath, "/value/text"),
    },
    {
      nodeId: "source_conflict_review",
      scope: currentScope,
      output: await latest("/sourceReview"),
      ...(options.scenario === "missing_memory"
        ? {}
        : {
            inputs: [
              {
                from: "memory_recall" as const,
                value: await latest("/sourceReview/memoryRecall/selectedText"),
              },
            ],
          }),
    },
    { nodeId: "self_repair_hands", scope: currentScope, output: await latest("/hands") },
    { nodeId: "memory_write_gate", scope: currentScope, output: await latest("/status") },
    {
      nodeId: "self_repair_memory_cleaner",
      scope: currentScope,
      output: await latest("/hands/memoryCleaner"),
    },
    {
      nodeId: "correction_note",
      scope: currentScope,
      output: await latest("/hands/memoryCleaner/correctionMarkdown"),
    },
    {
      nodeId: "stale_memory_downrank",
      scope: currentScope,
      output: await latest("/hands/memoryCleaner/memoryTier"),
    },
    {
      nodeId: "self_repair_training_case_builder",
      scope: currentScope,
      output: await latest("/hands/trainingCaseBuilder"),
    },
    {
      nodeId: "training_eval_candidate_packet",
      scope: currentScope,
      output: await latest("/hands/trainingCaseBuilder/candidate"),
    },
    {
      nodeId: "self_repair_latest_receipt",
      scope: await ref(cliPath, "/latestWrittenReceipt/sourceReview/scope"),
      output: await ref(cliPath, "/latestWrittenReceipt"),
    },
    {
      nodeId: "governance_autopilot",
      scope: await governanceRef("/snapshot"),
      output: await governanceRef("/runReceipt"),
      inputs: [
        {
          from: "self_repair_latest_receipt",
          value: await governanceRef("/owners/selfRepairHands/latestWrittenReceipt"),
        },
      ],
    },
    {
      nodeId: "owner_coverage_map",
      scope: await mapRef("/snapshot"),
      output: await mapRef("/items"),
      inputs: [{ from: "governance_autopilot", value: await mapRef("/runReceipt") }],
    },
  ];
  if (reviewed) {
    const reviewPath = path.join(
      produced.workspaceDir,
      "state/lcx-self-repair-content-review-latest.json",
    );
    nodes.push({
      nodeId: "review_panel",
      scope: await ref(reviewPath, "/scope"),
      output: await ref(reviewPath, "/status"),
      inputs: [{ from: "training_eval_candidate_packet", value: await ref(reviewPath, "/inputs") }],
    });
  }
  const actualNodes =
    produced.current.receipt.status === "write_completed"
      ? nodes
      : nodes.filter((node) =>
          [
            "memory_recall",
            "source_conflict_review",
            "self_repair_hands",
            "memory_write_gate",
            "self_repair_latest_receipt",
            "governance_autopilot",
            "owner_coverage_map",
          ].includes(node.nodeId),
        );
  // A blocked writer's planned body is not an actual written candidate. The audit
  // intentionally keeps omitted consumer/phase and cross-run identity gaps.
  const auditInput: WorkflowHandoffEvidence[] = [
    {
      scenarioId: "self_repair_hands_waterflow",
      environment: "offline_fixture",
      nodes: actualNodes,
      ...(nextFeedback
        ? {
            feedbackReads: [
              {
                kind: "self_repair_diagnostic" as const,
                from: "owner_coverage_map" as const,
                to: "self_repair_hands" as const,
                receipt: nextFeedback.receipt,
              },
            ],
          }
        : {}),
    },
  ];
  const audit = await auditWorkflowHandoffs(auditInput);
  const scenarioAudit = audit.find((entry) => entry.scenarioId === "self_repair_hands_waterflow");
  await fs.writeFile(
    path.join(options.directory, "same-attempt-audit-input.json"),
    JSON.stringify(auditInput, null, 2) + "\n",
  );
  await fs.writeFile(
    path.join(options.directory, "same-attempt-audit.json"),
    JSON.stringify(scenarioAudit, null, 2) + "\n",
  );
  const result = {
    scenario: options.scenario,
    produced,
    reviewed,
    reviewCalls,
    cli,
    readback,
    consumed,
    mapPath,
    mapBytes,
    governanceBytes,
    request,
    host,
    nextFeedback,
    feedback: {
      argv: feedbackArgv,
      ...feedback,
      parsed: JSON.parse(feedback.stdout) as Record<string, unknown>,
    },
    rootAfter,
    rootAfterLate: await fs.readFile(produced.current.receipt.latestJsonPath, "utf8"),
    auditInput,
    scenarioAudit,
    reviewAfter,
    reviewAfterLate: reviewed
      ? await fs.readFile(
          path.join(produced.workspaceDir, "state/lcx-self-repair-content-review-latest.json"),
          "utf8",
        )
      : undefined,
    boundary:
      "Actual original registered memory source delivery, explicit prewrite writer, original candidate review and safe CLI readback, actual isolated runOwner child/capture, original partial governance receipt expressions/writer, original owner map builder/writer and readonly feedback consumer. Only selfRepairHands owner selected; missing siblings preserve original governance blocked status. No natural parent loop, model/provider/service/training/protected memory. Old source run is historical reference, current candidate scope stays independent, governance host is a later observation. Review no-adapter or timed-out model response remains failed, never semantic acceptance.",
  };
  await fs.writeFile(
    path.join(options.directory, "same-attempt-proof.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return result;
}
