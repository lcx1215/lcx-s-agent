import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  writeLarkLanguageRoutingCandidateCapture,
  writeLarkRoutingCandidatePromotionReview,
} from "../../extensions/feishu/src/lark-routing-candidate-corpus.ts";
import { LARK_ROUTING_CORPUS } from "../../extensions/feishu/src/lark-routing-corpus.ts";
import type { FeishuConfig } from "../../extensions/feishu/src/types.ts";

const cfg = {
  surfaces: {
    control_room: { chatId: "oc-control" },
    technical_daily: { chatId: "oc-tech" },
    fundamental_research: { chatId: "oc-fund" },
    knowledge_maintenance: { chatId: "oc-knowledge" },
    ops_audit: { chatId: "oc-ops" },
    learning_command: { chatId: "oc-learning" },
    watchtower: { chatId: "oc-watch" },
  },
} as FeishuConfig;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lark-capture-smoke-"));
const generatedAt = "2026-05-03T00:00:00.000Z";

try {
  const capture = await writeLarkLanguageRoutingCandidateCapture({
    workspaceDir,
    cfg,
    agentId: "capture-smoke-agent",
    targetSurface: "learning_command",
    effectiveSurface: "learning_command",
    chatId: "oc-learning",
    sessionKey: "capture-smoke-session",
    messageId: "capture-smoke-message",
    userMessage: "去学习世界顶级大学前沿金融论文",
    finalReplyText: "我会先说明实际 source coverage，再把可复用规则进入待审 corpus。",
    apiReplyPayloads: [
      "去 arxiv 上找资产配置前沿论文，只保留可复用规则并标注覆盖范围",
      "去 GitHub 学习开源量化研究助手项目，说明只看了哪些 repo",
      "Authorization: Bearer sk-ant-api03-thisshouldnotbelearned",
      Buffer.from([0, 1, 2, 3]),
    ],
    generatedAt,
  });
  assert(capture, "capture should be written");
  assert(capture.artifact.boundary === "language_routing_only", "language-only boundary");
  assert(capture.artifact.noFinanceLearningArtifact, "brain artifact marker");
  assert(capture.artifact.candidates.length >= 6, "user, reply, api, secret, binary candidates");
  assert(capture.artifact.evaluation.counts.accepted >= 2, "accepted language cases");
  assert(capture.artifact.evaluation.counts.discarded >= 2, "secret and binary discarded");

  const review = await writeLarkRoutingCandidatePromotionReview({
    workspaceDir,
    dateKey: "2026-05-03",
    existingCorpus: LARK_ROUTING_CORPUS,
    minAcceptedPerFamily: 2,
  });
  assert(review.review.counts.sourceArtifacts === 1, "review should read one capture artifact");
  assert(review.review.counts.promotedCases >= 2, "same-family accepted batch should promote");
  assert(
    review.review.familyDecisions.some(
      (decision) =>
        decision.family === "external_source_coverage_honesty" &&
        decision.status === "eligible_for_review",
    ),
    "external source family should be eligible for review",
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        boundary: "language_routing_only",
        capturePath: capture.relativePath,
        reviewPath: review.reviewPath,
        patchPath: review.patchPath,
        candidateCounts: capture.artifact.evaluation.counts,
        reviewCounts: review.review.counts,
        familyDecisions: review.review.familyDecisions,
        noFinanceLearningArtifact: capture.artifact.noFinanceLearningArtifact,
        liveTouched: false,
        formalCorpusMutated: false,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await fs.rm(workspaceDir, { recursive: true, force: true });
}
