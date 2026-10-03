import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  boundPerception,
  compactReceipts,
  nextCycleContinuation,
  runCentralHarnessCycle,
  type CompactBacklogEntry,
} from "./harness-loop.js";
import { buildCentralBrainPrompt, type CentralBrain } from "./model-brain.js";
import { createCentralToolRegistry } from "./tool-registry.js";
import type {
  CentralActionPlan,
  CentralPerception,
  CentralProposedAction,
  CentralRunReceipt,
} from "./types.js";

const roots: string[] = [];
const capabilities = new Set(["quant_math", "learning_distill"]);
const observedAt = "2026-10-03T00:00:00.000Z";
const reviewNote = [
  "# Learning Review: 2026-10-02 12:00:00 UTC",
  "- **Session Key**: generic-feedback-fixture",
  "- **Session ID**: generic-feedback-fixture",
  "- **Topic**: coding-and-systems",
  "- mistake_pattern: Counting a successful dispatch as completion without consuming its facts.",
  "- core_principle: Keep the evidence and exact input scope until the dependent decision is made.",
  "- micro_drill: Compare measured request latency slopes rather than guessing from task labels.",
  "- transfer_hint: Account identifiers and engineering experiment inputs both delimit evidence.",
  "",
].join("\n");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "central-generic-feedback-"));
  roots.push(workspaceDir);
  const memoryDir = path.join(workspaceDir, "memory");
  await fs.mkdir(memoryDir);
  const notePath = path.join(memoryDir, "2026-10-02-review-feedback.md");
  await fs.writeFile(notePath, reviewNote);
  const fullRegistry = createCentralToolRegistry({ workspaceDir });
  const registry = new Map([...fullRegistry].filter(([ownerId]) => capabilities.has(ownerId)));
  const receipts: CentralRunReceipt[] = [];
  const cycle = async (
    decide: (perception: CentralPerception) => CentralActionPlan,
  ): Promise<CentralRunReceipt> => {
    const perception: CentralPerception = {
      task: {
        objective: "Resolve the engineering or learning evidence gap using declared local facts.",
        focus: "general",
      },
      observedAt: new Date(Date.parse(observedAt) + receipts.length * 1_000).toISOString(),
      ownerTotals: {},
      controlRoom: {
        genericTask: {
          objective: "Resolve the declared engineering or learning evidence gap using local facts.",
          evidenceKind: "offline_scripted_replay",
        },
      },
      backlog: compactReceipts(receipts, 10, capabilities),
      boundaries: ["synthetic_data_only", "local_tools_only", "no_execution_authority"],
    };
    const brain: CentralBrain = {
      propose: async (observed) => {
        // This is scripted replay evidence, never a claim of model reasoning or provider use.
        expect(boundPerception(observed).report.overBudget).toBe(false);
        expect(buildCentralBrainPrompt(observed)).toContain("offline_scripted_replay");
        return {
          kind: "proposed",
          provider: "offline-fixture",
          modelId: "scripted-feedback",
          plan: decide(observed),
        };
      },
    };
    const receipt = await runCentralHarnessCycle({
      perception,
      registry,
      brain,
      planOnly: true,
      capabilityOwnerIds: capabilities,
    });
    receipts.push(receipt);
    expect(receipt.task).toEqual(perception.task);
    expect(receipt.contextBudget?.overBudget).toBe(false);
    expect(receipt.brainCall.modelCall).toBeUndefined();
    expect(receipt.liveTouched).toBe(false);
    expect(receipt.providerConfigTouched).toBe(false);
    expect(receipt.protectedMemoryTouched).toBe(false);
    return receipt;
  };
  const act = (action: CentralProposedAction) =>
    cycle(() => ({ actions: [action], note: "offline scripted local-tool step" }));
  return { workspaceDir, notePath, receipts, cycle, act };
}

function retained(perception: CentralPerception, ownerId: string) {
  return (perception.backlog as readonly CompactBacklogEntry[])
    .flatMap((entry) => entry.outcomes)
    .filter((entry) => entry.ownerId === ownerId && entry.outcome !== undefined);
}

function regressionArgs(scale: number) {
  return {
    action: "linear_regression",
    series: [scale, scale * 2, scale * 3],
    benchmark: [1, 2, 3],
  };
}

