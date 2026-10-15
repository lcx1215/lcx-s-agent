import { EventEmitter } from "node:events";
import { once } from "node:events";
import { type AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket, { type ClientOptions, WebSocketServer } from "ws";
import {
  createFinanceAlpacaOrderStream,
  type FinanceAlpacaOrderStreamOptions,
} from "./finance-alpaca-order-stream.js";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: Record<string, unknown>[] = [];
  ack = true;
  respondToPing = true;
  lateErrorOnTerminate = false;

  send(raw: string) {
    const message = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(message);
    if (!this.ack) {
      return;
    }
    if (message.action === "auth") {
      queueMicrotask(() => {
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              stream: "authorization",
              data: { status: "authorized", action: "authenticate" },
            }),
          ),
          true,
        );
      });
    } else if (message.action === "listen") {
      queueMicrotask(() => {
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({ stream: "listening", data: { streams: ["trade_updates"] } }),
          ),
          true,
        );
      });
    }
  }

  open() {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit("close", 1000, Buffer.from("closed")));
  }

  terminate() {
    this.close();
    if (this.lateErrorOnTerminate) {
      queueMicrotask(() => this.emit("error", new Error("late fixture socket error")));
    }
  }

  ping() {
    if (this.respondToPing) {
      queueMicrotask(() => this.emit("pong"));
    }
  }

  frame(message: unknown, isBinary = true) {
    this.emit("message", Buffer.from(JSON.stringify(message)), isBinary);
  }
}

const streams: Array<ReturnType<typeof createFinanceAlpacaOrderStream>> = [];
afterEach(async () => {
  await Promise.all(streams.splice(0).map((stream) => stream.close()));
  vi.restoreAllMocks();
});

function fixture(
  makeSocket: (url: string, wsOptions: ClientOptions) => FakeSocket,
  overrides: Partial<FinanceAlpacaOrderStreamOptions> = {},
) {
  const controller = new AbortController();
  const onWake = vi.fn();
  const onStatus = vi.fn();
  const options: FinanceAlpacaOrderStreamOptions = {
    credentials: { keyId: "PKpaper-fixture", secret: "secret-fixture" },
    signal: controller.signal,
    onWake,
    onStatus,
    ackTimeoutMs: 100,
    heartbeatIntervalMs: 60_000,
    reconnectPolicy: { initialMs: 5, maxMs: 5, factor: 1, jitter: 0 },
    webSocketFactory: (url, wsOptions) => makeSocket(url, wsOptions) as unknown as WebSocket,
    ...overrides,
  };
  const stream = createFinanceAlpacaOrderStream(options);
  streams.push(stream);
  return { controller, onWake, onStatus, stream };
}

