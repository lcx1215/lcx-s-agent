import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { openFinanceRunCheckpoints } from "./finance-run-checkpoints.js";

const exec = promisify(execFile);
const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function options() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-checkpoint-test-"));
  paths.push(dir);
  return {
    path: path.join(dir, "checkpoint.sqlite"),
    runId: "case-run-1",
    executionFingerprint: "fixture-code-v1",
  };
}
describe("finance durable reservations", () => {
  it("persists results and charged reservations across close/reopen", async () => {
    const opts = await options();
    const first = openFinanceRunCheckpoints(opts, "input", 2);
    const reservation = first.reserve("one", 1);
    expect(reservation.status).toBe("reserved");
    if (reservation.status !== "reserved") {
      throw new Error("missing reservation");
    }
    first.complete("one", reservation.token, { data: "original evidence" });
    first.close();
    const resumed = openFinanceRunCheckpoints(opts, "input", 2);
    try {
      expect(resumed.reserve("one", 1)).toEqual({
        status: "completed",
        result: { data: "original evidence" },
      });
      expect(resumed.reserved()).toBe(1);
      expect(resumed.reserve("two", 1).status).toBe("reserved");
      expect(resumed.reserve("three", 1).status).toBe("budget_exhausted");
    } finally {
      resumed.close();
    }
  });
  it("rejects changed input and budget without altering the original run", async () => {
    const opts = await options();
    openFinanceRunCheckpoints(opts, "input", 2).close();
    expect(() => openFinanceRunCheckpoints(opts, "different", 2)).toThrow("mismatch");
    expect(() => openFinanceRunCheckpoints(opts, "input", 3)).toThrow("mismatch");
    const resumed = openFinanceRunCheckpoints(opts, "input", 2);
    expect(resumed.reserved()).toBe(0);
    resumed.close();
  });
  it("retains uncertain reservations after abrupt process exit", async () => {
    const opts = await options();
    const script = `import { openFinanceRunCheckpoints } from './src/agents/finance-run-checkpoints.ts';
      const store = openFinanceRunCheckpoints(${JSON.stringify(opts)}, 'input', 1);
      store.reserve('interrupted', 1); process.exit(0);`;
    await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script]);
    const resumed = openFinanceRunCheckpoints(opts, "input", 1);
    try {
      expect(resumed.reserve("interrupted", 1).status).toBe("uncertain");
      expect(resumed.reserved()).toBe(1);
      expect(resumed.reserve("other", 1).status).toBe("budget_exhausted");
    } finally {
      resumed.close();
    }
  });
  it("allows only one process to reserve the same node", async () => {
    const opts = await options();
    openFinanceRunCheckpoints(opts, "input", 1).close();
    const script = `import { openFinanceRunCheckpoints } from './src/agents/finance-run-checkpoints.ts';
      const store = openFinanceRunCheckpoints(${JSON.stringify(opts)}, 'input', 1);
      console.log(store.reserve('same', 1).status); store.close();`;
    const results = await Promise.all(
      [0, 1].map(() =>
        exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script]),
      ),
    );
    expect(results.map((result) => result.stdout.trim()).toSorted()).toEqual([
      "reserved",
      "uncertain",
    ]);
  });
});
