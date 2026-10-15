import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createModuleLearningPipelineReviewTool } from "../../src/agents/tools/module-learning-pipeline-review-tool.js";
import { createModuleContentReviewProbe } from "./lcx-waterflow-module-content-review-nineteenth-probe.js";

const executeFile = promisify(execFile);
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("native_absorption_result_not_object");
  }
  return value as Record<string, unknown>;
}

export type AbsorptionContentFault =
  | "missing_receipt"
  | "receipt_hash"
  | "foreign_scope"
  | "missing_host"
  | "source_changed"
  | "root_escape";

/** Real local quality input, original plan/review writer and a separate original gate CLI.
 * Only source documents and the nineteenth probe's lowest model responses are synthetic.
 * The gate receives no model adapter; a private empty guard log preserves normal eval hold.
 */
export async function probeAbsorptionContentTwentieth(options: {
  workspaceDir: string;
  contradictory?: boolean;
  genericAnswer?: boolean;
  fault?: AbsorptionContentFault;
  includeContentReview?: boolean;
  json?: boolean;
}) {
  const producer = await createModuleContentReviewProbe(
    options.workspaceDir,
    options.contradictory,
  );
  const written = await createModuleLearningPipelineReviewTool({
    workspaceDir: options.workspaceDir,
    scope: producer.scope,
    qualityOptions: options.genericAnswer
      ? {
          ...producer.qualityOptions,
          modelInvoker: async (input: unknown, signal: AbortSignal) => {
            const value = await producer.modelInvoker(input, signal);
            const response = record(value);
            return response.kind === "artifact"
              ? {
                  ...response,
                  artifact: { ...record(response.artifact), answer: "Further review is required." },
                }
              : value;
          },
        }
      : producer.qualityOptions,
  }).execute("native-absorption-content-writer", {
    targetModule: "skill_pattern_distillation",
    writeReview: true,
    contentReview: producer.request,
  });
  const details = record(written.details);
  if (typeof details.reviewPath !== "string") {
    throw new Error("native_content_review_writer_path_missing");
  }
  const reviewBytes = await fs.readFile(path.join(options.workspaceDir, details.reviewPath));
  const reviewReceipt = { path: details.reviewPath, sha256: hash(reviewBytes) };
  const registrySha256 = hash(
    await fs.readFile(path.join(options.workspaceDir, "local/source-register.json")),
  );
  const callsBeforeGate = producer.modelInputs.length;
  const guardLog = path.join(options.workspaceDir, "private-empty-guard.jsonl");
  await fs.writeFile(guardLog, "");
  const outsideReceipt = `${options.workspaceDir}-outside-review.json`;
  let receiptPath = reviewReceipt.path;
  if (options.fault === "missing_receipt") {
    receiptPath = "missing-content-review.json";
  } else if (options.fault === "source_changed") {
    await fs.appendFile(
      path.join(options.workspaceDir, producer.request.source.path),
      "Changed.\n",
    );
  } else if (options.fault === "root_escape") {
    await fs.writeFile(outsideReceipt, "private-outside-review-must-not-be-read");
    receiptPath = path.relative(options.workspaceDir, outsideReceipt);
  }
  const observationsPath = path.join(options.workspaceDir, "gate-io-observations.jsonl");
  const preload = path.join(options.workspaceDir, "gate-io-guard.mjs");
  await fs.writeFile(observationsPath, "");
  await fs.writeFile(
    preload,
    `import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
const append = fs.appendFileSync;
const observations = ${JSON.stringify(observationsPath)};
const forbiddenPath = ${JSON.stringify(outsideReceipt)};
function deny(kind,target) {
  append(observations, JSON.stringify({kind,target:String(target)})+'\\n');
  throw new Error('private_gate_io_forbidden:'+kind);
}
globalThis.fetch = () => deny('network','fetch');
for (const [owner,names] of [[http,['request','get']],[https,['request','get']],[net,['connect','createConnection']]]) {
  for (const name of names) {
    const original = owner[name];
    owner[name] = function(...args) {
      const loaderSocket = '/tmp/tsx-'+process.geteuid()+'/'+process.ppid+'.pipe';
      if (owner === net && args[0] === loaderSocket) {
        append(observations, JSON.stringify({kind:'local_loader_ipc',target:loaderSocket})+'\\n');
        return Reflect.apply(original,this,args);
      }
      return deny('network',name+':'+JSON.stringify(args));
    };
  }
}
for (const [owner,names] of [[fs,['openSync','readFileSync','open','readFile']],[fsp,['open','readFile']]]) {
  for (const name of names) {
    const original = owner[name];
    owner[name] = function(target,...args) {
      if (typeof target === 'string' && path.resolve(target) === forbiddenPath) deny('outside_read',target);
      return Reflect.apply(original,this,[target,...args]);
    };
  }
}
syncBuiltinESMExports();
`,
  );
  const args = [
    "--import",
    preload,
    "--import",
    "tsx",
    "scripts/operator/lcx-module-learning-absorption-gate.ts",
    "--workspace",
    options.workspaceDir,
    "--guard-log",
    guardLog,
    "--source",
    producer.request.source.path,
    "--target-module",
    "skill_pattern_distillation",
    "--receipt-sha256",
    producer.request.planReceipt.sha256,
    "--source-sha256",
    registrySha256,
    "--host-run-id",
    "private-gate-readback-run",
    ...(options.json === false ? [] : ["--json"]),
    ...(options.includeContentReview === false
      ? []
      : [
          "--content-review-receipt",
          receiptPath,
          "--content-review-sha256",
          options.fault === "receipt_hash" ? "0".repeat(64) : reviewReceipt.sha256,
          ...(options.fault === "missing_host"
            ? []
            : [
                "--review-account-id",
                producer.scope.accountId,
                "--review-run-id",
                options.fault === "foreign_scope" ? "other-review-attempt" : producer.scope.runId,
              ]),
        ]),
  ];
  try {
    const execution = await executeFile(process.execPath, args, {
      cwd: process.env.LCX_ABSORPTION_CONTENT_GATE_REPO ?? repoRoot,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        LCX_USER_HOME: path.join(options.workspaceDir, "private-home"),
      },
      timeout: 20_000,
      killSignal: "SIGTERM",
      maxBuffer: 4 * 1024 * 1024,
    });
    const observations = (await fs.readFile(observationsPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    return {
      producer: {
        request: producer.request,
        plan: producer.plan,
        modelInputs: producer.modelInputs,
        written: details,
        reviewReceipt,
        callsBeforeGate,
        callsAfterGate: producer.modelInputs.length,
      },
      gate: options.json === false ? undefined : record(JSON.parse(execution.stdout)),
      stdout: execution.stdout,
      stderr: execution.stderr,
      command: [process.execPath, ...args],
      observations: observations.filter((entry) => record(entry).kind !== "local_loader_ipc"),
      localLoaderIpc: observations.filter((entry) => record(entry).kind === "local_loader_ipc"),
      reviewReceiptUnchanged:
        hash(await fs.readFile(path.join(options.workspaceDir, reviewReceipt.path))) ===
        reviewReceipt.sha256,
      directChildExited: true,
      descendantCleanup: "not_observed",
      limits: [
        "Injected scripted quality, not natural semantic or legal acceptance",
        "Actual application effectiveness unobserved",
        "No hardened eval or training engine run; private empty log preserves hold",
        "Gate child cannot use parent model invoker; no paid adapter enabled",
        "20s child watchdog is not proof of descendant cancellation",
      ],
    };
  } finally {
    await fs.rm(outsideReceipt, { force: true });
  }
}

export async function saveAbsorptionContentProof(
  workspaceDir: string,
  name: string,
  value: unknown,
) {
  const root = process.env.LCX_ABSORPTION_CONTENT_PROOF_DIR;
  if (!root) {
    return;
  }
  const target = path.join(root, name);
  await fs.mkdir(target, { recursive: true });
  await fs.cp(workspaceDir, path.join(target, "private-input"), { recursive: true });
  await fs.writeFile(path.join(target, "actual-owner-result.json"), JSON.stringify(value, null, 2));
}
