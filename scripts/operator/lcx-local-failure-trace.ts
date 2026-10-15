import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertValidLcxOntologyEdges,
  LCX_ONTOLOGY_EVIDENCE_KINDS,
  LCX_ONTOLOGY_EVIDENCE_STATUSES,
} from "../../src/shared/lcx-ontology.ts";
import {
  boundaryFromFlags,
  buildLcxRunReceipt,
  createLcxRunId,
  LCX_RUN_RECEIPT_CONTRACT_VERSION,
  type LcxRunReceipt,
  type LcxRunSnapshot,
} from "../../src/shared/lcx-run-receipt.ts";
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
  runReceipt?: LcxRunReceipt;
};

export type FailureTraceInput = {
  checkedAt: string;
  snapshot?: LcxRunSnapshot;
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
  const exitFailure = params.ownerCommands.find(
    (owner) => owner.exitCode !== 0 && owner.runReceipt?.status !== "blocked",
  );
  if (exitFailure) {
    return `owner_exit_failed:${exitFailure.id}`;
  }
  const failedOwner = params.ownerCommands.find((owner) => owner.runReceipt?.status === "failed");
  if (failedOwner) {
    return `owner_failed:${failedOwner.id}`;
  }
  if (params.activePidSummary.eval.length > 0 || params.activePidSummary.mlx.length > 0) {
    return "active_eval_or_mlx";
  }
  const blockedOwner = params.ownerCommands.find((owner) => owner.runReceipt?.status === "blocked");
  return (
    params.blockedGates[0] ??
    params.failedGates[0] ??
    params.structuralOwnerFailures[0] ??
    params.blockedClusters[0] ??
    (blockedOwner ? `owner_blocked:${blockedOwner.id}` : undefined) ??
    "none"
  );
}

