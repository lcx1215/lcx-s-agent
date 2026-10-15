import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../src/agents/tools/common.js";
import { createFinanceLearningCapabilityApplyTool } from "../src/agents/tools/finance-learning-capability-apply-tool.js";
import { createFinanceLearningPipelineOrchestratorTool } from "../src/agents/tools/finance-learning-pipeline-orchestrator-tool.js";
import { createModuleLearningPipelinePlanTool } from "../src/agents/tools/module-learning-pipeline-plan-tool.js";
import { createModuleLearningPipelineReviewTool } from "../src/agents/tools/module-learning-pipeline-review-tool.js";
import {
  probeContinuousNativeLearning,
  type NativeLearningObservation,
  learningGate,
  learningHash,
  record,
  seedNativeLearning,
  text,
} from "./fixtures/lcx-waterflow-learning-probe.js";

const observation = vi.hoisted(() => ({
  runId: "",
  workspace: "",
  calls: [] as NativeLearningObservation[],
  stack: [] as string[],
}));
function observeOriginal(
  owner: string,
  workspaceDir: string | undefined,
  tool: AnyAgentTool,
): AnyAgentTool {
  return {
    ...tool,
    execute: async (...args: Parameters<AnyAgentTool["execute"]>) => {
      if (!observation.runId) {
        return tool.execute(...args);
      }
      if (path.resolve(workspaceDir ?? "") !== observation.workspace) {
        throw new Error("Observation workspace conflict");
      }
      const id = `${owner}:${observation.calls.length}:${args[0]}`;
      const parentId = observation.stack.at(-1) ?? null;
      const input = structuredClone(args[1]) as Record<string, unknown>;
      observation.stack.push(id);
      try {
        const result = await tool.execute(...args);
        observation.calls.push({
          owner,
          id,
          parentId,
          toolCallId: args[0],
          input,
          output: structuredClone(record(result.details)),
          scope: {
            runId: observation.runId,
            workspaceId: createHash("sha256").update(observation.workspace).digest("hex"),
          },
        });
        return result;
      } finally {
        observation.stack.pop();
      }
    },
  };
}
vi.mock("../src/agents/tools/finance-research-source-workbench-tool.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../src/agents/tools/finance-research-source-workbench-tool.js")
    >();
  return {
    ...original,
    createFinanceResearchSourceWorkbenchTool: (
      options?: Parameters<typeof original.createFinanceResearchSourceWorkbenchTool>[0],
    ) =>
      observeOriginal(
        "finance-research-source-workbench-tool",
        options?.workspaceDir,
        original.createFinanceResearchSourceWorkbenchTool(options),
      ),
  };
});
vi.mock(
  "../src/agents/tools/finance-article-extract-capability-input-tool.js",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../src/agents/tools/finance-article-extract-capability-input-tool.js")
      >();
    return {
      ...original,
      createFinanceArticleExtractCapabilityInputTool: (
        options?: Parameters<typeof original.createFinanceArticleExtractCapabilityInputTool>[0],
      ) =>
        observeOriginal(
          "finance-article-extract-capability-input-tool",
          options?.workspaceDir,
          original.createFinanceArticleExtractCapabilityInputTool(options),
        ),
    };
  },
);
vi.mock(
  "../src/agents/tools/finance-learning-capability-attach-tool.js",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../src/agents/tools/finance-learning-capability-attach-tool.js")
      >();
    return {
      ...original,
      createFinanceLearningCapabilityAttachTool: (
        options?: Parameters<typeof original.createFinanceLearningCapabilityAttachTool>[0],
      ) =>
        observeOriginal(
          "finance-learning-capability-attach-tool",
          options?.workspaceDir,
          original.createFinanceLearningCapabilityAttachTool(options),
        ),
    };
  },
);
vi.mock(
  "../src/agents/tools/finance-learning-capability-inspect-tool.js",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../src/agents/tools/finance-learning-capability-inspect-tool.js")
      >();
    return {
      ...original,
      createFinanceLearningCapabilityInspectTool: (
        options?: Parameters<typeof original.createFinanceLearningCapabilityInspectTool>[0],
      ) =>
        observeOriginal(
          "finance-learning-capability-inspect-tool",
          options?.workspaceDir,
          original.createFinanceLearningCapabilityInspectTool(options),
        ),
    };
  },
);
vi.mock("../src/agents/tools/finance-learning-capability-apply-tool.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../src/agents/tools/finance-learning-capability-apply-tool.js")
    >();
  return {
    ...original,
    createFinanceLearningCapabilityApplyTool: (
      options?: Parameters<typeof original.createFinanceLearningCapabilityApplyTool>[0],
    ) =>
      observeOriginal(
        "finance-learning-capability-apply-tool",
        options?.workspaceDir,
        original.createFinanceLearningCapabilityApplyTool(options),
      ),
  };
});
vi.mock("../src/agents/tools/module-learning-pipeline-plan-tool.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../src/agents/tools/module-learning-pipeline-plan-tool.js")
    >();
  return {
    ...original,
    createModuleLearningPipelinePlanTool: (
      options?: Parameters<typeof original.createModuleLearningPipelinePlanTool>[0],
    ) =>
      observeOriginal(
        "module-learning-pipeline-plan-tool",
        options?.workspaceDir,
        original.createModuleLearningPipelinePlanTool(options),
      ),
  };
});
vi.mock("../src/agents/tools/module-learning-pipeline-review-tool.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../src/agents/tools/module-learning-pipeline-review-tool.js")
    >();
  return {
    ...original,
    createModuleLearningPipelineReviewTool: (
      options?: Parameters<typeof original.createModuleLearningPipelineReviewTool>[0],
    ) =>
      observeOriginal(
        "module-learning-pipeline-review-tool",
        options?.workspaceDir,
        original.createModuleLearningPipelineReviewTool(options),
      ),
  };
});

