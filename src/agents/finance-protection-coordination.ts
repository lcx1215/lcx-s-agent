/** Working sell stops reserve inventory; they are neither new entry orders nor free inventory. */
export function classifyFinanceProtectionOrders(
  orders: readonly Record<string, unknown>[],
  positions: ReadonlyMap<string, number>,
  now = Date.now(),
) {
  const reserved = new Map<string, number>();
  const protective: { id: string; instrument: string; quantity: number; stopPrice: number }[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const order of orders) {
    const id = typeof order.id === "string" ? order.id : "";
    const instrument = typeof order.symbol === "string" ? order.symbol : "";
    const qty = Number(order.qty),
      filled = Number(order.filled_qty),
      stop = Number(order.stop_price);
    if (
      !id ||
      seen.has(id) ||
      !instrument ||
      order.side !== "sell" ||
      order.type !== "stop" ||
      order.status !== "new" ||
      order.time_in_force !== "gtc" ||
      !Number.isFinite(qty) ||
      qty <= 0 ||
      filled !== 0 ||
      !Number.isFinite(stop) ||
      stop <= 0 ||
      (order.expires_at !== undefined &&
        (typeof order.expires_at !== "string" || !(Date.parse(order.expires_at) > now))) ||
      (order.legs !== undefined &&
        order.legs !== null &&
        (!Array.isArray(order.legs) || order.legs.length !== 0))
    ) {
      unresolved.push(id || "missing-order-id");
      continue;
    }
    seen.add(id);
    const total = (reserved.get(instrument) ?? 0) + qty;
    if (total > (positions.get(instrument) ?? 0) + 1e-10) {
      unresolved.push(id);
      continue;
    }
    reserved.set(instrument, total);
    protective.push({ id, instrument, quantity: qty, stopPrice: stop });
  }
  return { reserved, protective, unresolved };
}

export function planFinanceProtectedReduction(input: {
  positionQuantity: number;
  sellQuantity: number;
  protective: readonly { id: string; quantity: number; stopPrice: number }[];
}) {
  const reserved = input.protective.reduce((sum, order) => sum + order.quantity, 0);
  if (
    !Number.isFinite(input.positionQuantity) ||
    !Number.isFinite(input.sellQuantity) ||
    input.sellQuantity <= 0 ||
    input.sellQuantity > input.positionQuantity ||
    reserved > input.positionQuantity ||
    input.protective.some((order) => !order.id || !(order.quantity > 0) || !(order.stopPrice > 0))
  ) {
    throw new Error("invalid protected reduction");
  }
  const free = input.positionQuantity - reserved;
  return {
    status:
      input.sellQuantity <= free ? ("ready" as const) : ("protection_change_required" as const),
    freeQuantity: free,
    requestedQuantity: input.sellQuantity,
    remainingQuantity: input.positionQuantity - input.sellQuantity,
    // Cancellation acknowledgement is not cancellation completion. The controller must
    // re-read fills/positions and re-size, rather than reuse this pre-cancellation amount.
    conflictingOrderIds: input.sellQuantity > free ? input.protective.map((order) => order.id) : [],
    requiresTerminalCancellationAndFreshPosition: input.sellQuantity > free,
  };
}

/** Runs inside the shared execution account lock and after its durable claim.
 * One whole-position stop is supported; ambiguous/multi-stop books remain unresolved. */
export async function executeFinanceProtectedReduction<
  T extends { filledQuantity: number },
>(options: {
  instrument: string;
  positionQuantity: number;
  sellQuantity: number;
  protection: { id: string; quantity: number; stopPrice: number };
  signal: AbortSignal;
  readStop: () => Promise<{
    id: string;
    status: string;
    filledQuantity: number;
    quantity: number;
    stopPrice: number;
    instrument: string;
  }>;
  cancelStop: () => Promise<void>;
  readPosition: () => Promise<number>;
  execute: () => Promise<T>;
  isDefinitelyRejected?: (error: unknown) => boolean;
  restoreProtection: (quantity: number, stopPrice: number) => Promise<void>;
}) {
  const { protection, signal } = options;
  if (
    protection.quantity !== options.positionQuantity ||
    options.sellQuantity <= 0 ||
    options.sellQuantity > options.positionQuantity
  ) {
    throw new Error("protected reduction requires one whole-position stop");
  }
  const verify = (stop: Awaited<ReturnType<typeof options.readStop>>) => {
    if (
      stop.id !== protection.id ||
      stop.instrument !== options.instrument ||
      stop.quantity !== protection.quantity ||
      stop.stopPrice !== protection.stopPrice ||
      stop.filledQuantity !== 0
    ) {
      throw new Error("protection changed or filled during reduction");
    }
  };
  signal.throwIfAborted();
  const initial = await options.readStop();
  verify(initial);
  if (initial.status !== "new") {
    throw new Error("protective stop not ready for cancellation");
  }
  await options.cancelStop();
  for (;;) {
    signal.throwIfAborted();
    const stop = await options.readStop();
    verify(stop);
    if (stop.status === "canceled") {
      break;
    }
    if (!["new", "pending_cancel"].includes(stop.status)) {
      throw new Error("protective cancellation unresolved");
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, 100);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
    });
  }
  const before = await options.readPosition();
  if (before !== options.positionQuantity) {
    throw new Error("position changed during protective cancellation");
  }
  let result: T;
  try {
    signal.throwIfAborted();
    result = await options.execute();
  } catch (error) {
    if (options.isDefinitelyRejected?.(error)) {
      signal.throwIfAborted();
      if ((await options.readPosition()) !== before) {
        throw new Error("rejected sell position changed", { cause: error });
      }
      await options.restoreProtection(before, protection.stopPrice);
      throw error;
    }
    // The sell may have filled. Re-arming the old quantity would risk a short position.
    throw new Error("protected reduction outcome requires reconciliation", { cause: error });
  }
  const remaining = before - result.filledQuantity;
  if (
    !Number.isFinite(remaining) ||
    remaining < 0 ||
    result.filledQuantity < 0 ||
    result.filledQuantity > options.sellQuantity
  ) {
    throw new Error("invalid protected reduction fill");
  }
  if ((await options.readPosition()) !== remaining) {
    throw new Error("post-reduction position requires reconciliation");
  }
  if (remaining > 0) {
    signal.throwIfAborted();
    await options.restoreProtection(remaining, protection.stopPrice);
  }
  return result;
}
