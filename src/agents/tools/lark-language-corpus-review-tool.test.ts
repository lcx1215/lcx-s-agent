import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLarkPendingRoutingCandidateCorpus,
  evaluateLarkRoutingCandidateCorpus,
} from "../../../extensions/feishu/src/lark-routing-candidate-corpus.js";
import type { FeishuConfig } from "../../../extensions/feishu/src/types.js";
import { createLarkLanguageCorpusReviewTool } from "./lark-language-corpus-review-tool.js";

const cfg = {
  surfaces: {
    control_room: { chatId: "oc-control" },
    technical_daily: { chatId: "oc-tech" },
    fundamental_research: { chatId: "oc-fund" },
    knowledge_maintenance: { chatId: "oc-knowledge" },
    ops_audit: { chatId: "oc-ops" },
    learning_command: { chatId: "oc-learning" },
  },
} as FeishuConfig;

async function writePendingArtifact(params: {
  workspaceDir: string;
  dateKey: string;
  messageId: string;
  utterance: string;
}) {
  const corpus = buildLarkPendingRoutingCandidateCorpus({
    source: "lark_user_utterance",
    generatedAt: `${params.dateKey}T00:00:00.000Z`,
    payloads: [params.utterance],
  });
  const evaluation = evaluateLarkRoutingCandidateCorpus({
    cfg,
    corpus,
    evaluatedAt: `${params.dateKey}T00:01:00.000Z`,
  });
  const dir = path.join(
    params.workspaceDir,
    "memory",
    "lark-language-routing-candidates",
    params.dateKey,
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${params.messageId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      boundary: "language_routing_only",
      source: "feishu_final_reply_capture",
      messageId: params.messageId,
      noFinanceLearningArtifact: true,
      evaluation,
    })}\n`,
    "utf-8",
  );
}

describe("lark_language_corpus_review tool", () => {
  it("writes review and patch artifacts without mutating the formal corpus", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lark-review-tool-"));
    await writePendingArtifact({
      workspaceDir,
      dateKey: "2026-04-27",
      messageId: "msg-one",
      utterance: "去 arxiv 上批量学习 ETF 择时论文，并说明 source coverage limits",
    });
    await writePendingArtifact({
      workspaceDir,
      dateKey: "2026-04-27",
      messageId: "msg-two",
      utterance: "去 GitHub 上学习 ETF 风控项目，但要说清楚实际看了哪些来源",
    });

    const tool = createLarkLanguageCorpusReviewTool({ workspaceDir });
    const result = await tool.execute("lark-language-review", {
      dateKey: "2026-04-27",
      minAcceptedPerFamily: 2,
    });
    const details = result.details as {
      ok: boolean;
      updated: boolean;
      boundary: string;
      reviewPath: string;
      patchPath: string;
      counts: { promotedCases: number };
      familyDecisions: Array<{ status: string; family: string }>;
    };

    expect(details).toMatchObject({
      ok: true,
      updated: true,
      boundary: "language_routing_only",
      reviewPath: "memory/lark-language-routing-reviews/2026-04-27.json",
      patchPath: "memory/lark-language-routing-reviews/2026-04-27.patch.ts",
      counts: { promotedCases: 2 },
      familyDecisions: [
        {
          family: "external_source_coverage_honesty",
          status: "eligible_for_review",
        },
      ],
    });
    const patch = await fs.readFile(path.join(workspaceDir, details.patchPath), "utf-8");
    expect(patch).toContain("append these cases to LARK_ROUTING_CORPUS");
    expect(patch).toContain("Promoted from pending Lark language-routing candidate review");
    expect(patch).not.toMatch(
      /finance_learning|finance-learning|memory\/local-memory|capability card/u,
    );

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("can run as a dry review without writing artifacts", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lark-review-dry-"));
    await writePendingArtifact({
      workspaceDir,
      dateKey: "2026-04-27",
      messageId: "msg-one",
      utterance: "去学习世界顶级大学前沿金融论文",
    });

    const tool = createLarkLanguageCorpusReviewTool({ workspaceDir });
    const result = await tool.execute("lark-language-review-dry", {
      dateKey: "2026-04-27",
      writeReview: false,
    });
    const details = result.details as {
      updated: boolean;
      reviewPath?: string;
      patchPath?: string;
      counts: { promotedCases: number };
    };

    expect(details).toMatchObject({
      updated: false,
      counts: { promotedCases: 0 },
    });
    expect(details.reviewPath).toBeUndefined();
    expect(details.patchPath).toBeUndefined();
    await expect(
      fs.access(path.join(workspaceDir, "memory", "lark-language-routing-reviews")),
    ).rejects.toThrow();

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });
});
