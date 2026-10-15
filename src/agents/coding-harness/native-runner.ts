import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import { runEmbeddedPiAgent } from "../pi-embedded-runner/run.js";
import {
  completeLocalSubagentRun,
  confirmSubagentDispatch,
  recordSubagentDispatchFailure,
  registerSubagentRun,
} from "../subagent-registry.js";
import {
  resolveTrustedNativeCodingBinding,
  type NativeCodingRunBinding,
  type NativeCodingRunInput,
  type NativeCodingRunResult,
} from "./native-types.js";

const consumedBindings = new WeakSet<NativeCodingRunBinding>();

/** Host-side orchestration only. Verification and container destruction belong to the coordinator. */
export async function runNativeCodingAgent(
  input: NativeCodingRunInput,
): Promise<NativeCodingRunResult> {
  let childRunId = "";
  let childSessionKey = "";
  let executionStarted = false;
  let deadline: AbortSignal | undefined;
  try {
    const native = resolveTrustedNativeCodingBinding(input.binding);
    childRunId = native.runId;
    childSessionKey = native.sessionKey;
    if (consumedBindings.has(input.binding)) {
      throw new Error("Native coding binding already consumed");
    }
    if (input.signal.aborted) {
      throw new Error("Native coding cancelled before dispatch");
    }
    if (
      input.timeoutMs !== undefined &&
      (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)
    ) {
      throw new Error("Native coding timeout must be positive");
    }
    const timeoutMs = Math.min(input.timeoutMs ?? native.maxRuntimeMs, native.maxRuntimeMs);
    deadline = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)));
    const signal = AbortSignal.any([input.signal, deadline]);
    registerSubagentRun({
      completionSource: "local",
      dispatchState: "preparing",
      runId: childRunId,
      childSessionKey,
      requesterSessionKey: input.requesterSessionKey,
      requesterDisplayKey: input.requesterSessionKey,
      task: input.task,
      cleanup: "keep",
      runTimeoutSeconds: Math.ceil(timeoutMs / 1000),
    });
    consumedBindings.add(input.binding);
    if (!confirmSubagentDispatch(childRunId, childRunId)) {
      recordSubagentDispatchFailure(childRunId, "Local dispatch blocked by persistence failure");
      throw new Error("Native coding dispatch confirmation could not be persisted");
    }
    const model = resolveDefaultModelForAgent({
      cfg: native.config,
      agentId: resolveAgentIdFromSessionKey(native.sessionKey),
    });
    executionStarted = true;
    const result = await runEmbeddedPiAgent({
      nativeCodingBinding: input.binding,
      runId: childRunId,
      sessionId: native.sessionId,
      sessionKey: childSessionKey,
      sessionFile: native.sessionFile,
      workspaceDir: native.workspaceDir,
      agentDir: native.agentDir,
      config: native.config,
      provider: model.provider,
      model: model.model,
      prompt: input.task,
      abortSignal: signal,
      timeoutMs,
      lane: "subagent",
    });
    const status: NativeCodingRunResult["status"] =
      result.meta.timedOut || deadline.aborted
        ? "timed-out"
        : result.meta.aborted || input.signal.aborted
          ? "cancelled"
          : result.meta.error?.kind === "context_overflow"
            ? "context-limit"
            : result.meta.error ||
                result.payloads?.some((payload) => payload.isError) ||
                result.meta.promptCompleted !== true ||
                result.meta.stopReason !== "stop" ||
                (result.meta.pendingToolCalls?.length ?? 0) > 0
              ? "failed"
              : "completed";
    const persisted = completeLocalSubagentRun(
      childRunId,
      status === "completed" ? { status: "ok" } : { status: "error", error: status },
    );
    return {
      status: persisted ? status : "interrupted",
      result,
      executionStarted,
      childRunId,
      childSessionKey,
      ...(!persisted ? { error: "Local completion could not be persisted" } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = deadline?.aborted
      ? "timed-out"
      : input.signal.aborted
        ? "cancelled"
        : /read-only|read.only credentials|no api key/i.test(message)
          ? "blocked"
          : executionStarted
            ? message === "native-context-limit"
              ? "context-limit"
              : "failed"
            : "blocked";
    const persisted =
      !executionStarted ||
      completeLocalSubagentRun(childRunId, { status: "error", error: message });
    return {
      status: persisted ? status : "interrupted",
      error: message,
      executionStarted,
      childRunId,
      childSessionKey,
    };
  }
}
