import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_WORKSPACE_DIR,
  LOCAL_FAILURE_TRACE_JSONL_PATH,
  LOCAL_FAILURE_TRACE_LATEST_PATH,
} from "./lcx-local-paths.ts";

type JsonRecord = Record<string, unknown>;

export type FailureTraceActivePidSummary = {
  guard: string[];
  eval: string[];
  mlx: string[];
  teacher: string[];
  quota: string[];
};

export type FailureTraceOwnerCommand = {
  id: string;
  command: string;
  exitCode: number;
  parsed: boolean;
  ok?: boolean;
};

export type FailureTraceInput = {
  checkedAt: string;
  workspaceDir: string;
  repo: {
    cwd: string;
    statusShortBranch: string;
    dirtyCount: number;
  };
  activePidSummary: FailureTraceActivePidSummary;
  source: string;
  sourceArtifacts: string[];
  writtenArtifacts: string[];
  ownerCommands: FailureTraceOwnerCommand[];
  summary: {
    activeTrainingOrEval?: boolean;
    structuralOwnerFailures?: unknown;
    blockedClusters?: unknown;
    blockedGates?: unknown;
    failedGates?: unknown;
    fastestSafeNextAction?: unknown;
  };
  boundaryFlags: {
    liveTouched: boolean;
    providerConfigTouched: boolean;
    protectedMemoryTouched: boolean;
  };
};

function recordValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function compactUnknownArray(value: unknown): string[] {
  return arrayValue(value)
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      const record = recordValue(item);
      const id = record?.id ?? record?.gate ?? record?.cluster ?? record?.name;
      return typeof id === "string" ? id : undefined;
    })
    .filter((item): item is string => typeof item === "string");
}

function activeCounts(activePidSummary: FailureTraceActivePidSummary) {
  return {
    guard: activePidSummary.guard.length,
    eval: activePidSummary.eval.length,
    mlx: activePidSummary.mlx.length,
    teacher: activePidSummary.teacher.length,
    quota: activePidSummary.quota.length,
  };
}

function sanitizeIdPart(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase();
}

function buildRunId(checkedAt: string, source: string, key: string): string {
  const timePart = checkedAt.replace(/[^0-9TZ]+/gu, "-").replace(/[:-]/gu, "-");
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
  return `${timePart}-${sanitizeIdPart(source)}-${hash}`;
}

function inferFirstFailedGate(params: {
  activePidSummary: FailureTraceActivePidSummary;
  ownerCommands: FailureTraceOwnerCommand[];
  structuralOwnerFailures: string[];
  blockedGates: string[];
  failedGates: string[];
  blockedClusters: string[];
}) {
  const parseFailure = params.ownerCommands.find((owner) => !owner.parsed);
  if (parseFailure) {
    return `owner_parse_failed:${parseFailure.id}`;
  }
  const exitFailure = params.ownerCommands.find((owner) => owner.exitCode !== 0);
  if (exitFailure) {
    return `owner_exit_failed:${exitFailure.id}`;
  }
  if (params.activePidSummary.eval.length > 0 || params.activePidSummary.mlx.length > 0) {
    return "active_eval_or_mlx";
  }
  return (
    params.blockedGates[0] ??
    params.failedGates[0] ??
    params.structuralOwnerFailures[0] ??
    params.blockedClusters[0] ??
    "none"
  );
}

function inferResult(params: {
  firstFailedGate: string;
  activeTrainingOrEval: boolean;
  structuralOwnerFailures: string[];
  blockedGates: string[];
  failedGates: string[];
  blockedClusters: string[];
  boundaryFlags: FailureTraceInput["boundaryFlags"];
}) {
  if (
    params.boundaryFlags.liveTouched ||
    params.boundaryFlags.providerConfigTouched ||
    params.boundaryFlags.protectedMemoryTouched ||
    params.firstFailedGate.startsWith("owner_parse_failed:") ||
    params.firstFailedGate.startsWith("owner_exit_failed:")
  ) {
    return "failed";
  }
  if (
    params.activeTrainingOrEval ||
    params.structuralOwnerFailures.length > 0 ||
    params.blockedGates.length > 0 ||
    params.failedGates.length > 0 ||
    params.blockedClusters.length > 0
  ) {
    return "blocked";
  }
  return "passed";
}

