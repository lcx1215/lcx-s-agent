import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/operator/lcx-finance-scheduler.ts", import.meta.url),
);
let directory: string;
const children = new Set<ChildProcess>();
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "finance-scheduler-lifecycle-"));
});
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
  }
  children.clear();
  fs.rmSync(directory, { recursive: true, force: true });
});

function start(argv: string[]) {
  const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk: Buffer) => {
    output.stdout += String(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output.stderr += String(chunk);
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { child, output, closed };
}

it("runs the real idle loop, excludes another CLI writer, and removes ownership on SIGTERM", async () => {
  // Freeze only this isolated fixture's clock before the first slot. No finance
  // cycle, provider request, model call or venue action can be due in this process.
  const fixture = `
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : ['2026-09-21T10:00:00Z'])); }
      static now() { return new RealDate('2026-09-21T10:00:00Z').getTime(); }
    };
    const {runFinanceScheduler} = await import(${JSON.stringify(script)});
    process.exitCode = await runFinanceScheduler(['--loop','--dir',${JSON.stringify(directory)}]);
  `;
  const owner = start(["--import", "tsx", "--input-type=module", "-e", fixture]);
  await vi.waitFor(() => expect(owner.output.stdout).toContain("scheduler pid="), {
    timeout: 5000,
  });
  expect(fs.existsSync(path.join(directory, "daily-cycle-scheduler.lock"))).toBe(true);
  const contender = start(["--import", "tsx", script, "--once", "day", "--dir", directory]);
  expect(await contender.closed).toBe(1);
  expect(contender.output.stderr).toContain("lock exists");
  owner.child.kill("SIGTERM");
  expect(await owner.closed).toBe(143);
  expect(fs.existsSync(path.join(directory, "daily-cycle-scheduler.lock"))).toBe(false);
  expect(fs.existsSync(path.join(directory, "daily-cycle-scheduler.pid"))).toBe(false);
  expect(fs.existsSync(path.join(directory, "daily-cycle-runs.jsonl"))).toBe(false);
}, 15_000);

it("returns a real nonzero CLI exit for corrupt state and leaves the source state untouched", async () => {
  const filename = path.join(directory, "daily-cycle-scheduler.json");
  fs.writeFileSync(filename, "{broken");
  const run = start(["--import", "tsx", script, "--once", "day", "--dir", directory]);
  expect(await run.closed).toBe(1);
  expect(fs.readFileSync(filename, "utf8")).toBe("{broken");
  expect(fs.existsSync(path.join(directory, "daily-cycle-runs.jsonl"))).toBe(false);
  expect(fs.existsSync(path.join(directory, "daily-cycle-scheduler.lock"))).toBe(false);
}, 10_000);

it("does not claim detached readiness when the real child cannot read its state", async () => {
  fs.writeFileSync(path.join(directory, "daily-cycle-scheduler.json"), "{broken");
  const run = start(["--import", "tsx", script, "--detach", "--dir", directory]);
  expect(await run.closed).toBe(1);
  expect(run.output.stdout).not.toContain("ready");
  expect(run.output.stderr).toContain("before ready");
  expect(fs.readFileSync(path.join(directory, "daily-cycle-scheduler.log"), "utf8")).toContain(
    "SyntaxError",
  );
  expect(fs.existsSync(path.join(directory, "daily-cycle-scheduler.lock"))).toBe(false);
}, 15_000);
