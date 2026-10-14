import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import { buildOwnerControlMap } from "../../scripts/operator/lcx-owner-control-map.js";
import {
  writeSelfRepairContentReviewReceipt,
  type SelfRepairHandsReceipt,
} from "../../scripts/operator/lcx-self-repair-hands.js";
import { buildQualityHarnessModelPromptWithCoverage } from "../../src/agents/local-text-model-adapter.js";
import type {
  LogicalAgentModelAdapter,
  LogicalAgentModelRouting,
  ModelCallObservation,
} from "../../src/agents/logical-agent-model-router.js";
import type {
  QualityHarnessModelRequest,
  QualityHarnessStageOutput,
} from "../../src/agents/quality-harness.js";
import {
  inspectSelfRepairCandidateReview,
  readSelfRepairCandidateReviewInput,
  reviewSelfRepairCandidate,
} from "../../src/agents/self-repair-candidate-review.js";

const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "../..");
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
export type SelfRepairContentReviewFault =
  | "source_missing"
  | "source_hash"
  | "receipt_hash"
  | "body_mismatch"
  | "scope"
  | "quality_reject"
  | "coverage_missing"
  | "cli_no_adapter"
  | "cli_source_gap"
  | "cli_scope_unavailable"
  | "cli_internal_alias"
  | "cli_external_escape"
  | "timeout"
  | "old_review";

async function produce(workspace: string, replacementRule: string, name: string) {
  await fs.mkdir(path.join(workspace, "state"), { recursive: true });
  const scope = { accountId: "private-review-paper", runId: "private-review-attempt" };
  const sourceBody = `${JSON.stringify(
    {
      scope,
      observedAt: new Date(Date.now() - 1000).toISOString(),
      replacementRule,
      trust: "private synthetic input; not source truth",
    },
    null,
    2,
  )}\n`;
  const sourcePath = path.join(workspace, "state/source.json");
  const manifestPath = path.join(workspace, "state/source-review.json");
  await fs.writeFile(sourcePath, sourceBody);
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      source: { path: "state/source.json", sha256: sha(sourceBody) },
    }),
  );
  const argv = [
    "--import",
    "tsx",
    path.join(repo, "scripts/operator/lcx-self-repair-hands.ts"),
    "--workspace-dir",
    workspace,
    "--write",
    "--json",
    "--source-review",
    manifestPath,
    "--review-account-id",
    scope.accountId,
    "--review-run-id",
    scope.runId,
    "--replacement-rule",
    replacementRule,
    "--signal-key",
    name,
  ];
  const cli = await exec(process.execPath, argv, { cwd: repo, timeout: 30000 });
  const writer = JSON.parse(cli.stdout) as SelfRepairHandsReceipt;
  assert.equal(writer.status, "write_completed");
  assert.equal(writer.sourceReview.status, "verified_reference_candidate_only");
  const receiptBytes = await fs.readFile(writer.latestJsonPath, "utf8");
  const receiptRef = {
    path: path.relative(workspace, writer.latestJsonPath),
    sha256: sha(receiptBytes),
  };
  // Exact independent disk readback bytes retained before the next original writer refreshes latest.
  await fs.writeFile(path.join(workspace, `state/native-${name}-receipt.json`), receiptBytes);
  const bodies = {
    correction: await fs.readFile(writer.hands.memoryCleaner.path, "utf8"),
    training: await fs.readFile(writer.hands.trainingCaseBuilder.path, "utf8"),
    patch: await fs.readFile(writer.hands.patchCandidateBuilder.path, "utf8"),
  };
  return { argv, cli, writer, receiptBytes, receiptRef, sourceBody, sourcePath, scope, bodies };
}

async function originalCompact(payload: Record<string, unknown>) {
  const sourcePath = path.join(repo, "scripts/operator/lcx-governance-autopilot.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const names = ["recordValue", "arrayValue", "stringArray", "compactOwner"];
  const functions = ast.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text),
  );
  assert.equal(functions.length, names.length);
  const code = `${functions.map((node) => node.getText(ast)).join("\n")}\ncompactOwner("selfRepairHands", payload)`;
  return {
    compact: vm.runInNewContext(
      ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
      { payload, JSON },
    ) as Record<string, unknown>,
    sourceSha256: sha(source),
  };
}