function stringifySafe(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

export function buildLocalFailureTraceReceipt(input: FailureTraceInput) {
  const structuralOwnerFailures = compactUnknownArray(input.summary.structuralOwnerFailures);
  const blockedClusters = compactUnknownArray(input.summary.blockedClusters);
  const blockedGates = compactUnknownArray(input.summary.blockedGates);
  const failedGates = compactUnknownArray(input.summary.failedGates);
  const firstFailedGate = inferFirstFailedGate({
    activePidSummary: input.activePidSummary,
    ownerCommands: input.ownerCommands,
    structuralOwnerFailures,
    blockedClusters,
    blockedGates,
    failedGates,
  });
  const activeTrainingOrEval =
    input.summary.activeTrainingOrEval === true ||
    input.activePidSummary.eval.length > 0 ||
    input.activePidSummary.mlx.length > 0;
  const result = inferResult({
    firstFailedGate,
    activeTrainingOrEval,
    structuralOwnerFailures,
    blockedClusters,
    blockedGates,
    failedGates,
    boundaryFlags: input.boundaryFlags,
  });
  const canBecomeTrainingMaterial = result !== "passed";
  const key = [
    input.checkedAt,
    input.source,
    input.repo.statusShortBranch,
    input.repo.dirtyCount,
    firstFailedGate,
    structuralOwnerFailures.join(","),
    blockedGates.join(","),
    failedGates.join(","),
    blockedClusters.join(","),
    input.writtenArtifacts.join(","),
  ].join("|");

  return {
    ok: true,
    kind: "lcx-local-failure-trace",
    boundary: "dev_local_failure_trace_index_only",
    checkedAt: input.checkedAt,
    runId: buildRunId(input.checkedAt, input.source, key),
    source: input.source,
    result,
    firstFailedGate,
    canBecomeTrainingMaterial,
    trainingMaterialReason: canBecomeTrainingMaterial
      ? "blocked_or_failed_owner_output_can_seed_targeted_eval_or_sop"
      : "passed_run_has_no_failure_material",
    nextSafeAction:
      stringifySafe(input.summary.fastestSafeNextAction) ?? "review_first_failed_gate",
    repo: input.repo,
    processSummary: {
      activeHeavy: input.activePidSummary.eval.length > 0 || input.activePidSummary.mlx.length > 0,
      activeTrainingOrEval,
      counts: activeCounts(input.activePidSummary),
    },
    ownerResults: input.ownerCommands.map((owner) => ({
      id: owner.id,
      parsed: owner.parsed,
      ok: owner.ok,
      exitCode: owner.exitCode,
      command: owner.command,
    })),
    blockers: {
      structuralOwnerFailures,
      blockedGates,
      failedGates,
      blockedClusters,
    },
    artifacts: {
      source: [...new Set(input.sourceArtifacts)],
      written: [...new Set(input.writtenArtifacts)],
      latestPath: LOCAL_FAILURE_TRACE_LATEST_PATH,
      jsonlPath: LOCAL_FAILURE_TRACE_JSONL_PATH,
    },
    indexOnly: true,
    notTouched: [
      "live_sender",
      "provider_config",
      "protected_memory",
      "formal_language_corpus",
      "training_processes",
    ],
    liveTouched: input.boundaryFlags.liveTouched,
    providerConfigTouched: input.boundaryFlags.providerConfigTouched,
    protectedMemoryTouched: input.boundaryFlags.protectedMemoryTouched,
  };
}

export type LocalFailureTraceReceipt = ReturnType<typeof buildLocalFailureTraceReceipt>;

export function summarizeTraceForHandoff(receipt: LocalFailureTraceReceipt): string {
  return [
    "## Local Failure Trace",
    "boundary: dev_local_failure_trace_index_only",
    `latestPath: ${LOCAL_FAILURE_TRACE_LATEST_PATH}`,
    `jsonlPath: ${LOCAL_FAILURE_TRACE_JSONL_PATH}`,
    `结果: ${receipt.result}`,
    `第一处卡点: ${receipt.firstFailedGate}`,
    `能否变训练材料: ${receipt.canBecomeTrainingMaterial}`,
    `下一步: ${receipt.nextSafeAction}`,
    "边界: 只做索引，不碰线上、不碰配置、不碰受保护记忆、不启动训练",
  ].join("\n");
}

export async function writeLocalFailureTraceReceipt(receipt: LocalFailureTraceReceipt) {
  await fs.mkdir(path.dirname(LOCAL_FAILURE_TRACE_LATEST_PATH), { recursive: true });
  await fs.mkdir(path.dirname(LOCAL_FAILURE_TRACE_JSONL_PATH), { recursive: true });
  await fs.writeFile(LOCAL_FAILURE_TRACE_LATEST_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
  await fs.appendFile(LOCAL_FAILURE_TRACE_JSONL_PATH, `${JSON.stringify(receipt)}\n`);
}

async function readJson(filePath: string): Promise<JsonRecord | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as JsonRecord;
  } catch {
    return undefined;
  }
}

