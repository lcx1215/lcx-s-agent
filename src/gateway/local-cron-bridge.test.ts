import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "../cron/service.js";
import { createNoopLogger } from "../cron/service.test-harness.js";
import {
  createLocalCronGatewayCaller,
  isLocalCronMethod,
  LOCAL_CRON_METHODS,
} from "./local-cron-bridge.js";

const VALID_JOB = {
  name: "bridge-job",
  enabled: true,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "main",
  wakeMode: "next-heartbeat",
  payload: { kind: "systemEvent", text: "hello from the bridge" },
} as const;

async function withBridge(
  run: (call: ReturnType<typeof createLocalCronGatewayCaller>) => Promise<void>,
  options?: { cronEnabled?: boolean },
) {
  // A per-test temp dir: `createCronStoreHarness` relies on suite-level
  // `beforeAll`, so it cannot be used from inside a test body.
  const root = await mkdtemp(join(tmpdir(), "local-cron-bridge-"));
  const storePath = join(root, "cron", "jobs.json");
  await mkdir(join(root, "cron"), { recursive: true });
  const cron = new CronService({
    cronEnabled: options?.cronEnabled ?? true,
    storePath,
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })) as never,
  });
  await cron.start();
  try {
    await run(createLocalCronGatewayCaller({ cron, cronStorePath: storePath }));
  } finally {
    cron.stop();
    await rm(root, { recursive: true, force: true });
  }
}

describe("local cron bridge method surface", () => {
  it("advertises exactly the cron tool's method set", () => {
    expect([...LOCAL_CRON_METHODS].toSorted()).toEqual(
      [
        "cron.add",
        "cron.list",
        "cron.remove",
        "cron.run",
        "cron.runs",
        "cron.status",
        "cron.update",
        "wake",
      ].toSorted(),
    );
  });

  it("accepts cron methods and rejects unrelated ones", () => {
    expect(isLocalCronMethod("cron.status")).toBe(true);
    expect(isLocalCronMethod("wake")).toBe(true);
    // Non-cron families must keep going to the real Gateway.
    expect(isLocalCronMethod("sessions.list")).toBe(false);
    expect(isLocalCronMethod("canvas.push")).toBe(false);
    expect(isLocalCronMethod("")).toBe(false);
  });
});

describe("local cron bridge RPC behaviour", () => {
  it("reports status and tracks job count", async () => {
    await withBridge(async (call) => {
      const before = await call<{ enabled: boolean; jobs: number; storePath: string }>(
        "cron.status",
        {},
        {},
      );
      expect(before.enabled).toBe(true);
      // Proves the bridge is bound to this test's store, not the real config dir.
      expect(before.storePath).toContain("local-cron-bridge-");

      await call("cron.add", {}, { ...VALID_JOB });
      const after = await call<{ jobs: number }>("cron.status", {}, {});
      expect(after.jobs).toBe(before.jobs + 1);
    });
  });

  it("round-trips add -> list -> update -> remove", async () => {
    await withBridge(async (call) => {
      const added = await call<{ id: string }>("cron.add", {}, { ...VALID_JOB });
      expect(typeof added.id).toBe("string");

      const listed = await call<{ jobs: Array<{ id: string; name?: string }> }>(
        "cron.list",
        {},
        { includeDisabled: true },
      );
      expect(listed.jobs.map((job) => job.id)).toContain(added.id);

      const updated = await call<{ name?: string }>(
        "cron.update",
        {},
        {
          id: added.id,
          patch: { name: "renamed" },
        },
      );
      expect(updated.name).toBe("renamed");

      const removed = await call<{ removed?: boolean; id?: string }>(
        "cron.remove",
        {},
        {
          id: added.id,
        },
      );
      expect(removed.id ?? added.id).toBe(added.id);

      const after = await call<{ jobs: Array<{ id: string }> }>(
        "cron.list",
        {},
        {
          includeDisabled: true,
        },
      );
      expect(after.jobs.map((job) => job.id)).not.toContain(added.id);
    });
  });

  it("runs a job on demand", async () => {
    await withBridge(async (call) => {
      const added = await call<{ id: string }>("cron.add", {}, { ...VALID_JOB });
      const result = await call(
        "cron.run",
        {},
        {
          id: added.id,
          mode: "force",
        },
      );
      expect(result).toBeTruthy();
    });
  });

  it("serves run history without throwing", async () => {
    await withBridge(async (call) => {
      const added = await call<{ id: string }>("cron.add", {}, { ...VALID_JOB });
      const runs = await call<{ entries?: unknown[] }>("cron.runs", {}, { id: added.id });
      expect(Array.isArray(runs.entries ?? [])).toBe(true);
    });
  });

  it("settles wake without throwing", async () => {
    await withBridge(async (call) => {
      await expect(
        call("wake", {}, { mode: "next-heartbeat", text: "ping" }),
      ).resolves.toBeDefined();
    });
  });
});

describe("local cron bridge error surface", () => {
  it("rejects methods outside the advertised set", async () => {
    await withBridge(async (call) => {
      await expect(call("sessions.list", {}, {})).rejects.toThrow(
        /does not implement method "sessions.list"/,
      );
    });
  });

  it("surfaces validation failures from the reused handlers", async () => {
    await withBridge(async (call) => {
      // `cron.add` requires a schedule, payload, and session target.
      await expect(call("cron.add", {}, { name: "incomplete" })).rejects.toThrow(
        /cron\.add failed/,
      );
    });
  });

  it("surfaces a missing-id failure on update", async () => {
    await withBridge(async (call) => {
      await expect(call("cron.update", {}, { patch: { name: "x" } })).rejects.toThrow(
        /cron\.update failed/,
      );
    });
  });

  it("reports a disabled scheduler instead of failing", async () => {
    await withBridge(
      async (call) => {
        const status = await call<{ enabled: boolean }>("cron.status", {}, {});
        expect(status.enabled).toBe(false);
      },
      { cronEnabled: false },
    );
  });
});
