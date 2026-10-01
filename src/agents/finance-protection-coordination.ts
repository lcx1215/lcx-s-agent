/** Working sell stops reserve inventory; they are neither new entry orders nor free inventory. */
export type FinanceProtectiveOrder = Readonly<{
  id: string;
  quantity: number;
  stopPrice: number;
  /** Missing is the legacy stop-order representation. */
  orderType?: "stop" | "stop_limit";
  limitPrice?: number;
}>;

export function classifyFinanceProtectionOrders(
  orders: readonly Record<string, unknown>[],
  positions: ReadonlyMap<string, number>,
  now = Date.now(),
) {
  const reserved = new Map<string, number>();
  const protective: (FinanceProtectiveOrder & {
    instrument: string;
    orderType: "stop" | "stop_limit";
  })[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const order of orders) {
    const id = typeof order.id === "string" ? order.id : "";
    const rawInstrument = typeof order.symbol === "string" ? order.symbol : "";
    // Broker crypto orders may use BTCUSD while the position owner supplies BTC/USD.
    // An exact holding wins; resolve an alias only against an existing position.
    const cryptoInstrument = /^[A-Z0-9]+USD$/.test(rawInstrument)
      ? `${rawInstrument.slice(0, -3)}/USD`
      : "";
    const instrument =
      !positions.has(rawInstrument) && positions.has(cryptoInstrument)
        ? cryptoInstrument
        : rawInstrument;
    const qty = Number(order.qty),
      filled = Number(order.filled_qty),
      stop = Number(order.stop_price),
      orderType = order.type,
      limit =
        order.limit_price === undefined || order.limit_price === null
          ? undefined
          : Number(order.limit_price);
    if (
      ![order.qty, order.filled_qty, order.stop_price].every(
        (value) => typeof value === "number" || (typeof value === "string" && value.trim() !== ""),
      ) ||
      !id.trim() ||
      seen.has(id) ||
      !instrument ||
      order.side !== "sell" ||
      (orderType !== "stop" && orderType !== "stop_limit") ||
      (orderType === "stop" && limit !== undefined) ||
      (orderType === "stop_limit" &&
        (!(
          typeof order.limit_price === "number" ||
          (typeof order.limit_price === "string" && order.limit_price.trim() !== "")
        ) ||
          !Number.isFinite(limit) ||
          limit! <= 0 ||
          limit! > stop)) ||
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
    const held = positions.get(instrument);
    if (held === undefined || !Number.isFinite(held) || held < 0 || total > held + 1e-10) {
      unresolved.push(id);
      continue;
    }
    reserved.set(instrument, total);
    protective.push({
      id,
      instrument,
      quantity: qty,
      stopPrice: stop,
      orderType,
      ...(orderType === "stop_limit" ? { limitPrice: limit! } : {}),
    });
  }
  // Order validity alone says nothing about holdings with no recognized stop.
  // This is observed order coverage, not a guarantee of exit price or loss.
  const coverage = [...positions].map(([instrument, held]) => {
    const supported = Number.isFinite(held) && held > 0;
    const recognizedStopQuantity = supported ? Math.min(held, reserved.get(instrument) ?? 0) : 0;
    const uncoveredQuantity = supported ? Math.max(0, held - recognizedStopQuantity) : null;
    return {
      instrument,
      positionQuantity: Number.isFinite(held) ? held : null,
      recognizedStopQuantity,
      uncoveredQuantity,
      status: !supported
        ? ("unsupported_position" as const)
        : uncoveredQuantity === 0
          ? ("covered" as const)
          : recognizedStopQuantity > 0
            ? ("partial" as const)
            : ("no_recognized_stop" as const),
    };
  });
  return { reserved, protective, unresolved, coverage };
}

export function planFinanceProtectedReduction(input: {
  positionQuantity: number;
  sellQuantity: number;
  protective: readonly FinanceProtectiveOrder[];
}) {
  const reserved = input.protective.reduce((sum, order) => sum + order.quantity, 0);
  if (
    !Number.isFinite(input.positionQuantity) ||
    !Number.isFinite(input.sellQuantity) ||
    input.sellQuantity <= 0 ||
    input.sellQuantity > input.positionQuantity ||
    reserved > input.positionQuantity ||
    input.protective.some(
      (order) =>
        !order.id.trim() ||
        !Number.isFinite(order.quantity) ||
        order.quantity <= 0 ||
        !Number.isFinite(order.stopPrice) ||
        order.stopPrice <= 0 ||
        ![undefined, "stop", "stop_limit"].includes(order.orderType) ||
        ((order.orderType ?? "stop") === "stop" && order.limitPrice !== undefined) ||
        ((order.orderType ?? "stop") === "stop_limit" &&
          (!Number.isFinite(order.limitPrice) ||
            order.limitPrice! <= 0 ||
            order.limitPrice! > order.stopPrice)),
    )
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
  protection: FinanceProtectiveOrder;
  signal: AbortSignal;
  readStop: () => Promise<{
    id: string;
    status: string;
    filledQuantity: number;
    quantity: number;
    stopPrice: number;
    orderType?: "stop" | "stop_limit";
    limitPrice?: number;
    instrument: string;
  }>;
  cancelStop: () => Promise<void>;
  readPosition: () => Promise<number>;
  execute: () => Promise<T>;
  isDefinitelyRejected?: (error: unknown) => boolean;
  restoreProtection: (
    quantity: number,
    stopPrice: number,
    orderType: "stop" | "stop_limit",
    limitPrice?: number,
  ) => Promise<void>;
}) {
  const { protection, signal } = options;
  const protectionType = protection.orderType ?? "stop";
  planFinanceProtectedReduction({
    positionQuantity: options.positionQuantity,
    sellQuantity: options.sellQuantity,
    protective: [protection],
  });
  if (protection.quantity !== options.positionQuantity) {
    throw new Error("protected reduction requires one whole-position stop");
  }
  const verify = (stop: Awaited<ReturnType<typeof options.readStop>>) => {
    if (
      stop.id !== protection.id ||
      stop.instrument !== options.instrument ||
      stop.quantity !== protection.quantity ||
      stop.stopPrice !== protection.stopPrice ||
      (stop.orderType ?? "stop") !== protectionType ||
      stop.limitPrice !== protection.limitPrice ||
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
      await options.restoreProtection(
        before,
        protection.stopPrice,
        protectionType,
        protection.limitPrice,
      );
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
    await options.restoreProtection(
      remaining,
      protection.stopPrice,
      protectionType,
      protection.limitPrice,
    );
  }
  return result;
}