function parseArgs(args: string[]) {
  const options = {
    json: false,
    write: false,
    autopilotPath: path.join(
      DEFAULT_WORKSPACE_DIR,
      "state",
      "lcx-governance-autopilot-latest.json",
    ),
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--autopilot-path") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--autopilot-path requires a value");
      }
      options.autopilotPath = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        "Usage: node --import tsx scripts/dev/lcx-local-failure-trace.ts [--json] [--write] [--autopilot-path PATH]",
      );
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const autopilot = await readJson(options.autopilotPath);
  if (!autopilot) {
    throw new Error(`Cannot read autopilot JSON: ${options.autopilotPath}`);
  }
  const summary = recordValue(autopilot.summary) ?? {};
  const receipt = buildLocalFailureTraceReceipt({
    checkedAt: new Date().toISOString(),
    workspaceDir:
      typeof autopilot.workspaceDir === "string" ? autopilot.workspaceDir : DEFAULT_WORKSPACE_DIR,
    repo: {
      cwd: process.cwd(),
      statusShortBranch: "",
      dirtyCount: 0,
    },
    activePidSummary: { guard: [], eval: [], mlx: [], teacher: [], quota: [] },
    source: "local_failure_trace_cli",
    sourceArtifacts: [options.autopilotPath],
    writtenArtifacts: options.write
      ? [LOCAL_FAILURE_TRACE_LATEST_PATH, LOCAL_FAILURE_TRACE_JSONL_PATH]
      : [],
    ownerCommands: arrayValue(autopilot.ownerCommands).map((owner) => {
      const record = recordValue(owner) ?? {};
      return {
        id: typeof record.id === "string" ? record.id : "unknown_owner",
        command: typeof record.command === "string" ? record.command : "",
        exitCode: typeof record.exitCode === "number" ? record.exitCode : 0,
        parsed: record.parsed === true,
        ok: typeof record.ok === "boolean" ? record.ok : undefined,
      };
    }),
    summary,
    boundaryFlags: {
      liveTouched: autopilot.liveTouched === true,
      providerConfigTouched: autopilot.providerConfigTouched === true,
      protectedMemoryTouched: autopilot.protectedMemoryTouched === true,
    },
  });
  if (options.write) {
    await writeLocalFailureTraceReceipt(receipt);
  }
  if (options.json) {
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    console.log(summarizeTraceForHandoff(receipt));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