async function until(predicate: () => boolean, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("fixture condition timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

it("authenticates, confirms the Paper subscription, decodes binary JSON, and deduplicates event wakes", async () => {
  let socket!: FakeSocket;
  let url = "";
  let wsOptions: ClientOptions | undefined;
  const f = fixture((target, options) => {
    url = target;
    wsOptions = options;
    socket = new FakeSocket();
    queueMicrotask(() => socket.open());
    return socket;
  });

  f.stream.start();
  await until(() => f.stream.getStatus().state === "listening");
  expect(url).toBe("wss://paper-api.alpaca.markets/stream");
  expect(wsOptions).toMatchObject({ maxPayload: 64 * 1024, handshakeTimeout: 100 });
  expect(socket.sent).toEqual([
    { action: "auth", key: "PKpaper-fixture", secret: "secret-fixture" },
    { action: "listen", data: { streams: ["trade_updates"] } },
  ]);

  const fillEvent = {
    stream: "trade_updates",
    data: {
      event: "partial_fill",
      event_id: "event-1",
      timestamp: "2026-10-01T12:00:00Z",
      order: { id: "order-1", client_order_id: "client-1", updated_at: "2026-10-01T12:00:00Z" },
      qty: "1",
      price: "100.00",
    },
  };
  socket.frame(fillEvent, true);
  socket.frame(fillEvent, true);
  expect(f.stream.getStatus()).toMatchObject({
    state: "listening",
    eventCount: 1,
    duplicateCount: 1,
    lastConnectedAt: expect.any(String),
    lastSubscribedAt: expect.any(String),
    lastEventType: "partial_fill",
    lastEventAt: "2026-10-01T12:00:00.000Z",
  });
  expect(f.onWake.mock.calls.map(([reason]) => reason)).toEqual(["connected", "partial_fill"]);
  expect(JSON.stringify(f.stream.getStatus())).not.toContain("secret-fixture");
});

it("requires the listening acknowledgement to include trade_updates and reconnects with an acknowledged subscription", async () => {
  const sockets: FakeSocket[] = [];
  const f = fixture((_url, _options) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    if (sockets.length === 1) {
      socket.send = function (raw: string) {
        const message = JSON.parse(raw) as Record<string, unknown>;
        this.sent.push(message);
        if (message.action === "auth") {
          queueMicrotask(() =>
            this.emit(
              "message",
              Buffer.from(
                JSON.stringify({
                  stream: "authorization",
                  data: { status: "authorized", action: "authenticate" },
                }),
              ),
              true,
            ),
          );
        } else {
          queueMicrotask(() =>
            this.emit(
              "message",
              Buffer.from(
                JSON.stringify({
                  stream: "listening",
                  data: { streams: [] },
                }),
              ),
              true,
            ),
          );
        }
      };
    }
    queueMicrotask(() => socket.open());
    return socket;
  });

  f.stream.start();
  await until(() => f.stream.getStatus().state === "listening");
  expect(sockets.length).toBeGreaterThanOrEqual(2);
  expect(f.stream.getStatus().lastErrorCode).toBeNull();
  expect(f.onWake).toHaveBeenCalledWith("connected");
});

it("wakes reconciliation on disconnect and again only after a reconnected subscription is acknowledged", async () => {
  const sockets: FakeSocket[] = [];
  const f = fixture((_url, _options) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    queueMicrotask(() => socket.open());
    return socket;
  });
  f.stream.start();
  await until(() => f.stream.getStatus().state === "listening");
  sockets[0].close();
  await until(() => f.onWake.mock.calls.some(([reason]) => reason === "reconnected"));
  expect(f.onWake.mock.calls.map(([reason]) => reason)).toContain("disconnected");
  expect(f.stream.getStatus().state).toBe("listening");
});

it("reconnects on oversized frames, bounds dedupe memory, and closes without restarting on abort", async () => {
  const sockets: FakeSocket[] = [];
  const f = fixture(
    (_url, _options) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket;
    },
    { maxPayloadBytes: 256, dedupeCapacity: 2, heartbeatIntervalMs: 60_000 },
  );
  f.stream.start();
  await until(() => f.stream.getStatus().state === "listening");
  sockets[0].frame({
    stream: "trade_updates",
    data: { event: "fill", order: { id: "x" }, padding: "x".repeat(300) },
  });
  await until(() => sockets.length >= 2 && f.stream.getStatus().state === "listening");
  expect(f.stream.getStatus().lastErrorCode).toBeNull();
  const current = sockets.at(-1)!;
  const orderEvent = (id: string) => ({
    stream: "trade_updates",
    data: { event: "new", event_id: id, order: { id: `order-${id}` } },
  });
  current.frame(orderEvent("a"));
  current.frame(orderEvent("b"));
  current.frame(orderEvent("c"));
  current.frame(orderEvent("a"));
  expect(f.stream.getStatus()).toMatchObject({ eventCount: 4, duplicateCount: 0 });

  f.controller.abort();
  await until(() => f.stream.getStatus().state === "stopped");
  const countAfterStop = sockets.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sockets).toHaveLength(countAfterStop);
  expect(sockets.every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(true);
});

