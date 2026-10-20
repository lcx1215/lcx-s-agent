import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { guardChildMemory, processTreeRssBytes } from "./child-memory-budget.js";
import { killProcessTree } from "./kill-tree.js";

it("counts the owned process and all descendants, without unrelated process memory", () => {
  expect(processTreeRssBytes("12 1 12 100\n13 12 12 200\n15 13 12 300\n99 1 99 999", 12)).toBe(
    600 * 1024,
  );
  expect(processTreeRssBytes("12 1 12 100", 88)).toBeUndefined();
  expect(processTreeRssBytes("13 1 12 200\n99 1 99 999", 12, true)).toBe(200 * 1024);
});

it("rejects an unavailable process measurement rather than reporting enforcement", async () => {
  const child = spawn("python3", ["-c", "import time; time.sleep(10)"], { detached: true });
  const closed = once(child, "close");
  const guard = guardChildMemory(child, {
    budgetMb: 64,
    readBytes: async () => undefined,
    onError: () => {
      if (child.pid) {
        killProcessTree(child.pid, { graceMs: 25 });
      }
    },
  });
  try {
    await expect(guard.ready).rejects.toThrow("memory_observation_unavailable");
    await expect(guard.stop()).rejects.toThrow("memory_observation_unavailable");
    await closed;
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      killProcessTree(child.pid, { graceMs: 25 });
    }
  }
});

it("keeps guarding an owned child after its detached group leader exits", async () => {
  const child = spawn(
    "python3",
    [
      "-c",
      "import subprocess, sys, time; subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(0.5); allocation=bytearray(48*1024*1024); allocation[::4096]=bytes([1])*(len(allocation)//4096); time.sleep(10)']); time.sleep(0.25)",
    ],
    { detached: true },
  );
  const closed = once(child, "close");
  let failure: Error | undefined;
  const guard = guardChildMemory(child, {
    budgetMb: 40,
    includeProcessGroup: true,
    onError: (error) => {
      failure = error;
      if (child.pid) {
        killProcessTree(child.pid, { graceMs: 25 });
      }
    },
  });
  try {
    await guard.ready;
    await once(child, "exit");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(failure?.message).toBe("memory_budget_exceeded");
  } finally {
    if (child.pid) {
      killProcessTree(child.pid, { graceMs: 25 });
    }
    await closed;
    await guard.stop().catch(() => undefined);
  }
});
