import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import type { walkArtifacts } from "../../scripts/operator/lcx-universe-index.js";
const nativeExec = promisify(execFile);
const sourceRoot = path.resolve(import.meta.dirname, "../..");
type Deadline = NonNullable<Parameters<typeof walkArtifacts>[2]>;
type ExecSubstitute = (
  command: string,
  args: string[],
  options: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

/** Extract actual original functions without executing CLI main or governance owner stacks. */
export async function universeDeadlineFunctions(substitute?: ExecSubstitute) {
  const filename = path.join(sourceRoot, "scripts/operator/lcx-universe-index.ts");
  const source = await fs.readFile(filename, "utf8");
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const body = ast.statements
    .filter(ts.isFunctionDeclaration)
    .filter((node) => node.name?.text !== "main")
    .map((node) => node.getText(ast).replace(/^export\s+/u, ""))
    .join("\n");
  const js = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  return vm.runInNewContext(
    `${js}\n({ createOwnerDeadline, readWithinDeadline, execLinesWithStatus, changeImpactCoverage, parseArgs, walkArtifacts })`,
    {
      fs,
      path,
      process,
      repoRoot: sourceRoot,
      EXEC_MAX_BUFFER: 64 * 1024 * 1024,
      STALE_ARTIFACT_AGE_MS: 7 * 24 * 60 * 60 * 1000,
      LARGE_ARTIFACT_BYTES: 50 * 1024 * 1024,
      AbortController,
      setTimeout,
      clearTimeout,
      execFileAsync: substitute ?? nativeExec,
    },
  ) as {
    createOwnerDeadline: (
      options: { timeoutMs?: number; deadlineAtMs?: number },
      startedAtMs?: number,
    ) => Deadline;
    readWithinDeadline: <T>(
      source: string,
      operation: () => Promise<T>,
      deadline: Deadline,
    ) => Promise<T>;
    execLinesWithStatus: (
      command: string,
      args: string[],
      cwd: string,
      trimLines: boolean,
      deadline: Deadline,
    ) => Promise<{ ok: boolean; lines: string[]; error?: string }>;
    changeImpactCoverage: (
      files: string[],
      deadline: Deadline,
    ) => Promise<{ ok: boolean; source: string; error?: string }>;
    parseArgs: (args: string[]) => { timeoutMs?: number; deadlineAtMs?: number };
    walkArtifacts: typeof walkArtifacts;
  };
}

/** Pure original consumers only, never start the governance coordinator. */
export async function consumeUniverseDeadlineReceipt(receipt: Record<string, unknown>) {
  const extract = async (file: string, names: string[]) => {
    const raw = await fs.readFile(path.join(sourceRoot, file), "utf8");
    const ast = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);
    const body = ast.statements
      .filter(ts.isFunctionDeclaration)
      .filter((node) => names.includes(node.name?.text ?? ""))
      .map((node) => node.getText(ast).replace(/^export\s+/u, ""))
      .join("\n");
    return ts.transpileModule(body, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
    }).outputText;
  };
  const compactJS = await extract("scripts/operator/lcx-governance-autopilot.ts", [
    "recordValue",
    "compactOwner",
  ]);
  const compact = vm.runInNewContext(`${compactJS}\ncompactOwner`) as (
    id: string,
    payload: Record<string, unknown>,
  ) => Record<string, unknown>;
  const gateJS = await extract("src/agents/central-harness/tool-registry.ts", ["ownerObservedOk"]);
  const gate = vm.runInNewContext(`${gateJS}\nownerObservedOk`) as (
    payload: Record<string, unknown>,
    cleanExit: boolean,
  ) => boolean;
  return {
    compact: compact("universeIndex", receipt),
    observedOk: gate(receipt, false),
    input: receipt,
  };
}
