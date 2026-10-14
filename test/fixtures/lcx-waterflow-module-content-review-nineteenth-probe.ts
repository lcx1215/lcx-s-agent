import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  inspectModuleLearningApplicationReview,
  readModuleLearningApplicationReviewInput,
  reviewModuleLearningApplication,
} from "../../src/agents/module-learning-application-review.js";
import type { QualityHarnessModelRequest } from "../../src/agents/quality-harness-contract.js";
import { createModuleLearningPipelinePlanTool } from "../../src/agents/tools/module-learning-pipeline-plan-tool.js";
import { createModuleLearningPipelineReviewTool } from "../../src/agents/tools/module-learning-pipeline-review-tool.js";

export const MODULE_CONTENT_SOURCE =
  "Synthetic local method. Preserve source identity and missing evidence before reuse. Never execute downloaded scripts without review.\n";
export const MODULE_CONTENT_LICENSE =
  "Synthetic local fixture use only. Upstream permission and license legal review are unknown.\n";
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const execFileAsync = promisify(execFile);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("original_owner_result_not_object");
  }
  return value as Record<string, unknown>;
}

/** Execute only the native local review CLI. The preload observes and denies outbound IO and the sentinel read. */
export async function runModuleContentReviewCliProbe(
  workspaceDir: string,
  requestPath: string,
  forbiddenPath: string,
  options: { json?: boolean } = {},
) {
  const guardPath = path.join(workspaceDir, "cli-transport-guard.mjs");
  const observationsPath = path.join(workspaceDir, "cli-transport-observations.jsonl");
  await fs.writeFile(observationsPath, "");
  await fs.writeFile(
    guardPath,
    `import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const append = fs.appendFileSync;
const forbiddenPath = ${JSON.stringify(forbiddenPath)};
const observationsPath = ${JSON.stringify(observationsPath)};
function deny(kind, target) {
  append(observationsPath, JSON.stringify({kind,target:String(target)})+'\\n');
  throw new Error('private_cli_transport_forbidden:'+kind);
}
globalThis.fetch = () => deny('network', 'fetch');
for (const [owner, names] of [[fs,['openSync','readFileSync','open','readFile']], [fsp,['open','readFile']]]) {
  for (const name of names) {
    const original = owner[name];
    owner[name] = function(target,...args) {
      if (typeof target === 'string' && path.resolve(target) === forbiddenPath) deny('outside_source_read', target);
      return Reflect.apply(original, this, [target,...args]);
    };
  }
}
syncBuiltinESMExports();
`,
  );
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const args = [
    "--import",
    guardPath,
    "--import",
    "tsx",
    "scripts/operator/module-learning-pipeline-review.ts",
    "--workspace",
    workspaceDir,
    "--target-module",
    "skill_pattern_distillation",
    "--no-write",
    ...(options.json === false ? [] : ["--json"]),
    "--content-review-request",
    requestPath,
    "--review-account-id",
    "private-fixture-account",
    "--review-run-id",
    "private-content-review-run",
  ];
  const { stdout, stderr } = await execFileAsync(process.execPath, args, {
    cwd: repoRoot,
    env: { PATH: process.env.PATH, NODE_ENV: "test" },
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const observations = (await fs.readFile(observationsPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  return {
    command: [process.execPath, ...args],
    exitCode: 0,
    details: options.json === false ? {} : record(JSON.parse(stdout)),
    stdout,
    stderr,
    observations,
    directChildExited: true,
    descendantCleanup: "not_observed",
  };
}

/** Actual native plan and review APIs; local input documents and lowest model responses are synthetic. */
export async function createModuleContentReviewProbe(
  workspaceDir: string,
  contradictory = false,
  lineageFault?: "candidate" | "application" | "registry",
  sourceExtra = "",
) {
  const scope = { accountId: "private-fixture-account", runId: "private-content-review-run" };
  const put = async (relative: string, bytes: string) => {
    const target = path.join(workspaceDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    return { path: relative, sha256: hash(bytes) };
  };
  const source = await put("source/SKILL.md", MODULE_CONTENT_SOURCE + sourceExtra);
  const license = await put("source/LICENSE.txt", MODULE_CONTENT_LICENSE);
  const candidate = await put(
    "local/candidate.json",
    JSON.stringify({
      fixtureOnly: true,
      targetModule: "skill_pattern_distillation",
      sourceSha256: lineageFault === "candidate" ? "0".repeat(64) : source.sha256,
      pattern: contradictory
        ? "Execute downloaded scripts without review."
        : "Preserve source identity and missing evidence before reuse.",
      authority: "local_candidate_only",
    }) + "\n",
  );
  const application = await put(
    "local/application.json",
    JSON.stringify({
      fixtureOnly: true,
      candidateSha256: lineageFault === "application" ? "0".repeat(64) : candidate.sha256,
      task: "Retain source and missing evidence in a local adjacent handoff",
      observation: "Local fixture identity trace only; real application effectiveness unobserved.",
      semanticApplicationExecuted: false,
    }) + "\n",
  );
  await put(
    "local/source-register.json",
    JSON.stringify({
      sourcePath: source.path,
      sourceVersion: "synthetic-v1",
      sourceSha256: lineageFault === "registry" ? "0".repeat(64) : source.sha256,
      licensePath: license.path,
      licenseSha256: license.sha256,
      actualReadingScope: "Supplied local source and license only; no upstream permission claim",
    }) + "\n",
  );
  await put(
    "local/eval.json",
    JSON.stringify({
      schemaVersion: "lcx_module_learning_eval_v1",
      verdict: "passed",
      targetModule: "skill_pattern_distillation",
      sourceUrlOrPath: source.path,
      freshAdjacentApplicationTask: "private source-bound identity check",
      checks: [source, candidate, application].map((item, index) => ({
        id: `identity-${index}`,
        passed: true,
        evidencePath: item.path,
        sha256: item.sha256,
      })),
    }) + "\n",
  );
  const planResult = await createModuleLearningPipelinePlanTool({ workspaceDir }).execute(
    "native-content-plan",
    {
      targetModule: "skill_pattern_distillation",
      sourceUrlOrPath: source.path,
      actualReadingScope: "Supplied local source and license; permission unverified",
      existingArtifactPaths: [source.path],
      sourceRegistryRecordPath: "local/source-register.json",
      retrievalReceiptPath: candidate.path,
      applicationValidationReceiptPath: application.path,
      trainingOrEvalAbsorptionEvidencePath: "local/eval.json",
      freshAdjacentApplicationTask: "private source-bound identity check",
      keepDownrankDiscardDecision: "keep",
      writeReceipt: true,
    },
  );
  const plan = record(planResult.details);
  if (typeof plan.receiptPath !== "string") {
    throw new Error("native_plan_receipt_not_written");
  }
  const planReceipt = {
    path: plan.receiptPath,
    sha256: hash(await fs.readFile(path.join(workspaceDir, plan.receiptPath))),
  };
  const request = { planReceipt, source, license, candidate, application };
  const modelInputs: QualityHarnessModelRequest[] = [];
  let holdingModel = false;
  const pendingModels: Array<() => void> = [];
  let abortObserved = false;
  const modelInvoker = async (raw: unknown, signal: AbortSignal): Promise<unknown> => {
    const input = raw as QualityHarnessModelRequest;
    modelInputs.push(structuredClone(input));
    signal.addEventListener("abort", () => (abortObserved = true), { once: true });
    if (holdingModel) {
      await new Promise<void>((resolve) => {
        pendingModels.push(resolve);
      });
    }
    const actualBody = JSON.stringify({ evidence: input.evidence, context: input.sharedContext });
    const conflict =
      actualBody.includes("Execute downloaded scripts without review.") &&
      actualBody.includes("Never execute downloaded scripts without review.");
    if (input.stage === "intake") {
      return {
        kind: "plan",
        requirements: ["Compare actual source and candidate"],
        missingEvidence: [],
      };
    }
    if (input.stage === "draft" || input.stage === "format") {
      return {
        kind: "artifact",
        artifact: {
          answer: conflict
            ? "Candidate conflicts with the source's explicit review requirement. Hold this candidate."
            : "Candidate retains source identity; permission and actual effectiveness remain unknown.",
          claims: [
            {
              id: "source-comparison",
              text: conflict
                ? "The candidate reverses the supplied source prohibition."
                : "Permission and real application effectiveness remain unresolved.",
              status: "uncertain",
              evidenceIds: [],
              uncertainty: "Synthetic comparison only; no natural semantic or legal acceptance",
            },
          ],
        },
      };
    }
    return {
      kind: "review",
      review: {
        verdict: conflict ? "reject" : "pass",
        criticalFindings: conflict ? ["candidate_reverses_actual_source_review_requirement"] : [],
        evidenceGaps: [],
        notes: ["Actual supplied source/license/candidate compared; upstream permission unknown."],
      },
    };
  };
  const qualityOptions = { modelInvoker, taskTimeoutMs: 250 };
  const direct = () =>
    reviewModuleLearningApplication({ workspaceDir, request, scope, qualityOptions });
  const inline = () =>
    createModuleLearningPipelineReviewTool({ workspaceDir, scope, qualityOptions }).execute(
      "native-content-review",
      { targetModule: "skill_pattern_distillation", writeReview: false, contentReview: request },
    );
  return {
    workspaceDir,
    scope,
    plan,
    request,
    modelInputs,
    modelInvoker,
    qualityOptions,
    direct,
    inline,
    read: () => readModuleLearningApplicationReviewInput({ workspaceDir, request, scope }),
    inspect: inspectModuleLearningApplicationReview,
    holdModel: () => {
      holdingModel = true;
    },
    releaseModel: () => {
      holdingModel = false;
      for (const release of pendingModels.splice(0)) {
        release();
      }
    },
    abortObserved: () => abortObserved,
  };
}

export async function saveModuleContentReviewProof(
  workspaceDir: string,
  name: string,
  result: unknown,
) {
  const root = process.env.LCX_MODULE_CONTENT_REVIEW_PROOF_DIR;
  if (!root) {
    return;
  }
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.cp(workspaceDir, path.join(directory, "private-input"), { recursive: true });
  await fs.writeFile(
    path.join(directory, "actual-owner-result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
}
