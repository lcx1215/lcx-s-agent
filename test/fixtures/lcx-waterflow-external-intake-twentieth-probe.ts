import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  readExternalAgentLocalIntake,
  type ExternalAgentLocalIntakeReceipt,
} from "../../scripts/operator/lcx-external-agent-upgrade-radar.ts";
import {
  auditWorkflowHandoffs,
  type WorkflowHandoffEvidence,
} from "../../scripts/operator/lcx-flow-graph.ts";
import { readFileWithinRoot } from "../../src/infra/fs-safe.ts";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");
export const externalIntakeHash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const EXTERNAL_INTAKE_SOURCE =
  "Synthetic local skill input. Retain source identity. Review unknown scripts before any reuse.\n";
export const EXTERNAL_INTAKE_LICENSE =
  "Synthetic fixture only. Upstream permission and covered files are unknown.\n";
export type ExternalIntakeFault =
  | "missing_manifest"
  | "missing_source"
  | "missing_license"
  | "manifest_hash"
  | "source_hash"
  | "license_hash"
  | "cross_scope"
  | "candidate_unknown"
  | "source_escape"
  | "source_symlink";

/** Documents are private synthetic inputs; all stages and gates remain original production. */
export async function createExternalIntakeProbe(workspaceDir: string, fault?: ExternalIntakeFault) {
  const scope = { accountId: "private-intake-account", runId: "private-intake-run" };
  await fs.mkdir(path.join(workspaceDir, "source"), { recursive: true });
  const source = {
    path: "source/SKILL.md",
    sha256: externalIntakeHash(EXTERNAL_INTAKE_SOURCE),
    version: "synthetic-v1",
  };
  const license = {
    path: "source/LICENSE.txt",
    sha256: externalIntakeHash(EXTERNAL_INTAKE_LICENSE),
  };
  await fs.writeFile(path.join(workspaceDir, source.path), EXTERNAL_INTAKE_SOURCE);
  await fs.writeFile(path.join(workspaceDir, license.path), EXTERNAL_INTAKE_LICENSE);
  const outsidePath = `${workspaceDir}-outside-source.md`;
  if (fault === "source_escape" || fault === "source_symlink") {
    await fs.writeFile(outsidePath, EXTERNAL_INTAKE_SOURCE);
    if (fault === "source_escape") {
      source.path = path.relative(workspaceDir, outsidePath);
    } else {
      await fs.rm(path.join(workspaceDir, source.path));
      await fs.symlink(outsidePath, path.join(workspaceDir, source.path));
    }
  }
  const manifestBody = {
    schemaVersion: "lcx_external_local_intake_v1",
    candidateId:
      fault === "candidate_unknown" ? "unknown-private-candidate" : "skillopt_v2_autoskill_coach",
    source,
    license,
    ...(fault === "cross_scope" ? { scope: { ...scope, runId: "other-private-run" } } : {}),
  };
  const bytes = JSON.stringify(manifestBody, null, 2) + "\n";
  const manifest = { path: "local-intake.json", sha256: externalIntakeHash(bytes) };
  await fs.writeFile(path.join(workspaceDir, manifest.path), bytes);
  if (fault === "missing_manifest") {
    await fs.rm(path.join(workspaceDir, manifest.path));
  }
  if (fault === "missing_source") {
    await fs.rm(path.join(workspaceDir, source.path));
  }
  if (fault === "missing_license") {
    await fs.rm(path.join(workspaceDir, license.path));
  }
  if (fault === "manifest_hash") {
    await fs.appendFile(path.join(workspaceDir, manifest.path), " ");
  }
  if (fault === "source_hash") {
    await fs.appendFile(path.join(workspaceDir, source.path), "Changed actual source.\n");
  }
  if (fault === "license_hash") {
    await fs.appendFile(path.join(workspaceDir, license.path), "Changed actual license.\n");
  }
  return { workspaceDir, scope, manifest, manifestBody, outsidePath };
}

export async function runExternalIntakeCli(
  probe: Awaited<ReturnType<typeof createExternalIntakeProbe>>,
  staticOnly = false,
  options: { omitFlag?: "--intake-run-id" | "--local-intake-sha256" } = {},
) {
  const observationsPath = path.join(probe.workspaceDir, "cli-denied-io.jsonl");
  const preloadPath = path.join(probe.workspaceDir, "cli-deny-io.mjs");
  await fs.writeFile(observationsPath, "");
  await fs.writeFile(
    preloadPath,
    `import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import cp from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const logPath=${JSON.stringify(observationsPath)};
function deny(kind,args){fs.appendFileSync(logPath,JSON.stringify({kind,args})+'\\n');throw new Error('private_intake_io_forbidden:'+kind);}
globalThis.fetch=()=>deny('fetch');
const loaderIpcBase=path.join(os.tmpdir(),'tsx-'+(process.geteuid?process.geteuid():os.userInfo().username),process.ppid+'.pipe');
const loaderIpcPath=process.platform==='win32'?${JSON.stringify("\\\\?\\pipe\\")}+loaderIpcBase:loaderIpcBase;
for(const [owner,names] of [[http,['get','request']],[https,['get','request']],[net,['connect','createConnection']],[tls,['connect']],[cp,['exec','execFile','execSync','execFileSync','spawn','spawnSync','fork']]])for(const name of names){const original=owner[name];owner[name]=function(...args){if(owner===net&&name==='createConnection'&&args[0]===loaderIpcPath){fs.appendFileSync(logPath,JSON.stringify({kind:'local_loader_ipc',path:args[0]})+'\\n');return Reflect.apply(original,this,args);}return deny(name,args);};}
syncBuiltinESMExports();
`,
  );
  const args = [
    "--import",
    pathToFileURL(preloadPath).href,
    "--import",
    "tsx",
    "scripts/operator/lcx-external-agent-upgrade-radar.ts",
    "--json",
  ];
  if (!staticOnly) {
    args.push(
      "--local-intake",
      probe.manifest.path,
      "--local-intake-sha256",
      probe.manifest.sha256,
      "--workspace",
      probe.workspaceDir,
      "--intake-account-id",
      probe.scope.accountId,
      "--intake-run-id",
      probe.scope.runId,
    );
  }
  if (options.omitFlag) {
    const index = args.indexOf(options.omitFlag);
    if (index < 0) {
      throw new Error("private_cli_flag_not_present");
    }
    args.splice(index, 2);
  }
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = {
      ...(await execFileAsync(process.execPath, args, {
        cwd: repoRoot,
        env: { PATH: process.env.PATH, NODE_ENV: "test" },
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
      })),
      exitCode: 0,
    };
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    if (failure.code !== 1 || typeof failure.stdout !== "string") {
      throw error;
    }
    result = { stdout: failure.stdout, stderr: failure.stderr ?? "", exitCode: failure.code };
  }
  const observations = (await fs.readFile(observationsPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; path?: string; args?: unknown[] });
  return {
    command: [process.execPath, ...args],
    stdout: result.stdout,
    stderr: result.stderr,
    receipt: JSON.parse(result.stdout) as unknown,
    observations: observations.filter((row) => row.kind !== "local_loader_ipc"),
    localLoaderIpc: observations.filter((row) => row.kind === "local_loader_ipc"),
    exitCode: result.exitCode,
    directChildExitObserved: true,
    descendantCleanup: "not_observed",
  };
}

