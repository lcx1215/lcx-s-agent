import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeUniverseDeadlineReceipt,
  universeDeadlineFunctions,
} from "./fixtures/lcx-universe-deadline-probe.js";
import { probeUniverseWhole } from "./fixtures/lcx-waterflow-universe-whole-probe.js";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
describe("original Universe new owner-local collection deadline", () => {
  it("caps relative and caller absolute bounds by the new 120000ms default", async () => {
    const functions = await universeDeadlineFunctions();
    const now = Date.now();
    const defaultDeadline = functions.createOwnerDeadline({}, now);
    const caller = functions.createOwnerDeadline(
      { timeoutMs: 999999, deadlineAtMs: now + 600000 },
      now,
    );
    const narrowed = functions.createOwnerDeadline(
      { timeoutMs: 90000, deadlineAtMs: now + 30000 },
      now,
    );
    expect(defaultDeadline.deadlineAtMs).toBe(now + 120000);
    expect(caller.deadlineAtMs).toBe(now + 120000);
    expect(narrowed.deadlineAtMs).toBe(now + 30000);
    expect(functions.parseArgs(["--timeout-ms", "999999"])).toMatchObject({ timeoutMs: 120000 });
    expect(() => functions.parseArgs(["--deadline-at", "garbage"])).toThrow();
    for (const item of [defaultDeadline, caller, narrowed]) {
      item.dispose();
    }
  });
  it("does not start a child after an already elapsed caller deadline", async () => {
    const child = vi.fn(async () => ({ stdout: "late success", stderr: "" }));
    const functions = await universeDeadlineFunctions(child);
    const deadline = functions.createOwnerDeadline({ deadlineAtMs: Date.now() - 1 });
    expect(await functions.changeImpactCoverage(["test/changed.test.ts"], deadline)).toMatchObject({
      ok: false,
      source: "lcx-change-impact-plan_failed",
    });
    expect(await functions.changeImpactCoverage([], deadline)).toMatchObject({
      ok: false,
      source: "lcx-change-impact-plan_failed",
    });
    expect(child).not.toHaveBeenCalled();
    expect(deadline.snapshot()).toMatchObject({
      status: "timed_out",
      cleanupStatus: "cleanup_unconfirmed",
    });
    deadline.dispose();
  });
  it("rejects an ignored signal and preserves the failed source after its late result", async () => {
    let complete: ((value: { stdout: string; stderr: string }) => void) | undefined;
    const child = vi.fn(
      (_command: string, _args: string[], _options: { signal?: AbortSignal }) =>
        new Promise<{ stdout: string; stderr: string }>((resolve) => {
          complete = resolve;
        }),
    );
    const functions = await universeDeadlineFunctions(child);
    const deadline = functions.createOwnerDeadline({ timeoutMs: 20 });
    const result = await functions.execLinesWithStatus(
      "git",
      ["ls-files"],
      "/private/offline",
      true,
      deadline,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("deadline exceeded");
    expect(child.mock.calls[0][2].signal?.aborted).toBe(true);
    const sealed = JSON.stringify(result);
    complete?.({ stdout: "test/late-success.test.ts\n", stderr: "" });
    await pause(10);
    expect(JSON.stringify(result)).toBe(sealed);
    expect(deadline.snapshot().status).toBe("timed_out");
    deadline.dispose();
  });
  it("bounds an uncancellable original filesystem read and retains incomplete instead of accepting late metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "universe-deadline-read-"));
    roots.push(root);
    const functions = await universeDeadlineFunctions();
    let finish: (() => void) | undefined;
    vi.spyOn(fs, "access").mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const deadline = functions.createOwnerDeadline({ timeoutMs: 20 });
    const inventory = await functions.walkArtifacts(root, Date.now(), deadline);
    expect(inventory).toMatchObject({
      exists: null,
      sourceStatus: "incomplete",
      fileCount: 0,
      readErrors: [
        expect.objectContaining({ code: "UNIVERSE_OWNER_DEADLINE_EXCEEDED", operation: "access" }),
      ],
    });
    const sealed = JSON.stringify(inventory);
    expect(deadline.snapshot().pendingOperations).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "filesystem" })]),
    );
    finish?.();
    await pause(10);
    expect(JSON.stringify(inventory)).toBe(sealed);
    expect(deadline.snapshot().cleanupStatus).toBe("cleanup_unconfirmed");
    deadline.dispose();
  });
  it("produces an actual private CLI timeout receipt consumed as a source failure by original owners", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "universe-deadline-cli-"));
    roots.push(root);
    const evidence = process.env.LCX_UNIVERSE_DEADLINE_PROOF_DIR ?? root;
    const result = await probeUniverseWhole(
      root,
      path.join(evidence, "after-native-cli"),
      "git_timeout",
    );
    expect(result.cliTimedOut).toBe(false);
    expect(result.cli.ok).toBe(false);
    expect(result.cli.ownerDeadline).toMatchObject({
      status: "timed_out",
      cleanupStatus: "cleanup_unconfirmed",
    });
    expect(result.cli.ownerCoverage.changeImpact.source).toBe("lcx-change-impact-plan_failed");
    expect(result.cli.artifacts.workspaceState.sourceStatus).toBe("incomplete");
    const consumed = await consumeUniverseDeadlineReceipt(result.cli);
    expect(consumed.observedOk).toBe(false);
    expect(consumed.compact).toMatchObject({
      artifactInventoryComplete: false,
      governanceStatus: "incomplete",
    });
    expect(consumed.compact.visibleInventory).toEqual(result.cli.repo.visibleInventory);
    expect(result.cli.repo.trackedInventory.ok).toBe(false);
    expect(result.cli.repo.gitStatusInventory.ok).toBe(false);
    if (process.env.LCX_UNIVERSE_DEADLINE_PROOF_DIR) {
      await fs.writeFile(
        path.join(evidence, "original-source-consumer.json"),
        JSON.stringify(consumed, null, 2),
      );
    }
  }, 30_000);
});
