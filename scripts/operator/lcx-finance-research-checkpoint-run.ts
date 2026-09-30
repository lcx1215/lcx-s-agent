import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runFinanceResearchRun } from "../../src/agents/finance-research-runner.ts";

export class FinanceResearchRunFailure extends Error {
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
  }
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
  const record = (status: string, reason?: string) => {
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
      record("cancelling", "research_run_deadline_exceeded");
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
    record("completed", receipt.status);
    return receipt;
  } catch (error) {
    const reason = controller.signal.aborted
      ? "research_run_deadline_exceeded"
      : signal.aborted
        ? "research_run_cancelled"
        : "research_run_failed";
    record(signal.aborted ? "aborted" : "failed", reason);
    throw new FinanceResearchRunFailure(reason, runId, checkpoint.path, startedAt, error);
  } finally {
    clearTimeout(timer);
  }
}