export async function saveExternalIntakeProof(
  workspaceDir: string,
  name: string,
  receipt: unknown,
) {
  const root = process.env.LCX_EXTERNAL_INTAKE_PROOF_DIR ?? path.join(workspaceDir, "proofs");
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  const privateInput = path.join(directory, "private-input");
  await fs.mkdir(privateInput, { recursive: true });
  for (const entry of await fs.readdir(workspaceDir)) {
    const source = path.join(workspaceDir, entry);
    if (entry === "proofs" || path.resolve(source) === path.resolve(root)) {
      continue;
    }
    await fs.cp(source, path.join(privateInput, entry), { recursive: true, dereference: false });
  }
  const nativePath = path.join(directory, "actual-native-receipt.json");
  const bytes = JSON.stringify(receipt, null, 2) + "\n";
  await fs.writeFile(nativePath, bytes);
  return { directory, nativePath, sha256: externalIntakeHash(bytes) };
}

export async function auditExternalIntakeReceipt(
  workspaceDir: string,
  name: string,
  receipt: ExternalAgentLocalIntakeReceipt,
  nativeReceipt: unknown = receipt,
  pointerPrefix = "",
) {
  const saved = await saveExternalIntakeProof(workspaceDir, name, nativeReceipt);
  const ref = (pointer: string) => ({
    path: saved.nativePath,
    sha256: saved.sha256,
    pointer: pointerPrefix + pointer,
  });
  const evidence: WorkflowHandoffEvidence = {
    scenarioId: "external_agent_skill_distillation_waterflow",
    environment: "offline_fixture",
    nodes: receipt.stages.map((stage, index) => ({
      nodeId: stage.nodeId,
      scope: ref(`/stages/${index}/scope`),
      ...(stage.output ? { output: ref(`/stages/${index}/output`) } : {}),
      ...(index > 0 && stage.input
        ? {
            inputs: [
              { from: receipt.stages[index - 1].nodeId, value: ref(`/stages/${index}/input`) },
            ],
          }
        : {}),
      ...(stage.filter
        ? {
            block: {
              filter: stage.filter,
              status: ref(`/stages/${index}/status`),
              reason: ref(`/stages/${index}/reason`),
            },
          }
        : {}),
    })),
  };
  const audit = (await auditWorkflowHandoffs([evidence])).find(
    (row) => row.scenarioId === evidence.scenarioId,
  );
  if (!audit) {
    throw new Error("original_intake_audit_missing");
  }
  await fs.writeFile(
    path.join(saved.directory, "actual-fieldrefs-input.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  await fs.writeFile(
    path.join(saved.directory, "original-fieldrefs-audit.json"),
    JSON.stringify(audit, null, 2) + "\n",
  );
  return { ...saved, evidence, audit };
}

/** Hold only a completed original filesystem read; original deadline/cancel still owns terminal state. */
export async function runExternalIntakeDelayedRead(
  probe: Awaited<ReturnType<typeof createExternalIntakeProbe>>,
  fault: "deadline" | "cancel",
) {
  const reads: string[] = [];
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const readFile: typeof readFileWithinRoot = async (options) => {
    reads.push(options.relativePath);
    const result = await readFileWithinRoot(options);
    if (options.relativePath === probe.manifestBody.source.path) {
      entered();
      await held;
    }
    return result;
  };
  const pending = readExternalAgentLocalIntake({
    ...probe,
    signal: controller.signal,
    timeoutMs: 1_000,
    readFile,
  });
  try {
    await Promise.race([
      enteredPromise,
      pending.then(() => {
        throw new Error("original_deadline_before_source_read_entry");
      }),
    ]);
    if (fault === "cancel") {
      controller.abort(new Error("private-caller-cancel"));
    }
    const receipt = await pending;
    const sealed = JSON.stringify(receipt);
    const readsAtTerminal = [...reads];
    release();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    return {
      receipt,
      readEntered: true,
      readsAtTerminal,
      readsAfterLate: reads,
      lateResultCannotChangeTerminal: JSON.stringify(receipt) === sealed,
      readResourceCancellation: "not_confirmed_by_original_signal_race",
    };
  } finally {
    release();
  }
}