function inferResult(params: {
  firstFailedGate: string;
  ownerCommands: FailureTraceOwnerCommand[];
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
    params.firstFailedGate.startsWith("owner_exit_failed:") ||
    params.ownerCommands.some((owner) => owner.runReceipt?.status === "failed")
  ) {
    return "failed";
  }
  if (
    params.activeTrainingOrEval ||
    params.structuralOwnerFailures.length > 0 ||
    params.blockedGates.length > 0 ||
    params.failedGates.length > 0 ||
    params.blockedClusters.length > 0 ||
    params.ownerCommands.some((owner) => owner.runReceipt?.status === "blocked")
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
    ownerCommands: input.ownerCommands,
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

  const runId = createLcxRunId({ checkedAt: input.checkedAt, owner: input.source, key });
  const nextAction =
    stringifySafe(input.summary.fastestSafeNextAction) ??
    input.ownerCommands.find((owner) => owner.runReceipt?.status === "failed")?.runReceipt
      ?.nextAction ??
    input.ownerCommands.find((owner) => owner.runReceipt?.status === "blocked")?.runReceipt
      ?.nextAction ??
    "review_first_failed_gate";
  const runReceipt = buildLcxRunReceipt({
    runId,
    owner: input.source,
    phase: "handoff",
    status: result,
    checkedAt: input.checkedAt,
    snapshot: input.snapshot,
    boundary: boundaryFromFlags({
      scope: "local_failure_trace_index_only",
      externalSenderTouched: input.boundaryFlags.liveTouched,
      providerConfigTouched: input.boundaryFlags.providerConfigTouched,
      protectedMemoryTouched: input.boundaryFlags.protectedMemoryTouched,
    }),
    evidence: input.ownerCommands.map((owner) => ({
      id: `owner:${owner.id}`,
      kind: "proof" as const,
      status: owner.parsed ? "present" : "missing",
      owner: input.source,
      locator: owner.command,
      detail: owner.parsed
        ? `exitCode=${owner.exitCode}; ok=${String(owner.ok ?? "unknown")}`
        : "owner output was not parsed",
    })),
    nextAction,
  });

  return {
    ok: true,
    kind: "lcx-local-failure-trace",
    boundary: "local_failure_trace_index_only",
    checkedAt: input.checkedAt,
    snapshot: runReceipt.snapshot,
    runId,
    runReceipt,
    source: input.source,
    result,
    firstFailedGate,
    canBecomeTrainingMaterial,
    trainingMaterialReason: canBecomeTrainingMaterial
      ? "blocked_or_failed_owner_output_can_seed_targeted_eval_or_sop"
      : "passed_run_has_no_failure_material",
    nextSafeAction: nextAction,
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
      ...(owner.runReceipt ? { runReceipt: owner.runReceipt } : {}),
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
      "external_channel_sender",
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
    "boundary: local_failure_trace_index_only",
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

function readbackRunReceipt(value: unknown): LcxRunReceipt {
  const row = recordValue(value);
  if (
    !row ||
    row.contractVersion !== LCX_RUN_RECEIPT_CONTRACT_VERSION ||
    !recordValue(row.snapshot) ||
    !recordValue(row.boundary) ||
    !Array.isArray(row.evidence) ||
    !Array.isArray(row.ontologyEdges) ||
    row.evidence.some((item) => {
      const evidence = recordValue(item);
      return (
        !evidence ||
        !LCX_ONTOLOGY_EVIDENCE_KINDS.some((kind) => kind === evidence.kind) ||
        !LCX_ONTOLOGY_EVIDENCE_STATUSES.some((status) => status === evidence.status)
      );
    })
  ) {
    throw new Error("source_run_receipt_invalid");
  }
  // The original constructor validates identity, time, boundary and ontology at this JSON boundary.
  const edges = row.ontologyEdges as LcxRunReceipt["ontologyEdges"];
  assertValidLcxOntologyEdges(edges, "failure trace source receipt ontology");
  const generated = edges.filter(
    (edge) =>
      edge.relation === "produces" &&
      edge.subject.type === "module" &&
      edge.subject.id === row.owner &&
      edge.object.type === "receipt" &&
      edge.object.id === row.runId,
  );
  if (generated.length !== 1) {
    throw new Error("source_receipt_producer_missing");
  }
  // The constructor adds its own producer edge; retain original validated edge bytes in readback.
  const normalized = buildLcxRunReceipt({
    ...(row as unknown as LcxRunReceipt),
    ontologyEdges: edges.filter((edge) => edge !== generated[0]),
  });
  return { ...normalized, ontologyEdges: edges };
}

export async function readFailureTraceSource(filePath: string, expectedSha256?: string) {
  let sha256: string | undefined;
  try {
    const bytes = await fs.readFile(filePath);
    sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (expectedSha256 && (!/^[a-f0-9]{64}$/u.test(expectedSha256) || expectedSha256 !== sha256)) {
      throw new Error("source_hash_conflict");
    }
    const autopilot = recordValue(JSON.parse(bytes.toString("utf8")));
    if (!autopilot || !Array.isArray(autopilot.ownerCommands)) {
      throw new Error("source_owner_commands_missing");
    }
    const scoped =
      autopilot.runReceipt !== undefined ||
      autopilot.ownerCommands.some((owner) => recordValue(owner)?.runReceipt !== undefined);
    if (scoped && autopilot.runReceipt === undefined) {
      throw new Error("source_parent_receipt_missing");
    }
    const parent = scoped ? readbackRunReceipt(autopilot.runReceipt) : undefined;
    const matchesSnapshot = (value: unknown) => {
      const snapshot = recordValue(value);
      return (
        snapshot &&
        parent &&
        Object.entries(parent.snapshot).every(([key, item]) => snapshot[key] === item)
      );
    };
    if (
      parent &&
      (parent.owner !== "lcx-governance-autopilot" ||
        autopilot.runId !== parent.runId ||
        autopilot.checkedAt !== parent.checkedAt ||
        !matchesSnapshot(autopilot.snapshot))
    ) {
      throw new Error("source_parent_scope_conflict");
    }
    const owners = autopilot.ownerCommands.map((value) => {
      const row = recordValue(value) ?? {};
      const owner: FailureTraceOwnerCommand = {
        id: typeof row.id === "string" ? row.id : "unknown_owner",
        command: typeof row.command === "string" ? row.command : "",
        exitCode: typeof row.exitCode === "number" ? row.exitCode : 0,
        parsed: row.parsed === true,
        ok: typeof row.ok === "boolean" ? row.ok : undefined,
      };
      if (parent) {
        if (
          !owner.id.trim() ||
          owner.id === "unknown_owner" ||
          !owner.command.trim() ||
          typeof row.parsed !== "boolean" ||
          !Number.isInteger(row.exitCode)
        ) {
          throw new Error(`source_owner_fields_invalid:${owner.id}`);
        }
        if (row.runReceipt === undefined) {
          throw new Error(`source_owner_receipt_missing:${owner.id}`);
        }
        const receipt = readbackRunReceipt(row.runReceipt);
        if (
          receipt.owner !== owner.id ||
          receipt.parentRunId !== parent.runId ||
          receipt.checkedAt !== parent.checkedAt ||
          !matchesSnapshot(receipt.snapshot)
        ) {
          throw new Error(`source_owner_scope_conflict:${owner.id}`);
        }
        owner.runReceipt = receipt;
      }
      return owner;
    });
    const seenOwners = new Set<string>();
    for (const owner of owners) {
      if (seenOwners.has(owner.id)) {
        throw new Error(`source_owner_id_duplicate:${owner.id}`);
      }
      seenOwners.add(owner.id);
    }
    return {
      autopilot,
      parent,
      owners,
      sourceReadback: {
        status: parent ? "validated" : "legacy_unverified",
        reason: parent ? "source_parent_snapshot_consistent" : "legacy_owner_receipts_not_provided",
        path: filePath,
        sha256,
        hashValidation: expectedSha256 ? "pinned" : "not_requested",
        identityValidation: parent ? "same_source_parent_snapshot_only" : "not_verified",
        semanticTruth: "not_proven",
        readAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return {
      autopilot: {} as JsonRecord,
      parent: undefined,
      owners: [] as FailureTraceOwnerCommand[],
      sourceReadback: {
        status: "blocked",
        reason: error instanceof Error ? error.message : String(error),
        path: filePath,
        sha256,
        hashValidation: expectedSha256
          ? sha256 === expectedSha256
            ? "pinned"
            : "pin_failed"
          : "not_requested",
        identityValidation: "not_verified",
        semanticTruth: "not_proven",
        readAt: new Date().toISOString(),
      },
    };
  }
}

function parseArgs(args: string[]) {
  const options = {
    json: false,
    write: false,
    autopilotSha256: undefined as string | undefined,
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
    } else if (arg === "--autopilot-sha256") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--autopilot-sha256 requires a value");
      }
      options.autopilotSha256 = value;
      index += 1;
    } else if (arg === "--autopilot-path") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--autopilot-path requires a value");
      }
      options.autopilotPath = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        "Usage: node --import tsx scripts/operator/lcx-local-failure-trace.ts [--json] [--write] [--autopilot-path PATH] [--autopilot-sha256 SHA256]",
      );
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = await readFailureTraceSource(options.autopilotPath, options.autopilotSha256);
  const autopilot = source.autopilot;
  const blocked = source.sourceReadback.status === "blocked";
  const summary = blocked
    ? {
        blockedGates: [`source_readback_blocked:${source.sourceReadback.reason}`],
        fastestSafeNextAction: "repair_original_failure_trace_source",
      }
    : (recordValue(autopilot.summary) ?? {});
  const receipt = buildLocalFailureTraceReceipt({
    checkedAt: source.parent?.checkedAt ?? new Date().toISOString(),
    snapshot: source.parent?.snapshot,
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
    ownerCommands: source.owners,
    summary,
    boundaryFlags: {
      liveTouched: autopilot.liveTouched === true,
      providerConfigTouched: autopilot.providerConfigTouched === true,
      protectedMemoryTouched: autopilot.protectedMemoryTouched === true,
    },
  });
  const output = {
    ...receipt,
    ...(source.parent
      ? { runReceipt: { ...receipt.runReceipt, parentRunId: source.parent.runId } }
      : {}),
    ok: !blocked,
    sourceReadback: source.sourceReadback,
  };
  if (options.write) {
    await writeLocalFailureTraceReceipt(output);
  }
  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(summarizeTraceForHandoff(output));
  }
  if (blocked) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
