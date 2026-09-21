import { afterEach, expect, it, vi } from "vitest";
import { isPidAlive } from "../shared/pid-alive.js";
import { runFinanceCycleProcess } from "./finance-scheduler-process.js";

const cwd = process.cwd();
afterEach(() => vi.restoreAllMocks());

it("observes real zero and nonzero exits without executing finance code", async () => {
  const success = await runFinanceCycleProcess({
    argv: ["-e", "console.log('fixture');"],
    cwd,
    timeoutMs: 3000,
  });
  expect(success).toMatchObject({ status: "succeeded", ok: true, exitCode: 0 });
  expect(success.stdout).toContain("fixture");
  const failure = await runFinanceCycleProcess({
    argv: ["-e", "console.error('failed');process.exitCode=7;"],
    cwd,
    timeoutMs: 3000,
  });
  expect(failure).toMatchObject({ status: "failed", ok: false, exitCode: 7 });
  expect(failure.stderr).toContain("failed");
});

it("caps noisy output without preventing the child from exiting", async () => {
  const result = await runFinanceCycleProcess({
    argv: [
      "-e",
      "process.stdout.write('x'.repeat(200000)); process.stderr.write('y'.repeat(200000));",
    ],
    cwd,
    timeoutMs: 3000,
  });
  expect(result.ok).toBe(true);
  expect(result.outputTruncated).toBe(true);
  expect(result.stdout).toHaveLength(65536);
  expect(result.stderr).toHaveLength(65536);
});

it("reports a spawn error for an inaccessible working directory", async () => {
  const result = await runFinanceCycleProcess({
    argv: ["-e", "0"],
    cwd: "/nonexistent-finance-scheduler-test-directory",
    timeoutMs: 3000,
  });
  expect(result).toMatchObject({ ok: false, status: "spawn_error", exitCode: null });
});

it("does not start a child when cancellation precedes execution", async () => {
  const result = await runFinanceCycleProcess({
    argv: ["-e", "throw Error('must not run')"],
    cwd,
    timeoutMs: 3000,
    signal: AbortSignal.abort(),
  });
  expect(result).toMatchObject({ status: "cancelled", ok: false, stdout: "", stderr: "" });
});

it.skipIf(process.platform === "win32")(
  "kills a real process group after timeout, including a SIGTERM-resistant descendant",
  async () => {
    const grandchild =
      "process.on('SIGTERM',()=>{});console.log('grandchild='+process.pid);setInterval(()=>{},1000);";
    const fixture = `
    const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>{});
    console.log('parent='+process.pid);
    spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});
    setInterval(()=>{},1000);
  `;
    const result = await runFinanceCycleProcess({
      argv: ["-e", fixture],
      cwd,
      timeoutMs: 500,
      killGraceMs: 50,
    });
    expect(result).toMatchObject({ ok: false, status: "timed_out", signal: "SIGKILL" });
    const pids = [...result.stdout.matchAll(/(?:parent|grandchild)=(\d+)/g)].map((match) =>
      Number(match[1]),
    );
    expect(pids).toHaveLength(2);
    await vi.waitFor(() => expect(pids.map(isPidAlive)).toEqual([false, false]), { timeout: 2000 });
  },
);

it.skipIf(process.platform === "win32")(
  "cancels and reaps a running child even when it ignores SIGTERM",
  async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 400);
    try {
      const result = await runFinanceCycleProcess({
        argv: [
          "-e",
          "process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000);",
        ],
        cwd,
        timeoutMs: 3000,
        killGraceMs: 50,
        signal: controller.signal,
      });
      expect(result).toMatchObject({ ok: false, status: "cancelled", signal: "SIGKILL" });
      expect(isPidAlive(Number(result.stdout.trim()))).toBe(false);
    } finally {
      clearTimeout(timer);
    }
  },
);

it.each([0, -1, 0.5, Infinity, 2_147_483_648])(
  "rejects invalid timeout %s before spawning",
  async (timeoutMs) => {
    await expect(runFinanceCycleProcess({ argv: ["-e", "0"], cwd, timeoutMs })).rejects.toThrow(
      "timer-safe",
    );
  },
);
