import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { runCentralHarnessCycle } from "./harness-loop.js";
import { executeOwnedProcess } from "./owned-process.js";
import type { CentralToolSpec } from "./types.js";

it.skipIf(process.platform === "win32")(
  "cleans an owner and TERM-resistant grandchild before settlement, without another dispatch",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "central-owner-tree-"));
    const ready = path.join(root, "pids.json");
    const controller = new AbortController();
    let pids: number[] = [];
    try {
      const source = `const {spawn}=require('node:child_process');const fs=require('node:fs');
const child=spawn(process.execPath,['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
      const execute = vi.fn(async (_args, signal: AbortSignal) => {
        return executeOwnedProcess(process.execPath, ["-e", source, ready], {
          cwd: root,
          env: process.env,
          maxBuffer: 1024,
          signal,
        });
      });
      const spec: CentralToolSpec = {
        ownerId: "fixture",
        name: "fixture",
        label: "fixture",
        description: "fixture",
        boundary: [],
        allowedSideEffects: [],
        approve: () => ({ ok: true }),
        execute,
      };
      const pending = runCentralHarnessCycle({
        perception: {
          observedAt: new Date().toISOString(),
          ownerTotals: {},
          controlRoom: {},
          backlog: [],
          boundaries: [],
        },
        brain: {
          propose: async () => ({
            kind: "proposed",
            provider: "fixture",
            modelId: "fixture",
            plan: { actions: [{ ownerId: "fixture" }, { ownerId: "fixture" }], note: "fixture" },
          }),
        },
        registry: new Map([["fixture", spec]]),
        signal: controller.signal,
      });
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          pids = JSON.parse(await fs.readFile(ready, "utf8"));
          break;
        } catch {
          await delay(20);
        }
      }
      expect(pids).toHaveLength(2);
      controller.abort(new Error("fixture cancelled"));
      const receipt = await pending;
      expect(execute).toHaveBeenCalledTimes(1);
      expect(receipt.steps[0].failureReason).toContain("process_group_cleanup_confirmed");
      expect(receipt.nextAction).toBe("halt_and_report");
      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      controller.abort();
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);

it("preserves successful output and nonzero owner receipts", async () => {
  const options = {
    cwd: os.tmpdir(),
    env: process.env,
    maxBuffer: 1024,
    signal: new AbortController().signal,
  };
  await expect(
    executeOwnedProcess(process.execPath, ["-e", 'process.stdout.write("正常")'], options),
  ).resolves.toEqual({ stdout: "正常" });
  await expect(
    executeOwnedProcess(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify({ok:false}));process.exitCode=1"],
      options,
    ),
  ).rejects.toMatchObject({ code: 1, stdout: '{"ok":false}' });
});
