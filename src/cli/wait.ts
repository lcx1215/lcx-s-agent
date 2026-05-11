type WaitHandle = Promise<void> & { cancel: () => void };

export function waitForever(): WaitHandle {
  let cleanup: (() => void) | null = null;
  let resolveHandle: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolveHandle = resolve;
    const interval = setInterval(() => {}, 1_000_000);
    interval.unref();
    const stop = (): void => {
      if (cleanup) {
        cleanup();
      }
      if (resolveHandle) {
        resolveHandle();
        resolveHandle = null;
      }
    };

    cleanup = () => {
      clearInterval(interval);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      cleanup = null;
      if (resolveHandle) {
        resolveHandle();
        resolveHandle = null;
      }
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  const handle = promise as WaitHandle;
  handle.cancel = () => {
    if (cleanup) {
      cleanup();
    }
  };
  return handle;
}
