import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeReceipt } from "../../scripts/operator/lcx-finance-research-run.ts";
import { runFinanceResearchRun } from "../../src/agents/finance-research-runner.ts";

let directory: string;
const asOf = "2026-09-08T12:00:00.000Z";
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "research-receipt-atomic-"));
  await fs.mkdir(path.join(directory, "state"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await fs.rm(directory, { recursive: true, force: true });
});
const receipt = () =>
  runFinanceResearchRun({
    input: { ask: "Review SPY", asOf, horizonMonths: 1 },
    liveFetch: false,
  });
const host = () => ({ workspaceDir: directory, config: {} });

it("replaces the latest symlink without writing or chmodding its target", async () => {
  const target = path.join(directory, "unrelated.txt");
  await fs.writeFile(target, "unrelated sentinel", { mode: 0o644 });
  const before = await fs.stat(target);
  const latest = path.join(directory, "state", "lcx-finance-research-run-latest.json");
  await fs.symlink(target, latest);
  const written = await writeReceipt(await receipt(), asOf, host());
  expect(await fs.readFile(target, "utf8")).toBe("unrelated sentinel");
  expect((await fs.stat(target)).mode).toBe(before.mode);
  expect((await fs.lstat(latest)).isFile()).toBe(true);
  expect((await fs.stat(latest)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await fs.readFile(latest, "utf8"))).toEqual(
    JSON.parse(await fs.readFile(written.datedPath, "utf8")),
  );
});

it("preserves a complete latest receipt when publication fails and removes owned temporary files", async () => {
  const latest = path.join(directory, "state", "lcx-finance-research-run-latest.json");
  await fs.writeFile(latest, '{"old":true}\n');
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to === latest) {
      throw new Error("fixture publication failure");
    }
    return rename(from, to);
  });
  await expect(writeReceipt(await receipt(), asOf, host())).rejects.toThrow(
    "fixture publication failure",
  );
  expect(await fs.readFile(latest, "utf8")).toBe('{"old":true}\n');
  expect((await fs.readdir(path.dirname(latest))).filter((name) => name.endsWith(".tmp"))).toEqual(
    [],
  );
  const archived = await fs.readdir(
    path.join(directory, "state", "finance-research-runs", "2026-09-08"),
  );
  expect(archived).toHaveLength(1);
});

it("keeps distinct archives when two receipts are published in the same millisecond", async () => {
  const value = await receipt();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(asOf));
  const results = await Promise.all([
    writeReceipt(value, asOf, host()),
    writeReceipt(value, asOf, host()),
  ]);
  expect(new Set(results.map((result) => result.datedPath)).size).toBe(2);
  for (const result of results) {
    expect(JSON.parse(await fs.readFile(result.datedPath, "utf8"))).toEqual(value);
  }
});
