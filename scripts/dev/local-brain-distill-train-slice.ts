import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {
  buildLocalBrainTrainingPrompt,
  LOCAL_BRAIN_TRAINING_PROMPT_VERSION,
} from "./local-brain-training-contract.js";

type CliOptions = {
  dataDir: string;
  outDir: string;
  maxReviewExamples: number;
  curatedRepeat: number;
  nonReviewRepeat: number;
  json: boolean;
};

type JsonRecord = {
  prompt?: unknown;
  completion?: unknown;
  meta?: {
    sourceKind?: unknown;
    sourcePath?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type SourceCounts = {
  sourceTrain: number;
  curatedSeen: number;
  nonReviewSeen: number;
  reviewSeen: number;
  sourceKinds: Record<string, number>;
  trustTiers: Record<string, number>;
  teacherQuality: TeacherQualityAccumulator;
  reviewCandidates: ReviewCandidate[];
};

type TeacherQualityAccumulator = {
  total: number;
  qualityTiers: Record<string, number>;
  failureFamilies: Record<string, number>;
  signatureSources: Map<string, string[]>;
};

type ReviewCandidate = {
  index: number;
  signature: string;
  qualityTier: string;
  failureFamily: string;
};

const DEFAULT_DATA_DIR = path.join(
  process.env.HOME ?? ".",
  ".openclaw",
  "local-brain-trainer",
  "datasets",
  "thought-flow-v1",
);
const DEFAULT_OUT_DIR = `${DEFAULT_DATA_DIR}-train-slice`;
const REVIEW_SOURCE_KIND = "brain_distillation_review";
const CURATED_SOURCE_KIND = "curated_seed";
const NON_REVIEW_SOURCE_KINDS_TO_REPEAT = new Set([
  "finance_learning_capability_apply_receipt",
  "feishu_work_receipt",
  "lark_language_handoff_receipt",
  "module_learning_plan_receipt",
  "module_learning_review_receipt",
]);
const SOURCE_KIND_TRUST_TIERS: Record<string, string> = {
  [CURATED_SOURCE_KIND]: "gold_curated",
  [REVIEW_SOURCE_KIND]: "teacher_distillation_review",
  finance_learning_capability_apply_receipt: "workflow_receipt",
  feishu_work_receipt: "workflow_receipt",
  lark_language_handoff_receipt: "workflow_receipt",
  module_learning_plan_receipt: "plan_only_receipt",
  module_learning_review_receipt: "review_only_receipt",
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/local-brain-distill-train-slice.ts [--data DIR] [--out DIR] [--max-review-examples N] [--curated-repeat N] [--non-review-repeat N] [--json]",
      "",
      "Builds a bounded, balanced MLX-LM training slice from the full local-brain dataset.",
    ].join("\n"),
  );
}

function readValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    usage();
  }
  return value;
}

function readPositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    usage();
  }
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    dataDir: DEFAULT_DATA_DIR,
    outDir: DEFAULT_OUT_DIR,
    maxReviewExamples: 1024,
    // A repeated row with a different sourcePath is still the same training
    // signal. Keep the default one pass; callers must opt into repetition
    // explicitly for a bounded experiment.
    curatedRepeat: 1,
    nonReviewRepeat: 1,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--data") {
      options.dataDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--out") {
      options.outDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--max-review-examples") {
      options.maxReviewExamples = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--curated-repeat") {
      options.curatedRepeat = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--non-review-repeat") {
      options.nonReviewRepeat = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

function sourceKindOf(record: JsonRecord): string {
  return typeof record.meta?.sourceKind === "string" ? record.meta.sourceKind : "unknown";
}

function trustTierForSourceKind(sourceKind: string): string {
  return SOURCE_KIND_TRUST_TIERS[sourceKind] ?? "unknown_or_unclassified";
}

