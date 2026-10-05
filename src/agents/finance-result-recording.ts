import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { recordAgentArtifact, type ArtifactRecordingReceipt } from "./artifact-result-recording.js";
import type {
  FinanceIntradayDecisionRecord,
  FinanceIntradayOutcomeRecord,
} from "./finance-intraday-control-ledger.js";
import type { FinanceResearchRunReceipt } from "./finance-research-runner.js";
import { financeIntradayControlLedgerPath } from "./finance-state-dir.js";

/** Trusted owner injection for isolated checks; never supplied by model tool arguments. */
export type FinanceResultRecordingHost = Readonly<{
  config: OpenClawConfig;
  workspaceDir: string;
}>;
type Scope = { workspaceDir: string; host?: FinanceResultRecordingHost; signal?: AbortSignal };

async function capture(
  scope: Scope,
  input: {
    owner: string;
    runId: string;
    value: unknown;
    sourceReceiptRefs: string[];
  },
): Promise<ArtifactRecordingReceipt> {
  try {
    return await recordAgentArtifact({
      config: scope.host?.config ?? loadConfig(),
      workspaceDir: scope.host?.workspaceDir ?? scope.workspaceDir,
      agentId: "main",
      ...input,
      signal: scope.signal,
    });
  } catch {
    return { status: "unavailable", reason: "finance_artifact_host_unavailable" };
  }
}

export async function recordFinanceIntradayResult(
  input: Scope & {
    directory: string;
    accountId: string;
    venue: string;
    decision: FinanceIntradayDecisionRecord;
    outcome: FinanceIntradayOutcomeRecord;
  },
): Promise<ArtifactRecordingReceipt> {
  try {
    if (
      !input.accountId.trim() ||
      input.venue !== "alpaca:paper" ||
      input.decision.input.signalId !== input.outcome.signalId
    ) {
      return { status: "unavailable", reason: "finance_artifact_scope_invalid" };
    }
    const directory = realpathSync(input.directory);
    const nativePath = financeIntradayControlLedgerPath(directory);
    const runId = `finance-intraday-${createHash("sha256")
      .update(JSON.stringify([directory, input.outcome.signalId]))
      .digest("hex")}`;
    return await capture(input, {
      owner: "finance_intraday_execution",
      runId,
      value: {
        content: [
          {
            type: "text",
            text: `${input.decision.input.instrument} ${input.decision.input.action}: ${input.outcome.status}`,
          },
        ],
        details: {
          accountId: input.accountId,
          venue: input.venue,
          decision: input.decision,
          outcome: input.outcome,
        },
      },
      sourceReceiptRefs: [
        `${nativePath}#finance_intraday_outcomes/${encodeURIComponent(input.outcome.signalId)}`,
        `decision:${input.decision.ref}`,
        ...(input.outcome.receiptId ? [`receipt:${input.outcome.receiptId}`] : []),
      ],
    });
  } catch {
    return { status: "unavailable", reason: "finance_artifact_capture_unavailable" };
  }
}

export async function recordFinanceResearchResult(
  input: Scope & {
    receipt: FinanceResearchRunReceipt;
    datedPath: string;
    sourceSha256: string;
  },
): Promise<ArtifactRecordingReceipt> {
  try {
    return await capture(input, {
      owner: "finance_research",
      runId: input.receipt.quality?.runId ?? `finance-research-${input.sourceSha256}`,
      value: {
        content: [
          {
            type: "text",
            text: `Finance research ${input.receipt.status}: ${input.receipt.plan.targets.map((target) => target.instrument).join(", ")}`,
          },
        ],
        details: { receipt: input.receipt },
      },
      sourceReceiptRefs: [input.datedPath, `sha256:${input.sourceSha256}`],
    });
  } catch {
    return { status: "unavailable", reason: "finance_artifact_capture_unavailable" };
  }
}
