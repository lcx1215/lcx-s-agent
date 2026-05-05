import fs from "node:fs/promises";
import path from "node:path";
import {
  LARK_BRAIN_DISTILLATION_CANDIDATE_DIR,
  LARK_BRAIN_DISTILLATION_REVIEW_DIR,
  type LarkBrainDistillationCandidate,
  type LarkBrainDistillationCandidateArtifact,
  type LarkBrainDistillationReviewArtifact,
} from "../../extensions/feishu/src/lark-brain-distillation-candidates.js";

type CliOptions = {
  workspaceDir: string;
  maxFiles: number;
  write: boolean;
  json: boolean;
};

type CandidateRead = {
  sourcePath: string;
  artifact: LarkBrainDistillationCandidateArtifact;
};

const DEFAULT_WORKSPACE = path.join(process.env.HOME ?? ".", ".openclaw", "workspace");

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lark-brain-distillation-review.ts [--workspace DIR] [--max-files N] [--write] [--json]",
      "",
      "Reviews pending brain-distillation candidates and writes accepted review artifacts only when --write is set.",
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

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    usage();
  }
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    workspaceDir: DEFAULT_WORKSPACE,
    maxFiles: 100,
    write: false,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workspace") {
      options.workspaceDir = readValue(args, index);
      index += 1;
    } else if (arg === "--max-files") {
      options.maxFiles = positiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  options.workspaceDir = path.resolve(options.workspaceDir);
  return options;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectJsonFiles(root: string, maxFiles: number): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }
  const files: Array<{ filePath: string; mtimeMs: number }> = [];
  async function walk(dir: string): Promise<void> {
    if (files.length >= maxFiles) {
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        const stat = await fs.stat(fullPath);
        files.push({ filePath: fullPath, mtimeMs: stat.mtimeMs });
      }
    }
  }
  await walk(root);
  return files
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles)
    .map((entry) => entry.filePath);
}

async function readCandidateArtifact(
  filePath: string,
  workspaceDir: string,
): Promise<CandidateRead | undefined> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<LarkBrainDistillationCandidateArtifact>;
  if (parsed.boundary !== "brain_distillation_candidate" || !Array.isArray(parsed.candidates)) {
    return undefined;
  }
  return {
    sourcePath: path.relative(workspaceDir, filePath).split(path.sep).join("/"),
    artifact: parsed as LarkBrainDistillationCandidateArtifact,
  };
}

function mergeUnique(...groups: readonly string[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of groups.flat()) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(normalized);
  }
  return merged;
}

function textOf(candidate: LarkBrainDistillationCandidate): string {
  return [candidate.userMessage, candidate.candidateText].filter(Boolean).join("\n");
}

function hardenAcceptedCandidate(
  candidate: LarkBrainDistillationCandidate,
): LarkBrainDistillationCandidate {
  const text = textOf(candidate);
  let modules = candidate.proposedPrimaryModules ?? [];
  let tools = candidate.proposedRequiredTools ?? [];
  let missingData = candidate.proposedMissingData ?? [];
  let riskBoundaries = (candidate.proposedRiskBoundaries ?? []).filter(
    (entry) => !["language_routing_only", "language_routing_required"].includes(entry),
  );
  if (
    /(google scholar|ssrn|nber|arxiv|working paper|preprint|论文|paper|网页|source|citation|url|链接)/iu.test(
      text,
    )
  ) {
    modules = mergeUnique(modules, ["finance_learning_memory", "source_registry"]);
    tools = mergeUnique(tools, [
      "finance_article_source_collection_preflight",
      "finance_article_source_registry_record",
      "finance_learning_retrieval_review",
    ]);
    missingData = mergeUnique(missingData, ["source_url_or_local_source_path"]);
  }
  if (/(google scholar|ssrn|nber|全覆盖|读过哪些|coverage|actual read|实际读过)/iu.test(text)) {
    modules = mergeUnique(modules, ["causal_map"]);
    missingData = mergeUnique(missingData, ["actual_reading_scope", "source_coverage_limits"]);
    riskBoundaries = mergeUnique(riskBoundaries, ["do_not_claim_exhaustive_coverage"]);
  }
  if (
    /(nvda|aapl|msft|googl|goog|amzn|meta|tsla|公司|基本面|fundamental|capex|revenue|margin|earnings|估值)/iu.test(
      text,
    ) &&
    /(组合|持仓|仓位|科技仓|portfolio|sleeve|风险|risk|传导|连接|影响)/iu.test(text)
  ) {
    modules = mergeUnique(modules, [
      "company_fundamentals_value",
      "causal_map",
      "portfolio_risk_gates",
    ]);
    tools = mergeUnique(tools, [
      "finance_framework_company_fundamentals_value_producer",
      "finance_framework_causal_map_producer",
      "finance_framework_portfolio_risk_gates_producer",
    ]);
    missingData = mergeUnique(missingData, [
      "latest_company_fundamental_inputs",
      "portfolio_weights_and_risk_limits",
      "company_to_portfolio_exposure_map",
    ]);
  }
  riskBoundaries = mergeUnique(riskBoundaries, [
    "research_only",
    "no_execution_authority",
    "evidence_required",
    "no_model_math_guessing",
  ]);
  return {
    ...candidate,
    status: "accepted_brain_plan",
    proposedPrimaryModules: modules,
    proposedSupportingModules: mergeUnique(candidate.proposedSupportingModules ?? [], [
      "review_panel",
      "control_room_summary",
    ]),
    proposedRequiredTools: mergeUnique(tools, ["review_panel"]),
    proposedMissingData: missingData,
    proposedRiskBoundaries: riskBoundaries,
    proposedNextStep:
      candidate.proposedNextStep ?? "route_to_concrete_modules_then_review_before_visible_reply",
    review: {
      accepted: true,
      reviewer: "deterministic_review",
      reason:
        "accepted because the candidate has distillable text, concrete modules, review tools, and research-only boundaries",
    },
  };
}

