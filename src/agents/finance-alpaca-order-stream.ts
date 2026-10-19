import WebSocket, { type ClientOptions, type RawData } from "ws";
import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "../infra/backoff.js";

const PAPER_STREAM_URL = "wss://paper-api.alpaca.markets/stream";
const DEFAULT_ACK_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_DEDUPE_CAPACITY = 512;
const DEFAULT_RECONNECT_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.2,
};

export const ALPACA_PAPER_ORDER_STREAM_EVENTS = [
  "accepted",
  "new",
  "partial_fill",
  "fill",
  "canceled",
  "expired",
  "done_for_day",
  "replaced",
  "rejected",
  "pending_new",
  "stopped",
  "pending_cancel",
  "pending_replace",
  "calculated",
  "suspended",
  "order_replace_rejected",
  "order_cancel_rejected",
] as const;
export type AlpacaPaperOrderStreamEvent = (typeof ALPACA_PAPER_ORDER_STREAM_EVENTS)[number];

export type AlpacaOrderStreamWakeReason =
  | "connected"
  | "reconnected"
  | "disconnected"
  | AlpacaPaperOrderStreamEvent;

export type AlpacaPaperOrderStreamStatus = Readonly<{
  state: "stopped" | "connecting" | "authenticating" | "subscribing" | "listening" | "reconnecting";
  reconnectCount: number;
  eventCount: number;
  duplicateCount: number;
  lastConnectedAt: string | null;
  lastSubscribedAt: string | null;
  lastPongAt: string | null;
  lastEventAt: string | null;
  lastEventType: AlpacaPaperOrderStreamEvent | null;
  lastErrorCode:
    | "connect_failed"
    | "auth_rejected"
    | "auth_timeout"
    | "listen_unavailable"
    | "listen_timeout"
    | "heartbeat_timeout"
    | "stream_error"
    | "malformed_frame"
    | "payload_too_large"
    | "socket_error"
    | null;
}>;

type StreamSocket = WebSocket;

export type FinanceAlpacaOrderStreamOptions = Readonly<{
  credentials: Readonly<{ keyId: string; secret: string }>;
  signal: AbortSignal;
  onWake: (reason: AlpacaOrderStreamWakeReason) => void;
  onStatus?: (status: AlpacaPaperOrderStreamStatus) => void;
  /** Test seam. Production always receives the fixed Paper URL. */
  webSocketFactory?: (url: string, options: ClientOptions) => StreamSocket;
  ackTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxPayloadBytes?: number;
  dedupeCapacity?: number;
  reconnectPolicy?: Partial<BackoffPolicy>;
}>;

export type FinanceAlpacaOrderStream = Readonly<{
  start: () => void;
  close: () => Promise<void>;
  getStatus: () => AlpacaPaperOrderStreamStatus;
}>;

function positiveInteger(value: number | undefined, fallback: number, max: number): number {
  return Number.isSafeInteger(value) && value! > 0 && value! <= max ? value! : fallback;
}

function nextCount(value: number): number {
  return Math.min(value + 1, Number.MAX_SAFE_INTEGER);
}

function resolveReconnectPolicy(overrides?: Partial<BackoffPolicy>): BackoffPolicy {
  const initialMs = positiveInteger(
    overrides?.initialMs,
    DEFAULT_RECONNECT_POLICY.initialMs,
    60_000,
  );
  const maxMs = positiveInteger(overrides?.maxMs, DEFAULT_RECONNECT_POLICY.maxMs, 120_000);
  const factor = Number.isFinite(overrides?.factor)
    ? Math.max(1.1, Math.min(5, overrides!.factor!))
    : DEFAULT_RECONNECT_POLICY.factor;
  const jitter = Number.isFinite(overrides?.jitter)
    ? Math.max(0, Math.min(1, overrides!.jitter!))
    : DEFAULT_RECONNECT_POLICY.jitter;
  return { initialMs, maxMs: Math.max(initialMs, maxMs), factor, jitter };
}

