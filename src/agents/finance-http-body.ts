export const DEFAULT_FINANCE_HTTP_BODY_MAX_BYTES = 8 * 1024 * 1024;
export const ALPACA_FINANCE_HTTP_BODY_MAX_BYTES = 2 * 1024 * 1024;

type BoundedTextResponse = Readonly<{
  headers: { get(name: string): string | null };
  body: unknown;
}>;

type BoundedBodyReader = Readonly<{
  closed?: Promise<unknown>;
  read(): Promise<Readonly<{ done: boolean; value?: unknown }>>;
  cancel(): unknown;
  releaseLock(): void;
}>;

export class FinanceHttpBodyAbortError extends Error {
  constructor(readonly cleanupStatus: "confirmed" | "unconfirmed") {
    super(`finance response body aborted; cleanup_${cleanupStatus}`);
  }
}

/**
 * Read a finance HTTP response without allowing an endpoint to allocate an
 * unbounded string before the caller validates JSON or vendor semantics.
 */
export async function readBoundedFinanceResponseText(
  response: BoundedTextResponse,
  options: { maxBytes?: number; label?: string; signal?: AbortSignal; discardBody?: boolean } = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_FINANCE_HTTP_BODY_MAX_BYTES;
  const label = options.label ?? "finance HTTP";
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("finance HTTP response limit must be a positive integer");
  }
  if (!response.body) {
    if (options.signal?.aborted) {
      throw new FinanceHttpBodyAbortError("confirmed");
    }
    return "";
  }
  const stream = response.body as { getReader?: () => BoundedBodyReader };
  if (typeof stream.getReader !== "function") {
    throw new Error(`${label} response body is not readable`);
  }
  const reader = stream.getReader();
  const signal = options.signal;
  let cancellation: Promise<unknown> | undefined;
  const cancel = () => (cancellation ??= Promise.resolve().then(() => reader.cancel()));
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => {
      void cancel().catch(() => undefined);
      reject(new FinanceHttpBodyAbortError("unconfirmed"));
    };
  });
  // The abort may precede the first read (for example a declared-size rejection).
  void aborted.catch(() => undefined);
  if (signal?.aborted) {
    rejectAbort?.();
  } else {
    signal?.addEventListener("abort", rejectAbort!, { once: true });
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let failed = false;
  let failure: unknown;
  let cleanupConfirmed = false;
  try {
    const declared = response.headers.get("content-length");
    if (!options.discardBody && declared !== null && Number(declared) > maxBytes) {
      throw new Error(`${label} response too large`);
    }
    while (!options.discardBody) {
      const item = await (signal ? Promise.race([reader.read(), aborted]) : reader.read());
      if (signal?.aborted) {
        throw new FinanceHttpBodyAbortError("unconfirmed");
      }
      if (item.done) {
        break;
      }
      if (!(item.value instanceof Uint8Array)) {
        throw new Error(`${label} response body chunk is invalid`);
      }
      size += item.value.byteLength;
      if (size > maxBytes) {
        throw new Error(`${label} response too large`);
      }
      chunks.push(item.value);
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    signal?.removeEventListener("abort", rejectAbort!);
    if (signal) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        cleanupConfirmed = await Promise.race([
          cancel().then(
            () => true,
            // Fetch may already have errored the stream on abort. In that case
            // cancel rejects, but a settled closed promise confirms terminal reads.
            () =>
              reader.closed?.then(
                () => true,
                () => true,
              ) ?? false,
          ),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 1_500);
          }),
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    } else {
      await cancel().catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {
      cleanupConfirmed = false;
    }
  }
  if (signal?.aborted) {
    throw new FinanceHttpBodyAbortError(cleanupConfirmed ? "confirmed" : "unconfirmed");
  }
  if (failed) {
    throw failure;
  }
  return Buffer.concat(chunks, size).toString("utf8");
}