function reviewCandidate(
  candidate: LarkBrainDistillationCandidate,
):
  | { accepted: true; candidate: LarkBrainDistillationCandidate }
  | { accepted: false; reason: string } {
  if (candidate.status === "discarded") {
    return { accepted: false, reason: candidate.discardReason ?? "discarded candidate" };
  }
  if (candidate.boundary !== "brain_distillation_candidate") {
    return { accepted: false, reason: "invalid candidate boundary" };
  }
  if (!candidate.candidateText?.trim()) {
    return { accepted: false, reason: "missing distillable candidate text" };
  }
  const hardened = hardenAcceptedCandidate(candidate);
  if ((hardened.proposedPrimaryModules ?? []).length === 0) {
    return { accepted: false, reason: "missing concrete primary modules" };
  }
  if (!(hardened.proposedRequiredTools ?? []).includes("review_panel")) {
    return { accepted: false, reason: "missing review panel tool" };
  }
  if (!(hardened.proposedRiskBoundaries ?? []).includes("research_only")) {
    return { accepted: false, reason: "missing research-only boundary" };
  }
  return { accepted: true, candidate: hardened };
}

function buildReviewArtifact(params: {
  sourceArtifacts: string[];
  pendingCandidates: LarkBrainDistillationCandidate[];
  reviewedAt: string;
}): LarkBrainDistillationReviewArtifact {
  const acceptedCandidates: LarkBrainDistillationCandidate[] = [];
  const rejectedCandidates: LarkBrainDistillationReviewArtifact["rejectedCandidates"] = [];
  let discarded = 0;
  for (const candidate of params.pendingCandidates) {
    const review = reviewCandidate(candidate);
    if (review.accepted) {
      acceptedCandidates.push(review.candidate);
    } else {
      if (candidate.status === "discarded") {
        discarded += 1;
      }
      rejectedCandidates.push({
        id: candidate.id,
        source: candidate.source,
        reason: review.reason,
      });
    }
  }
  return {
    schemaVersion: 1,
    boundary: "brain_distillation_review",
    reviewedAt: params.reviewedAt,
    noLanguageRoutingPromotion: true,
    noLiveSenderTouched: true,
    sourceArtifacts: params.sourceArtifacts,
    acceptedCandidates,
    rejectedCandidates,
    counts: {
      sourceArtifacts: params.sourceArtifacts.length,
      pendingCandidates: params.pendingCandidates.length,
      accepted: acceptedCandidates.length,
      rejected: rejectedCandidates.length,
      discarded,
    },
  };
}

const options = parseArgs(process.argv.slice(2));
const candidateRoot = path.join(options.workspaceDir, LARK_BRAIN_DISTILLATION_CANDIDATE_DIR);
const candidateFiles = await collectJsonFiles(candidateRoot, options.maxFiles);
const reads = (
  await Promise.all(
    candidateFiles.map((filePath) => readCandidateArtifact(filePath, options.workspaceDir)),
  )
).filter((entry): entry is CandidateRead => Boolean(entry));
const pendingCandidates = reads.flatMap((read) =>
  read.artifact.candidates.filter(
    (candidate) => candidate.status === "pending_brain_review" || candidate.status === "discarded",
  ),
);
const reviewedAt = new Date().toISOString();
const review = buildReviewArtifact({
  sourceArtifacts: reads.map((read) => read.sourcePath),
  pendingCandidates,
  reviewedAt,
});

let reviewPath: string | undefined;
if (options.write) {
  const dateKey = reviewedAt.slice(0, 10);
  const reviewDir = path.join(options.workspaceDir, LARK_BRAIN_DISTILLATION_REVIEW_DIR, dateKey);
  await fs.mkdir(reviewDir, { recursive: true });
  reviewPath = path.join(reviewDir, `review-${reviewedAt.replace(/[:.]/gu, "-")}.json`);
  await fs.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
}

const result = {
  ok: true,
  boundary: "brain_distillation_review",
  workspaceDir: options.workspaceDir,
  write: options.write,
  reviewPath: reviewPath
    ? path.relative(options.workspaceDir, reviewPath).split(path.sep).join("/")
    : undefined,
  counts: review.counts,
  noLanguageRoutingPromotion: review.noLanguageRoutingPromotion,
  liveTouched: false,
  providerConfigTouched: false,
};

process.stdout.write(
  options.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `brain distillation review ok accepted=${review.counts.accepted} rejected=${review.counts.rejected} write=${options.write}\n`,
);
