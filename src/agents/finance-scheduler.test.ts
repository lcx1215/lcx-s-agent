import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../config/config.js", () => ({
  loadConfig: () => {
    throw new Error("unexpected config read");
  },
}));
vi.mock("../config/env-vars.js", () => ({ applyConfigEnvVars: vi.fn() }));
vi.mock("../cli/serve-detach.js", () => ({ buildDetachedServeEnv: () => ({}) }));
let root: string;
const originalArgv = process.argv;
let exitCode: typeof process.exitCode;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T19:30:00Z"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "finance-scheduler-"));
  process.argv = ["node", "/synthetic/importer", "--dir", root];
  exitCode = process.exitCode;
  mocks.spawn.mockReset();
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = exitCode;
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});
function childResult(stdout: string, code = 0) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    unref: vi.fn(),
    pid: 123,
  });
  mocks.spawn.mockImplementationOnce(() => {
    void Promise.resolve().then(() => {
      child.stdout.emit("data", stdout);
      child.emit("close", code);
    });
    return child;
  });
}
describe("durable scheduler claims", () => {
  it("does not call success from exit zero with failed or malformed report", async () => {
    const { cycleOutputSucceeded } =
      await import("../../scripts/operator/lcx-finance-scheduler.js");
    expect(cycleOutputSucceeded('{"ok":true}')).toBe(true);
    for (const text of ['{"ok":false}', "{}", "not json"]) {
      expect(cycleOutputSucceeded(text)).toBe(false);
    }
  });
  it("records failure without advancing lastFired or replaying on restart", async () => {
    const { fire } = await import("../../scripts/operator/lcx-finance-scheduler.js");
    childResult('{"ok":false}');
    await fire("day", []);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, "daily-cycle-2026-09-22-day.json"), "utf8"))
        .status,
    ).toBe("failed");
    expect(fs.existsSync(path.join(root, "daily-cycle-scheduler.json"))).toBe(false);
    vi.resetModules();
    await (await import("../../scripts/operator/lcx-finance-scheduler.js")).fire("day", []);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
  it("preserves interrupted claim and never dispatches an ambiguous run twice", async () => {
    fs.writeFileSync(
      path.join(root, "daily-cycle-2026-09-22-day.json"),
      JSON.stringify({ status: "started" }),
    );
    await (await import("../../scripts/operator/lcx-finance-scheduler.js")).fire("day", []);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
  it("claims atomically before dispatch and completes one concurrent caller", async () => {
    const { fire } = await import("../../scripts/operator/lcx-finance-scheduler.js");
    childResult('{"ok":true}');
    await Promise.all([fire("day", []), fire("day", [])]);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, "daily-cycle-scheduler.json"), "utf8")).lastFired
        .day,
    ).toBe("2026-09-22");
  });
  it("carries the resolved book into detached process", async () => {
    mocks.spawn.mockReturnValue({ unref: vi.fn(), pid: 123 });
    (await import("../../scripts/operator/lcx-finance-scheduler.js")).detach(["--place"]);
    expect(mocks.spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(["--dir", root]));
  });
});