it("does not wake for malformed, unknown, or duplicate non-fill events", async () => {
  let socket!: FakeSocket;
  const f = fixture((_url, _options) => {
    socket = new FakeSocket();
    queueMicrotask(() => socket.open());
    return socket;
  });
  f.stream.start();
  await until(() => f.stream.getStatus().state === "listening");
  socket.frame({
    stream: "trade_updates",
    data: { event: "not-a-real-event", order: { id: "1" } },
  });
  socket.frame({
    stream: "trade_updates",
    data: { event: "new", order: { id: "2" }, updated_at: "x" },
  });
  expect(f.stream.getStatus().eventCount).toBe(1);
  expect(f.stream.getStatus().lastEventType).toBe("new");
  expect(f.onWake.mock.calls.map(([reason]) => reason)).toEqual(["connected", "new"]);
});

it("updates bounded liveness status from pong and reconnects when heartbeats stop", async () => {
  const sockets: FakeSocket[] = [];
  const f = fixture(
    (_url, _options) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      if (sockets.length === 1) {
        socket.respondToPing = false;
      }
      queueMicrotask(() => socket.open());
      return socket;
    },
    { heartbeatIntervalMs: 8, heartbeatTimeoutMs: 8 },
  );
  f.stream.start();
  await until(() => f.stream.getStatus().state === "listening");
  await until(() =>
    f.onStatus.mock.calls.some(([status]) => status.lastErrorCode === "heartbeat_timeout"),
  );
  await until(() => f.onWake.mock.calls.some(([reason]) => reason === "reconnected"));
  await until(() => f.stream.getStatus().lastPongAt !== null);
  expect(sockets.length).toBeGreaterThanOrEqual(2);
  expect(f.stream.getStatus().lastPongAt).toEqual(expect.any(String));
});

it("rejects non-Paper credential bindings before opening a socket", () => {
  const controller = new AbortController();
  expect(() =>
    createFinanceAlpacaOrderStream({
      credentials: { keyId: "live-key", secret: "secret" },
      signal: controller.signal,
      onWake: () => {},
    }),
  ).toThrow("Paper Alpaca stream requires Paper credentials");
});

it("swallows a late socket error after aborting a connecting socket and does not reconnect", async () => {
  let created = 0;
  let socket!: FakeSocket;
  const f = fixture(() => {
    created += 1;
    socket = new FakeSocket();
    socket.lateErrorOnTerminate = true;
    return socket;
  });
  f.stream.start();
  await until(() => f.stream.getStatus().state === "connecting");
  f.controller.abort();
  await until(() => f.stream.getStatus().state === "stopped");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(created).toBe(1);
  expect(socket.readyState).toBe(WebSocket.CLOSED);
});

it("uses real ws client framing and ping/pong against a local fake server only", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const localUrl = `ws://127.0.0.1:${address.port}`;
  server.on("connection", (client) => {
    client.on("ping", () => client.pong());
    client.on("message", (raw) => {
      const messageText = Buffer.isBuffer(raw)
        ? raw.toString()
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString()
          : Buffer.from(raw).toString();
      const message = JSON.parse(messageText) as Record<string, unknown>;
      const response =
        message.action === "auth"
          ? { stream: "authorization", data: { status: "authorized", action: "authenticate" } }
          : { stream: "listening", data: { streams: ["trade_updates"] } };
      client.send(Buffer.from(JSON.stringify(response)), { binary: true });
      if (message.action === "listen") {
        client.send(
          Buffer.from(
            JSON.stringify({
              stream: "trade_updates",
              data: {
                event: "rejected",
                event_id: "local-event",
                timestamp: "2026-10-01T12:00:01Z",
                order: { id: "local-order" },
              },
            }),
          ),
          { binary: true },
        );
      }
    });
  });
  try {
    const f = fixture(
      (_, wsOptions) => new WebSocket(localUrl, wsOptions) as unknown as FakeSocket,
      {
        heartbeatIntervalMs: 8,
        heartbeatTimeoutMs: 50,
      },
    );
    f.stream.start();
    await until(() => f.stream.getStatus().lastPongAt !== null);
    expect(f.stream.getStatus()).toMatchObject({ state: "listening", lastEventType: "rejected" });
    expect(f.onWake.mock.calls.map(([reason]) => reason)).toContain("rejected");
    await f.stream.close();
  } finally {
    for (const client of server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
