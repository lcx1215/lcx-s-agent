import { randomUUID } from "node:crypto";
import { caseflowFingerprint } from "./finance-caseflow.js";
import {
  openFinanceRunCheckpoints,
  type FinanceCheckpointOptions,
} from "./finance-run-checkpoints.js";
import { ModelAdapterError } from "./logical-agent-model-router.js";
import type { LogicalAgentModelInvoker, LogicalAgentModelRouting } from "./logical-agent-pool.js";

export type FinanceModelCheckpointOptions = FinanceCheckpointOptions & { maxModelCalls: number };
export class FinanceModelStageUncertainError extends Error {
  constructor(stage: string) {
    super(`model_stage_outcome_unknown:${stage}`);
  }
}

export function financeModelRoutingIdentity(routing: LogicalAgentModelRouting | undefined) {
  if (!routing) {
    return null;
  }
  const adapterIdentity = (id: string) => {
    const adapter = routing.adapters.find((entry) => entry.id === id);
    return adapter
      ? {
          provider: adapter.provider,
          modelId: adapter.modelId,
          mode: adapter.mode,
          capabilities: adapter.capabilities,
          requiredTools: adapter.requiredTools,
          requiredSideEffects: adapter.requiredSideEffects,
          roleScope: adapter.roleScope,
          maxInputBytes: adapter.maxInputBytes,
          qualificationId: adapter.qualificationId,
        }
      : { missingAdapter: id };
  };
  const policyIdentity = (policy: LogicalAgentModelRouting["defaultPolicy"]) => ({
    ...policy,
    outputContract: policy.outputContract
      ? { revision: policy.outputContract.revision }
      : undefined,
    primary: adapterIdentity(policy.primary),
    fallback: (policy.fallback ?? []).map(adapterIdentity),
  });
  return {
    revision: routing.revision,
    defaultPolicy: policyIdentity(routing.defaultPolicy),
    roles: Object.fromEntries(
      Object.entries(routing.roles ?? {}).map(([role, policy]) => [role, policyIdentity(policy)]),
    ),
  };
}

/** Preserve whole stage receipts, including original call attestations and quality gates. */
export function openFinanceModelCheckpoints(
  options: FinanceModelCheckpointOptions,
  input: unknown,
) {
  const store = openFinanceRunCheckpoints(
    { ...options, runId: `${options.runId}:models` },
    caseflowFingerprint(input),
    options.maxModelCalls,
  );
  const reusedStages: string[] = [];
  let newModelCalls = 0;
  let closed = false;
  const invoke = (
    call: () => Promise<unknown>,
    signal: AbortSignal,
    identity = "legacy",
    diagnose?: (result: unknown) => { passed: boolean; detail?: string },
  ) => {
    if (signal.aborted) {
      throw new Error("model_checkpoint_cancelled_before_dispatch");
    }
    const startedAt = new Date().toISOString();
    const key = `call:${identity}:${startedAt}:${randomUUID()}`;
    const reservation = store.reserve(key, 1);
    if (reservation.status !== "reserved") {
      throw new Error("model_call_budget_exhausted");
    }
    newModelCalls++;
    // A reserved call remains charged even if it times out or throws. No late
    // transport completion may write into a database closed by its stage owner.
    return (async () => {
      const finish = (
        transportOutcome: string,
        contractCheck?: { passed: boolean; detail?: string },
        failureCode?: string,
      ) => {
        if (!closed) {
          store.complete(key, reservation.token, {
            startedAt,
            finishedAt: new Date().toISOString(),
            transportOutcome,
            // Transport return is not output-contract acceptance or stage success.
            contractAcceptance: "not_assessed",
            ...(contractCheck ? { contractCheck } : {}),
            ...(failureCode ? { failureCode } : {}),
          });
        }
      };
      let result: unknown;
      try {
        result = await call();
      } catch (error) {
        finish(
          signal.aborted ? "aborted" : "threw",
          undefined,
          error instanceof ModelAdapterError ? error.code : "adapter_error",
        );
        throw error;
      }
      let contractCheck: { passed: boolean; detail?: string } | undefined;
      if (!signal.aborted && diagnose) {
        try {
          contractCheck = diagnose(result);
        } catch {
          /* Diagnostics cannot alter dispatch results. */
        }
      }
      finish(signal.aborted ? "returned_after_abort" : "returned", contractCheck);
      return result;
    })();
  };
  return {
    invoker(original: LogicalAgentModelInvoker | undefined): LogicalAgentModelInvoker | undefined {
      return original
        ? (request, signal) => invoke(() => original(request, signal), signal)
        : undefined;
    },
    routing(original: LogicalAgentModelRouting | undefined): LogicalAgentModelRouting | undefined {
      return original
        ? {
            ...original,
            adapters: original.adapters.map((adapter) => ({
              ...adapter,
              invoke: (request, signal) =>
                invoke(
                  () => adapter.invoke(request, signal),
                  signal,
                  `${request.role}:${adapter.id}:${request.attempt}`,
                  (result) => {
                    const contract = (original.roles?.[request.role] ?? original.defaultPolicy)
                      .outputContract;
                    if (!contract) {
                      throw new Error("output contract unavailable");
                    }
                    const passed = contract.validate(result, request.payload);
                    return {
                      passed,
                      ...(!passed && contract.describeFailure
                        ? {
                            detail: contract.describeFailure(result, request.payload).slice(0, 600),
                          }
                        : {}),
                    };
                  },
                ),
            })),
          }
        : undefined;
    },
    async stage<T>(name: "committee" | "quality", execute: () => Promise<T>): Promise<T> {
      const reservation = store.reserve(`stage:${name}`, 0);
      if (reservation.status === "completed") {
        reusedStages.push(name);
        return reservation.result as T;
      }
      if (reservation.status !== "reserved") {
        throw new FinanceModelStageUncertainError(name);
      }
      const result = await execute();
      store.complete(`stage:${name}`, reservation.token, result);
      return result;
    },
    summary() {
      return {
        scope: "model_stages" as const,
        runId: options.runId,
        maxModelCalls: options.maxModelCalls,
        reservedModelCalls: store.reserved(),
        newModelCalls,
        reusedStages: [...reusedStages],
        attestationScope: "original_execution_receipts" as const,
      };
    },
    close() {
      closed = true;
      store.close();
    },
  };
}
