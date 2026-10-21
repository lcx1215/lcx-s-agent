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
      "process.stdout.write('x'.repeat(2000000)); process.stderr.write('y'.repeat(2000000));",
    ],
    cwd,
    timeoutMs: 3000,
  });
  expect(result.ok).toBe(true);
  expect(result.outputTruncated).toBe(true);
  expect(result.stdout).toHaveLength(1024 * 1024);
  expect(result.stderr).toHaveLength(1024 * 1024);
});

it("preserves JSON evidence when UTF-8 characters span real stdout and stderr chunks", async () => {
  const expected = JSON.stringify({ reason: "证据更新🧠，先核对再判断", gap: "尚缺当前价格" });
  const script = `
    const body=Buffer.from(${JSON.stringify(expected)});
    const splits=[body.indexOf(Buffer.from('证'))+1,body.indexOf(Buffer.from('🧠'))+2];
    const chunks=[body.subarray(0,splits[0]),body.subarray(splits[0],splits[1]),body.subarray(splits[1])];
    (async()=>{for(const chunk of chunks){
      process.stdout.write(chunk);process.stderr.write(chunk);
      await new Promise(resolve=>setTimeout(resolve,60));
    }})();
  `;
  const result = await runFinanceCycleProcess({ argv: ["-e", script], cwd, timeoutMs: 3000 });
  expect(result).toMatchObject({ ok: true, outputTruncated: false });
  expect(result.stdout).toBe(expected);
  expect(result.stderr).toBe(expected);
  expect(JSON.parse(result.stdout)).toEqual(JSON.parse(expected));
});

it.each([1, 2])(
  "retains a contiguous Unicode prefix at output capacity with %s units left",
  async (left) => {
    const prefix = "x".repeat(1024 * 1024 - left);
    const script = `
    process.stdout.write('x'.repeat(${prefix.length})+'🧠');
    ${left === 1 ? "setTimeout(()=>process.stdout.write('Z'),60);" : ""}
  `;
    const result = await runFinanceCycleProcess({ argv: ["-e", script], cwd, timeoutMs: 3000 });
    expect(result.ok).toBe(true);
    expect(result.outputTruncated).toBe(left === 1);
    expect(result.stdout).toHaveLength(prefix.length + (left === 2 ? 2 : 0));
    expect(result.stdout).toBe(prefix + (left === 2 ? "🧠" : ""));
  },
);

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

it("passes an explicit child environment without modifying the parent", async () => {
  const before = process.env.LCX_FINANCE_HTTP_PROXY;
  const result = await runFinanceCycleProcess({
    argv: ["-e", "console.log(process.env.LCX_FINANCE_HTTP_PROXY)"],
    cwd,
    timeoutMs: 3000,
    env: { ...process.env, LCX_FINANCE_HTTP_PROXY: "http://127.0.0.1:7897" },
  });
  expect(result.ok).toBe(true);
  expect(result.stdout.trim()).toBe("http://127.0.0.1:7897");
  expect(process.env.LCX_FINANCE_HTTP_PROXY).toBe(before);
});

it("rejects a child completion after wall time expires even before its timer callback", async () => {
  const started = Date.now();
  let jumped = false;
  vi.spyOn(Date, "now").mockImplementation(() => {
    if (jumped) {
      return started + 60_000;
    }
    jumped = true;
    return started;
  });
  const result = await runFinanceCycleProcess({
    argv: ["-e", "console.log('late');"],
    cwd,
    timeoutMs: 3000,
    killGraceMs: 10,
  });
  expect(result).toMatchObject({ status: "timed_out", ok: false });
});