function incrementCount(counts: Record<string, number>, key: string, amount = 1): void {
  counts[key] = (counts[key] ?? 0) + amount;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim())
    : [];
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function normalizedContent(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function completionRecord(record: JsonRecord): Record<string, unknown> | undefined {
  if (typeof record.completion !== "string") {
    return undefined;
  }
  const parsed = safeJsonParse(record.completion);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function qualityTierForTeacherReview(record: JsonRecord): string {
  const completion = completionRecord(record);
  if (!completion) {
    return "parse_invalid";
  }
  const taskFamily = readString(completion.task_family);
  const primaryModules = readStringArray(completion.primary_modules);
  const supportingModules = readStringArray(completion.supporting_modules);
  const requiredTools = readStringArray(completion.required_tools);
  const missingData = readStringArray(completion.missing_data);
  const riskBoundaries = readStringArray(completion.risk_boundaries);
  const nextStep = readString(completion.next_step);
  if (!taskFamily || primaryModules.length === 0 || !nextStep) {
    return "contract_incomplete";
  }
  if (!riskBoundaries.includes("research_only")) {
    return "boundary_incomplete";
  }
  if (missingData.length > 8 || riskBoundaries.length > 6) {
    return "overwide_contract";
  }
  if (requiredTools.length === 0 && supportingModules.length === 0) {
    return "weak_tooling";
  }
  return "contract_complete_high_signal";
}

function failureFamilyForTeacherReview(record: JsonRecord): string {
  const completion = completionRecord(record);
  const text = normalizedContent(
    [
      readString(completion?.task_family) ?? "",
      ...readStringArray(completion?.primary_modules),
      ...readStringArray(completion?.supporting_modules),
      ...readStringArray(completion?.required_tools),
      ...readStringArray(completion?.risk_boundaries),
    ].join(" "),
  );
  if (/skill_pattern_distillation|external_agent|cli_anything|skill_harvester/u.test(text)) {
    return "agent_skill_distillation";
  }
  if (/lark|feishu|reply|visible|old_lark|context|language/u.test(text)) {
    return "lark_visible_workflow";
  }
  if (/learning|internalization|receipt|retrieval|module_learning|sedimentation/u.test(text)) {
    return "module_learning_absorption";
  }
  if (/source|vendor|provenance|filing|data_quality|timestamp|official/u.test(text)) {
    return "finance_source_quality";
  }
  if (/portfolio|risk_gate|qqq|tlt|nvda|position|weight/u.test(text)) {
    return "portfolio_risk";
  }
  if (/macro|rates|inflation|credit|liquidity|commodity|oil|gold|fx|cross_asset/u.test(text)) {
    return "macro_cross_asset";
  }
  if (/fundamental|valuation|company|margin|revenue|fcf|roic/u.test(text)) {
    return "company_fundamentals";
  }
  return "general_workflow";
}

function createTeacherQualityAccumulator(): TeacherQualityAccumulator {
  return {
    total: 0,
    qualityTiers: {},
    failureFamilies: {},
    signatureSources: new Map(),
  };
}

function recordTeacherQuality(acc: TeacherQualityAccumulator, record: JsonRecord): void {
  acc.total += 1;
  incrementCount(acc.qualityTiers, qualityTierForTeacherReview(record));
  incrementCount(acc.failureFamilies, failureFamilyForTeacherReview(record));
  const sourcePath =
    typeof record.meta?.sourcePath === "string" ? record.meta.sourcePath : "unknown-source";
  const signature = hashText(
    `${normalizedContent(typeof record.prompt === "string" ? record.prompt : "")}\n${normalizedContent(
      typeof record.completion === "string" ? record.completion : "",
    )}`,
  );
  acc.signatureSources.set(signature, [...(acc.signatureSources.get(signature) ?? []), sourcePath]);
}

function teacherReviewSignature(record: JsonRecord): string {
  return hashText(
    `${normalizedContent(typeof record.prompt === "string" ? record.prompt : "")}\n${normalizedContent(
      typeof record.completion === "string" ? record.completion : "",
    )}`,
  );
}

function reviewCandidateForRecord(index: number, record: JsonRecord): ReviewCandidate {
  return {
    index,
    signature: teacherReviewSignature(record),
    qualityTier: qualityTierForTeacherReview(record),
    failureFamily: failureFamilyForTeacherReview(record),
  };
}

function finishTeacherQualitySummary(
  acc: TeacherQualityAccumulator,
  scope: "source_train" | "written_slice",
): Record<string, unknown> {
  const duplicateGroups = [...acc.signatureSources.entries()]
    .filter(([, sourcePaths]) => sourcePaths.length > 1)
    .map(([signature, sourcePaths]) => ({
      signature,
      count: sourcePaths.length,
      sampleSourcePaths: sourcePaths.slice(0, 5),
    }))
    .toSorted(
      (left, right) => right.count - left.count || left.signature.localeCompare(right.signature),
    );
  return {
    boundary: "dev_teacher_distillation_review_quality_summary_only",
    sourceKind: REVIEW_SOURCE_KIND,
    scope,
    total: acc.total,
    qualityTiers: acc.qualityTiers,
    failureFamilies: acc.failureFamilies,
    dedup: {
      method: "normalized_prompt_completion_sha256_16",
      uniqueContent: acc.signatureSources.size,
      duplicateGroups: duplicateGroups.length,
      duplicateExamples: duplicateGroups.reduce((sum, group) => sum + group.count - 1, 0),
      topDuplicateGroups: duplicateGroups.slice(0, 8),
    },
    selectionBoundary:
      "teacher review quality stats guide bounded sampling; they are not promotion or absorption proof",
  };
}

async function* readJsonl(filePath: string): AsyncGenerator<JsonRecord> {
  const reader = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of reader) {
    if (!line.trim()) {
      continue;
    }
    const parsed = JSON.parse(line) as JsonRecord;
    if (typeof parsed.prompt !== "string" || typeof parsed.completion !== "string") {
      throw new Error(`Invalid distillation line in ${filePath}`);
    }
    yield parsed;
  }
}

async function countSourceKinds(trainPath: string): Promise<SourceCounts> {
  const counts: SourceCounts = {
    sourceTrain: 0,
    curatedSeen: 0,
    nonReviewSeen: 0,
    reviewSeen: 0,
    sourceKinds: {},
    trustTiers: {},
    teacherQuality: createTeacherQualityAccumulator(),
    reviewCandidates: [],
  };
  for await (const record of readJsonl(trainPath)) {
    counts.sourceTrain += 1;
    const sourceKind = sourceKindOf(record);
    incrementCount(counts.sourceKinds, sourceKind);
    incrementCount(counts.trustTiers, trustTierForSourceKind(sourceKind));
    if (sourceKind === CURATED_SOURCE_KIND) {
      counts.curatedSeen += 1;
    } else if (sourceKind === REVIEW_SOURCE_KIND) {
      counts.reviewSeen += 1;
      recordTeacherQuality(counts.teacherQuality, record);
      counts.reviewCandidates.push(reviewCandidateForRecord(counts.reviewSeen - 1, record));
    } else {
      counts.nonReviewSeen += 1;
    }
  }
  return counts;
}

function targetReviewIndexes(
  reviewCandidates: ReviewCandidate[],
  maxReviewExamples: number,
): Set<number> {
  const selectedIndexes = new Set<number>();
  const selectedSignatures = new Set<string>();
  const familyQueues = new Map<string, ReviewCandidate[]>();
  const candidates = reviewCandidates.toSorted((left, right) => {
    const qualityOrder =
      Number(right.qualityTier === "contract_complete_high_signal") -
      Number(left.qualityTier === "contract_complete_high_signal");
    return qualityOrder || left.index - right.index;
  });
  for (const candidate of candidates) {
    familyQueues.set(candidate.failureFamily, [
      ...(familyQueues.get(candidate.failureFamily) ?? []),
      candidate,
    ]);
  }
  const families = [...familyQueues.keys()].toSorted(
    (left, right) =>
      (familyQueues.get(right)?.length ?? 0) - (familyQueues.get(left)?.length ?? 0) ||
      left.localeCompare(right),
  );
  while (selectedIndexes.size < maxReviewExamples) {
    let selectedThisRound = false;
    for (const family of families) {
      if (selectedIndexes.size >= maxReviewExamples) {
        break;
      }
      const queue = familyQueues.get(family) ?? [];
      while (queue.length > 0) {
        const candidate = queue.shift();
        if (!candidate || selectedSignatures.has(candidate.signature)) {
          continue;
        }
        selectedIndexes.add(candidate.index);
        selectedSignatures.add(candidate.signature);
        selectedThisRound = true;
        break;
      }
    }
    if (!selectedThisRound) {
      break;
    }
  }
  if (selectedIndexes.size < Math.min(reviewCandidates.length, maxReviewExamples)) {
    for (const candidate of reviewCandidates) {
      if (selectedIndexes.size >= maxReviewExamples) {
        break;
      }
      selectedIndexes.add(candidate.index);
    }
  }
  return selectedIndexes;
}

function cloneForSlice(record: JsonRecord, repeat: number, lane: string): JsonRecord {
  const sourcePath =
    typeof record.meta?.sourcePath === "string" ? record.meta.sourcePath : "unknown-source";
  const { prompt, rewritten } = normalizePromptContract(record);
  return {
    ...record,
    prompt,
    meta: {
      ...record.meta,
      sourcePath: `${sourcePath}#train-slice-${lane}-${repeat + 1}`,
      curriculumSlice: true,
      promptContractVersion: LOCAL_BRAIN_TRAINING_PROMPT_VERSION,
      promptContractRewritten: rewritten,
    },
  };
}

function normalizePromptContract(record: JsonRecord): { prompt: string; rewritten: boolean } {
  const rawPrompt = typeof record.prompt === "string" ? record.prompt : "";
  const userAsk = /^user_or_task:\s*([^\n]*)/mu.exec(rawPrompt)?.[1]?.trim();
  const hasLegacySourceContext =
    rawPrompt.includes("\nsource_kind:") || rawPrompt.includes("\nsource_summary:");
  return {
    prompt:
      userAsk && hasLegacySourceContext ? buildLocalBrainTrainingPrompt({ userAsk }) : rawPrompt,
    rewritten: Boolean(userAsk && hasLegacySourceContext),
  };
}

async function writeFileAtomic(filePath: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(tempPath, content);
  await fs.rename(tempPath, filePath);
}

async function rewritePromptContractFile(
  sourcePath: string,
  outPath: string,
): Promise<{ rows: number; rewritten: number; legacyUnrewritten: number }> {
  const lines: string[] = [];
  let rows = 0;
  let rewritten = 0;
  let legacyUnrewritten = 0;
  for await (const record of readJsonl(sourcePath)) {
    const normalized = normalizePromptContract(record);
    const prompt = normalized.prompt;
    const hasLegacySourceContext =
      prompt.includes("\nsource_summary:") || prompt.includes("\nsource_kind:");
    if (normalized.rewritten) {
      rewritten += 1;
    } else if (hasLegacySourceContext) {
      legacyUnrewritten += 1;
    }
    lines.push(
      JSON.stringify({
        ...record,
        prompt,
        meta: {
          ...record.meta,
          promptContractVersion: LOCAL_BRAIN_TRAINING_PROMPT_VERSION,
          promptContractRewritten: normalized.rewritten,
        },
      }),
    );
    rows += 1;
  }
  await writeFileAtomic(outPath, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  return { rows, rewritten, legacyUnrewritten };
}

async function buildTrainSlice(options: CliOptions): Promise<Record<string, unknown>> {
  const trainPath = path.join(options.dataDir, "train.jsonl");
  const counts = await countSourceKinds(trainPath);
  const selectedReviewIndexes = targetReviewIndexes(
    counts.reviewCandidates,
    options.maxReviewExamples,
  );
  const trainOut = path.join(options.outDir, "train.jsonl");
  await fs.mkdir(options.outDir, { recursive: true });
  const tempTrainOut = path.join(options.outDir, `.train.jsonl.${process.pid}.${Date.now()}.tmp`);
  const handle = await fs.open(tempTrainOut, "w");
  let trainWritten = 0;
  let reviewIndex = 0;
  let reviewSelected = 0;
  let curatedWritten = 0;
  let nonReviewWritten = 0;
  const writtenSourceKinds: Record<string, number> = {};
  const writtenTrustTiers: Record<string, number> = {};
  const writtenTeacherQuality = createTeacherQualityAccumulator();
  const writtenPairCounts = new Map<string, number>();
  let promptContractRewritten = 0;
  let promptContractLegacyUnrewritten = 0;

  function recordWrite(sourceKind: string): void {
    incrementCount(writtenSourceKinds, sourceKind);
    incrementCount(writtenTrustTiers, trustTierForSourceKind(sourceKind));
  }

  async function writeSliceRecord(record: JsonRecord, repeat: number, lane: string): Promise<void> {
    const cloned = cloneForSlice(record, repeat, lane);
    const prompt = typeof cloned.prompt === "string" ? cloned.prompt : "";
    const completion = typeof cloned.completion === "string" ? cloned.completion : "";
    await handle.write(`${JSON.stringify(cloned)}\n`);
    if (cloned.meta?.promptContractRewritten === true) {
      promptContractRewritten += 1;
    } else if (prompt.includes("\nsource_summary:") || prompt.includes("\nsource_kind:")) {
      promptContractLegacyUnrewritten += 1;
    }
    const pair = hashText(`${normalizedContent(prompt)}\n${normalizedContent(completion)}`);
    writtenPairCounts.set(pair, (writtenPairCounts.get(pair) ?? 0) + 1);
  }

  try {
    for await (const record of readJsonl(trainPath)) {
      const sourceKind = sourceKindOf(record);
      if (sourceKind === CURATED_SOURCE_KIND) {
        for (let repeat = 0; repeat < options.curatedRepeat; repeat += 1) {
          await writeSliceRecord(record, repeat, "curated");
          trainWritten += 1;
          curatedWritten += 1;
          recordWrite(sourceKind);
        }
      } else if (sourceKind === REVIEW_SOURCE_KIND) {
        if (selectedReviewIndexes.has(reviewIndex)) {
          await writeSliceRecord(record, 0, "review");
          trainWritten += 1;
          reviewSelected += 1;
          recordWrite(sourceKind);
          recordTeacherQuality(writtenTeacherQuality, record);
        }
        reviewIndex += 1;
      } else {
        const repeatCount = NON_REVIEW_SOURCE_KINDS_TO_REPEAT.has(sourceKind)
          ? options.nonReviewRepeat
          : 1;
        for (let repeat = 0; repeat < repeatCount; repeat += 1) {
          await writeSliceRecord(record, repeat, "non-review");
          trainWritten += 1;
          nonReviewWritten += 1;
          recordWrite(sourceKind);
        }
      }
    }
  } finally {
    await handle.close();
  }
  await fs.rename(tempTrainOut, trainOut);

  const validPromptContract = await rewritePromptContractFile(
    path.join(options.dataDir, "valid.jsonl"),
    path.join(options.outDir, "valid.jsonl"),
  );
  const testPromptContract = await rewritePromptContractFile(
    path.join(options.dataDir, "test.jsonl"),
    path.join(options.outDir, "test.jsonl"),
  );
  const duplicateRows = [...writtenPairCounts.values()].reduce(
    (sum, count) => sum + (count > 1 ? count - 1 : 0),
    0,
  );

  const manifest = {
    ok: true,
    boundary: "local_auxiliary_thought_flow_only",
    sourceDataDir: options.dataDir,
    outDir: options.outDir,
    policy: {
      selection: "curated_first_non_review_teacher_quality_family_dedup_sample",
      maxReviewExamples: options.maxReviewExamples,
      curatedRepeat: options.curatedRepeat,
      nonReviewRepeat: options.nonReviewRepeat,
      defaultExactRowRepeatDisabled: true,
    },
    counts: {
      sourceTrain: counts.sourceTrain,
      curatedSeen: counts.curatedSeen,
      nonReviewSeen: counts.nonReviewSeen,
      reviewSeen: counts.reviewSeen,
      reviewSelected,
      curatedWritten,
      nonReviewWritten,
      trainWritten,
      validCopied: validPromptContract.rows,
      testCopied: testPromptContract.rows,
    },
    repetition: {
      boundary: "exact_prompt_completion_pair_repetition_only",
      exactPairUnique: writtenPairCounts.size,
      duplicateGroups: [...writtenPairCounts.values()].filter((count) => count > 1).length,
      duplicateRows,
      duplicateRate: trainWritten === 0 ? 0 : Number((duplicateRows / trainWritten).toFixed(4)),
      note: "meta.sourcePath changes do not make a duplicated prompt/completion pair novel; use explicit repeat flags only for controlled ablations.",
    },
    promptContract: {
      version: LOCAL_BRAIN_TRAINING_PROMPT_VERSION,
      sourceKindAndSourceSummaryInModelPrompt: promptContractLegacyUnrewritten === 0,
      rowsRewrittenFromLegacyPrompt: promptContractRewritten,
      legacyRowsStillContainingSourceContext: promptContractLegacyUnrewritten,
      validRowsRewrittenFromLegacyPrompt: validPromptContract.rewritten,
      validLegacyRowsStillContainingSourceContext: validPromptContract.legacyUnrewritten,
      testRowsRewrittenFromLegacyPrompt: testPromptContract.rewritten,
      testLegacyRowsStillContainingSourceContext: testPromptContract.legacyUnrewritten,
      note: "Legacy rows with a user_or_task line are rebuilt through the shared contract; rows without recoverable user text remain visible for manual review rather than being guessed.",
    },
    sourceKinds: counts.sourceKinds,
    writtenSourceKinds,
    teacherReviewQuality: {
      boundary: "dev_teacher_distillation_review_quality_summary_only",
      sourceTrain: finishTeacherQualitySummary(counts.teacherQuality, "source_train"),
      writtenSlice: finishTeacherQualitySummary(writtenTeacherQuality, "written_slice"),
    },
    sampleTrust: {
      boundary: "dev_local_brain_sample_trust_summary_only",
      sourceTrustTiers: SOURCE_KIND_TRUST_TIERS,
      sourceTrustTierCounts: counts.trustTiers,
      writtenTrustTierCounts: writtenTrustTiers,
      highestTrustSourceKind: CURATED_SOURCE_KIND,
      largestTeacherSourceKind: REVIEW_SOURCE_KIND,
      hardEvalProofSeparateFromTrainingSamples: true,
      teacherDistillationIsTrainingMaterialNotPromotionProof: true,
      planAndReviewReceiptsAreWorkflowEvidenceNotAbsorptionProof: true,
      recommendedNextHardening: [
        "expand_curated_seed_gold_set",
        "keep_teacher_reviews_bounded_in_train_slice",
        "stratify_teacher_reviews_by_failure_family_and_quality",
        "grow_hardened_eval_by_capability_family",
      ],
    },
    notTouched: [
      "external_channel_sender",
      "provider_config",
      "protected_repo_memory",
      "formal_lark_routing_corpus",
      "finance_doctrine",
    ],
  };
  await writeFileAtomic(
    path.join(options.outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

const options = parseArgs(process.argv.slice(2));
const manifest = await buildTrainSlice(options);
if (options.json) {
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} else {
  process.stdout.write(
    [
      "local brain training slice built",
      `out_dir=${options.outDir}`,
      `train=${(manifest.counts as { trainWritten: number }).trainWritten}`,
    ].join("\n") + "\n",
  );
}
