import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_GUARD_LOG_PATH,
  DEFAULT_WORKSPACE_DIR,
  GOVERNANCE_AUTOPILOT_LATEST_PATH,
  MONOTONIC_DATA_LEDGER_JSONL_PATH,
  MONOTONIC_DATA_LEDGER_LATEST_PATH,
} from "./lcx-local-paths.ts";
import { buildLocalBrainTrainingPlan } from "./local-brain-training-plan.ts";

type JsonRecord = Record<string, unknown>;

type CliOptions = {
  json: boolean;
  write: boolean;
  workspaceDir: string;
  ledgerPath: string;
  latestPath: string;
  autopilotPath: string;
  processCheck: boolean;
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-monotonic-data-ledger.ts [--json] [--write] [--no-process-check]",
      "",
      "Builds a local-only monotonic data ledger entry from local-brain training-plan,",
      "SkillOpt/autopilot snapshots, and promotion truth. With --write it appends",
      "one de-duplicated JSONL row and refreshes the latest state file.",
    ].join("\n"),
  );
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    write: false,
    workspaceDir: DEFAULT_WORKSPACE_DIR,
    ledgerPath: MONOTONIC_DATA_LEDGER_JSONL_PATH,
    latestPath: MONOTONIC_DATA_LEDGER_LATEST_PATH,
    autopilotPath: GOVERNANCE_AUTOPILOT_LATEST_PATH,
    processCheck: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--no-process-check") {
      options.processCheck = false;
    } else if (arg === "--workspace-dir") {
      options.workspaceDir = requireValue(args, (index += 1), arg);
    } else if (arg === "--ledger-path") {
      options.ledgerPath = requireValue(args, (index += 1), arg);
    } else if (arg === "--latest-path") {
      options.latestPath = requireValue(args, (index += 1), arg);
    } else if (arg === "--autopilot-path") {
      options.autopilotPath = requireValue(args, (index += 1), arg);
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }

  return options;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function recordValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return arrayValue(value).filter((entry): entry is string => typeof entry === "string");
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function ledgerKeyValue(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

async function readJsonFile(filePath: string): Promise<JsonRecord | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as JsonRecord;
  } catch {
    return undefined;
  }
}

async function readLatestLedgerEntry(ledgerPath: string): Promise<JsonRecord | undefined> {
  try {
    const content = await fs.readFile(ledgerPath, "utf8");
    const line = content
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .at(-1);
    return line ? (JSON.parse(line) as JsonRecord) : undefined;
  } catch {
    return undefined;
  }
}

function countByStatus(items: unknown[], expected: string): number {
  return items.filter((item) => recordValue(item)?.status === expected).length;
}

function sourceKindTotal(sourceKinds: JsonRecord | undefined): number {
  return Object.values(sourceKinds ?? {}).reduce(
    (sum, value) => sum + (numberValue(value) ?? 0),
    0,
  );
}

function countNonEmpty(values: unknown[]): number {
  return values.filter((value) => {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return value !== undefined && value !== null && value !== "";
  }).length;
}

function compareNumber(current: number | undefined, previous: number | undefined) {
  if (typeof current !== "number") {
    return "unknown";
  }
  if (typeof previous !== "number") {
    return "no_previous";
  }
  if (current > previous) {
    return "increased";
  }
  if (current === previous) {
    return "unchanged";
  }
  return "decreased";
}

function ledgerCountsFromEntry(entry: JsonRecord | undefined) {
  const datasetCounts = recordValue(recordValue(entry?.dataset)?.counts);
  const trainSliceCounts = recordValue(recordValue(entry?.trainSlice)?.counts);
  const dispositions = recordValue(entry?.dispositions);
  return {
    datasetExamples: numberValue(datasetCounts?.examples),
    datasetTrain: numberValue(datasetCounts?.train),
    trainSliceWritten: numberValue(trainSliceCounts?.trainWritten),
    acceptedSkillOptPackets: numberValue(dispositions?.acceptedSkillOptPackets),
    blockedAdapterCandidates: numberValue(dispositions?.blockedAdapterCandidates),
  };
}