function boundedString(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function frameBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw);
  }
  return Buffer.from(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEvent(value: unknown): value is AlpacaPaperOrderStreamEvent {
  return (
    typeof value === "string" &&
    (ALPACA_PAPER_ORDER_STREAM_EVENTS as readonly string[]).includes(value)
  );
}

function wakeForEvent(event: AlpacaPaperOrderStreamEvent): AlpacaOrderStreamWakeReason | undefined {
  return event;
}

function timestampOf(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return new Date(value).toISOString();
}

function dedupeKey(data: Record<string, unknown>, order: Record<string, unknown>, event: string) {
  const preferred = data.event_id ?? data.execution_id;
  if (boundedString(preferred)) {
    return `${event}:${preferred}`;
  }
  const orderId = boundedString(order.id) ? order.id : "";
  const timestamp = boundedString(data.timestamp)
    ? data.timestamp
    : boundedString(order.updated_at)
      ? order.updated_at
      : "";
  const qty = boundedString(data.qty) || typeof data.qty === "number" ? String(data.qty) : "";
  const price =
    boundedString(data.price) || typeof data.price === "number" ? String(data.price) : "";
  return `${event}:${orderId}:${timestamp}:${qty}:${price}`.slice(0, 512);
}

export function createFinanceAlpacaOrderStream(
  options: FinanceAlpacaOrderStreamOptions,
): FinanceAlpacaOrderStream {
  if (
    !boundedString(options.credentials?.keyId, 256) ||
    !options.credentials.keyId.startsWith("PK") ||
    !boundedString(options.credentials.secret, 512)
  ) {
    throw new Error("Paper Alpaca stream requires Paper credentials");
  }
  const ackTimeoutMs = positiveInteger(options.ackTimeoutMs, DEFAULT_ACK_TIMEOUT_MS, 60_000);
  const heartbeatIntervalMs = positiveInteger(
    options.heartbeatIntervalMs,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
    300_000,
  );
  const heartbeatTimeoutMs = positiveInteger(
    options.heartbeatTimeoutMs,
    DEFAULT_HEARTBEAT_TIMEOUT_MS,
    60_000,
  );
  const maxPayloadBytes = positiveInteger(
    options.maxPayloadBytes,
    DEFAULT_MAX_PAYLOAD_BYTES,
    1024 * 1024,
  );
  const dedupeCapacity = positiveInteger(options.dedupeCapacity, DEFAULT_DEDUPE_CAPACITY, 10_000);
  const reconnectPolicy = resolveReconnectPolicy(options.reconnectPolicy);
  const createSocket =
    options.webSocketFactory ?? ((url, wsOptions) => new WebSocket(url, wsOptions));
  const seen = new Map<string, true>();
  let status: AlpacaPaperOrderStreamStatus = Object.freeze({
    state: "stopped",
    reconnectCount: 0,
    eventCount: 0,
    duplicateCount: 0,
    lastConnectedAt: null,
    lastSubscribedAt: null,
    lastPongAt: null,
    lastEventAt: null,
    lastEventType: null,
    lastErrorCode: null,
  });
  let started = false;
  let stopped = false;
  let everListened = false;
  let socket: StreamSocket | undefined;
  let loopPromise: Promise<void> | undefined;

  const publish = (patch: Partial<AlpacaPaperOrderStreamStatus>) => {
    status = Object.freeze({ ...status, ...patch });
    try {
      options.onStatus?.(status);
    } catch {
      // Diagnostics must not interrupt stream recovery.
    }
  };

  const wake = (reason: AlpacaOrderStreamWakeReason) => {
    try {
      options.onWake(reason);
    } catch {
      // A wake-up is advisory; scheduler health and REST reconciliation own closure.
    }
  };

  const parseMessage = (raw: RawData): Record<string, unknown> | undefined => {
    const bytes = frameBuffer(raw);
    if (bytes.byteLength > maxPayloadBytes) {
      publish({ lastErrorCode: "payload_too_large" });
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      if (!isRecord(parsed)) {
        throw new Error("invalid frame");
      }
      return parsed;
    } catch {
      publish({ lastErrorCode: "malformed_frame" });
      return undefined;
    }
  };

  const connectOnce = (): Promise<boolean> =>
    new Promise((resolve) => {
      let phase: "open" | "auth" | "listen" = "open";
      let listening = false;
      let settled = false;
      let ackTimer: NodeJS.Timeout | undefined;
      let heartbeatTimer: NodeJS.Timeout | undefined;
      let heartbeatTimeoutTimer: NodeJS.Timeout | undefined;
      let heartbeatPending = false;
      const clearTimers = () => {
        if (ackTimer) {
          clearTimeout(ackTimer);
        }
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        if (heartbeatTimeoutTimer) {
          clearTimeout(heartbeatTimeoutTimer);
        }
        ackTimer = undefined;
        heartbeatTimer = undefined;
        heartbeatTimeoutTimer = undefined;
      };
      const finish = (reconnect: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimers();
        options.signal.removeEventListener("abort", onAbort);
        const current = socket;
        socket = undefined;
        if (current) {
          current.off("open", onOpen);
          current.off("message", onMessage);
          current.off("error", onError);
          current.off("close", onClose);
          current.off("pong", onPong);
          // ws may emit a final error after terminate()/close() and after this promise
          // has settled. Keep a sink so a late transport event cannot crash the resident.
          current.on("error", () => {});
        }
        if (reconnect && !stopped && !options.signal.aborted) {
          publish({ state: "reconnecting" });
        }
        if (listening && !stopped && !options.signal.aborted) {
          wake("disconnected");
        }
        resolve(listening);
      };
      const fail = (code: NonNullable<AlpacaPaperOrderStreamStatus["lastErrorCode"]>) => {
        publish({ lastErrorCode: code });
        socket?.terminate();
        finish(true);
      };
      const armAckTimeout = (code: "auth_timeout" | "listen_timeout") => {
        if (ackTimer) {
          clearTimeout(ackTimer);
        }
        ackTimer = setTimeout(() => fail(code), ackTimeoutMs);
      };
      const onOpen = () => {
        phase = "auth";
        publish({
          state: "authenticating",
          lastConnectedAt: new Date().toISOString(),
          lastPongAt: null,
          lastErrorCode: null,
        });
        armAckTimeout("auth_timeout");
        try {
          socket?.send(
            JSON.stringify({
              action: "auth",
              key: options.credentials.keyId,
              secret: options.credentials.secret,
            }),
          );
        } catch {
          fail("socket_error");
        }
      };
      const onMessage = (raw: RawData) => {
        const message = parseMessage(raw);
        if (!message) {
          fail(status.lastErrorCode ?? "malformed_frame");
          return;
        }
        if (message.action === "error") {
          fail("stream_error");
          return;
        }
        if (message.stream === "authorization") {
          const data = isRecord(message.data) ? message.data : undefined;
          if (data?.action !== "authenticate" || phase !== "auth") {
            return;
          }
          if (data.status !== "authorized") {
            fail("auth_rejected");
            return;
          }
          phase = "listen";
          publish({ state: "subscribing" });
          armAckTimeout("listen_timeout");
          try {
            socket?.send(
              JSON.stringify({ action: "listen", data: { streams: ["trade_updates"] } }),
            );
          } catch {
            fail("socket_error");
          }
          return;
        }
        if (message.stream === "listening") {
          const data = isRecord(message.data) ? message.data : undefined;
          const streams = Array.isArray(data?.streams) ? data.streams : [];
          if (phase !== "listen" || !streams.includes("trade_updates")) {
            fail("listen_unavailable");
            return;
          }
          if (ackTimer) {
            clearTimeout(ackTimer);
          }
          ackTimer = undefined;
          phase = "open";
          listening = true;
          const wasListening = everListened;
          everListened = true;
          publish({
            state: "listening",
            lastSubscribedAt: new Date().toISOString(),
            lastErrorCode: null,
          });
          wake(wasListening ? "reconnected" : "connected");
          heartbeatPending = false;
          heartbeatTimer = setInterval(() => {
            if (!socket || socket.readyState !== WebSocket.OPEN) {
              return;
            }
            if (heartbeatPending) {
              fail("heartbeat_timeout");
              return;
            }
            heartbeatPending = true;
            heartbeatTimeoutTimer = setTimeout(() => {
              if (heartbeatPending) {
                fail("heartbeat_timeout");
              }
            }, heartbeatTimeoutMs);
            try {
              socket.ping();
            } catch {
              fail("socket_error");
            }
          }, heartbeatIntervalMs);
          return;
        }
        if (message.stream !== "trade_updates" || !listening) {
          return;
        }
        const data = isRecord(message.data) ? message.data : undefined;
        const order = isRecord(data?.order) ? data.order : undefined;
        if (!data || !order || !isEvent(data.event) || !boundedString(order.id, 128)) {
          publish({ lastErrorCode: "malformed_frame" });
          return;
        }
        const key = dedupeKey(data, order, data.event);
        if (seen.has(key)) {
          publish({ duplicateCount: nextCount(status.duplicateCount) });
          return;
        }
        seen.set(key, true);
        if (seen.size > dedupeCapacity) {
          const oldest = seen.keys().next().value;
          if (oldest !== undefined) {
            seen.delete(oldest);
          }
        }
        publish({
          eventCount: nextCount(status.eventCount),
          lastEventAt: timestampOf(data.timestamp ?? order.updated_at),
          lastEventType: data.event,
        });
        const reason = wakeForEvent(data.event);
        if (reason) {
          wake(reason);
        }
      };
      const onError = () => fail("socket_error");
      const onClose = () => finish(true);
      const onPong = () => {
        heartbeatPending = false;
        if (heartbeatTimeoutTimer) {
          clearTimeout(heartbeatTimeoutTimer);
        }
        heartbeatTimeoutTimer = undefined;
        publish({ lastPongAt: new Date().toISOString() });
      };
      const onAbort = () => {
        stopped = true;
        const current = socket;
        if (current?.readyState === WebSocket.CONNECTING) {
          current.terminate();
        } else {
          current?.close(1000, "scheduler stopped");
        }
        finish(false);
      };

      if (options.signal.aborted || stopped) {
        finish(false);
        return;
      }
      try {
        publish({ state: "connecting" });
        socket = createSocket(PAPER_STREAM_URL, {
          handshakeTimeout: ackTimeoutMs,
          maxPayload: maxPayloadBytes,
        });
      } catch {
        publish({ lastErrorCode: "connect_failed" });
        finish(true);
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
      socket.once("open", onOpen);
      socket.on("message", onMessage);
      socket.on("error", onError);
      socket.once("close", onClose);
      socket.on("pong", onPong);
      // Bound a connection that neither opens nor emits an error/close.
      armAckTimeout("auth_timeout");
    });

  const run = async () => {
    let attempt = 0;
    while (!stopped && !options.signal.aborted) {
      const connected = await connectOnce();
      if (stopped || options.signal.aborted) {
        break;
      }
      if (connected) {
        attempt = 0;
      }
      attempt += 1;
      publish({
        reconnectCount: nextCount(status.reconnectCount),
        state: "reconnecting",
      });
      const waitMs = computeBackoff(reconnectPolicy, attempt);
      try {
        await sleepWithAbort(waitMs, options.signal);
      } catch {
        break;
      }
    }
    publish({ state: "stopped" });
  };

  const stop = () => {
    stopped = true;
    if (socket) {
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      } else {
        socket.close(1000, "client stopped");
      }
    }
  };

  return Object.freeze({
    start: () => {
      if (started || stopped || options.signal.aborted) {
        return;
      }
      started = true;
      loopPromise = run();
      options.signal.addEventListener("abort", stop, { once: true });
    },
    close: async () => {
      stop();
      options.signal.removeEventListener("abort", stop);
      await loopPromise;
    },
    getStatus: () => status,
  });
}

/** Scheduler-facing name retained for the existing integration seam. */
export const createAlpacaPaperOrderStream = createFinanceAlpacaOrderStream;
