import path from "node:path";
import { createModuleLearningPipelinePlanTool } from "../../src/agents/tools/module-learning-pipeline-plan-tool.ts";
import { DEFAULT_WORKSPACE_DIR } from "./lcx-local-paths.ts";

type CliOptions = {
  targetModule?: string;
  sourceUrlOrPath?: string;
  learningIntent?: string;
  actualReadingScope?: string;
  applicationValidationTask?: string;
  existingArtifactPaths: string[];
  sourceRegistryRecordPath?: string;
  retrievalReceiptPath?: string;
  applicationValidationReceiptPath?: string;
  trainingOrEvalAbsorptionEvidencePath?: string;
  freshAdjacentApplicationTask?: string;
  keepDownrankDiscardDecision?: string;
  supersedesReceiptPath?: string;
  workspaceDir: string;
  writeReceipt: boolean;
  json: boolean;
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/module-learning-pipeline-plan.ts --target-module NAME [--source PATH_OR_URL] [--learning-intent TEXT] [--actual-reading-scope TEXT] [--existing-artifact PATH] [--source-registry-record PATH] [--retrieval-receipt PATH] [--application-validation-receipt PATH] [--training-or-eval-absorption-evidence PATH] [--fresh-adjacent-application-task TEXT] [--keep-downrank-discard-decision keep|downrank|discard|not_decided] [--write] [--json]",
      "",
      "Plans one module-learning run through the existing source -> capability -> retrieval/apply -> eval/training absorption chain.",
      "Default is dry-run under ~/.openclaw/workspace. Use --write to create memory/module-learning-pipeline-plan-receipts/<date>/*.json.",
      "This is local only and does not fetch remote content or touch live/provider/protected-memory state.",
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

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    existingArtifactPaths: [],
    workspaceDir: DEFAULT_WORKSPACE_DIR,
    writeReceipt: false,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target-module") {
      options.targetModule = readValue(args, index);
      index += 1;
    } else if (arg === "--source" || arg === "--source-url-or-path") {
      options.sourceUrlOrPath = readValue(args, index);
      index += 1;
    } else if (arg === "--learning-intent") {
      options.learningIntent = readValue(args, index);
      index += 1;
    } else if (arg === "--actual-reading-scope") {
      options.actualReadingScope = readValue(args, index);
      index += 1;
    } else if (arg === "--application-validation-task") {
      options.applicationValidationTask = readValue(args, index);
      index += 1;
    } else if (arg === "--existing-artifact") {
      options.existingArtifactPaths.push(readValue(args, index));
      index += 1;
    } else if (arg === "--source-registry-record") {
      options.sourceRegistryRecordPath = readValue(args, index);
      index += 1;
    } else if (arg === "--retrieval-receipt") {
      options.retrievalReceiptPath = readValue(args, index);
      index += 1;
    } else if (arg === "--application-validation-receipt") {
      options.applicationValidationReceiptPath = readValue(args, index);
      index += 1;
    } else if (arg === "--training-or-eval-absorption-evidence") {
      options.trainingOrEvalAbsorptionEvidencePath = readValue(args, index);
      index += 1;
    } else if (arg === "--fresh-adjacent-application-task") {
      options.freshAdjacentApplicationTask = readValue(args, index);
      index += 1;
    } else if (arg === "--keep-downrank-discard-decision") {
      options.keepDownrankDiscardDecision = readValue(args, index);
      index += 1;
    } else if (arg === "--supersedes-receipt") {
      options.supersedesReceiptPath = readValue(args, index);
      index += 1;
    } else if (arg === "--workspace" || arg === "--worktree") {
      options.workspaceDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--write") {
      options.writeReceipt = true;
    } else if (arg === "--no-write" || arg === "--dry-run") {
      options.writeReceipt = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  if (!options.targetModule) {
    usage();
  }
  return options;
}

function stringValue(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function renderText(details: Record<string, unknown>): string {
  const lines = [
    `Module learning pipeline plan | mode=${details.receiptWritten ? "write" : "dry-run"}`,
    `boundary=${stringValue(details.boundary)}`,
    `target_module=${stringValue(details.targetModule)}`,
    `status=${stringValue(details.status)}`,
    `receipt_path=${stringValue(details.receiptPath, "none")}`,
  ];
  const missingEvidence = stringArrayValue(details.missingEvidence);
  if (missingEvidence.length > 0) {
    lines.push(`missing_evidence=${missingEvidence.join(",")}`);
  }
  lines.push(`claim_boundary=${stringValue(details.claimBoundary)}`);
  return `${lines.join("\n")}\n`;
}

const options = parseArgs(process.argv.slice(2));
const tool = createModuleLearningPipelinePlanTool({ workspaceDir: options.workspaceDir });
const result = await tool.execute("module-learning-pipeline-plan-cli", {
  targetModule: options.targetModule,
  sourceUrlOrPath: options.sourceUrlOrPath,
  learningIntent: options.learningIntent,
  actualReadingScope: options.actualReadingScope,
  applicationValidationTask: options.applicationValidationTask,
  existingArtifactPaths: options.existingArtifactPaths,
  sourceRegistryRecordPath: options.sourceRegistryRecordPath,
  retrievalReceiptPath: options.retrievalReceiptPath,
  applicationValidationReceiptPath: options.applicationValidationReceiptPath,
  trainingOrEvalAbsorptionEvidencePath: options.trainingOrEvalAbsorptionEvidencePath,
  freshAdjacentApplicationTask: options.freshAdjacentApplicationTask,
  keepDownrankDiscardDecision: options.keepDownrankDiscardDecision,
  supersedesReceiptPath: options.supersedesReceiptPath,
  writeReceipt: options.writeReceipt,
});
const details = result.details as Record<string, unknown>;

if (options.json) {
  console.log(JSON.stringify(details, null, 2));
} else {
  process.stdout.write(renderText(details));
}
