import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { appendFinanceBars } from "../finance-bar-ledger.js";
import { compactReceipts, runCentralHarnessCycle } from "./harness-loop.js";
import { buildCentralToolCatalog } from "./model-brain.js";
import { executeOwnedProcess } from "./owned-process.js";
import { createCentralToolRegistry } from "./tool-registry.js";
import type { CentralPerception, CentralToolSpec } from "./types.js";

it("carries exact bar-source comparison through the registered reader into the next decision", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "central-bar-source-"));
  const source = {
    origin: "retained-eod-history",
    sourceUrlOrArtifact: `https://example.test/original-daily-history?instrument=WBD&scope=${"x".repeat(50)}`,
  };
  const bars = Array.from({ length: 25 }, (_, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, "0")}`,
    open: 30.15,
    high: 31.15,
    low: 29.15,
    close: Number((30.15 + index / 100).toFixed(2)),
    volume: 13_708_348,
  }));
  const directory = path.join(root, "state", "finance");
  try {
    await appendFinanceBars(directory, {
      instrument: "WBD",
      derivation: "ohlcv",
      observedAt: "2026-09-26T00:00:00Z",
      provenance: source,
      bars,
    });
    await appendFinanceBars(directory, {
      instrument: "WBD",
      derivation: "ohlcv",
      observedAt: "2026-09-26T01:00:00Z",
      provenance: { origin: "other", sourceUrlOrArtifact: "fixture://other" },
      bars: [{ ...bars[24], close: 30.5 }],
    });
    const registry = createCentralToolRegistry({ workspaceDir: root });
    const args = {
      action: "read",
      instrument: "WBD",
      asOf: "2026-09-27T00:00:00Z",
      source,
      limit: 25,
    };
    const spec = registry.get("finance_bar_ledger")!;
    expect(spec.inputKeys).toContain("source");
    const catalog = buildCentralToolCatalog([...registry.values()]);
    expect(spec.approve(args)).toEqual({ ok: true });
    expect(spec.approve({ ...args, action: "append" }).ok).toBe(false);
    expect(spec.approve({ ...args, directory }).ok).toBe(false);
    const perception = {
      observedAt: args.asOf,
      ownerTotals: {},
      controlRoom: {},
      backlog: [],
      boundaries: [],
    };
    const first = await runCentralHarnessCycle({
      perception,
      registry,
      brain: {
        propose: async () => ({
          kind: "proposed",
          provider: "offline-fixture",
          modelId: "scripted-consumer",
          plan: { actions: [{ ownerId: spec.ownerId, args }], note: "read exact retained source" },
        }),
      },
    });
    expect(first.steps[0].outcome).toMatchObject({
      sourceSelection: {
        requested: source,
        matchedRecordCount: 1,
        excludedRecordCount: 1,
        allSourcesDivergentDates: ["WBD@2026-09-25"],
      },
      divergentDates: [],
    });
    expect(first.steps[0].outcomeDroppedKeys).not.toContain("sourceSelection");
    const backlog = compactReceipts([first], 10);
    const decide = vi.fn(async (seen: CentralPerception) => {
      const carried = (seen.backlog as ReturnType<typeof compactReceipts>)[0].outcomes[0];
      expect(seen.backlog).toEqual(compactReceipts([first], 10));
      const outcome = carried.outcome!;
      expect(outcome.sourceSelection).toEqual(first.steps[0].outcome?.sourceSelection);
      expect(outcome.headRef).toBe(first.steps[0].outcome?.headRef);
      expect(carried.args?.source).toEqual(source);
      const selection = outcome.sourceSelection as { allSourcesDivergentDates: string[] };
      return {
        kind: "proposed" as const,
        provider: "offline-fixture",
        modelId: "scripted-consumer",
        plan: {
          actions: [],
          note: selection.allSourcesDivergentDates.length
            ? "require source-equivalence evidence before judging"
            : "no retained cross-source conflict",
        },
      };
    });
    const second = await runCentralHarnessCycle({
      perception: { ...perception, backlog },
      registry,
      brain: { propose: decide },
    });
    expect(second.brainCall.note).toBe("require source-equivalence evidence before judging");
    expect(decide).toHaveBeenCalledOnce();
    expect(catalog).toContain("source={origin, sourceUrlOrArtifact}");
    const missing = await spec.execute(
      { ...args, source: { ...source, sourceUrlOrArtifact: "fixture://missing" } },
      new AbortController().signal,
    );
    expect(missing).toMatchObject({
      status: "empty_for_filter",
      returnedBarCount: 0,
      sourceSelection: { matchedRecordCount: 0, excludedRecordCount: 2 },
    });
    const unfiltered = await spec.execute(
      { action: "read", instrument: "WBD", asOf: args.asOf, limit: 25 },
      new AbortController().signal,
    );
    expect(unfiltered).toMatchObject({ divergentDates: ["WBD@2026-09-25"] });
    expect(unfiltered).not.toHaveProperty("sourceSelection");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("binds declared workspace inputs to the trusted host while refusing model-selected roots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "central-recall-host-"));
  try {
    const runDir = path.join(root, "state", "finance-research-runs", "host-only-run");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "runtime.json"), JSON.stringify({ source: "host-root" }));
    const registry = createCentralToolRegistry({ workspaceDir: root });
    const reader = registry.get("finance_research_runs_read")!;
    expect(reader.approve({ action: "list" })).toEqual({ ok: true });
    expect(reader.approve({ action: "list", workspaceDir: os.tmpdir() }).ok).toBe(false);
    expect(reader.inputKeys).not.toContain("workspaceDir");
    expect(reader.inputKeys).toContain("field");
    const signal = new AbortController().signal;
    const listing = await reader.execute({ action: "list" }, signal);
    expect(listing).toMatchObject({ available: true, runs: [{ id: "host-only-run" }] });
    expect(await reader.execute({ action: "read", run: "host-only-run" }, signal)).toMatchObject({
      available: true,
      json: { source: "host-root" },
    });
    expect(
      await reader.execute({ action: "read", run: "host-only-run", field: "/source" }, signal),
    ).toMatchObject({
      available: true,
      selectedValue: "host-root",
      selectionComplete: true,
      truncated: false,
      sourceBytes: Buffer.byteLength(JSON.stringify({ source: "host-root" })),
    });
    expect(
      await registry
        .get("quant_math")!
        .execute({ action: "beta", series: [2, 4, 6], benchmark: [1, 2, 3] }, signal),
    ).toMatchObject({ beta: 2 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

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
