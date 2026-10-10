import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinanceAlpacaOrderStreamOptions } from "./finance-alpaca-order-stream.js";
import { FinanceExecutionSafetyFactsError } from "./finance-execution-safety.js";
import { FINANCE_SCHEDULER_LOCK } from "./finance-scheduler-lock.js";

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  stream: vi.fn(),
  start: vi.fn(),
  close: vi.fn(),
  cycle: vi.fn(),
  slots: [] as { mode: "day" | "night"; hour: number; minute: number }[],
}));
vi.mock("./finance-alpaca-order-stream.js", () => ({ createAlpacaPaperOrderStream: mocks.stream }));
vi.mock("./finance-alpaca-history-sync.js", () => ({
  syncConfiguredAlpacaPaperHistory: mocks.history,
}));
vi.mock("./finance-credential-env.js", () => ({
  resolveFinanceCredentialEnv: () => ({
    ALPACA_API_KEY_ID: "PK_SYNTHETIC",
    ALPACA_API_SECRET_KEY: "synthetic",
  }),
}));
vi.mock("./finance-cycle-schedule.js", async (actual) => ({
  ...(await actual<typeof import("./finance-cycle-schedule.js")>()),
  DEFAULT_FINANCE_CYCLE_SLOTS: mocks.slots,
}));
vi.mock("./finance-scheduler-process.js", () => ({
  DEFAULT_FINANCE_CYCLE_TIMEOUT_MS: 900_000,
  runFinanceCycleProcess: mocks.cycle,
}));
import { runFinanceScheduler } from "../../scripts/operator/lcx-finance-scheduler.js";

let root: string;
afterEach(() => {
  mocks.slots.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it.each([
  {
    error: new FinanceExecutionSafetyFactsError("execution_recovery_incomplete"),
    expected: "execution_recovery_incomplete",
  },
  { error: new Error("untrusted raw provider details"), expected: "reconciliation_failed" },
])("persists only the trusted reconciliation category $expected", async ({ error, expected }) => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "finance-stream-error-"));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    if (String(chunk).includes("Alpaca stream reconciliation failed")) {
      setImmediate(() => process.emit("SIGTERM"));
    }
    return true;
  });
  mocks.close.mockResolvedValue(undefined);
  let streamOptions: FinanceAlpacaOrderStreamOptions | undefined;
  mocks.stream.mockImplementation((options: FinanceAlpacaOrderStreamOptions) => {
    streamOptions = options;
    return { start: mocks.start, close: mocks.close };
  });
  mocks.start.mockImplementation(() => streamOptions?.onWake("connected"));
  mocks.history.mockRejectedValue(error);
  expect(
    await runFinanceScheduler([
      "--loop",
      "--dir",
      root,
      "--venue",
      "alpaca",
      "--sync-alpaca-history",
      "--no-source-heartbeat",
    ]),
  ).toBe(143);
  const observation = JSON.parse(
    fs.readFileSync(path.join(root, "alpaca-order-stream-latest.json"), "utf8"),
  );
  expect(observation.reconciliation).toMatchObject({
    lastErrorCode: expected,
    lastReadinessStatus: "unavailable",
    lastSucceededAt: null,
  });
  expect(JSON.stringify(observation)).not.toContain("untrusted raw provider details");
  expect(mocks.cycle).not.toHaveBeenCalled();
});

