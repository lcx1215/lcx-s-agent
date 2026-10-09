import { setTimeout as delay } from "node:timers/promises";

export type FinanceSchedulerAccountWork = Readonly<{
  schemaVersion: "lcx_finance_account_work_v1";
  activeWork: "trading" | "reconciliation" | null;
  queuedWork: number;
  reconciliationPending: boolean;
}>;

/** One resident account lane; events request REST reconciliation without writing account facts. */
export function createFinanceSchedulerReconciliationWake(options: {
  signal: AbortSignal;
  reconcile: () => Promise<void>;
  onError: (error: unknown) => void;
  minIntervalMs?: number;
  /** Persist before admitting work; an observation failure prevents that work from starting. */
  onStateChange?: (state: FinanceSchedulerAccountWork) => void;
}) {
  let tail = Promise.resolve();
  let pending = false;
  let pump: Promise<void> | undefined;
  let lastAttemptAt = 0;
  let activeWork: FinanceSchedulerAccountWork["activeWork"] = null;
  let queuedWork = 0;
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? 5_000);
  const getStatus = (): FinanceSchedulerAccountWork =>
    Object.freeze({
      schemaVersion: "lcx_finance_account_work_v1",
      activeWork,
      queuedWork,
      reconciliationPending: pending && !options.signal.aborted,
    });
  const publish = () => options.onStateChange?.(getStatus());

  const run = <T>(
    work: () => Promise<T>,
    kind: Exclude<FinanceSchedulerAccountWork["activeWork"], null> = "trading",
  ): Promise<T> => {
    queuedWork++;
    try {
      publish();
    } catch (error) {
      queuedWork--;
      return Promise.reject(error);
    }
    const next = tail.then(async () => {
      queuedWork--;
      activeWork = kind;
      try {
        publish();
        if (options.signal.aborted) {
          throw options.signal.reason ?? new Error("finance scheduler aborted");
        }
        return await work();
      } finally {
        activeWork = null;
        publish();
      }
    });
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const request = () => {
    if (options.signal.aborted) {
      return;
    }
    pending = true;
    if (pump) {
      return;
    }
    pump = run(async () => {
      if (pending && !options.signal.aborted) {
        const waitMs = Math.max(0, lastAttemptAt + minIntervalMs - Date.now());
        if (waitMs > 0) {
          await delay(waitMs, undefined, { signal: options.signal });
        }
        // A burst received while another account task owns the lane becomes one readback.
        pending = false;
        lastAttemptAt = Date.now();
        try {
          await options.reconcile();
        } catch (error) {
          if (!options.signal.aborted) {
            options.onError(error);
          }
        }
      }
    }, "reconciliation")
      .catch((error: unknown) => {
        // Failed admission/observation is not a fresh hint; avoid a hot retry loop.
        pending = false;
        if (!options.signal.aborted) {
          options.onError(error);
        }
      })
      .finally(() => {
        pump = undefined;
        if (pending && !options.signal.aborted) {
          request();
        }
      });
  };

  return {
    getStatus,
    run,
    request,
    flush: async () => {
      await tail;
      while (pump) {
        await pump;
      }
    },
  };
}
