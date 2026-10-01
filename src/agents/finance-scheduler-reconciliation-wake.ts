import { setTimeout as delay } from "node:timers/promises";

/** One resident account lane; events request REST reconciliation without writing account facts. */
export function createFinanceSchedulerReconciliationWake(options: {
  signal: AbortSignal;
  reconcile: () => Promise<void>;
  onError: (error: unknown) => void;
  minIntervalMs?: number;
}) {
  let tail = Promise.resolve();
  let pending = false;
  let pump: Promise<void> | undefined;
  let lastAttemptAt = 0;
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? 5_000);

  const run = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(async () => {
      if (options.signal.aborted) {
        throw options.signal.reason ?? new Error("finance scheduler aborted");
      }
      return work();
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
    })
      .catch((error: unknown) => {
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
