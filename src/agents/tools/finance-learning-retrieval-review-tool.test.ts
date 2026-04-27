import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceLearningRetrievalReviewTool } from "./finance-learning-retrieval-review-tool.js";

async function seedJson(workspaceDir: string, relativePath: string, payload: unknown) {
  const absolutePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readJson(workspaceDir: string, relativePath: string) {
  return JSON.parse(await fs.readFile(path.join(workspaceDir, relativePath), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("finance learning retrieval review tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("writes a daily review from retrieval receipts without touching language corpus", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-review-");
    await seedJson(workspaceDir, "memory/finance-learning-retrieval-receipts/2026-04-27/a.json", {
      schemaVersion: 1,
      boundary: "finance_learning_retrieval_receipt",
      generatedAt: "2026-04-27T01:00:00.000Z",
      sourceName: "Manual ETF Note",
      learningIntent: "学习 ETF 因子择时和 regime risk",
      retainedCandidateCount: 1,
      preflightCandidateCount: 0,
      postAttachCandidateCount: 1,
      newlyRetrievableCandidateDelta: 1,
      reusedExistingBeforeLearning: false,
      retrievalFirstLearningApplied: true,
      noExecutionAuthority: true,
      noDoctrineMutation: true,
      normalizedArticleArtifactPaths: ["memory/finance-articles/2026-04-27/a.md"],
      normalizedReferenceArtifactPaths: [],
    });
    await seedJson(workspaceDir, "memory/finance-learning-retrieval-receipts/2026-04-27/b.json", {
      schemaVersion: 1,
      boundary: "finance_learning_retrieval_receipt",
      generatedAt: "2026-04-27T02:00:00.000Z",
      sourceName: "Weak Note",
      learningIntent: "学习一个还没有稳定标签的策略",
      retainedCandidateCount: 1,
      preflightCandidateCount: 0,
      postAttachCandidateCount: 0,
      newlyRetrievableCandidateDelta: 0,
      reusedExistingBeforeLearning: false,
      retrievalFirstLearningApplied: true,
      noExecutionAuthority: true,
      noDoctrineMutation: true,
      normalizedArticleArtifactPaths: ["memory/finance-articles/2026-04-27/b.md"],
      normalizedReferenceArtifactPaths: [],
    });
    await seedJson(workspaceDir, "memory/finance-learning-retrieval-receipts/2026-04-27/c.json", {
      boundary: "language_routing_candidate",
    });
    const tool = createFinanceLearningRetrievalReviewTool({ workspaceDir });

    const result = await tool.execute("review", {
      dateKey: "2026-04-27",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "finance_learning_review_only",
        updated: true,
        reviewPath: "memory/finance-learning-retrieval-reviews/2026-04-27.json",
        counts: {
          receiptFiles: 3,
          validReceipts: 2,
          invalidReceipts: 1,
          retrievableAfterLearning: 1,
          newlyRetrievable: 1,
          reusedExistingBeforeLearning: 0,
          weakLearningReceipts: 1,
        },
        weakLearningIntents: [
          expect.objectContaining({
            learningIntent: "学习一个还没有稳定标签的策略",
            reason: "not_retrievable_after_learning",
          }),
        ],
        separationContract: expect.objectContaining({
          languageCorpusUntouched: true,
          protectedMemoryUntouched: true,
          noExecutionAuthority: true,
          noDoctrineMutation: true,
        }),
      }),
    );
    const review = await readJson(
      workspaceDir,
      "memory/finance-learning-retrieval-reviews/2026-04-27.json",
    );
    expect(review).toEqual(
      expect.objectContaining({
        boundary: "finance_learning_retrieval_review",
      }),
    );
    expect(review.separationContract).toEqual(
      expect.objectContaining({
        readsOnly: "memory/finance-learning-retrieval-receipts",
        writesOnly: "memory/finance-learning-retrieval-reviews",
        languageCorpusUntouched: true,
      }),
    );
  });

  it("supports dry-run review when no receipts exist", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-review-");
    const tool = createFinanceLearningRetrievalReviewTool({ workspaceDir });

    const result = await tool.execute("dry", {
      dateKey: "2026-04-27",
      writeReview: false,
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "finance_learning_review_only",
        updated: false,
        reviewPath: undefined,
        counts: {
          receiptFiles: 0,
          validReceipts: 0,
          invalidReceipts: 0,
          retrievableAfterLearning: 0,
          newlyRetrievable: 0,
          reusedExistingBeforeLearning: 0,
          weakLearningReceipts: 0,
        },
      }),
    );
    await expect(
      fs.stat(path.join(workspaceDir, "memory/finance-learning-retrieval-reviews/2026-04-27.json")),
    ).rejects.toThrow();
  });
});
