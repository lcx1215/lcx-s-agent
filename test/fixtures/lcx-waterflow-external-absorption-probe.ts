import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { probeDistillationSample } from "./lcx-waterflow-distillation-sample-probe.js";

const executeFile = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected original absorption output");
  }
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value) {
    throw new Error("Expected original producer path");
  }
  return value;
};
export type ExternalAbsorptionFault =
  | "missing_source"
  | "hash_conflict"
  | "candidate_content_conflict"
  | "body_removed_after_plan"
  | "eval_removed_after_plan"
  | "registry_pin_conflict"
  | "receipt_pin_conflict"
  | "cross_workspace";

/** Reuses original loop production, then the existing CLI's own review caller and byte readback. */
export async function probeExternalAbsorption(params: {
  workspaceDir: string;
  proofDir: string;
  fault?: ExternalAbsorptionFault;
}) {
  await fs.mkdir(params.proofDir, { recursive: true });
  const loopFault = ["missing_source", "hash_conflict", "candidate_content_conflict"].includes(
    params.fault ?? "",
  )
    ? (params.fault as Parameters<typeof probeDistillationSample>[0]["fault"])
    : undefined;
  const producer = await probeDistillationSample({
    workspaceDir: params.workspaceDir,
    fault: loopFault,
  });
  const receiptPath = producer.plan ? text(producer.plan.receiptPath) : undefined;
  const registryPath = producer.plan ? text(producer.plan.sourceRegistryRecordPath) : undefined;
  const preserved: Array<{ relativePath: string; path: string; sha256: string }> = [];
  for (const relativePath of [
    "source/SKILL.md",
    "source/LICENSE.txt",
    "local/source-register.json",
    "local/candidate.json",
    "local/application-trace.json",
    "local/eval.json",
    ...(receiptPath ? [receiptPath] : []),
  ]) {
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(path.join(params.workspaceDir, relativePath));
    } catch (error) {
      if (record(error).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const target = path.join(params.proofDir, "original-producer-bytes", relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    preserved.push({ relativePath, path: target, sha256: digest(bytes) });
  }
  const receiptSha256 = preserved.find((entry) => entry.relativePath === receiptPath)?.sha256;
  const registrySha256 = preserved.find((entry) => entry.relativePath === registryPath)?.sha256;
  if (params.fault === "body_removed_after_plan") {
    await fs.rm(path.join(params.workspaceDir, "source/SKILL.md"));
  }
  if (params.fault === "eval_removed_after_plan") {
    await fs.rm(path.join(params.workspaceDir, "local/eval.json"));
  }
  const consumerWorkspace =
    params.fault === "cross_workspace"
      ? path.join(params.workspaceDir, "independent-empty-workspace")
      : params.workspaceDir;
  await fs.mkdir(consumerWorkspace, { recursive: true });
  const guardLog = path.join(consumerWorkspace, "private-empty-guard.jsonl");
  await fs.writeFile(guardLog, "");
  // Child imports execute the unchanged owner; trap any accidental network use at its IO seam.
  const preload = path.join(params.workspaceDir, "private-network-guard.mjs");
  await fs.writeFile(
    preload,
    'import http from "node:http";\nimport https from "node:https";\nimport net from "node:net";\nimport {syncBuiltinESMExports} from "node:module";\nconst forbidden=()=>{throw new Error("external_absorption_network_forbidden")};\nglobalThis.fetch=forbidden;\nhttp.request=forbidden;http.get=forbidden;https.request=forbidden;https.get=forbidden;net.connect=forbidden;net.createConnection=forbidden;\nsyncBuiltinESMExports();\n',
  );
  const args = [
    "--import",
    preload,
    "--import",
    "tsx",
    "scripts/operator/lcx-module-learning-absorption-gate.ts",
    "--workspace",
    consumerWorkspace,
    "--guard-log",
    guardLog,
    "--source",
    "source/SKILL.md",
    "--target-module",
    "skill_pattern_distillation",
    ...(receiptSha256
      ? [
          "--receipt-sha256",
          params.fault === "receipt_pin_conflict" ? "0".repeat(64) : receiptSha256,
        ]
      : []),
    ...(registrySha256
      ? [
          "--source-sha256",
          params.fault === "registry_pin_conflict" ? "0".repeat(64) : registrySha256,
        ]
      : []),
    "--json",
  ];
  const execution = await executeFile(process.execPath, args, {
    cwd: process.env.LCX_EXTERNAL_ABSORPTION_GATE_REPO ?? repoRoot,
    env: { ...process.env, LCX_USER_HOME: path.join(consumerWorkspace, "private-home") },
    timeout: 30_000,
    killSignal: "SIGTERM",
    maxBuffer: 4 * 1024 * 1024,
  });
  const consumer = record(JSON.parse(execution.stdout));
  const consumerPath = path.join(params.proofDir, "original-gate-stdout.json");
  await fs.writeFile(consumerPath, execution.stdout);
  // Independent disk readback uses the exact CLI stdout, not producer's review field.
  const readbackBytes = await fs.readFile(consumerPath);
  const consumerReadback = record(JSON.parse(readbackBytes.toString("utf8")));
  const afterReceiptSha256 = receiptPath
    ? digest(await fs.readFile(path.join(params.workspaceDir, receiptPath)))
    : undefined;
  const trace = {
    fault: params.fault ?? null,
    boundary: "original_private_skill_loop_to_original_absorption_cli_readback",
    producer,
    originalProducerBytes: preserved,
    consumer,
    consumerReadback,
    consumerArtifact: { path: consumerPath, sha256: digest(readbackBytes) },
    producerReceiptSHA256: receiptSha256 ?? null,
    producerReceiptUnchanged: receiptSha256 === afterReceiptSha256,
    registryPinSemantics:
      "sourceRegistryRecordPath bytes; original eval separately checks SKILL body",
    command: [process.execPath, ...args],
    consumerRepoRoot: process.env.LCX_EXTERNAL_ABSORPTION_GATE_REPO ?? repoRoot,
    stderr: execution.stderr,
    hostWorkspaceSHA256: digest(path.resolve(consumerWorkspace)),
    canonicalRunIdentity: "unavailable; no host-run-id invented",
    guardBoundary: "Private empty log is parsed; no guard program or owner stack invoked",
    deadlineBoundary:
      "30s child watchdog only; original filesystem review has no AbortSignal/deadline or cleanup receipt",
    notProven: [
      "source truth",
      "upstream license permission",
      "security review",
      "semantic application acceptance",
      "natural model adoption",
      "central 4KB/12KB budget",
      "whole external skill scene",
    ],
  };
  await fs.writeFile(
    path.join(params.proofDir, "actual-original-consumption.json"),
    JSON.stringify(trace, null, 2) + "\n",
  );
  return trace;
}