function compactEval(evalRecord: JsonRecord | undefined) {
  if (!evalRecord) {
    return undefined;
  }
  return {
    at: evalRecord.at,
    name: evalRecord.name,
    adapterPath: evalRecord.adapterPath,
    passed: evalRecord.passed,
    total: evalRecord.total,
    promotionReady: evalRecord.promotionReady,
    failedCaseIds: evalRecord.failedCaseIds,
    parseErrorCaseIds: evalRecord.parseErrorCaseIds,
    parseRecoveredCaseIds: evalRecord.parseRecoveredCaseIds,
  };
}

export function buildMonotonicDataLedgerSnapshot(params: {
  checkedAt: string;
  workspaceDir: string;
  trainingPlan: JsonRecord;
  skillOptLite?: JsonRecord;
  previousEntry?: JsonRecord;
  write?: boolean;
}) {
  const dataset = recordValue(params.trainingPlan.onDiskLocalBrainDataset);
  const datasetCounts = recordValue(dataset?.counts);
  const sourceKinds = recordValue(dataset?.sourceKinds);
  const trainSlice = recordValue(params.trainingPlan.onDiskTrainSlice);
  const trainSliceCounts = recordValue(trainSlice?.counts);
  const qwenConsolidation = recordValue(params.trainingPlan.qwenCapabilityConsolidation);
  const moduleReview = recordValue(params.trainingPlan.moduleLearningReview);
  const moduleReviewCounts = recordValue(moduleReview?.counts);
  const skillPackets = arrayValue(params.skillOptLite?.skillPackets);
  const latestCandidateEval = recordValue(params.trainingPlan.latestCandidateEval);
  const latestStableEval = recordValue(params.trainingPlan.latestStableEval);
  const latestPassingEval = recordValue(params.trainingPlan.latestPassingEval);
  const latestEval = recordValue(params.trainingPlan.latestEval);
  const currentCounts = {
    datasetExamples: numberValue(datasetCounts?.examples),
    datasetTrain: numberValue(datasetCounts?.train),
    trainSliceWritten: numberValue(trainSliceCounts?.trainWritten),
    acceptedSkillOptPackets: skillPackets.filter((packet) => recordValue(packet)?.accepted === true)
      .length,
    blockedAdapterCandidates: numberValue(qwenConsolidation?.blockedCandidateAdapterCount),
  };
  const previousCounts = ledgerCountsFromEntry(params.previousEntry);
  const acceptedSkillIds = skillPackets
    .map((packet) => recordValue(packet)?.skillId)
    .filter((skillId): skillId is string => typeof skillId === "string");
  const candidatePaths = skillPackets
    .map((packet) => recordValue(packet)?.candidatePath)
    .filter((candidatePath): candidatePath is string => typeof candidatePath === "string");
  const latestCandidateFailureCount =
    stringArray(latestCandidateEval?.failedCaseIds).length +
    stringArray(latestCandidateEval?.parseErrorCaseIds).length +
    stringArray(latestCandidateEval?.parseRecoveredCaseIds).length;
  const downrankedOrWeakModuleLearningCount =
    (numberValue(moduleReviewCounts?.weakModuleLearning) ?? 0) +
    (numberValue(moduleReviewCounts?.invalidReceipts) ?? 0);
  const ledgerEntryKey = [
    ledgerKeyValue(currentCounts.datasetExamples, "na"),
    ledgerKeyValue(currentCounts.datasetTrain, "na"),
    ledgerKeyValue(currentCounts.trainSliceWritten, "na"),
    ledgerKeyValue(latestEval?.at, "no_eval"),
    ledgerKeyValue(latestCandidateEval?.at, "no_candidate"),
    acceptedSkillIds.join(",") || "no_skillopt",
    candidatePaths.join(",") || "no_skillopt_candidates",
  ].join("|");
  const previousEntryKey =
    typeof params.previousEntry?.entryKey === "string" ? params.previousEntry.entryKey : undefined;

  return {
    ok: true,
    boundary: "local_monotonic_data_ledger_only",
    checkedAt: params.checkedAt,
    workspaceDir: params.workspaceDir,
    entryKey: ledgerEntryKey,
    writeRequested: params.write === true,
    appendDecision:
      params.write === true
        ? previousEntryKey === ledgerEntryKey
          ? "duplicate_latest_entry_not_appended"
          : "append_latest_entry"
        : "dry_run_no_append",
    guaranteeLevel: "data_accounting_not_model_capability_guarantee",
    dataset: {
      path: dataset?.path,
      exists: dataset?.exists,
      counts: {
        sourceFiles: numberValue(datasetCounts?.sourceFiles),
        examples: currentCounts.datasetExamples,
        train: currentCounts.datasetTrain,
        valid: numberValue(datasetCounts?.valid),
        test: numberValue(datasetCounts?.test),
      },
      sourceKindCount: Object.keys(sourceKinds ?? {}).length,
      sourceKindTotal: sourceKindTotal(sourceKinds),
      sourceKinds,
    },
    trainSlice: {
      path: trainSlice?.path,
      exists: trainSlice?.exists,
      counts: {
        sourceTrain: numberValue(trainSliceCounts?.sourceTrain),
        curatedSeen: numberValue(trainSliceCounts?.curatedSeen),
        nonReviewSeen: numberValue(trainSliceCounts?.nonReviewSeen),
        reviewSeen: numberValue(trainSliceCounts?.reviewSeen),
        trainWritten: currentCounts.trainSliceWritten,
        validCopied: numberValue(trainSliceCounts?.validCopied),
        testCopied: numberValue(trainSliceCounts?.testCopied),
      },
      policy: trainSlice?.policy,
    },
    dispositions: {
      acceptedSkillOptPackets: currentCounts.acceptedSkillOptPackets,
      pendingSkillOptEvalPackets: countByStatus(
        skillPackets,
        "candidate_edit_static_accepted_pending_eval",
      ),
      acceptedSkillIds,
      rejectedOrBlockedCurrentCandidateCases: latestCandidateFailureCount,
      blockedAdapterCandidates: currentCounts.blockedAdapterCandidates,
      cleanAdapterCandidates: numberValue(qwenConsolidation?.cleanCandidateAdapterCount),
      downrankedOrWeakModuleLearningCount,
      moduleLearningStoredOnly: numberValue(moduleReviewCounts?.storedOnly),
      moduleLearningApplicationReady: numberValue(moduleReviewCounts?.applicationReady),
      moduleLearningEvalAbsorbed: numberValue(moduleReviewCounts?.evalAbsorbed),
    },
    skillOpt: {
      status: params.skillOptLite?.status,
      skillFamilyCount: params.skillOptLite?.skillFamilyCount,
      staticGateOk: params.skillOptLite?.staticGateOk,
      matchedSkillIds: params.skillOptLite?.matchedSkillIds,
      candidatePaths,
      modelWeightAbsorbed: boolValue(
        recordValue(recordValue(params.skillOptLite?.proofChain)?.modelWeightAbsorption)?.[
          "modelWeightAbsorbed"
        ],
      ),
      proofStatus: recordValue(params.skillOptLite?.proofChain)?.modelWeightAbsorption
        ? recordValue(recordValue(params.skillOptLite?.proofChain)?.modelWeightAbsorption)?.status
        : undefined,
    },
    promotion: {
      selectedCleanAdapter:
        params.trainingPlan.selectedCleanAdapter ?? qwenConsolidation?.selectedCleanAdapter,
      latestStableEval: compactEval(latestStableEval),
      latestPassingEval: compactEval(latestPassingEval),
      latestCandidateEval: compactEval(latestCandidateEval),
      latestEval: compactEval(latestEval),
      runtimeMonotonicPolicy: recordValue(qwenConsolidation?.monotonicIntelligenceGuard)
        ?.runtimeInvariant,
      noRegressionGate: recordValue(qwenConsolidation?.monotonicIntelligenceGuard)
        ?.noRegressionGate,
      currentRuntimeStatus: recordValue(qwenConsolidation?.monotonicIntelligenceGuard)
        ?.currentRuntimeStatus,
      latestChallengerStatus: recordValue(qwenConsolidation?.monotonicIntelligenceGuard)
        ?.latestChallengerStatus,
    },
    deltaFromPrevious: {
      previousEntryKey,
      datasetExamples: compareNumber(currentCounts.datasetExamples, previousCounts.datasetExamples),
      datasetTrain: compareNumber(currentCounts.datasetTrain, previousCounts.datasetTrain),
      trainSliceWritten: compareNumber(
        currentCounts.trainSliceWritten,
        previousCounts.trainSliceWritten,
      ),
      acceptedSkillOptPackets: compareNumber(
        currentCounts.acceptedSkillOptPackets,
        previousCounts.acceptedSkillOptPackets,
      ),
      blockedAdapterCandidates: compareNumber(
        currentCounts.blockedAdapterCandidates,
        previousCounts.blockedAdapterCandidates,
      ),
    },
    proofBoundaries: {
      dataIncreaseIsNotCapabilityIncrease: true,
      runtimeMonotonicNotEveryTrainingRound: true,
      modelWeightAbsorptionRequiresPromotionProof: true,
      externalChannelRequiresSeparateUserVisibleProof: true,
      liveExternalRequiresSeparateLiveProof: true,
    },
    materialChangeSignalCount: countNonEmpty([
      compareNumber(currentCounts.datasetExamples, previousCounts.datasetExamples) === "increased",
      compareNumber(currentCounts.datasetTrain, previousCounts.datasetTrain) === "increased",
      compareNumber(currentCounts.trainSliceWritten, previousCounts.trainSliceWritten) ===
        "increased",
      compareNumber(
        currentCounts.acceptedSkillOptPackets,
        previousCounts.acceptedSkillOptPackets,
      ) === "increased",
      latestCandidateFailureCount > 0 ? latestCandidateFailureCount : undefined,
    ]),
    notTouched: [
      "external_channel_sender",
      "provider_config",
      "protected_memory",
      "formal_language_corpus",
      "training_processes",
    ],
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

async function writeLedger(entry: JsonRecord, options: CliOptions): Promise<void> {
  await fs.mkdir(path.dirname(options.latestPath), { recursive: true });
  await fs.writeFile(options.latestPath, `${JSON.stringify(entry, null, 2)}\n`);
  if (entry.appendDecision !== "append_latest_entry") {
    return;
  }
  await fs.mkdir(path.dirname(options.ledgerPath), { recursive: true });
  await fs.appendFile(options.ledgerPath, `${JSON.stringify(entry)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [previousEntry, autopilot] = await Promise.all([
    readLatestLedgerEntry(options.ledgerPath),
    readJsonFile(options.autopilotPath),
  ]);
  const owners = recordValue(autopilot?.owners);
  const trainingPlan = await buildLocalBrainTrainingPlan({
    guardLogPath: DEFAULT_GUARD_LOG_PATH,
    workspaceDir: options.workspaceDir,
    json: true,
    processCheck: options.processCheck,
  });
  const entry = buildMonotonicDataLedgerSnapshot({
    checkedAt: new Date().toISOString(),
    workspaceDir: options.workspaceDir,
    trainingPlan,
    skillOptLite: recordValue(owners?.skillOptLite),
    previousEntry,
    write: options.write,
  });

  if (options.write) {
    await writeLedger(entry, options);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `boundary=${entry.boundary}`,
        `append=${entry.appendDecision}`,
        `dataset_examples=${ledgerKeyValue(
          recordValue(recordValue(entry.dataset)?.counts)?.examples,
          "unknown",
        )}`,
        `train_slice_written=${ledgerKeyValue(
          recordValue(recordValue(entry.trainSlice)?.counts)?.trainWritten,
          "unknown",
        )}`,
        `accepted_skillopt=${ledgerKeyValue(
          recordValue(entry.dispositions)?.acceptedSkillOptPackets,
          "unknown",
        )}`,
        `candidate_blocked_cases=${ledgerKeyValue(
          recordValue(entry.dispositions)?.rejectedOrBlockedCurrentCandidateCases,
          "unknown",
        )}`,
      ].join("\n") + "\n",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