describe("generic capability feedback through the production loop (offline scripted replay)", () => {
  it.each([2, 7])(
    "consumes actual engineering calculation after a stopped cycle and unrelated learning work (scale=%s)",
    async (scale) => {
      const run = await fixture();
      const args = regressionArgs(scale);
      const read = await run.act({ ownerId: "quant_math", args });
      expect(read.steps[0]).toMatchObject({
        status: "ran_ok",
        outcome: { action: "linear_regression", beta: scale, observations: 3 },
      });
      expect(nextCycleContinuation(read, 1, 4).run).toBe(true);

      const stopped = await run.cycle(() => ({ actions: [], note: "no changed input" }));
      expect(nextCycleContinuation(stopped, 2, 4, read)).toEqual({
        run: false,
        because: "nothing_left_to_follow_up",
      });
      // A later bounded invocation resumes the same receipts; a no-op is not new evidence.
      const unrelated = await run.act({
        ownerId: "learning_distill",
        args: { since: "2026-10-01T00:00:00.000Z" },
      });
      expect(unrelated.steps[0].outcome).toMatchObject({ status: "distilled", pending: 1 });

      const final = await run.cycle((perception) => {
        const [evidence] = retained(perception, "quant_math");
        expect(evidence?.args).toEqual(args);
        expect(evidence?.sourceObservedAt).toBe(read.observedAt);
        expect(evidence?.argsSha256).toMatch(/^[a-f0-9]{64}$/u);
        return {
          actions: [],
          note: JSON.stringify({
            status: evidence?.outcome ? "resolved" : "unknown",
            beta: evidence?.outcome?.beta,
            evidenceSource: evidence?.ownerId,
            sourceObservedAt: evidence?.sourceObservedAt,
            inputRef: evidence?.argsSha256,
            evidenceKind: "offline_scripted_replay",
          }),
        };
      });
      expect(JSON.parse(final.brainCall.note ?? "{}")).toMatchObject({
        status: "resolved",
        beta: scale,
        evidenceSource: "quant_math",
        evidenceKind: "offline_scripted_replay",
      });
      expect(nextCycleContinuation(final, 4, 4, unrelated)).toEqual({
        run: false,
        because: "nothing_left_to_follow_up",
      });
      expect(await fs.readFile(run.notePath, "utf8")).toBe(reviewNote);
    },
  );

  it("keeps distinct actual calculation scopes apart and canonicalizes reordered arguments", async () => {
    const run = await fixture();
    const firstArgs = regressionArgs(2);
    const secondArgs = regressionArgs(9);
    const first = await run.act({ ownerId: "quant_math", args: firstArgs });
    const second = await run.act({ ownerId: "quant_math", args: secondArgs });
    const repeated = await run.act({
      ownerId: "quant_math",
      args: {
        benchmark: secondArgs.benchmark,
        series: secondArgs.series,
        action: secondArgs.action,
      },
    });
    expect(nextCycleContinuation(repeated, 3, 6, second)).toEqual({
      run: false,
      because: "unchanged_result",
    });
    await run.act({
      ownerId: "learning_distill",
      args: { since: "2026-10-01T00:00:00.000Z" },
    });
    const final = await run.cycle((perception) => {
      const results = retained(perception, "quant_math");
      expect(results).toHaveLength(2);
      const inputRefs = results.map((entry) => entry.argsSha256);
      expect(new Set(inputRefs).size).toBe(2);
      const selected = [firstArgs, secondArgs].map((args) => {
        const match = results.find(
          (entry) => JSON.stringify(entry.args?.series) === JSON.stringify(args.series),
        );
        expect(match?.args).toEqual(args);
        expect(match?.sourceObservedAt).toBe(
          args === firstArgs ? first.observedAt : repeated.observedAt,
        );
        return { beta: match?.outcome?.beta, inputRef: match?.argsSha256 };
      });
      return { actions: [], note: JSON.stringify({ status: "resolved", selected }) };
    });
    expect(JSON.parse(final.brainCall.note ?? "{}")).toMatchObject({
      status: "resolved",
      selected: [{ beta: 2 }, { beta: 9 }],
    });
    const allOutcomes = compactReceipts(run.receipts, 10, capabilities).flatMap(
      (entry) => entry.outcomes,
    );
    expect(
      allOutcomes.some((entry) =>
        entry.outcomeDroppedKeys?.includes("outcome_superseded_in_backlog"),
      ),
    ).toBe(true);
  });

  it("keeps an omitted learning card unknown after another tool and stops at the exact unsupported read gap", async () => {
    const run = await fixture();
    const learning = await run.act({
      ownerId: "learning_distill",
      args: { since: "2026-10-01T00:00:00.000Z" },
    });
    expect(learning.steps[0]).toMatchObject({
      status: "ran_ok",
      outcome: { status: "distilled", pending: 1 },
    });
    expect(learning.steps[0].outcomeDroppedKeys).toContain("cards");
    const statePath = path.join(run.workspaceDir, "state", "lcx-learning-workflow-latest.json");
    const durable = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      cards: Array<{ corePrinciple: string }>;
    };
    expect(durable.cards[0]?.corePrinciple).toContain("exact input scope");
    const calculation = await run.act({ ownerId: "quant_math", args: regressionArgs(5) });
    expect(nextCycleContinuation(calculation, 2, 3, learning).run).toBe(true);

    const final = await run.cycle((perception) => {
      const [evidence] = retained(perception, "learning_distill");
      expect(evidence?.outcomeDroppedKeys).toContain("cards");
      expect(evidence?.outcome).not.toHaveProperty("cards");
      expect(evidence?.sourceObservedAt).toBe(learning.observedAt);
      // The registry has no scoped learning-card reader; a filesystem path is not a binding.
      return {
        actions: [],
        note: JSON.stringify({
          status: "unresolved",
          reason: "learning_card_reader_not_registered",
          missingFields: evidence?.outcomeDroppedKeys?.filter((key) => key === "cards"),
          sourceObservedAt: evidence?.sourceObservedAt,
          inputRef: evidence?.argsSha256,
          corePrinciple: "unknown",
          evidenceKind: "offline_scripted_replay",
        }),
      };
    });
    expect(JSON.parse(final.brainCall.note ?? "{}")).toMatchObject({
      status: "unresolved",
      missingFields: ["cards"],
      corePrinciple: "unknown",
      reason: "learning_card_reader_not_registered",
      evidenceKind: "offline_scripted_replay",
    });
    expect(nextCycleContinuation(final, 3, 3, calculation)).toEqual({
      run: false,
      because: "nothing_left_to_follow_up",
    });
    expect(run.receipts.flatMap((receipt) => receipt.steps).map((step) => step.ownerId)).toEqual([
      "learning_distill",
      "quant_math",
    ]);
    expect(await fs.readFile(run.notePath, "utf8")).toBe(reviewNote);
  });
});