let workspace = "";
afterEach(async () => {
  observation.runId = "";
  observation.calls = [];
  observation.stack = [];
  vi.unstubAllGlobals();
  if (workspace) {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
async function prepare() {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-native-learning-"));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network forbidden in offline learning probe");
    }),
  );
  return seedNativeLearning(workspace);
}
async function persist(name: string, proof: unknown) {
  if (!process.env.LCX_WATERFLOW_PROOF_DIR) {
    return;
  }
  await fs.mkdir(process.env.LCX_WATERFLOW_PROOF_DIR, { recursive: true });
  await fs.writeFile(
    path.join(process.env.LCX_WATERFLOW_PROOF_DIR, `learning-${name}.json`),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
}
describe("original module learning producer and consumer handoff", () => {
  it("uses original normalized source, retrieval and application receipts in source-bound local evaluation and review; global registered sources remain held", async () => {
    const seeded = await prepare();
    expect(seeded.intake.ok).toBe(true);
    expect(seeded.apply.ok).toBe(true);
    expect(seeded.plan.status).toBe("eval_absorbed");
    expect(record(seeded.plan.evidenceVerification).evaluationVerified).toBe(true);
    const rows = seeded.review.rows as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      sourceUrlOrPath: seeded.source,
      retrievalReceiptPath: seeded.candidate.retrievalReceiptPath,
      applicationValidationReceiptPath: seeded.applicationPath,
      evaluationVerified: true,
      keepDownrankDiscardDecision: "keep",
      status: "eval_absorbed",
    });
    const gate = await learningGate(workspace);
    expect(gate.absorptionReady).toBe(false);
    expect(gate.blockers).toContain("registered_sources_missing_application_or_eval_evidence");
    expect(gate.reviewReadMode).toBe("fresh_read_only");
    await persist("native", {
      intake: seeded.intake,
      apply: seeded.apply,
      evaluation: JSON.parse(
        await fs.readFile(path.join(workspace, seeded.evaluationPath), "utf8"),
      ),
      plan: seeded.plan,
      review: seeded.review,
      gate,
      sourceSha256: await learningHash(workspace, seeded.source),
      noNetworkCalls: vi.mocked(fetch).mock.calls.length,
      unresolved: [
        "Global original source registry obligations",
        "Review-to-capability feedback has not been demonstrated",
      ],
    });
  }, 60_000);
  it("actual source-byte conflict downgrades a previously absorbed receipt at fresh review and gate", async () => {
    const seeded = await prepare();
    await fs.appendFile(
      path.join(workspace, seeded.source),
      "\nChanged original source content after evaluation.\n",
    );
    const review = record(
      (
        await createModuleLearningPipelineReviewTool({ workspaceDir: workspace }).execute(
          "hash-conflict",
          { writeReview: false },
        )
      ).details,
    );
    expect((review.rows as Array<Record<string, unknown>>)[0]).toMatchObject({
      declaredStatus: "eval_absorbed",
      status: "application_ready",
      evaluationVerified: false,
    });
    const gate = await learningGate(workspace);
    expect(gate.blockers).toContain("module_receipts_not_eval_absorbed");
    await persist("hash-conflict", {
      review,
      gate,
      changedSourceSha256: await learningHash(workspace, seeded.source),
    });
  }, 60_000);
  it("actual missing retrieval file reaches the original reviewer and holds absorption", async () => {
    const seeded = await prepare();
    await fs.rm(path.join(workspace, text(seeded.candidate.retrievalReceiptPath)));
    const review = record(
      (
        await createModuleLearningPipelineReviewTool({ workspaceDir: workspace }).execute(
          "missing-retrieval",
          { writeReview: false },
        )
      ).details,
    );
    const row = (review.rows as Array<Record<string, unknown>>)[0];
    expect(row.missingEvidence).toContain(
      `unreadable_evidence_file:${text(seeded.candidate.retrievalReceiptPath)}`,
    );
    expect(row.weak).toBe(true);
    const gate = await learningGate(workspace);
    expect(gate.absorptionReady).toBe(false);
    await persist("missing", { review, gate });
  }, 60_000);
  it("newer original hardened-eval timeout overrides old clean evidence without training or overwriting source receipts", async () => {
    const seeded = await prepare();
    const oldPlan = await fs.readFile(path.join(workspace, text(seeded.plan.receiptPath)), "utf8");
    await fs.appendFile(
      path.join(workspace, "guard.jsonl"),
      `${JSON.stringify({ at: "2026-10-11T01:00:00.000Z", event: "step_timeout", name: "stable_hardened_eval", result: { timeoutReason: "offline_probe_timeout", timeoutMs: 100, failedCaseIds: ["adjacent-task"] } })}\n`,
    );
    const gate = await learningGate(workspace);
    expect(gate.blockers).toContain("latest_hardened_eval_timeout_newer_than_absorption_evidence");
    expect(record(gate.latestEvalTimeout).newerThanLatestEval).toBe(true);
    expect(await fs.readFile(path.join(workspace, text(seeded.plan.receiptPath)), "utf8")).toBe(
      oldPlan,
    );
    await persist("timeout", { gate });
  }, 60_000);
  it.each(["downrank", "discard"])(
    "persisted %s blocks the next original application and explicit reviewed keep restores it",
    async (decision) => {
      const seeded = await prepare();
      const reviewed = record(
        (
          await createModuleLearningPipelinePlanTool({ workspaceDir: workspace }).execute(
            "decision",
            {
              ...seeded.planArgs,
              keepDownrankDiscardDecision: decision,
              supersedesReceiptPath: seeded.plan.receiptPath,
            },
          )
        ).details,
      );
      const blocked = record(
        (
          await createFinanceLearningCapabilityApplyTool({ workspaceDir: workspace }).execute(
            "blocked",
            { queryText: seeded.query, writeUsageReceipt: true },
          )
        ).details,
      );
      expect(blocked.applicationStatus).toBe("not_application_ready");
      expect((blocked.blockedCapabilities as Array<Record<string, unknown>>)[0]).toMatchObject({
        sourceArticlePath: seeded.source,
        moduleLearningReview: expect.objectContaining({
          status: decision,
          receipts: expect.arrayContaining([
            expect.objectContaining({
              receiptPath: reviewed.receiptPath,
              receiptSha256: await learningHash(workspace, text(reviewed.receiptPath)),
              keepDownrankDiscardDecision: decision,
            }),
          ]),
        }),
      });
      await createModuleLearningPipelinePlanTool({ workspaceDir: workspace }).execute(
        "explicit-keep",
        {
          ...seeded.planArgs,
          keepDownrankDiscardDecision: "keep",
          supersedesReceiptPath: reviewed.receiptPath,
        },
      );
      const restored = record(
        (
          await createFinanceLearningCapabilityApplyTool({ workspaceDir: workspace }).execute(
            "restored",
            { queryText: seeded.query, writeUsageReceipt: false },
          )
        ).details,
      );
      expect(restored.applicationStatus).toBe("application_ready");
      await persist(`decision-${decision}`, { reviewed, blocked, restored });
    },
    60_000,
  );
  it("a same-source decision in another module does not block this capability", async () => {
    const seeded = await prepare();
    await createModuleLearningPipelinePlanTool({ workspaceDir: workspace }).execute(
      "other-module",
      {
        ...seeded.planArgs,
        targetModule: "technical_timing",
        keepDownrankDiscardDecision: "discard",
      },
    );
    const apply = record(
      (
        await createFinanceLearningCapabilityApplyTool({ workspaceDir: workspace }).execute(
          "same-source-other-module",
          { queryText: seeded.query, writeUsageReceipt: false },
        )
      ).details,
    );
    expect(apply.applicationStatus).toBe("application_ready");
    await persist("module-scope", { apply });
  }, 60_000);
  it("same-name source at a different identity cannot downrank the selected card", async () => {
    const seeded = await prepare();
    const unrelated = "memory/unrelated/source.md";
    await fs.mkdir(path.dirname(path.join(workspace, unrelated)), { recursive: true });
    await fs.copyFile(path.join(workspace, seeded.source), path.join(workspace, unrelated));
    await createModuleLearningPipelinePlanTool({ workspaceDir: workspace }).execute(
      "other-source",
      {
        ...seeded.planArgs,
        sourceUrlOrPath: unrelated,
        sourceRegistryRecordPath: unrelated,
        keepDownrankDiscardDecision: "discard",
      },
    );
    const apply = record(
      (
        await createFinanceLearningCapabilityApplyTool({ workspaceDir: workspace }).execute(
          "exact-source",
          { queryText: seeded.query, writeUsageReceipt: false },
        )
      ).details,
    );
    expect(apply.applicationStatus).toBe("application_ready");
    await persist("source-scope", { apply, unrelated });
  }, 60_000);
  it("mixed cards count only the actually applied source in the result and original usage receipt", async () => {
    const seeded = await prepare();
    await createModuleLearningPipelinePlanTool({ workspaceDir: workspace }).execute(
      "downrank-selected",
      {
        ...seeded.planArgs,
        keepDownrankDiscardDecision: "downrank",
        supersedesReceiptPath: seeded.plan.receiptPath,
      },
    );
    const secondInput = "memory/input/independent.md";
    const content = (await fs.readFile(path.join(workspace, seeded.sourceFile), "utf8")).replace(
      "ETF risk sizing review workflow",
      "Independent ETF risk sizing review workflow",
    );
    await fs.writeFile(path.join(workspace, secondInput), content);
    const intake = record(
      (
        await createFinanceLearningPipelineOrchestratorTool({ workspaceDir: workspace }).execute(
          "second-card",
          {
            sourceName: "Independent risk source",
            sourceType: "manual_article_source",
            localFilePath: secondInput,
            title: "Independent risk sizing",
            retrievalNotes: "Private original source, no remote fetch",
            allowedActionAuthority: "research_only",
            learningIntent: seeded.query,
          },
        )
      ).details,
    );
    expect(intake.ok).toBe(true);
    const secondSource = text((intake.normalizedArticleArtifactPaths as string[])[0]);
    const apply = record(
      (
        await createFinanceLearningCapabilityApplyTool({ workspaceDir: workspace }).execute(
          "mixed-application",
          { queryText: seeded.query, maxCandidates: 10, writeUsageReceipt: true },
        )
      ).details,
    );
    expect(apply.candidateCount).toBe(1);
    expect(apply.appliedCapabilities).toEqual([
      expect.objectContaining({ sourceArticlePath: secondSource }),
    ]);
    expect(apply.blockedCapabilities).toEqual([
      expect.objectContaining({ sourceArticlePath: seeded.source }),
    ]);
    const receipt = JSON.parse(
      await fs.readFile(path.join(workspace, text(apply.usageReceiptPath)), "utf8"),
    ) as Record<string, unknown>;
    expect(receipt.candidateCount).toBe(1);
    expect(receipt.appliedCapabilities).toEqual([
      expect.objectContaining({ sourceArticlePath: secondSource }),
    ]);
    await persist("mixed-application", { intake, apply, receipt });
  }, 60_000);
  it("conflicting active source-module decisions block reuse until original receipts resolve them", async () => {
    const seeded = await prepare();
    await createModuleLearningPipelinePlanTool({ workspaceDir: workspace }).execute(
      "downrank-branch",
      {
        ...seeded.planArgs,
        keepDownrankDiscardDecision: "downrank",
        supersedesReceiptPath: seeded.plan.receiptPath,
      },
    );
    const alternateApplication = "evidence/alternate-original-application.json";
    await fs.copyFile(
      path.join(workspace, seeded.applicationPath),
      path.join(workspace, alternateApplication),
    );
    await createModuleLearningPipelinePlanTool({ workspaceDir: workspace }).execute(
      "keep-other-application-branch",
      {
        ...seeded.planArgs,
        applicationValidationReceiptPath: alternateApplication,
        keepDownrankDiscardDecision: "keep",
      },
    );
    const apply = record(
      (
        await createFinanceLearningCapabilityApplyTool({ workspaceDir: workspace }).execute(
          "conflicting-decision",
          { queryText: seeded.query, writeUsageReceipt: false },
        )
      ).details,
    );
    expect(apply.applicationStatus).toBe("not_application_ready");
    expect((apply.blockedCapabilities as Array<Record<string, unknown>>)[0]).toMatchObject({
      moduleLearningReview: expect.objectContaining({ status: "conflicting_review_decisions" }),
    });
    await persist("decision-conflict", { apply });
  }, 60_000);
  it("unreadable original plan directory cannot silently permit application", async () => {
    const seeded = await prepare();
    const root = path.join(workspace, "memory/module-learning-pipeline-plan-receipts");
    await fs.rename(root, `${root}.preserved`);
    await fs.writeFile(root, "A file is not a readable plan directory");
    const apply = record(
      (
        await createFinanceLearningCapabilityApplyTool({ workspaceDir: workspace }).execute(
          "unreadable-review",
          { queryText: seeded.query, writeUsageReceipt: false },
        )
      ).details,
    );
    expect(apply.applicationStatus).toBe("not_application_ready");
    expect((apply.blockedCapabilities as Array<Record<string, unknown>>)[0]).toMatchObject({
      sourceArticlePath: seeded.source,
      moduleLearningReview: expect.objectContaining({ status: "review_unavailable" }),
    });
    await persist("unreadable-review", { apply });
  }, 60_000);
  it("original review decision is consumed by a superseding plan without claiming model learning", async () => {
    const seeded = await prepare();
    const firstRow = (seeded.review.rows as Array<Record<string, unknown>>)[0];
    const next = record(
      (
        await createModuleLearningPipelinePlanTool({ workspaceDir: workspace }).execute(
          "native-downrank-feedback",
          {
            ...seeded.planArgs,
            keepDownrankDiscardDecision: "downrank",
            supersedesReceiptPath: firstRow.receiptPath,
          },
        )
      ).details,
    );
    const review = record(
      (
        await createModuleLearningPipelineReviewTool({ workspaceDir: workspace }).execute(
          "feedback-review",
          { writeReview: false },
        )
      ).details,
    );
    const rows = review.rows as Array<Record<string, unknown>>;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keepDownrankDiscardDecision: "downrank",
          terminalNonAbsorbedDecision: true,
        }),
      ]),
    );
    const afterDownrank = record(
      (
        await createFinanceLearningCapabilityApplyTool({ workspaceDir: workspace }).execute(
          "check-after-downrank",
          { queryText: seeded.query, writeUsageReceipt: false },
        )
      ).details,
    );
    expect(afterDownrank.ok).toBe(false);
    expect(afterDownrank.failedReason).toBe("module_learning_review_blocks_application");
    expect(afterDownrank.candidateCount).toBe(0);
    await persist("review-feedback", {
      priorReview: seeded.review,
      nextPlan: next,
      review,
      afterDownrank,
      feedback: "Original persisted review decision now changes next application outcome",
      boundary:
        "Review consumed by next module plan; does not prove retained capability card downrank or model training",
    });
  }, 60_000);
});

describe("continuous original learning owner waterflow", () => {
  it.each(["healthy", "source_hash_conflict", "missing_retrieval", "eval_timeout"] as const)(
    "preserves all original bytes and audits the continuous %s sample",
    async (fault) => {
      workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-learning-continuous-"));
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          throw new Error("Network forbidden");
        }),
      );
      const directory = process.env.LCX_WATERFLOW_PROOF_DIR
        ? path.join(process.env.LCX_WATERFLOW_PROOF_DIR, `continuous-${fault}`)
        : path.join(workspace, "offline-observation");
      observation.workspace = workspace;
      observation.runId = `continuous-native-learning-${fault}`;
      observation.calls = [];
      const result = await probeContinuousNativeLearning({
        workspace,
        directory,
        runId: observation.runId,
        observations: observation.calls,
        fault: fault === "healthy" ? undefined : fault,
      });
      expect(result.audit).toMatchObject({ status: "normal_block", gaps: [] });
      expect(result.nextApply.applicationStatus).toBe("not_application_ready");
      expect(result.gate.absorptionReady).toBe(false);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
    60_000,
  );
});
