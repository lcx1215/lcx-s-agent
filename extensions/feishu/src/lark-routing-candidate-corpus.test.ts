import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLarkPendingRoutingCandidateCorpus,
  buildLarkRoutingCandidatePromotionReview,
  createLarkPendingRoutingCandidate,
  evaluateLarkRoutingCandidateCorpus,
  evaluateLarkPendingRoutingCandidate,
  evaluateLarkPendingRoutingCandidates,
  readLarkRoutingCandidatePromotionArtifacts,
} from "./lark-routing-candidate-corpus.js";
import type { FeishuConfig } from "./types.js";

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

describe("lark routing candidate corpus", () => {
  it("normalizes API replies into pending language-routing candidates", () => {
    const candidate = createLarkPendingRoutingCandidate({
      source: "api_reply",
      payload: "去学习世界顶级大学前沿金融论文",
      createdAt: "2026-04-27T00:00:00.000Z",
    });

    expect(candidate).toMatchObject({
      id: expect.stringMatching(/^pending-language-api_reply-[a-f0-9]{16}$/u),
      source: "api_reply",
      status: "pending_review",
      boundary: "language_routing_only",
      createdAt: "2026-04-27T00:00:00.000Z",
      utterance: "去学习世界顶级大学前沿金融论文",
      sample: expect.objectContaining({
        disposition: "candidate_semantic_family",
      }),
      semantic: expect.objectContaining({
        family: "external_source_coverage_honesty",
      }),
    });
  });

  it("accepts a pending language candidate only after routing eval passes", () => {
    const candidate = createLarkPendingRoutingCandidate({
      source: "lark_visible_reply",
      payload: "去学习世界顶级大学前沿金融论文",
      createdAt: "2026-04-27T00:00:00.000Z",
    });
    const evaluation = evaluateLarkPendingRoutingCandidate({ cfg, candidate });

    expect(evaluation).toMatchObject({
      reason: "accepted_language_case",
      candidate: expect.objectContaining({
        status: "accepted_language_case",
        boundary: "language_routing_only",
      }),
      acceptedCase: expect.objectContaining({
        id: candidate.id,
        utterance: "去学习世界顶级大学前沿金融论文",
        family: "external_source_coverage_honesty",
        expectedSurface: "learning_command",
        expectedGuardMatchers: ["sourceCoverage"],
        notes: "Auto-normalized language-routing candidate; not a finance learning artifact.",
      }),
      score: expect.objectContaining({
        total: 1,
        deterministicPassed: 1,
        semanticCandidatePassed: 1,
      }),
    });
    expect(JSON.stringify(evaluation)).not.toMatch(
      /finance_learning|finance-learning|memory\/local-memory|capability card/u,
    );
  });

  it("keeps WeChat public-account source learning on the finance pipeline, not language corpus", () => {
    const candidate = createLarkPendingRoutingCandidate({
      source: "api_reply",
      payload:
        "微信公众号文章 sourceType=wechat_public_account_source 应该进入 finance_article_extract_capability_input，而不是 routing corpus。",
    });
    const evaluation = evaluateLarkPendingRoutingCandidate({ cfg, candidate });

    expect(evaluation.reason).not.toBe("accepted_language_case");
    expect(evaluation.acceptedCase).toBeUndefined();
    expect(candidate.boundary).toBe("language_routing_only");
  });

  it("discards secrets and binary payloads before pending corpus review", () => {
    const secret = createLarkPendingRoutingCandidate({
      source: "api_reply",
      payload: "Authorization: Bearer sk-ant-api03-thisshouldnotbelearned",
    });
    const binary = createLarkPendingRoutingCandidate({
      source: "api_reply",
      payload: Buffer.from([0, 1, 2, 3]),
    });

    expect(evaluateLarkPendingRoutingCandidates({ cfg, candidates: [secret, binary] })).toEqual([
      expect.objectContaining({ reason: "discarded_by_distillation" }),
      expect.objectContaining({ reason: "discarded_by_distillation" }),
    ]);
    expect(secret.utterance).toBeUndefined();
    expect(binary.utterance).toBeUndefined();
  });

  it("batch-builds a pending language corpus and evaluates accepted cases without touching brain artifacts", () => {
    const corpus = buildLarkPendingRoutingCandidateCorpus({
      source: "api_reply",
      generatedAt: "2026-04-27T00:00:00.000Z",
      payloads: [
        "去学习世界顶级大学前沿金融论文",
        "Authorization: Bearer sk-ant-api03-thisshouldnotbelearned",
        "这是一句没有足够路由信号的普通闲聊",
      ],
    });
    const evaluation = evaluateLarkRoutingCandidateCorpus({
      cfg,
      corpus,
      evaluatedAt: "2026-04-27T00:01:00.000Z",
    });

    expect(corpus).toMatchObject({
      schemaVersion: 1,
      boundary: "language_routing_only",
      generatedAt: "2026-04-27T00:00:00.000Z",
      candidates: expect.arrayContaining([
        expect.objectContaining({ status: "pending_review" }),
        expect.objectContaining({ status: "discarded" }),
      ]),
    });
    expect(evaluation).toMatchObject({
      schemaVersion: 1,
      boundary: "language_routing_only",
      evaluatedAt: "2026-04-27T00:01:00.000Z",
      counts: {
        total: 3,
        accepted: 1,
        rejected: 1,
        discarded: 1,
      },
      acceptedCases: [
        expect.objectContaining({
          family: "external_source_coverage_honesty",
          expectedSurface: "learning_command",
        }),
      ],
    });
    expect(JSON.stringify({ corpus, evaluation })).not.toMatch(
      /finance_learning|finance-learning|memory\/local-memory|capability card/u,
    );
  });

  it("promotes only family batches that meet review thresholds", () => {
    const firstCorpus = buildLarkPendingRoutingCandidateCorpus({
      source: "lark_user_utterance",
      generatedAt: "2026-04-27T00:00:00.000Z",
      payloads: ["去学习世界顶级大学前沿金融论文"],
    });
    const secondCorpus = buildLarkPendingRoutingCandidateCorpus({
      source: "lark_visible_reply",
      generatedAt: "2026-04-27T00:02:00.000Z",
      payloads: ["去 Google 上学习 ETF 轮动的公开资料"],
    });
    const review = buildLarkRoutingCandidatePromotionReview({
      generatedAt: "2026-04-27T00:03:00.000Z",
      minAcceptedPerFamily: 2,
      artifacts: [
        {
          boundary: "language_routing_only",
          source: "feishu_final_reply_capture",
          messageId: "msg-1",
          evaluation: evaluateLarkRoutingCandidateCorpus({
            cfg,
            corpus: firstCorpus,
            evaluatedAt: "2026-04-27T00:01:00.000Z",
          }),
        },
        {
          boundary: "language_routing_only",
          source: "feishu_final_reply_capture",
          messageId: "msg-2",
          evaluation: evaluateLarkRoutingCandidateCorpus({
            cfg,
            corpus: secondCorpus,
            evaluatedAt: "2026-04-27T00:02:30.000Z",
          }),
        },
      ],
    });

    expect(review).toMatchObject({
      schemaVersion: 1,
      boundary: "language_routing_only",
      generatedAt: "2026-04-27T00:03:00.000Z",
      minAcceptedPerFamily: 2,
      counts: {
        sourceArtifacts: 2,
        acceptedCases: 2,
        duplicateCases: 0,
        promotedCases: 2,
      },
      familyDecisions: [
        {
          family: "external_source_coverage_honesty",
          accepted: 2,
          promoted: 2,
          status: "eligible_for_review",
        },
      ],
    });
    expect(review.promotedCases).toHaveLength(2);
    expect(review.promotedCases[0]).toMatchObject({
      id: expect.stringMatching(
        /^promoted-language-external_source_coverage_honesty-[a-f0-9]{12}$/u,
      ),
      family: "external_source_coverage_honesty",
      expectedSurface: "learning_command",
      truthBoundary: "evidence_required",
      notes:
        "Promoted from pending Lark language-routing candidate review; not a finance learning artifact.",
    });
    expect(review.corpusPatch).toContain("append these cases to LARK_ROUTING_CORPUS");
    expect(review.corpusPatch).toContain("external_source_coverage_honesty");
    expect(JSON.stringify(review)).not.toMatch(
      /finance_learning|finance-learning|memory\/local-memory|capability card/u,
    );
  });

  it("keeps duplicate or under-threshold language candidates out of promotion patches", () => {
    const corpus = buildLarkPendingRoutingCandidateCorpus({
      source: "lark_user_utterance",
      generatedAt: "2026-04-27T00:00:00.000Z",
      payloads: ["去学习世界顶级大学前沿金融论文"],
    });
    const evaluation = evaluateLarkRoutingCandidateCorpus({
      cfg,
      corpus,
      evaluatedAt: "2026-04-27T00:01:00.000Z",
    });
    const review = buildLarkRoutingCandidatePromotionReview({
      generatedAt: "2026-04-27T00:02:00.000Z",
      minAcceptedPerFamily: 2,
      existingCorpus: [
        {
          id: "existing-language-case",
          utterance: "去学习世界顶级大学前沿金融论文",
          family: "external_source_coverage_honesty",
          expectedSurface: "learning_command",
          truthBoundary: "evidence_required",
        },
      ],
      artifacts: [
        {
          boundary: "language_routing_only",
          source: "feishu_final_reply_capture",
          messageId: "msg-duplicate",
          evaluation,
        },
      ],
    });

    expect(review).toMatchObject({
      counts: {
        sourceArtifacts: 1,
        acceptedCases: 1,
        duplicateCases: 1,
        promotedCases: 0,
      },
      promotedCases: [],
    });
    expect(review.corpusPatch).toContain("No language-routing candidates met promotion thresholds");
  });

  it("scans pending language artifact files and skips invalid boundaries", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lark-pending-scan-"));
    const rootDir = path.join(tempDir, "memory", "lark-language-routing-candidates");
    const validDir = path.join(rootDir, "2026-04-27");
    await fs.mkdir(validDir, { recursive: true });

    const corpus = buildLarkPendingRoutingCandidateCorpus({
      source: "lark_user_utterance",
      generatedAt: "2026-04-27T00:00:00.000Z",
      payloads: ["去学习世界顶级大学前沿金融论文"],
    });
    await fs.writeFile(
      path.join(validDir, "msg-valid.json"),
      JSON.stringify({
        schemaVersion: 1,
        boundary: "language_routing_only",
        source: "feishu_final_reply_capture",
        messageId: "msg-valid",
        noFinanceLearningArtifact: true,
        evaluation: evaluateLarkRoutingCandidateCorpus({
          cfg,
          corpus,
          evaluatedAt: "2026-04-27T00:01:00.000Z",
        }),
      }),
      "utf-8",
    );
    await fs.writeFile(path.join(validDir, "broken.json"), "{", "utf-8");
    await fs.writeFile(
      path.join(validDir, "finance.json"),
      JSON.stringify({
        boundary: "finance_learning",
        evaluation: { acceptedCases: [] },
      }),
      "utf-8",
    );

    const result = await readLarkRoutingCandidatePromotionArtifacts({ rootDir });

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      boundary: "language_routing_only",
      noFinanceLearningArtifact: true,
      messageId: "msg-valid",
    });
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "parse_failed" }),
        expect.objectContaining({ reason: "invalid_language_boundary" }),
      ]),
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