function response(request: QualityHarnessModelRequest, reject: boolean): QualityHarnessStageOutput {
  if (request.stage === "intake") {
    return {
      kind: "plan",
      requirements: ["Review actual candidate bodies and disclose reuse gaps"],
      missingEvidence: [],
    };
  }
  if (request.stage === "draft" || request.stage === "format") {
    return {
      kind: "artifact",
      artifact: {
        answer:
          "These remain provisional candidates; source consistency grants no replacement, ranking, training or trade authority.",
        claims: [
          {
            id: "source-rule",
            text: "The supplied private source declares a replacement rule; its correctness remains unproven.",
            status: "supported",
            evidenceIds: ["self-repair-source"],
          },
        ],
      },
    };
  }
  return {
    kind: "review",
    review: {
      verdict: reject && request.stage === "adversarial" ? "reject" : "pass",
      criticalFindings:
        reject && request.stage === "adversarial"
          ? ["private scripted reviewer rejects unsupported candidate semantics"]
          : [],
      evidenceGaps: [],
      notes: request.evidence.map(
        (entry) =>
          `[${entry.id}] private scripted review of supplied packet; natural semantic review not proved`,
      ),
    },
  };
}

/** Actual original writer -> exact persisted bodies -> existing ten-stage quality harness; model invocation only is scripted. */
export async function probeOriginalSelfRepairContentReview(params: {
  directory: string;
  fault?: SelfRepairContentReviewFault;
}) {
  const workspaceDir = path.join(params.directory, "workspace");
  const produced = await produce(
    workspaceDir,
    "Require fresh scoped evidence before provisional candidate reuse.",
    "A",
  );
  const requests: QualityHarnessModelRequest[] = [];
  const responses: { request: QualityHarnessModelRequest; output: QualityHarnessStageOutput }[] =
    [];
  let lateAttempted = false;
  let delayedAdapterEnteredAtMs: number | undefined;
  let delayedAdapterCompletedAtMs: number | undefined;
  let lateCompletion: Promise<void> | undefined;
  const invoke = async (
    request: QualityHarnessModelRequest,
  ): Promise<QualityHarnessStageOutput> => {
    requests.push(request);
    if (params.fault === "timeout" && requests.length === 1) {
      delayedAdapterEnteredAtMs = performance.now();
      await new Promise<void>((resolve) => {
        lateCompletion = new Promise<void>((settled) => {
          setTimeout(() => {
            lateAttempted = true;
            resolve();
            settled();
          }, 4000);
        });
      });
      delayedAdapterCompletedAtMs = performance.now();
    }
    const output = response(request, params.fault === "quality_reject");
    responses.push({ request, output });
    return output;
  };
  const promptReads: Array<{
    callId: string;
    prompt: string;
    evidenceCoverage: ModelCallObservation["evidenceCoverage"];
  }> = [];
  const observations = new Map<string, ModelCallObservation["evidenceCoverage"]>();
  const adapter: LogicalAgentModelAdapter = {
    id: "private-scripted-self-repair-review",
    provider: "fixture",
    modelId: "private-scripted-review",
    mode: "adapter",
    capabilities: ["quality_harness"],
    requiredTools: [],
    requiredSideEffects: [],
    invoke: async (call) => {
      const request = call.payload as QualityHarnessModelRequest;
      const rendered = buildQualityHarnessModelPromptWithCoverage(request);
      observations.set(call.callId, rendered.evidenceCoverage);
      promptReads.push({ callId: call.callId, ...rendered });
      return invoke(request);
    },
    observe: (call) => ({
      callId: call.callId,
      provider: "fixture",
      modelId: "private-scripted-review",
      transportRequestId: `private-scripted:${call.callId}`,
      kind: "model_inference",
      evidenceCoverage: observations.get(call.callId),
    }),
  };
  const routing: LogicalAgentModelRouting = {
    revision: "private-self-repair-review-v1",
    adapters: [adapter],
    defaultPolicy: {
      primary: adapter.id,
      requiredCapabilities: ["quality_harness"],
      maxInputBytes: 1_000_000,
      timeoutMs: params.fault === "timeout" ? 6_000 : 1_000,
    },
  };
  if (params.fault === "source_missing") {
    await fs.unlink(produced.sourcePath);
  }
  if (params.fault === "source_hash") {
    await fs.appendFile(produced.sourcePath, " ");
  }
  if (params.fault === "body_mismatch") {
    await fs.appendFile(produced.writer.hands.memoryCleaner.path, "changed actual candidate\n");
  }
  const host = {
    workspaceDir,
    receipt: {
      ...produced.receiptRef,
      sha256: params.fault === "receipt_hash" ? "0".repeat(64) : produced.receiptRef.sha256,
    },
    scope: {
      ...produced.scope,
      accountId: params.fault === "scope" ? "other-account" : produced.scope.accountId,
    },
  };
  const reviewed = await reviewSelfRepairCandidate({
    ...host,
    timeoutMs: params.fault === "timeout" ? 2000 : 10000,
    qualityOptions: {
      ...(params.fault === "coverage_missing"
        ? { modelInvoker: (raw: unknown) => invoke(raw as QualityHarnessModelRequest) }
        : { modelRouting: routing }),
      modelId: "private-scripted-review",
      taskTimeoutMs: params.fault === "timeout" ? 6000 : 1000,
      createRunId: () => "private-native-quality-A",
    },
  });
  const reviewReturnedAtMs = performance.now();
  const terminalBytes = JSON.stringify(reviewed);
  const reviewPath = path.join(workspaceDir, "state/lcx-self-repair-content-review-latest.json");
  await writeSelfRepairContentReviewReceipt(host, reviewed);
  const persistedReviewBytes = await fs.readFile(reviewPath, "utf8");
  const persistedReview = JSON.parse(persistedReviewBytes) as typeof reviewed;
  let cliReview: { stdout: string; stderr: string } | undefined;
  let safeReader: { stdout: string; stderr: string } | undefined;
  let compact: Record<string, unknown> | undefined;
  let ownerMap: ReturnType<typeof buildOwnerControlMap> | undefined;
  let governanceSourceSha256: string | undefined;
  let writeFault:
    | {
        error: string;
        stdout: string;
        stderr: string;
        exitCode?: number;
        target: string;
        before: string;
        after: string;
      }
    | undefined;
  const prefix = [
    "--import",
    "tsx",
    path.join(repo, "scripts/operator/lcx-self-repair-hands.ts"),
    "--workspace-dir",
    workspaceDir,
    "--json",
    "--review-account-id",
    produced.scope.accountId,
    "--review-run-id",
    produced.scope.runId,
  ];
  if (params.fault?.startsWith("cli_")) {
    const manifestPath = path.join(workspaceDir, "state/content-review-manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify({ receipt: produced.receiptRef }));
    const reviewArgv = [...prefix, "--candidate-review", manifestPath, "--write"];
    if (params.fault === "cli_internal_alias" || params.fault === "cli_external_escape") {
      const target =
        params.fault === "cli_internal_alias"
          ? produced.writer.latestJsonPath
          : path.join(params.directory, "external-private-sentinel.json");
      if (params.fault === "cli_external_escape") {
        await fs.writeFile(target, "private external sentinel must remain unchanged\n");
      }
      const before = await fs.readFile(target, "utf8");
      await fs.unlink(reviewPath);
      await fs.symlink(
        target,
        path.join(workspaceDir, "state/lcx-self-repair-content-review-latest.json"),
      );
      let error = "";
      let stdout = "";
      let stderr = "";
      let exitCode: number | undefined;
      try {
        await exec(process.execPath, reviewArgv, { cwd: repo, timeout: 30000 });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        if (typeof caught === "object" && caught !== null) {
          const failure = caught as { stdout?: unknown; stderr?: unknown; code?: unknown };
          stdout = typeof failure.stdout === "string" ? failure.stdout : "";
          stderr = typeof failure.stderr === "string" ? failure.stderr : "";
          exitCode = typeof failure.code === "number" ? failure.code : undefined;
        }
      }
      writeFault = {
        error,
        stdout,
        stderr,
        exitCode,
        target,
        before,
        after: await fs.readFile(target, "utf8"),
      };
    } else {
      cliReview = await exec(process.execPath, reviewArgv, { cwd: repo, timeout: 30000 });
      if (params.fault === "cli_source_gap") {
        await fs.unlink(produced.sourcePath);
      }
      const readerArgv = params.fault === "cli_scope_unavailable" ? prefix.slice(0, -4) : prefix;
      safeReader = await exec(process.execPath, readerArgv, { cwd: repo, timeout: 30000 });
    }
  }
  if (!params.fault || params.fault === "old_review") {
    safeReader = await exec(process.execPath, prefix, { cwd: repo, timeout: 30000 });
  }
  if (safeReader) {
    const projected = await originalCompact(
      JSON.parse(safeReader.stdout) as Record<string, unknown>,
    );
    compact = projected.compact;
    governanceSourceSha256 = projected.sourceSha256;
    ownerMap = buildOwnerControlMap({
      checkedAt: new Date().toISOString(),
      governance: { owners: { selfRepairHands: compact } },
      localFailureTrace: {},
      paths: {
        latestJsonPath: path.join(workspaceDir, "state/private-map.json"),
        latestMarkdownPath: path.join(workspaceDir, "state/private-map.md"),
        sourcePaths: [produced.writer.latestJsonPath],
      },
    });
  }
  let revised: Awaited<ReturnType<typeof produce>> | undefined;
  let revisedInput: Awaited<ReturnType<typeof readSelfRepairCandidateReviewInput>> | undefined;
  let oldInspection: ReturnType<typeof inspectSelfRepairCandidateReview> | undefined;
  let oldWriteRejection:
    | {
        error: string;
        sidecarBeforeBytes: string;
        sidecarAfterBytes: string;
        rootBeforeBytes: string;
        rootAfterBytes: string;
      }
    | undefined;
  if (params.fault === "old_review") {
    revised = await produce(
      workspaceDir,
      "Require fresh evidence and a completed adjacent application before reuse.",
      "B",
    );
    revisedInput = await readSelfRepairCandidateReviewInput({
      workspaceDir,
      receipt: revised.receiptRef,
      scope: revised.scope,
    });
    oldInspection = inspectSelfRepairCandidateReview(revisedInput, persistedReview);
    const sidecarBeforeBytes = await fs.readFile(reviewPath, "utf8");
    const rootBeforeBytes = await fs.readFile(revised.writer.latestJsonPath, "utf8");
    let error = "";
    try {
      await writeSelfRepairContentReviewReceipt(
        {
          workspaceDir,
          receipt: revised.receiptRef,
          scope: revised.scope,
        },
        persistedReview,
      );
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    oldWriteRejection = {
      error,
      sidecarBeforeBytes,
      sidecarAfterBytes: await fs.readFile(reviewPath, "utf8"),
      rootBeforeBytes,
      rootAfterBytes: await fs.readFile(revised.writer.latestJsonPath, "utf8"),
    };
  }
  if (lateCompletion) {
    await lateCompletion;
  }
  const proof = {
    fault: params.fault,
    produced,
    host,
    requests,
    promptReads,
    responses,
    reviewed,
    persistedReview,
    persistedReviewBytes,
    reviewWriter: {
      owner: "writeSelfRepairContentReviewReceipt",
      host,
      receiptPath: reviewPath,
      receiptSha256: sha(persistedReviewBytes),
    },
    persistedReviewSha256: sha(persistedReviewBytes),
    terminalUnchangedAfterLateCompletion: terminalBytes === JSON.stringify(reviewed),
    lateAttempted,
    delayedAdapterEnteredAtMs,
    delayedAdapterCompletedAtMs,
    reviewReturnedAtMs,
    timeoutFixture:
      params.fault === "timeout"
        ? { reviewDeadlineMs: 2000, adapterDelayMs: 4000, taskDeadlineMs: 6000 }
        : undefined,
    revised,
    revisedInput,
    oldInspection,
    oldWriteRejection,
    cliReview,
    safeReader,
    writeFault,
    compact,
    ownerMap,
    governanceSourceSha256,
    candidateRootUnchangedAfterCli:
      (await fs.readFile(produced.writer.latestJsonPath, "utf8")) ===
      (revised?.receiptBytes ?? produced.receiptBytes),
    sourceHashes: {
      writer: sha(
        await fs.readFile(path.join(repo, "scripts/operator/lcx-self-repair-hands.ts"), "utf8"),
      ),
      reviewOwner: sha(
        await fs.readFile(path.join(repo, "src/agents/self-repair-candidate-review.ts"), "utf8"),
      ),
      qualityHarness: sha(
        await fs.readFile(path.join(repo, "src/agents/quality-harness.ts"), "utf8"),
      ),
    },
    boundary:
      "Actual private original writer CLI, pin/scope/body readback and existing quality harness; only modelRouting adapter responses scripted; actual canonical prompt/coverage renderer used, adapter observations are fixture attestations and not real model inference (the unchanged router may set native realModelInferenceObserved from the fixture observation kind; this is synthetic and not accepted as natural evidence), no provider/model/network/training. Native A review is written by original writeSelfRepairContentReviewReceipt, independently read from its sidecar (before any later CLI overwrite), and inspected against actual native B input; no fabricated old receipt. Reference consistency and scripted verified quality do not prove semantic acceptance, source truth, recall before write, applied replacement/ranking or natural adoption. Local listener release leaves model cleanup unconfirmed.",
  };
  await fs.writeFile(
    path.join(params.directory, "proof.json"),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
  return proof;
}
