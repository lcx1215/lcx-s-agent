import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  LOCAL_BRAIN_MODULE_TAXONOMY,
  LOCAL_BRAIN_RISK_BOUNDARIES,
} from "./local-brain-taxonomy.js";
import {
  assessLocalBrainSemanticContract,
  findAnswerBearingContractTokens,
  redactTeacherContractLabels,
} from "./local-brain-training-contract.js";

export type TrainingSampleAuditRow = {
  prompt: string;
  completion: string;
  meta?: Record<string, unknown>;
};

export type TrainingSampleAuditOptions = {
  dataDir: string;
  sliceDir?: string;
};

const DEFAULT_DATA_DIR = path.join(
  process.env.HOME ?? ".",
  ".openclaw",
  "local-brain-trainer",
  "datasets",
  "thought-flow-v1",
);
const DEFAULT_SLICE_DIR = `${DEFAULT_DATA_DIR}-train-slice`;
const COMPLETION_KEYS = [
  "task_family",
  "primary_modules",
  "supporting_modules",
  "required_tools",
  "missing_data",
  "risk_boundaries",
  "next_step",
  "rejected_context",
] as const;
const SOURCE_SUMMARY_OUTPUT_FIELD_PATTERN =
  /["']?(?:candidateText|taskFamily|primaryModules|supportingModules|requiredTools|missingData|riskBoundaries|nextStep|rejectedContext)["']?\s*[:=]/u;
const PROMPT_CONTRACT_FIELD_PATTERN =
  /\b(?:task_family|primary_modules|supporting_modules|required_tools|missing_data|risk_boundaries|next_step|rejected_context|source_summary|source_kind)\b/iu;
const TRAJECTORY_MARKER_PATTERN =
  /\b(?:student|trajectory|rollout|tool_call|tool_result|observation|reward|turn_id|step_id|action_trace)\b/iu;
const CONTRACT_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u;
const CONTRACT_ID_SET = new Set<string>([
  ...LOCAL_BRAIN_MODULE_TAXONOMY,
  ...LOCAL_BRAIN_RISK_BOUNDARIES,
]);

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/local-brain-training-sample-audit.ts [--data DIR] [--slice DIR] [--json]",
      "",
      "Audits local-brain training prompts and completions without writing data or starting model work.",
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

function parseArgs(args: string[]): { dataDir: string; sliceDir?: string; json: boolean } {
  let dataDir = DEFAULT_DATA_DIR;
  let sliceDir: string | undefined = DEFAULT_SLICE_DIR;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--data") {
      dataDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--slice") {
      sliceDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return { dataDir: path.resolve(dataDir), sliceDir, json };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function containsToken(text: string, value: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(value)}(?![A-Za-z0-9_])`, "iu").test(text);
}

function normalized(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function staticPrompt(prompt: string): string {
  const markers = ["\n\nprompt_contract_version:", "\n\nsource_kind:", "\nprompt_contract_version:"]
    .map((marker) => prompt.indexOf(marker))
    .filter((index) => index >= 0);
  const marker = markers.length > 0 ? Math.min(...markers) : -1;
  return marker >= 0 ? prompt.slice(0, marker) : prompt;
}

function dynamicPrompt(prompt: string): {
  sourceKind: string;
  userOrTask: string;
  sourceSummary: string;
} {
  const sourceKind = /^source_kind:\s*([^\n]*)/mu.exec(prompt)?.[1]?.trim() ?? "";
  const userOrTask = /^user_or_task:\s*([^\n]*)/mu.exec(prompt)?.[1]?.trim() ?? "";
  const summaryMarker = prompt.indexOf("\nsource_summary:");
  const sourceSummary = summaryMarker >= 0 ? prompt.slice(summaryMarker + 16).trim() : "";
  return { sourceKind, userOrTask, sourceSummary };
}

function parseCompletion(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringValues(record: Record<string, unknown> | undefined): string[] {
  if (!record) {
    return [];
  }
  const values: string[] = [];
  for (const key of COMPLETION_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) {
      values.push(...value.filter((entry): entry is string => typeof entry === "string"));
    } else if (typeof value === "string") {
      values.push(value);
    }
  }
  return values;
}

function countMap(values: readonly string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].toSorted(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
}

function completionShape(record: Record<string, unknown> | undefined): string {
  if (!record) {
    return "invalid";
  }
  return JSON.stringify(
    COMPLETION_KEYS.map((key) => {
      const value = record[key];
      return [key, Array.isArray(value) ? `array:${value.length}` : typeof value];
    }),
  );
}

function completionKeyOrder(record: Record<string, unknown> | undefined): string {
  return record ? Object.keys(record).join("|") : "invalid";
}

function sourceKindOf(
  row: TrainingSampleAuditRow,
  dynamic: ReturnType<typeof dynamicPrompt>,
): string {
  const fromMeta = row.meta?.sourceKind;
  return typeof fromMeta === "string" && fromMeta.trim() ? fromMeta.trim() : dynamic.sourceKind;
}

function hasStructuredTrajectory(meta: Record<string, unknown> | undefined): boolean {
  return Object.keys(meta ?? {}).some((key) => TRAJECTORY_MARKER_PATTERN.test(key));
}

function rowSignature(row: TrainingSampleAuditRow): string {
  return hashText(`${normalized(row.prompt)}\n${normalized(row.completion)}`);
}

function splitAudit(rows: TrainingSampleAuditRow[], split: string): Record<string, unknown> {
  const promptStaticHashes = rows.map((row) => hashText(staticPrompt(row.prompt)));
  const promptExactHashes = rows.map((row) => hashText(row.prompt));
  const completionHashes = rows.map((row) => hashText(row.completion));
  const pairHashes = rows.map(rowSignature);
  const completions = rows.map((row) => parseCompletion(row.completion));
  const sourceKinds = countMap(
    rows.map((row) => sourceKindOf(row, dynamicPrompt(row.prompt)) || "unknown"),
  );
  const staticPromptCounts = countMap(promptStaticHashes);
  const pairCounts = countMap(pairHashes);
  const shapes = countMap(completions.map(completionShape));
  const keyOrders = countMap(completions.map(completionKeyOrder));
  const contractIdLeakRows = new Set<number>();
  const outputValueLeakRows = new Set<number>();
  const outputValueLeakFields = new Map<string, number>();
  const sourceSummaryOutputFieldRows = new Set<number>();
  const sourceSummaryContractIdRows = new Set<number>();
  const sourceKindRows = new Set<number>();
  const sourceSummaryRows = new Set<number>();
  const trajectoryPromptRows = new Set<number>();
  const trajectoryCompletionRows = new Set<number>();
  const structuredTrajectoryRows = new Set<number>();
  const promptContractFieldRows = new Set<number>();
  const userOrTaskContractFieldRows = new Set<number>();
  const answerBearingPromptTokenRows = new Set<number>();
  const answerBearingPromptTokenFields = new Map<string, number>();
  const leakExamples: Array<Record<string, unknown>> = [];
  const answerBearingPromptTokenExamples: Array<Record<string, unknown>> = [];
  const semanticAlignedRows = new Set<number>();
  const semanticMismatchRows = new Set<number>();
  const semanticUnknownRows = new Set<number>();
  const semanticReasonCounts = new Map<string, number>();
  const semanticMismatchExamples: Array<Record<string, unknown>> = [];

  rows.forEach((row, index) => {
    const dynamic = dynamicPrompt(row.prompt);
    const completion = completions[index];
    const dynamicText = `${dynamic.userOrTask}\n${dynamic.sourceSummary}`.toLowerCase();
    if (dynamic.sourceKind) {
      sourceKindRows.add(index);
    }
    if (dynamic.sourceSummary) {
      sourceSummaryRows.add(index);
    }
    if (PROMPT_CONTRACT_FIELD_PATTERN.test(`${dynamic.userOrTask}\n${dynamic.sourceSummary}`)) {
      promptContractFieldRows.add(index);
    }
    if (PROMPT_CONTRACT_FIELD_PATTERN.test(dynamic.userOrTask)) {
      userOrTaskContractFieldRows.add(index);
    }
    const answerBearingPromptTokens = [
      ["userOrTask", dynamic.userOrTask],
      ["sourceSummary", dynamic.sourceSummary],
    ].flatMap(([field, value]) => {
      const tokens = findAnswerBearingContractTokens(value);
      if (tokens.length > 0) {
        answerBearingPromptTokenFields.set(
          field,
          (answerBearingPromptTokenFields.get(field) ?? 0) + 1,
        );
      }
      return tokens.map((token) => ({ field, token }));
    });
    if (answerBearingPromptTokens.length > 0) {
      answerBearingPromptTokenRows.add(index);
      if (answerBearingPromptTokenExamples.length < 8) {
        answerBearingPromptTokenExamples.push({
          row: index,
          sourceKind: sourceKindOf(row, dynamic),
          hits: answerBearingPromptTokens.slice(0, 8),
        });
      }
    }
    if (SOURCE_SUMMARY_OUTPUT_FIELD_PATTERN.test(dynamic.sourceSummary)) {
      sourceSummaryOutputFieldRows.add(index);
    }
    if (TRAJECTORY_MARKER_PATTERN.test(row.prompt)) {
      trajectoryPromptRows.add(index);
    }
    if (TRAJECTORY_MARKER_PATTERN.test(row.completion)) {
      trajectoryCompletionRows.add(index);
    }
    if (hasStructuredTrajectory(row.meta)) {
      structuredTrajectoryRows.add(index);
    }
    if (SOURCE_SUMMARY_OUTPUT_FIELD_PATTERN.test(dynamic.sourceSummary)) {
      const outputValues = stringValues(completion).filter(
        (value) => CONTRACT_ID_PATTERN.test(value) && containsToken(dynamic.sourceSummary, value),
      );
      if (outputValues.length > 0) {
        sourceSummaryContractIdRows.add(index);
      }
    }
    if (!completion) {
      return;
    }
    const valuesByField = new Map<string, string[]>();
    for (const key of COMPLETION_KEYS) {
      const value = completion[key];
      const values = Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : typeof value === "string"
          ? [value]
          : [];
      valuesByField.set(key, values);
    }
    const hits: Array<{ field: string; value: string; inSourceSummary: boolean }> = [];
    for (const [field, values] of valuesByField) {
      for (const value of values) {
        if (!CONTRACT_ID_PATTERN.test(value) && !CONTRACT_ID_SET.has(value)) {
          continue;
        }
        if (containsToken(dynamicText, value)) {
          outputValueLeakRows.add(index);
          if (CONTRACT_ID_SET.has(value)) {
            contractIdLeakRows.add(index);
          }
          outputValueLeakFields.set(field, (outputValueLeakFields.get(field) ?? 0) + 1);
          hits.push({ field, value, inSourceSummary: containsToken(dynamic.sourceSummary, value) });
        }
      }
    }
    if (hits.length > 0 && leakExamples.length < 8) {
      leakExamples.push({
        row: index,
        sourceKind: sourceKindOf(row, dynamic),
        hits: hits.slice(0, 8),
      });
    }
    if (completion && dynamic.userOrTask) {
      const semantic = assessLocalBrainSemanticContract(
        redactTeacherContractLabels(dynamic.userOrTask),
        completion,
      );
      if (semantic.alignment === "aligned") {
        semanticAlignedRows.add(index);
      } else if (semantic.alignment === "mismatch") {
        semanticMismatchRows.add(index);
        for (const reason of semantic.reasonCodes) {
          semanticReasonCounts.set(reason, (semanticReasonCounts.get(reason) ?? 0) + 1);
        }
        if (semanticMismatchExamples.length < 8) {
          semanticMismatchExamples.push({
            row: index,
            sourceKind: sourceKindOf(row, dynamic),
            missingModules: semantic.missingModules.slice(0, 8),
            missingData: semantic.missingData.slice(0, 8),
            missingRiskBoundaries: semantic.missingRiskBoundaries.slice(0, 8),
          });
        }
      } else {
        semanticUnknownRows.add(index);
      }
    } else {
      semanticUnknownRows.add(index);
    }
  });

  const teacherIndexes = rows
    .map((row, index) =>
      sourceKindOf(row, dynamicPrompt(row.prompt)) === "brain_distillation_review" ? index : -1,
    )
    .filter((index) => index >= 0);
  const teacherPairs = teacherIndexes.map((index) => pairHashes[index]);
  const teacherCompletions = teacherIndexes.map((index) => completionHashes[index]);
  const teacherIndexSet = new Set(teacherIndexes);
  const nonTeacherCompletionHashes = new Set(
    completionHashes.filter((_, index) => !teacherIndexSet.has(index)),
  );
  const teacherLeakRows = teacherIndexes.filter((index) => outputValueLeakRows.has(index));
  const teacherStructuredTrajectoryRows = teacherIndexes.filter((index) =>
    structuredTrajectoryRows.has(index),
  );

  const duplicateRows = pairCounts.reduce((sum, [, count]) => sum + (count > 1 ? count - 1 : 0), 0);
  const modelVisibleLeakRows = new Set([
    ...outputValueLeakRows,
    ...sourceSummaryOutputFieldRows,
    ...sourceSummaryContractIdRows,
    ...promptContractFieldRows,
    ...answerBearingPromptTokenRows,
  ]).size;
  const curriculumReady =
    completions.every((completion) => Boolean(completion)) &&
    modelVisibleLeakRows === 0 &&
    duplicateRows === 0 &&
    semanticMismatchRows.size === 0 &&
    semanticUnknownRows.size === 0;
  const fullCaps = {
    primaryModules: rows.filter((_, index) => {
      const value = completions[index]?.primary_modules;
      return Array.isArray(value) && value.length === 8;
    }).length,
    supportingModules: rows.filter((_, index) => {
      const value = completions[index]?.supporting_modules;
      return Array.isArray(value) && value.length === 6;
    }).length,
    requiredTools: rows.filter((_, index) => {
      const value = completions[index]?.required_tools;
      return Array.isArray(value) && value.length === 6;
    }).length,
    missingData: rows.filter((_, index) => {
      const value = completions[index]?.missing_data;
      return Array.isArray(value) && value.length === 8;
    }).length,
    riskBoundaries: rows.filter((_, index) => {
      const value = completions[index]?.risk_boundaries;
      return Array.isArray(value) && value.length === 6;
    }).length,
    rejectedContext: rows.filter((_, index) => {
      const value = completions[index]?.rejected_context;
      return Array.isArray(value) && value.length === 3;
    }).length,
  };

  return {
    split,
    rows: rows.length,
    invalidCompletions: completions.filter((completion) => !completion).length,
    curriculumReady,
    curriculumGate: {
      boundary: "dev_local_brain_curriculum_readiness_only",
      modelVisibleLeakRows,
      duplicateRows,
      semanticMismatchRows: semanticMismatchRows.size,
      semanticUnknownRows: semanticUnknownRows.size,
      note: "A false gate blocks training-slice use; it is not model-learning or promotion proof.",
    },
    prompt: {
      exactUnique: new Set(promptExactHashes).size,
      staticUnique: new Set(promptStaticHashes).size,
      staticTop: staticPromptCounts.slice(0, 5),
      sourceKindRows: sourceKindRows.size,
      sourceSummaryRows: sourceSummaryRows.size,
    },
    completion: {
      exactUnique: new Set(completionHashes).size,
      keyOrderUnique: new Set(keyOrders.map(([key]) => key)).size,
      keyOrderTop: keyOrders.slice(0, 8),
      shapeUnique: new Set(shapes.map(([shape]) => shape)).size,
      shapeTop: shapes.slice(0, 12),
      fullCaps,
    },
    repetition: {
      exactPairUnique: new Set(pairHashes).size,
      duplicateGroups: pairCounts.filter(([, count]) => count > 1).length,
      duplicateRows,
      duplicateRate: rows.length === 0 ? 0 : Number((duplicateRows / rows.length).toFixed(4)),
    },
    leakage: {
      dynamicOutputValueLeakRows: outputValueLeakRows.size,
      dynamicContractIdLeakRows: contractIdLeakRows.size,
      dynamicOutputValueLeakRate:
        rows.length === 0 ? 0 : Number((outputValueLeakRows.size / rows.length).toFixed(4)),
      dynamicContractIdLeakRate:
        rows.length === 0 ? 0 : Number((contractIdLeakRows.size / rows.length).toFixed(4)),
      outputValueLeakFields: [...outputValueLeakFields.entries()].toSorted(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      ),
      sourceSummaryOutputFieldRows: sourceSummaryOutputFieldRows.size,
      sourceSummaryContractIdRows: sourceSummaryContractIdRows.size,
      promptContractFieldRows: promptContractFieldRows.size,
      userOrTaskContractFieldRows: userOrTaskContractFieldRows.size,
      answerBearingPromptTokenRows: answerBearingPromptTokenRows.size,
      answerBearingPromptTokenRate:
        rows.length === 0
          ? 0
          : Number((answerBearingPromptTokenRows.size / rows.length).toFixed(4)),
      answerBearingPromptTokenFields: [...answerBearingPromptTokenFields.entries()].toSorted(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      ),
      answerBearingPromptTokenExamples,
      examples: leakExamples,
    },
    semanticContract: {
      boundary: "shared_task_semantics_audit_only",
      alignedRows: semanticAlignedRows.size,
      mismatchRows: semanticMismatchRows.size,
      unknownRows: semanticUnknownRows.size,
      alignmentRate:
        rows.length === 0 ? 0 : Number((semanticAlignedRows.size / rows.length).toFixed(4)),
      mismatchReasonCounts: [...semanticReasonCounts.entries()].toSorted(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      ),
      examples: semanticMismatchExamples,
      note: "Semantic mismatch is a curriculum-quality signal, not model-learning or promotion proof.",
    },
    teacherNovelty: {
      rows: teacherIndexes.length,
      uniquePairs: new Set(teacherPairs).size,
      uniqueCompletions: new Set(teacherCompletions).size,
      uniqueCompletionsNotInNonTeacher: new Set(
        teacherCompletions.filter((hash) => !nonTeacherCompletionHashes.has(hash)),
      ).size,
      duplicateRows: teacherPairs.length - new Set(teacherPairs).size,
      promptLabelLeakRows: teacherLeakRows.length,
      sourceSummaryOutputFieldRows: teacherIndexes.filter((index) =>
        sourceSummaryOutputFieldRows.has(index),
      ).length,
      structuredTrajectoryRows: teacherStructuredTrajectoryRows.length,
    },
    studentTrajectoryCoverage: {
      promptMarkerRows: trajectoryPromptRows.size,
      completionMarkerRows: trajectoryCompletionRows.size,
      structuredMetaRows: structuredTrajectoryRows.size,
      rowsWithAnyTrajectoryEvidence: new Set([
        ...trajectoryPromptRows,
        ...trajectoryCompletionRows,
        ...structuredTrajectoryRows,
      ]).size,
    },
    sourceKinds,
  };
}

async function readJsonl(filePath: string): Promise<TrainingSampleAuditRow[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line, index) => {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object") {
        throw new Error(`Invalid JSONL row ${filePath}:${index + 1}`);
      }
      const record = parsed as Record<string, unknown>;
      if (typeof record.prompt !== "string" || typeof record.completion !== "string") {
        throw new Error(`Invalid training row ${filePath}:${index + 1}`);
      }
      return {
        prompt: record.prompt,
        completion: record.completion,
        meta:
          record.meta && typeof record.meta === "object"
            ? (record.meta as Record<string, unknown>)
            : undefined,
      };
    });
}

function overlap(left: TrainingSampleAuditRow[], right: TrainingSampleAuditRow[]): number {
  const rightSignatures = new Set(right.map(rowSignature));
  let shared = 0;
  for (const signature of new Set(left.map(rowSignature))) {
    if (rightSignatures.has(signature)) {
      shared += 1;
    }
  }
  return shared;
}

export async function auditTrainingSamples(
  options: TrainingSampleAuditOptions,
): Promise<Record<string, unknown>> {
  const splitNames = ["train", "valid", "test"] as const;
  const splits: Record<string, TrainingSampleAuditRow[]> = {};
  for (const split of splitNames) {
    splits[split] = await readJsonl(path.join(options.dataDir, `${split}.jsonl`));
  }
  const report: Record<string, unknown> = {
    ok: true,
    curriculumReady: false,
    curriculumGate: {
      boundary: "dev_local_brain_curriculum_readiness_only",
      note: "The top-level gate is finalized from all train/valid/test split audits below.",
    },
    boundary: "dev_local_brain_training_sample_audit_only",
    dataDir: options.dataDir,
    splits: Object.fromEntries(
      splitNames.map((split) => [split, splitAudit(splits[split], split)]),
    ),
    splitOverlap: {
      trainValid: overlap(splits.train, splits.valid),
      trainTest: overlap(splits.train, splits.test),
      validTest: overlap(splits.valid, splits.test),
    },
    recommendedActions: [
      "remove source_summary and answer-bearing case labels (including hyphenated acceptance tokens) from model-visible training prompts; keep provenance in meta or receipts",
      "disable exact-row oversampling by default and stratify teacher reviews without copying rows",
      "require teacher novelty and student-on-policy trajectory evidence before adding distillation rows",
      "keep no-prefill neutral and verified holdout outside the training dataset and promotion proof",
    ],
    notTouched: [
      "training_processes",
      "model_weights",
      "provider_config",
      "external_channel_sender",
      "protected_memory",
    ],
  };
  if (options.sliceDir) {
    const sliceExists = await fs
      .access(path.join(options.sliceDir, "train.jsonl"))
      .then(() => true)
      .catch(() => false);
    if (sliceExists) {
      const sliceSplits: Record<string, TrainingSampleAuditRow[]> = {};
      for (const split of splitNames) {
        sliceSplits[split] = await readJsonl(path.join(options.sliceDir, `${split}.jsonl`));
      }
      report.slice = {
        dataDir: options.sliceDir,
        splits: Object.fromEntries(
          splitNames.map((split) => [split, splitAudit(sliceSplits[split], `slice_${split}`)]),
        ),
        sourceTrainOverlap: overlap(splits.train, sliceSplits.train),
      };
    }
  }
  const splitAudits = report.splits as Record<string, Record<string, unknown>>;
  report.curriculumReady = splitNames.every(
    (split) => splitAudits[split]?.curriculumReady === true,
  );
  report.curriculumGate = {
    boundary: "dev_local_brain_curriculum_readiness_only",
    splitCurriculumReady: Object.fromEntries(
      splitNames.map((split) => [split, splitAudits[split]?.curriculumReady === true]),
    ),
    note: "Only a true gate across every split permits a downstream training-slice decision; no learning or promotion claim follows.",
  };
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cli = parseArgs(process.argv.slice(2));
  const report = await auditTrainingSamples({ dataDir: cli.dataDir, sliceDir: cli.sliceDir });
  if (cli.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const splits = report.splits as Record<string, Record<string, unknown>>;
    const train = splits.train ?? {};
    const prompt = (train.prompt as Record<string, unknown> | undefined) ?? {};
    const repetition = (train.repetition as Record<string, unknown> | undefined) ?? {};
    const leakage = (train.leakage as Record<string, unknown> | undefined) ?? {};
    const teacherNovelty = (train.teacherNovelty as Record<string, unknown> | undefined) ?? {};
    const numberField = (record: Record<string, unknown>, key: string): number =>
      typeof record[key] === "number" ? record[key] : 0;
    process.stdout.write(
      [
        "local brain training sample audit",
        `data_dir=${cli.dataDir}`,
        `train_rows=${numberField(train, "rows")}`,
        `train_prompt_static_unique=${numberField(prompt, "staticUnique")}`,
        `train_duplicate_rate=${numberField(repetition, "duplicateRate")}`,
        `train_dynamic_contract_id_leak_rate=${numberField(leakage, "dynamicContractIdLeakRate")}`,
        `train_answer_bearing_prompt_token_rate=${numberField(leakage, "answerBearingPromptTokenRate")}`,
        `teacher_rows=${numberField(teacherNovelty, "rows")}`,
        `teacher_structured_trajectory_rows=${numberField(teacherNovelty, "structuredTrajectoryRows")}`,
      ].join("\n") + "\n",
    );
  }
}
