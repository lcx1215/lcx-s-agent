import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./finance-scheduler-process.js", () => ({
  DEFAULT_FINANCE_CYCLE_TIMEOUT_MS: 900000,
  runFinanceCycleProcess: mocks.run,
}));
vi.mock("../config/config.js", () => ({
  loadConfig: () => {
    throw new Error("unexpected config read");
  },
}));
import {
  cycleOutputSucceeded,
  parseFinanceSchedulerArgs,
  runFinanceScheduler,
} from "../../scripts/operator/lcx-finance-scheduler.js";
import { readFinanceSchedulerState } from "./finance-scheduler-state.js";
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "finance-scheduler-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T19:30:00Z"));
  mocks.run.mockReset().mockResolvedValue({
    exitCode: 0,
    signal: null,
    status: "succeeded",
    ok: true,
    stdout: '{"ok":true}',
    stderr: "",
    outputTruncated: false,
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
describe("durable scheduler claims on the unified lifecycle", () => {
  it("requires JSON success, not merely exit zero", async () => {
    expect(cycleOutputSucceeded('{"ok":true}')).toBe(true);
    for (const stdout of ['{"ok":false}', "{}", "not json"]) {
      expect(cycleOutputSucceeded(stdout)).toBe(false);
    }
    mocks.run.mockResolvedValue({
      exitCode: 0,
      status: "succeeded",
      ok: true,
      stdout: '{"ok":false}',
      stderr: "",
    });
    expect(await runFinanceScheduler(["--once", "day", "--dir", root])).toBe(1);
    const state = readFinanceSchedulerState(root);
    expect(state.lastFired.day).toBe("2026-09-22");
    expect(state.lastSucceeded.day).toBeUndefined();
    expect(state.lastStatus.day).toBe("failed");
    expect(await runFinanceScheduler(["--once", "day", "--dir", root])).toBe(1);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it("preserves old interrupted claim without dispatch", async () => {
    fs.writeFileSync(
      path.join(root, "daily-cycle-2026-09-22-day.json"),
      JSON.stringify({ status: "started" }),
    );
    expect(await runFinanceScheduler(["--once", "day", "--dir", root])).toBe(1);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("does not overwrite an interrupted attempt from an earlier day", async () => {
    fs.writeFileSync(
      path.join(root, "daily-cycle-scheduler.json"),
      JSON.stringify({
        lastFired: { day: "2026-09-21" },
        lastStatus: { day: "running" },
        lastSucceeded: {},
      }),
    );
    expect(await runFinanceScheduler(["--once", "day", "--dir", root])).toBe(1);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("forwards explicit quote authorization through the unified argument parser and cycle", async () => {
    const flags = ["--execution-quote-feed", "sip", "--execution-max-age-ms", "1500"];
    expect(parseFinanceSchedulerArgs(["--loop", ...flags]).extraArgs).toEqual(flags);
    expect(await runFinanceScheduler(["--once", "day", "--dir", root, ...flags])).toBe(0);
    expect(mocks.run.mock.calls[0][0].argv).toEqual(
      expect.arrayContaining([...flags, "--dir", root]),
    );
    expect(() =>
      parseFinanceSchedulerArgs(["--loop", "--execution-quote-feed", "delayed"]),
    ).toThrow();
    expect(() => parseFinanceSchedulerArgs(["--loop", "--execution-max-age-ms", "0"])).toThrow();
  });
  it("allows only one concurrent owner to dispatch", async () => {
    let release!: () => void;
    mocks.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              exitCode: 0,
              status: "succeeded",
              ok: true,
              stdout: '{"ok":true}',
              stderr: "",
            });
        }),
    );
    const first = runFinanceScheduler(["--once", "day", "--dir", root]);
    await expect(runFinanceScheduler(["--once", "day", "--dir", root])).rejects.toThrow(
      "lock exists",
    );
    release();
    expect(await first).toBe(0);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
});
