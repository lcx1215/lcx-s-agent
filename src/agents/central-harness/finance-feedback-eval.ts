import fs from "node:fs/promises";
import path from "node:path";
import { FINANCE_EXECUTION_RECEIPT_SCHEMA } from "../finance-execution-adapter.js";
import {
  appendFinanceExecutionReceipt,
  appendFinancePositionMark,
} from "../finance-position-ledger.js";
import { runCentralHarnessCycle, compactReceipts } from "./harness-loop.js";
import type { CentralBrain } from "./model-brain.js";
import { createCentralToolRegistry } from "./tool-registry.js";
import type { CentralRunReceipt } from "./types.js";

/** Deterministic comparison follows the same task, tool and evidence seam. */
export const financeFeedbackRuleBrain: CentralBrain = {
  propose: async (perception) => {
    const task = perception.controlRoom.financeFeedbackTask as { primary: string; backup: string };
    const evidence = perception.controlRoom.financeEvidence as Record<string, unknown> | undefined;
    if (evidence?.status === "ready") {
      const positions = evidence.positions as Array<{ quantity: number }>;
      return {
        kind: "proposed",
        provider: "deterministic",
        modelId: "ledger-rule",
        plan: {
          actions: [],
          note: JSON.stringify({
            status: "ready",
            quantity: positions[0]?.quantity,
            unrealizedPnl: evidence.unrealizedPnl,
            basis: "synthetic",
          }),
        },
      };
    }
    return {
      kind: "proposed",
      provider: "deterministic",
      modelId: "ledger-rule",
      plan: {
        actions: [
          {
            ownerId: "finance_position_ledger_read",
            args: { directory: evidence?.status === "absent" ? task.backup : task.primary },
          },
        ],
        note: "Read the declared ledger source.",
      },
    };
  },
};

/** Three bounded cycles over an isolated synthetic ledger; no venue calls. */
export async function evaluateFinanceFeedback(options: {
  brain: CentralBrain;
  workspaceDir: string;
  evidenceKind: "fixture" | "model_call" | "deterministic";
}) {
  // Refuse reuse so a previous run cannot supply evidence or change the answer.
  await fs.mkdir(options.workspaceDir, { recursive: false });
  const primary = path.join(options.workspaceDir, "absent");
  const backup = path.join(options.workspaceDir, "synthetic-book");
  const at = "2026-01-02T00:00:00.000Z";
  await appendFinanceExecutionReceipt(backup, {
    schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
    receiptId: "synthetic-fill",
    intentId: "synthetic-intent",
    runAuthorizationId: "fixture-only",
    adapterId: "paper",
    adapterKind: "paper",
    venue: "paper",
    instrument: "SYNTH",
    side: "buy",
    orderType: "market",
    quantity: 10,
    referencePrice: 100,
    referencePriceAt: at,
    notional: 1000,
    fill: { filledQuantity: 10, fillPrice: 100, filledAt: at, venueRef: "fixture" },
    executionAuthority: "declared_execution_adapter_required",
    recordedAt: at,
  });
  await appendFinancePositionMark(backup, { instrument: "SYNTH", price: 120, at });
  const spec = createCentralToolRegistry().get("finance_position_ledger_read")!;
  let evidence: Record<string, unknown> | undefined;
  const observations: Array<Record<string, unknown>> = [];
  let toolCalls = 0;
  let duplicateCalls = 0;
  const seen = new Set<string>();
  const scopedRegistry = new Map([
    [
      spec.ownerId,
      {
        ...spec,
        approve: (args: Readonly<Record<string, unknown>>) => {
          if (
            ![primary, backup].includes(String(args.directory)) ||
            Object.keys(args).some((key) => key !== "directory")
          ) {
            return { ok: false, reason: "only the two synthetic ledger directories may be read" };
          }
          return spec.approve(args);
        },
        execute: async (args: Readonly<Record<string, unknown>>, signal: AbortSignal) => {
          toolCalls++;
          const directory = String(args.directory);
          if (seen.has(directory)) {
            duplicateCalls++;
          }
          seen.add(directory);
          const result = await spec.execute(args, signal);
          observations.push(result);
          // Preserve task evidence explicitly; verbose paths must not crowd numeric
          // answers out of the generic 512-byte step digest.
          evidence = {
            status: result.status,
            reason: result.reason,
            positions: result.positions,
            unrealizedPnl: result.unrealizedPnl,
            source: directory,
            basis: "synthetic",
          };
          return result;
        },
      },
    ],
  ]);
  const receipts: CentralRunReceipt[] = [];
  const started = performance.now();
  for (let round = 0; round < 3; round++) {
    const receipt = await runCentralHarnessCycle({
      brain: options.brain,
      registry: scopedRegistry,
      maxSteps: 1,
      perception: {
        observedAt: "2026-01-03T00:00:00.000Z",
        ownerTotals: {},
        backlog: compactReceipts(receipts, 3),
        boundaries: ["synthetic_data_only", "read_only", "no_execution_authority"],
        controlRoom: {
          financeFeedbackTask: {
            primary,
            backup,
            instruction:
              'This task uses only synthetic data. Read primary first; if absent, inspect backup. Discover and use finance_position_ledger_read with args {directory: exact path}, one action per cycle. An absent book does not mean zero holdings. After actual tool evidence is ready, stop calling tools and return actions: [] with note containing JSON {"status":"ready","quantity":number,"unrealizedPnl":number,"basis":"synthetic"}. Do not guess numbers. Other capabilities are unavailable for this task.',
          },
          ...(evidence ? { financeEvidence: evidence } : {}),
        },
      },
    });
    receipts.push(receipt);
    if (receipt.brainCall.outcome !== "completed" || receipt.actionsProposed === 0) {
      break;
    }
  }
  let answer: Record<string, unknown> | undefined;
  try {
    answer = JSON.parse(receipts.at(-1)?.brainCall.note ?? "") as Record<string, unknown>;
  } catch {
    /* No structured answer is a failed answer. */
  }
  const answerCorrect =
    answer?.status === "ready" &&
    answer.quantity === 10 &&
    answer.unrealizedPnl === 200 &&
    answer.basis === "synthetic";
  const feedbackFollowed =
    observations[0]?.status === "absent" && observations[1]?.status === "ready";
  const finalStopped =
    receipts.at(-1)?.actionsProposed === 0 && receipts.at(-1)?.brainCall.outcome === "completed";
  const invalidProposals = receipts.reduce(
    (sum, receipt) => sum + receipt.actionsBlockedByGate + Math.max(0, receipt.actionsProposed - 1),
    0,
  );
  return {
    evidenceKind: options.evidenceKind,
    scope: "synthetic_ledger_feedback" as const,
    answer,
    answerCorrect,
    feedbackFollowed,
    finalStopped,
    passed:
      answerCorrect &&
      feedbackFollowed &&
      finalStopped &&
      duplicateCalls === 0 &&
      invalidProposals === 0,
    elapsedMs: performance.now() - started,
    toolCalls,
    duplicateCalls,
    invalidProposals,
    receipts,
    observations,
    promotionApplied: false,
  };
}
