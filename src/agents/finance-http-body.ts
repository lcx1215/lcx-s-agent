export const DEFAULT_FINANCE_HTTP_BODY_MAX_BYTES = 8 * 1024 * 1024;
export const ALPACA_FINANCE_HTTP_BODY_MAX_BYTES = 2 * 1024 * 1024;

type BoundedTextResponse = Readonly<{
  headers: { get(name: string): string | null };
  body: unknown;
}>;

type BoundedBodyReader = Readonly<{
  read(): Promise<Readonly<{ done: boolean; value?: unknown }>>;
  cancel(): unknown;
  releaseLock(): void;
}>;

/**
 * Read a finance HTTP response without allowing an endpoint to allocate an
 * unbounded string before the caller validates JSON or vendor semantics.
 */
export async function readBoundedFinanceResponseText(
  response: BoundedTextResponse,
  options: { maxBytes?: number; label?: string } = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_FINANCE_HTTP_BODY_MAX_BYTES;
  const label = options.label ?? "finance HTTP";
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("finance HTTP response limit must be a positive integer");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maxBytes) {
      throw new Error(`${label} response too large`);
    }
  }
  if (!response.body) {
    return "";
  }
  const stream = response.body as { getReader?: () => BoundedBodyReader };
  if (typeof stream.getReader !== "function") {
    throw new Error(`${label} response body is not readable`);
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
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
  } finally {
    await Promise.resolve(reader.cancel()).catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}