describe("resident Paper stream wiring", () => {
  it("defers a fill hint until the daily execution child exits and retains the process lock through readback", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "finance-stream-execution-"));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T19:31:00.000Z"));
    mocks.slots.push({ mode: "day", hour: 15, minute: 30 });
    let wake: FinanceAlpacaOrderStreamOptions["onWake"] | undefined;
    mocks.stream.mockImplementation((options: FinanceAlpacaOrderStreamOptions) => {
      wake = options.onWake;
      return { start: mocks.start, close: mocks.close };
    });
    mocks.start.mockImplementation(() => undefined);
    mocks.close.mockResolvedValue(undefined);
    let release!: () => void;
    let entered!: () => void;
    let exited = false;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    mocks.cycle.mockImplementation(async () => {
      entered();
      await held;
      exited = true;
      return {
        ok: true,
        status: "succeeded",
        exitCode: 0,
        stdout: '{"ok":true}',
        stderr: "",
        outputTruncated: false,
      };
    });
    mocks.history.mockImplementation(async () => {
      if (mocks.history.mock.calls.length > 1) {
        expect(exited).toBe(true);
        expect(fs.existsSync(path.join(root, FINANCE_SCHEDULER_LOCK))).toBe(true);
        process.emit("SIGTERM");
      }
      return { accountId: "synthetic-account", accountReconciliation: { status: "reconciled" } };
    });
    const resident = runFinanceScheduler([
      "--loop",
      "--dir",
      root,
      "--venue",
      "alpaca",
      "--sync-alpaca-history",
      "--no-source-heartbeat",
    ]);
    await executionEntered;
    wake?.("fill");
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.history).toHaveBeenCalledTimes(1);
    release();
    expect(await resident).toBe(143);
    expect(mocks.history).toHaveBeenCalledTimes(2);
    expect(mocks.cycle).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(root, FINANCE_SCHEDULER_LOCK))).toBe(false);
  });
  it.each(["reconciled", "unresolved"])(
    "wakes broker readback and records %s separately from stream health",
    async (status) => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "finance-stream-wiring-"));
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      mocks.close.mockResolvedValue(undefined);
      let streamOptions: FinanceAlpacaOrderStreamOptions | undefined;
      mocks.stream.mockImplementation((options: FinanceAlpacaOrderStreamOptions) => {
        streamOptions = options;
        return { start: mocks.start, close: mocks.close };
      });
      mocks.start.mockImplementation(() => {
        streamOptions?.onWake("connected");
      });
      mocks.history.mockImplementation(async () => {
        process.emit("SIGTERM");
        return { accountId: "synthetic-account", accountReconciliation: { status } };
      });
      expect(
        await runFinanceScheduler([
          "--loop",
          "--dir",
          root,
          "--venue",
          "alpaca",
          "--sync-alpaca-history",
          "--no-source-heartbeat",
        ]),
      ).toBe(143);
      expect(mocks.history).toHaveBeenCalledTimes(1);
      expect(mocks.cycle).not.toHaveBeenCalled();
      expect(mocks.close).toHaveBeenCalledTimes(1);
      expect(streamOptions?.signal.aborted).toBe(true);
      const observation = JSON.parse(
        fs.readFileSync(path.join(root, "alpaca-order-stream-latest.json"), "utf8"),
      );
      expect(observation.reconciliation.lastReadbackAt).toBeTypeOf("string");
      expect(observation.reconciliation.lastReadinessStatus).toBe(status);
      if (status === "reconciled") {
        expect(observation.reconciliation.lastSucceededAt).toBeTypeOf("string");
      } else {
        expect(observation.reconciliation.lastSucceededAt).toBeNull();
      }
      expect(observation.boundary).toContain("rest_reconciliation_owns_account_facts");
      expect(fs.existsSync(path.join(root, FINANCE_SCHEDULER_LOCK))).toBe(false);
    },
  );
  it("degrades to periodic REST when stream construction fails", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "finance-stream-fallback-"));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mocks.stream.mockImplementation(() => {
      throw new Error("unavailable");
    });
    mocks.history.mockImplementation(async () => {
      process.emit("SIGTERM");
      return { accountId: "synthetic-account", accountReconciliation: { status: "reconciled" } };
    });
    expect(
      await runFinanceScheduler([
        "--loop",
        "--dir",
        root,
        "--venue",
        "alpaca",
        "--sync-alpaca-history",
        "--no-source-heartbeat",
      ]),
    ).toBe(143);
    expect(mocks.history).toHaveBeenCalledTimes(1);
    const observation = JSON.parse(
      fs.readFileSync(path.join(root, "alpaca-order-stream-latest.json"), "utf8"),
    );
    expect(observation.stream.state).toBe("unavailable");
    expect(observation.reconciliation.lastErrorCode).toBe("stream_unavailable");
    expect(mocks.cycle).not.toHaveBeenCalled();
  });
});
