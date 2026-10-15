import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts/operator/lcx-automation-repair-lock.ts");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(git = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-repair-lock-"));
  roots.push(root);
  const cwd = path.join(root, "worktree");
  await fs.mkdir(cwd);
  if (git) {
    await execFileAsync("git", ["init"], { cwd });
  }
  return { root, cwd, lock: path.join(root, "repair.lock") };
}
async function runLock(args: string[], cwd: string, lock: string) {
  const result = await execFileAsync(
    process.execPath,
    ["--import", "tsx", scriptPath, "--json", "--worktree", cwd, "--lock", lock, ...args],
    { cwd: repoRoot },
  );
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("lcx automation repair lock", () => {
  it("keeps the validated plan readback when a dirty worktree refuses acquisition", async () => {
    const { root, cwd, lock } = await fixture();
    await fs.writeFile(path.join(cwd, "existing-wip.txt"), "Preserve this existing work.\n");
    const context = {
      schemaVersion: "lcx_training_repair_context_v1",
      decisionId: "guard_failed_after_latest_start",
      worktree: cwd,
      codexRepairEligible: true,
    };
    const raw = JSON.stringify(context);
    const result = await runLock(
      ["--mode", "acquire", "--lane", "local-brain-training-plan", "--plan-context-json", raw],
      cwd,
      lock,
    );
    expect(result).toMatchObject({
      acquired: false,
      status: "dirty_worktree",
      planningInput: {
        context,
        contentSha256: crypto.createHash("sha256").update(raw).digest("hex"),
      },
    });
    expect(result.rejectedPlanningInput).toBeUndefined();
    await expect(fs.access(lock)).rejects.toThrow();
    expect(await fs.readFile(path.join(cwd, "existing-wip.txt"), "utf8")).toBe(
      "Preserve this existing work.\n",
    );
    if (process.env.LCX_REPAIR_REFUSAL_PROOF_DIR) {
      await fs.mkdir(process.env.LCX_REPAIR_REFUSAL_PROOF_DIR, { recursive: true });
      await fs.writeFile(
        path.join(process.env.LCX_REPAIR_REFUSAL_PROOF_DIR, "native-refusal.json"),
        JSON.stringify(
          {
            boundary:
              "private_original_cli_validated_declared_input_not_original_planner_or_repair_execution",
            inputText: raw,
            result,
            lockCreated: false,
            existingWipPreserved: true,
            privateRoot: root,
          },
          null,
          2,
        ) + "\n",
      );
    }
  });

  it("persists the actual selected plan input and reads it through the original lease", async () => {
    const { cwd, lock } = await fixture();
    const context = {
      schemaVersion: "lcx_training_repair_context_v1",
      decisionId: "guard_failed_after_latest_start",
      worktree: cwd,
      codexRepairEligible: true,
    };
    const raw = JSON.stringify(context);
    const acquired = await runLock(
      ["--mode", "acquire", "--lane", "local-brain-training-plan", "--plan-context-json", raw],
      cwd,
      lock,
    );
    expect(acquired.acquired).toBe(true);
    const persisted = JSON.parse(await fs.readFile(lock, "utf8"));
    expect(persisted.planningInput).toEqual({
      context,
      contentSha256: crypto.createHash("sha256").update(raw).digest("hex"),
    });
    const read = await runLock(["--mode", "status"], cwd, lock);
    expect(read.lock).toEqual(acquired.lock);
    expect(read.lock).toMatchObject({ planningInput: persisted.planningInput });
  });
  it.each([
    "ineligible",
    "cross-root",
    "malformed",
    "unknown-schema",
    "oversized",
    "extra-field",
  ] as const)(
    "does not create a lease from a %s training plan even with allow-dirty",
    async (fault) => {
      const { cwd, lock } = await fixture();
      const wipPath = path.join(cwd, "existing-wip.txt");
      const wip = "Preserve this existing work.\n";
      await fs.writeFile(wipPath, wip);
      const context: Record<string, unknown> = {
        schemaVersion: "lcx_training_repair_context_v1",
        decisionId: "guard_failed_after_latest_start",
        worktree: cwd,
        codexRepairEligible: true,
      };
      if (fault === "ineligible") {
        context.codexRepairEligible = false;
      }
      if (fault === "cross-root") {
        context.worktree = path.join(cwd, "other");
      }
      if (fault === "unknown-schema") {
        context.schemaVersion = "v999";
      }
      if (fault === "extra-field") {
        context.authorized = true;
      }
      const raw =
        fault === "malformed"
          ? "{"
          : fault === "oversized"
            ? JSON.stringify(context) + " ".repeat(1024)
            : JSON.stringify(context, null, fault === "ineligible" ? 2 : undefined);
      const result = await runLock(
        [
          "--mode",
          "acquire",
          "--lane",
          "local-brain-training-plan",
          "--allow-dirty",
          "--plan-context-json",
          raw,
        ],
        cwd,
        lock,
      );
      expect(result).toMatchObject({
        acquired: false,
        status:
          fault === "ineligible"
            ? "blocked_training_plan_repair_not_eligible"
            : fault === "cross-root"
              ? "blocked_training_plan_worktree_conflict"
              : "blocked_training_plan_context_invalid",
        liveTouched: false,
        providerConfigTouched: false,
      });
      expect(result.planningInput).toBeUndefined();
      if (fault === "ineligible") {
        expect(result.rejectedPlanningInput).toEqual({
          context,
          contentSha256: crypto.createHash("sha256").update(raw).digest("hex"),
          status: "not_eligible",
        });
      } else {
        expect(result.rejectedPlanningInput).toBeUndefined();
      }
      await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(wipPath, "utf8")).toBe(wip);
    },
  );

  it.each([{ laneArgs: [] }, { laneArgs: ["--lane", "unknown"] }])(
    "refuses acquisition without a known releasable lane: %j",
    async ({ laneArgs }) => {
      const { cwd, lock } = await fixture();
      const result = await runLock(["--mode", "acquire", ...laneArgs], cwd, lock);
      expect(result).toMatchObject({
        acquired: false,
        status: "blocked_lock_identity_unconfirmed",
      });
      expect(String(result.reason)).toContain("declared known repair lane");
      await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("serializes automation repair ownership by token", async () => {
    const { cwd, lock } = await fixture();
    const acquired = await runLock(["--mode", "acquire", "--lane", "teacher-quality"], cwd, lock);
    expect(acquired.acquired).toBe(true);
    expect(typeof acquired.token).toBe("string");
    const original = await fs.readFile(lock);
    const blocked = await runLock(["--mode", "acquire", "--lane", "health"], cwd, lock);
    expect(blocked.acquired).toBe(false);
    expect(blocked.status).toBe("locked");
    expect(await fs.readFile(lock)).toEqual(original);
    const wrongToken = await runLock(
      ["--mode", "release", "--lane", "health", "--token", "another-owner"],
      cwd,
      lock,
    ).catch((error: { stdout: string }) => JSON.parse(error.stdout));
    expect(wrongToken).toMatchObject({ released: false, status: "token_mismatch", ok: false });
    expect(await fs.readFile(lock)).toEqual(original);
    const released = await runLock(
      ["--mode", "release", "--lane", "teacher-quality", "--token", String(acquired.token)],
      cwd,
      lock,
    );
    expect(released.released).toBe(true);
    const reacquired = await runLock(["--mode", "acquire", "--lane", "health"], cwd, lock);
    expect(reacquired.acquired).toBe(true);
  });

  it.each(["wrong-lane", "missing-lane", "unknown-owner", "relative-owner"] as const)(
    "preserves the lease when release identity is %s despite a matching token",
    async (fault) => {
      const { cwd, lock } = await fixture();
      const acquired = await runLock(["--mode", "acquire", "--lane", "owner"], cwd, lock);
      if (fault === "unknown-owner" || fault === "relative-owner") {
        const stored = JSON.parse(await fs.readFile(lock, "utf8")) as Record<string, unknown>;
        if (fault === "unknown-owner") {
          stored.lane = "unknown";
        } else {
          stored.cwd = "worktree";
        }
        await fs.writeFile(lock, JSON.stringify(stored) + "\n");
      }
      const before = await fs.readFile(lock);
      const result = await runLock(
        [
          "--mode",
          "release",
          "--token",
          String(acquired.token),
          ...(fault === "missing-lane"
            ? []
            : ["--lane", fault === "wrong-lane" ? "other" : "owner"]),
        ],
        cwd,
        lock,
      ).catch((error: { stdout: string; code: number }) => {
        expect(error.code).toBe(1);
        return JSON.parse(error.stdout) as Record<string, unknown>;
      });
      expect(result).toMatchObject({
        ok: false,
        released: false,
        status: fault === "wrong-lane" ? "lane_mismatch" : "blocked_lock_identity_unconfirmed",
      });
      expect(await fs.readFile(lock)).toEqual(before);
    },
  );

  it("releases an original complete legacy lock with its exact worktree, lane and token", async () => {
    const { cwd, lock } = await fixture();
    await fs.writeFile(
      lock,
      JSON.stringify({
        token: "private-legacy-token",
        lane: "legacy-owner",
        pid: process.pid,
        cwd,
        startedAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-01-01T00:01:00.000Z",
        command: "private original legacy owner",
      }) + "\n",
    );
    const result = await runLock(
      ["--mode", "release", "--lane", "legacy-owner", "--token", "private-legacy-token"],
      cwd,
      lock,
    );
    expect(result).toMatchObject({ ok: true, released: true, status: "released" });
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses repair ownership on dirty git worktrees while retaining explicit allow-dirty", async () => {
    const { cwd, lock } = await fixture();
    await fs.writeFile(path.join(cwd, "untracked.txt"), "dirty\n");
    const blocked = await runLock(["--mode", "acquire", "--lane", "dev-acceptance"], cwd, lock);
    expect(blocked.acquired).toBe(false);
    expect(blocked.status).toBe("dirty_worktree");
    expect(blocked.dirtyFiles).toContain("?? untracked.txt");
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    const acquired = await runLock(
      ["--mode", "acquire", "--lane", "dev-acceptance", "--allow-dirty"],
      cwd,
      lock,
    );
    expect(acquired.acquired).toBe(true);
  });

  it.each(["missing", "nongit"] as const)(
    "blocks %s worktree without fabricating a clean status, including allow-dirty",
    async (kind) => {
      const { root, cwd, lock } = await fixture(false);
      const target = kind === "missing" ? path.join(root, "absent") : cwd;
      for (const flags of [[], ["--allow-dirty"]]) {
        const result = await runLock(
          ["--mode", "acquire", "--lane", "offline", ...flags],
          target,
          lock,
        );
        expect(result).toMatchObject({
          acquired: false,
          status: "blocked_worktree_status_unavailable",
        });
        expect(String(result.reason)).toContain("Git status is unavailable");
        await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "terminates a stalled native Git child and refuses ownership even with allow-dirty",
    async () => {
      const { root, cwd, lock } = await fixture();
      const bin = path.join(root, "bin");
      const pidPath = path.join(root, "git.pid");
      await fs.mkdir(bin);
      await fs.writeFile(
        path.join(bin, "git"),
        [
          `#!${process.execPath}`,
          `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
          'setTimeout(() => { process.stdout.write(""); }, 60000);',
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      const startedAt = Date.now();
      let childPid: number | undefined;
      try {
        const output = await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            scriptPath,
            "--mode",
            "acquire",
            "--lane",
            "offline-deadline",
            "--json",
            "--allow-dirty",
            "--worktree",
            cwd,
            "--lock",
            lock,
          ],
          {
            cwd: repoRoot,
            env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
            timeout: 18_000,
            killSignal: "SIGKILL",
          },
        );
        const result = JSON.parse(output.stdout) as Record<string, unknown>;
        childPid = Number(await fs.readFile(pidPath, "utf8"));
        expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
        expect(result).toMatchObject({
          acquired: false,
          status: "blocked_worktree_status_unavailable",
          liveTouched: false,
          providerConfigTouched: false,
        });
        expect(String(result.reason)).toContain("Git status is unavailable");
        expect(Date.now() - startedAt).toBeLessThan(18_000);
        await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
        expect(() => process.kill(childPid!, 0)).toThrowError(
          expect.objectContaining({ code: "ESRCH" }),
        );
        if (process.env.LCX_REPAIR_LOCK_DEADLINE_PROOF_DIR) {
          const proofDir = process.env.LCX_REPAIR_LOCK_DEADLINE_PROOF_DIR;
          await fs.mkdir(proofDir, { recursive: true });
          await fs.writeFile(
            path.join(proofDir, "native-deadline-result.json"),
            JSON.stringify({
              result,
              elapsedMs: Date.now() - startedAt,
              childPid,
              childExited: true,
              leaseCreated: false,
              scope: "private native child and lease only; no automation invoked",
            }) + "\n",
          );
        }
      } finally {
        childPid ??= Number(await fs.readFile(pidPath, "utf8").catch(() => "NaN"));
        if (Number.isSafeInteger(childPid) && childPid > 0) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch (error) {
            expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
          }
        }
      }
    },
    22_000,
  );

  it("treats an unreadable lock as unconfirmed ownership through status, acquire and release", async () => {
    const { cwd, lock } = await fixture();
    await fs.mkdir(lock);
    for (const mode of ["status", "acquire", "release"]) {
      const result = await runLock(
        ["--mode", mode, "--lane", "offline", "--token", "no-authority"],
        cwd,
        lock,
      );
      expect(result).toMatchObject({
        status: "blocked_lock_status_unavailable",
        unreadableLock: true,
      });
      expect(result.acquired).not.toBe(true);
      expect(result.released).not.toBe(true);
      expect((await fs.stat(lock)).isDirectory()).toBe(true);
    }
  });

  it.each(["", "null", "{}", '{"token":"other-owner","expiresAt":"invalid"}'])(
    "keeps malformed existing ownership blocked and unchanged (%j)",
    async (raw) => {
      const { cwd, lock } = await fixture();
      await fs.writeFile(lock, raw);
      for (const mode of ["status", "acquire", "release"]) {
        const result = await runLock(["--mode", mode, "--lane", "offline"], cwd, lock);
        expect(result).toMatchObject({ status: "locked", malformedLock: true });
        expect(result.acquired).not.toBe(true);
        expect(result.released).not.toBe(true);
        expect(await fs.readFile(lock, "utf8")).toBe(raw);
      }
    },
  );

  it("reclaims only a fully readable expired native lease", async () => {
    const { cwd, lock } = await fixture();
    const acquired = await runLock(["--mode", "acquire", "--lane", "first"], cwd, lock);
    const lease = JSON.parse(await fs.readFile(lock, "utf8"));
    lease.startedAt = "2026-01-01T00:00:00.000Z";
    lease.expiresAt = "2026-01-01T00:01:00.000Z";
    await fs.writeFile(lock, JSON.stringify(lease));
    const status = await runLock(["--mode", "status"], cwd, lock);
    expect(status.status).toBe("expired");
    const next = await runLock(["--mode", "acquire", "--lane", "second"], cwd, lock);
    expect(next.acquired).toBe(true);
    expect(next.token).not.toBe(acquired.token);
    expect(JSON.parse(await fs.readFile(lock, "utf8")).lane).toBe("second");
  });
});
