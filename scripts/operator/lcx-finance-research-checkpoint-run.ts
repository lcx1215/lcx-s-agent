import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FinanceModelStageFailure } from "../../src/agents/finance-model-checkpoints.ts";
import { runFinanceResearchRun } from "../../src/agents/finance-research-runner.ts";

export class FinanceResearchRunFailure extends Error {
  readonly failureClass: FinanceResearchFailureClass;
  readonly enteredStage?: "committee" | "quality";

  constructor(
    readonly reason:
      | "research_run_deadline_exceeded"
      | "research_run_cancelled"
      | "research_run_failed",
    readonly runId: string,
    readonly checkpointPath: string,
    readonly startedAt: string,
    cause?: unknown,
  ) {
    super(reason, { cause });
    this.name = "FinanceResearchRunFailure";
    this.enteredStage = cause instanceof FinanceModelStageFailure ? cause.stage : undefined;
    this.failureClass = classifyFinanceResearchFailure(
      reason,
      cause instanceof FinanceModelStageFailure ? cause.cause : cause,
    );
  }
}

export type FinanceResearchFailureClass =
  | "deadline"
  | "cancelled"
  | "provider_quota"
  | "provider_billing"
  | "provider_access"
  | "network"
  | "timeout"
  | "persistence"
  | "evidence_contract"
  | "model_response"
  | "unknown";

function classifyFinanceResearchFailure(
  reason: FinanceResearchRunFailure["reason"],
  cause: unknown,
): FinanceResearchFailureClass {
  if (reason === "research_run_deadline_exceeded") {
    return "deadline";
  }
  if (reason === "research_run_cancelled") {
    return "cancelled";
  }

  const message =
    cause instanceof Error
      ? `${cause.name} ${cause.message}`
      : typeof cause === "string"
        ? cause
        : "";
  if (
    /\b429\b|rate[_ -]?limit|quota|budget[_ -]?exhausted|insufficient[_ -]?quota/i.test(message)
  ) {
    return "provider_quota";
  }
  if (/\b402\b|payment[_ -]?required|billing/i.test(message)) {
    return "provider_billing";
  }
  if (/\b(?:401|403)\b|provider_auth|unauthori[sz]ed|forbidden|permission denied/i.test(message)) {
    return "provider_access";
  }
  if (/timeout|timed out|etimedout|deadline exceeded|operation was aborted/i.test(message)) {
    return "timeout";
  }
  if (
    /fetch failed|econnreset|econnrefused|enotfound|eai_again|network error|socket hang up/i.test(
      message,
    )
  ) {
    return "network";
  }
  if (/sqlite|database|eacces|eperm|enoent|read-only|disk full/i.test(message)) {
    return "persistence";
  }
  if (/controller\s*evidence|evidence.{0,40}(?:byte|size|limit|budget)/i.test(message)) {
    return "evidence_contract";
  }
  if (/model|inference|completion|invalid response|schema validation/i.test(message)) {
    return "model_response";
  }
  return "unknown";
}

/** The scheduler remains the hard process deadline owner; this deadline cancels the DAG. */
export async function runCheckpointedFinanceResearch(
  input: Parameters<typeof runFinanceResearchRun>[0],
  budget: { directory: string; runTimeoutMs: number; maxModelCalls: number },
  execute = runFinanceResearchRun,
) {
  if (
    !Number.isSafeInteger(budget.runTimeoutMs) ||
    budget.runTimeoutMs <= 0 ||
    budget.runTimeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(budget.maxModelCalls) ||
    budget.maxModelCalls <= 0
  ) {
    throw new Error("invalid research run budget");
  }
  const runId = randomUUID();
  const directory = path.join(budget.directory, runId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const checkpoint = {
    path: path.join(directory, "checkpoints.sqlite"),
    runId,
    // Fresh identities deliberately forbid accidental reuse across CLI invocations.
    executionFingerprint: `cli-research-v1:${runId}`,
  };
  const startedAt = new Date().toISOString();
  const record = (
    status: string,
    reason?: string,
    failureClass?: FinanceResearchFailureClass,
    enteredStage?: "committee" | "quality",
  ) => {
    const temporary = path.join(directory, "run.json.tmp");
    writeFileSync(
      temporary,
      JSON.stringify(
        {
          runId,
          startedAt,
          observedAt: new Date().toISOString(),
          status,
          reason,
          ...(failureClass ? { failureClass } : {}),
          ...(enteredStage ? { enteredStage } : {}),
          checkpointPath: checkpoint.path,
          runTimeoutMs: budget.runTimeoutMs,
          maxModelCalls: budget.maxModelCalls,
          deadlineScope: "cooperative_cancellation_scheduler_owns_process_timeout",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    renameSync(temporary, path.join(directory, "run.json"));
  };
  record("running");
  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  let checkpointWriteError: unknown;
  const timer = setTimeout(() => {
    try {
      record("cancelling", "research_run_deadline_exceeded", "deadline");
    } catch (error) {
      checkpointWriteError = error;
    } finally {
      controller.abort(new Error("research_run_deadline_exceeded"));
    }
  }, budget.runTimeoutMs);
  try {
    const receipt = await execute({
      ...input,
      signal,
      batchOptions: { ...input.batchOptions, checkpoint },
      modelCheckpoint: { ...checkpoint, maxModelCalls: budget.maxModelCalls },
    });
    // A late candidate must never be persisted as an actionable portfolio plan.
    signal.throwIfAborted();
    if (checkpointWriteError) {
      throw checkpointWriteError;
    }
    // A returned receipt can still contain a provider-blocked DAG. Preserve the
    // bounded cause without persisting raw role errors or calling it an admission.
    const providerFailure =
      receipt.answerDecision === "return_failed_reason"
        ? receipt.committee?.model.roleStatuses
            .filter((role) => role.status !== "completed" && role.error)
            .map((role) => classifyFinanceResearchFailure("research_run_failed", role.error))
            .find(
              (failure) =>
                failure === "provider_billing" ||
                failure === "provider_access" ||
                failure === "provider_quota",
            )
        : undefined;
    record("completed", receipt.status, providerFailure);
    return receipt;
  } catch (error) {
    const wasAborted = signal.aborted;
    const reason = controller.signal.aborted
      ? "research_run_deadline_exceeded"
      : signal.aborted
        ? "research_run_cancelled"
        : "research_run_failed";
    const failure = new FinanceResearchRunFailure(reason, runId, checkpoint.path, startedAt, error);
    // Classify the original failure before cancelling any still-running cooperative work.
    controller.abort(new Error("research_run_failure_cleanup"));
    record(wasAborted ? "aborted" : "failed", reason, failure.failureClass, failure.enteredStage);
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}
