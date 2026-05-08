import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildLarkBrainDistillationCandidate,
  buildLarkBrainDistillationCandidateArtifact,
} from "../../extensions/feishu/src/lark-brain-distillation-candidates.js";

const execFileAsync = promisify(execFile);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-brain-distill-candidate-"));
const workspace = path.join(root, "workspace");
const outDir = path.join(root, "dataset");
const candidateDir = path.join(workspace, "memory", "lark-brain-distillation-candidates");
await fs.mkdir(candidateDir, { recursive: true });

const accepted = buildLarkBrainDistillationCandidate({
  source: "teacher_review",
  userMessage:
    "从 Google Scholar、SSRN 和 NBER 学一批前沿量化论文，但要标清实际读过哪些材料，不要说全覆盖。",
  payload:
    "这是一个研究规划任务：先建立 source registry，记录实际读过的论文清单和 coverage limits，再把可复用规则交给 finance learning memory。",
  createdAt: "2026-05-04T00:00:00.000Z",
  review: {
    accepted: true,
    reviewer: "deterministic_smoke",
    reason:
      "contains source registry, finance learning memory, coverage limits, and no exhaustive claim",
  },
});
const pending = buildLarkBrainDistillationCandidate({
  source: "lark_visible_reply",
  userMessage: "给我一个 NVDA 基本面风险框架，不要直接说买卖，要能连接到我的科技仓风险。",
  payload:
    "先把 NVDA 基本面、AI capex、估值压力和科技仓组合风险连接起来，再用 review panel 检查缺失证据。",
  createdAt: "2026-05-04T00:00:00.000Z",
});
const externalPending = buildLarkBrainDistillationCandidate({
  source: "lark_visible_reply",
  userMessage:
    "帮本地大脑学习一篇 GitHub 上的开源金融 agent 项目和论文，先看以前有没有类似 skill、eval、receipt 或 source registry 路径，再决定复用还是扩展。",
  payload:
    "这是外部知识和技能内化任务：先查已有工程，再做 source registry、skill harvester、license 和安全审计，不能直接说已经学会。",
  createdAt: "2026-05-04T00:00:00.000Z",
});
const secret = buildLarkBrainDistillationCandidate({
  source: "api_reply",
  payload: "api_key=sk-this-secret-like-value-must-not-enter-training-123456",
  createdAt: "2026-05-04T00:00:00.000Z",
});
const binary = buildLarkBrainDistillationCandidate({
  source: "api_reply",
  payload: Buffer.from([0, 1, 2, 3]),
  createdAt: "2026-05-04T00:00:00.000Z",
});
const artifact = buildLarkBrainDistillationCandidateArtifact({
  generatedAt: "2026-05-04T00:00:00.000Z",
  candidates: [accepted, pending, externalPending, secret, binary],
});
await fs.writeFile(
  path.join(candidateDir, "teacher-reviewed-scholar.json"),
  JSON.stringify(artifact, null, 2),
);

assert(artifact.boundary === "brain_distillation_candidate", "brain distillation boundary");
assert(artifact.noLanguageRoutingPromotion, "must not promote into language corpus");
assert(artifact.noLiveSenderTouched, "must not touch live sender");
assert(accepted.status === "accepted_brain_plan", "accepted candidate status");
assert(secret.status === "discarded", "secret candidate discarded");
assert(binary.status === "discarded", "binary candidate discarded");
assert(accepted.proposedPrimaryModules?.includes("source_registry"), "source_registry module");
assert(
  accepted.proposedMissingData?.includes("actual_reading_scope"),
  "actual reading scope missing data",
);
assert(pending.status === "pending_brain_review", "pending candidate status");

const reviewRun = await execFileAsync(process.execPath, [
  "--import",
  "tsx",
  "scripts/dev/lark-brain-distillation-review.ts",
  "--workspace",
  workspace,
  "--write",
  "--json",
]);
const reviewManifest = JSON.parse(reviewRun.stdout) as {
  counts?: { accepted?: number; rejected?: number; discarded?: number };
  reviewPath?: string;
};
assert(reviewManifest.counts?.accepted === 2, "review accepted pending candidates");
assert(reviewManifest.counts?.discarded === 2, "review counted discarded unsafe candidates");
assert(reviewManifest.reviewPath, "review path returned");
const reviewArtifact = JSON.parse(
  await fs.readFile(path.join(workspace, reviewManifest.reviewPath), "utf8"),
) as {
  acceptedCandidates?: Array<{
    proposedMissingData?: string[];
    proposedRiskBoundaries?: string[];
    proposedRequiredTools?: string[];
  }>;
};
const externalReviewed = reviewArtifact.acceptedCandidates?.find((candidate) =>
  candidate.proposedRequiredTools?.includes("skill_harvester"),
);
assert(externalReviewed, "external skill/source candidate reviewed");
assert(
  externalReviewed.proposedMissingData?.includes(
    "prior_art_search_terms_or_existing_artifact_paths",
  ),
  "review preserves prior-art search gate",
);
assert(
  externalReviewed.proposedMissingData?.includes(
    "existing_contract_eval_skill_or_receipt_candidates",
  ),
  "review preserves existing mechanism candidates",
);
assert(
  externalReviewed.proposedMissingData?.includes("reuse_extend_or_new_decision"),
  "review preserves reuse/extend/new decision",
);
assert(
  externalReviewed.proposedRiskBoundaries?.includes(
    "do_not_create_parallel_protocol_before_prior_art_check",
  ),
  "review blocks parallel protocol before prior-art check",
);

const { stdout } = await execFileAsync(process.execPath, [
  "--import",
  "tsx",
  "scripts/dev/local-brain-distill-dataset.ts",
  "--workspace",
  workspace,
  "--out",
  outDir,
  "--json",
]);
const manifest = JSON.parse(stdout) as Record<string, unknown>;
const sourceKinds = manifest.sourceKinds as Record<string, number> | undefined;
assert(
  sourceKinds?.brain_distillation_candidate_review === 1,
  "brain candidate entered dataset once",
);
assert(sourceKinds?.brain_distillation_review === 2, "reviewed brain candidates entered dataset");

const splitText = (
  await Promise.all(
    ["train.jsonl", "valid.jsonl", "test.jsonl"].map((fileName) =>
      fs.readFile(path.join(outDir, fileName), "utf8"),
    ),
  )
).join("\n");
assert(
  splitText.includes("brain_distillation_candidate_review"),
  "dataset has brain candidate source kind",
);
assert(splitText.includes("source_registry"), "dataset preserves source_registry contract");
assert(
  splitText.includes("actual_reading_scope"),
  "dataset preserves actual reading scope contract",
);
assert(
  splitText.includes("prior_art_search_terms_or_existing_artifact_paths"),
  "dataset preserves prior-art reuse gate",
);

const result = {
  ok: true,
  boundary: "brain_distillation_candidate",
  workspace,
  outDir,
  acceptedCandidates: 3,
  discardedCandidates: 2,
  languageRoutingTouched: false,
  liveTouched: false,
  providerConfigTouched: false,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
