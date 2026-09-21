import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runNativeCodingHarness,
  reconcileNativeCodingRun,
  type NativeCodingHarnessInput,
} from "./native-coordinator.js";
import { type NativeDocker, type NativeContainer } from "./native-docker.js";
import { resolveTrustedNativeCodingBinding, type NativeCodingRunner } from "./native-types.js";
import {
  inspectNativeSource,
  snapshotNativeTree,
  nativeManifestDigest,
} from "./native-workspace.js";
const exec = promisify(execFile);
const roots: string[] = [];
const trustedArgv = ["/usr/bin/python3", "-I", "-B", "-c", "assert 2 + 3 == 5"] as const;
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture(): Promise<NativeCodingHarnessInput> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-coding-test-"));
  roots.push(root);
  const source = path.join(root, "source");
  await fs.mkdir(source);
  await exec("git", ["init", "-b", "codex/fixture", source]);
  await fs.writeFile(path.join(source, "answer.txt"), "before\n");
  await exec("git", ["-C", source, "add", "answer.txt"]);
  await exec("git", [
    "-C",
    source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  return {
    task: "fix fixture",
    cwd: source,
    authorizedWorkspaceDir: source,
    config: {},
    agentDir: path.join(root, "auth"),
    requesterSessionKey: "agent:fixture:main",
    artifactRoot: path.join(root, "artifacts"),
    timeoutMs: 5000,
  };
}
function fakeDocker() {
  const live = new Set<string>();
  const create = vi.fn<NativeDocker["create"]>(async ({ taskId, workspaceDir, allocated }) => {
    const name = `fixture-${live.size}-${Math.random()}`;
    await allocated(name);
    live.add(name);
    const container: NativeContainer = {
      id: name,
      name,
      taskId,
      workspaceDir,
      sandbox: {
        enabled: true,
        sessionKey: taskId,
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
        containerName: name,
        containerWorkdir: "/workspace",
        docker: {
          image: "fixture",
          containerPrefix: "fixture",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: [],
          network: "none",
          capDrop: ["ALL"],
        },
        tools: { allow: ["read", "write", "edit", "exec"] },
        browserAllowHostControl: false,
      },
    };
    return container;
  });
  const destroy = vi.fn<NativeDocker["destroy"]>(async (c) => {
    live.delete(c.name);
    return true;
  });
  const verify = vi.fn<NativeDocker["verify"]>(async () => ({
    code: 0,
    stdout: "pass",
    stderr: "",
  }));
  return { create, destroy, verify, live };
}
const edit: NativeCodingRunner = async ({ binding }) => {
  const view = resolveTrustedNativeCodingBinding(binding);
  await fs.writeFile(path.join(view.workspaceDir, "answer.txt"), "after\n");
  return {
    status: "completed",
    executionStarted: true,
    childRunId: view.runId,
    childSessionKey: view.sessionKey,
  };
};
describe("native coding isolation and artifact delivery", () => {
  it("verifies independent immutable artifact, preserves source and controller argv", async () => {
    const input = await fixture();
    const docker = fakeDocker();
    docker.verify.mockImplementation(async (container, argv) => {
      expect(docker.live.size).toBe(1);
      expect(container.workspaceDir).toMatch(/verifier$/);
      expect(argv).toEqual(trustedArgv);
      expect(await fs.readFile(path.join(container.workspaceDir, "answer.txt"), "utf8")).toBe(
        "after\n",
      );
      return { code: 0, stdout: "pass", stderr: "" };
    });
    const receipt = await runNativeCodingHarness(
      { ...input, verification: { argv: trustedArgv } },
      { docker, runner: edit },
    );
    expect(receipt.status).toBe("verified");
    expect(receipt.verified).toBe(true);
    expect(receipt.sourceUnchanged).toBe(true);
    expect(receipt.changedPaths).toEqual(["answer.txt"]);
    expect(docker.live.size).toBe(0);
    expect(await fs.readFile(path.join(input.cwd, "answer.txt"), "utf8")).toBe("before\n");
    expect(await fs.readFile(receipt.patchPath, "utf8")).toContain("+after");
  });
  it("preserves path-like source strings in patches and never persists provisional verified", async () => {
    const input = await fixture();
    const docker = fakeDocker();
    docker.verify.mockImplementation(async (container) => {
      const interim = JSON.parse(
        await fs.readFile(path.join(container.workspaceDir, "..", "receipt.json"), "utf8"),
      );
      expect(interim.status).toBe("running");
      expect(interim.verified).toBe(false);
      return { code: 0, stdout: "pass", stderr: "" };
    });
    const result = await runNativeCodingHarness(
      { ...input, verification: { argv: trustedArgv } },
      {
        docker,
        runner: async (args) => {
          const view = resolveTrustedNativeCodingBinding(args.binding);
          await fs.writeFile(
            path.join(view.workspaceDir, "answer.txt"),
            "literal a/base/x and b/artifact/y\n",
          );
          return {
            status: "completed",
            executionStarted: true,
            childRunId: view.runId,
            childSessionKey: view.sessionKey,
          };
        },
      },
    );
    expect(await fs.readFile(result.patchPath, "utf8")).toContain(
      "+literal a/base/x and b/artifact/y",
    );
  });
  it("blocks artifact-owned acceptance scripts before model dispatch", async () => {
    const input = await fixture();
    const docker = fakeDocker();
    const runner = vi.fn<NativeCodingRunner>(async (args) => {
      const view = resolveTrustedNativeCodingBinding(args.binding);
      await fs.writeFile(path.join(view.workspaceDir, "trusted.py"), "raise SystemExit(0)\n");
      return {
        status: "completed",
        executionStarted: true,
        childRunId: view.runId,
        childSessionKey: view.sessionKey,
      };
    });
    const receipt = await runNativeCodingHarness(
      { ...input, verification: { argv: ["python3", "-B", "trusted.py"] } },
      { docker, runner },
    );
    expect(receipt.status).toBe("blocked");
    expect(receipt.verified).toBe(false);
    expect(runner).not.toHaveBeenCalled();
    expect(docker.create).not.toHaveBeenCalled();
  });
  it("model replacement of trusted.py cannot replace frozen controller code", async () => {
    const input = await fixture();
    const docker = fakeDocker();
    docker.verify.mockImplementation(async (container, argv) => {
      expect(await fs.readFile(path.join(container.workspaceDir, "trusted.py"), "utf8")).toBe(
        "raise SystemExit(0)\n",
      );
      expect(argv).toEqual([
        "/usr/bin/python3",
        "-I",
        "-B",
        "-c",
        "assert False, 'independent acceptance fails'",
      ]);
      return { code: 1, stdout: "", stderr: "independent acceptance fails" };
    });
    const receipt = await runNativeCodingHarness(
      {
        ...input,
        verification: {
          argv: [
            "/usr/bin/python3",
            "-I",
            "-B",
            "-c",
            "assert False, 'independent acceptance fails'",
          ],
        },
      },
      {
        docker,
        runner: async (args) => {
          const view = resolveTrustedNativeCodingBinding(args.binding);
          await fs.writeFile(path.join(view.workspaceDir, "trusted.py"), "raise SystemExit(0)\n");
          return edit(args);
        },
      },
    );
    expect(receipt.status).toBe("failed");
    expect(receipt.verified).toBe(false);
  });
  it("without acceptance policy only completes unverified", async () => {
    const input = await fixture();
    const docker = fakeDocker();
    const result = await runNativeCodingHarness(input, { docker, runner: edit });
    expect(result.status).toBe("completed-unverified");
    expect(result.verified).toBe(false);
    expect(docker.verify).not.toHaveBeenCalled();
  });
  it("blocks unavailable Docker without dispatch and retains receipt", async () => {
    const input = await fixture();
    const docker = fakeDocker();
    docker.create.mockRejectedValue(new Error("Docker unavailable"));
    const runner = vi.fn(edit);
    const result = await runNativeCodingHarness(input, { docker, runner });
    expect(result.status).toBe("blocked");
    expect(runner).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(result.receiptPath, "utf8")).verified).toBe(false);
  });
  it("deadline destroys a container even when runner ignores its signal", async () => {
    const input = await fixture();
    const docker = fakeDocker();
    const result = await runNativeCodingHarness(
      { ...input, timeoutMs: 100 },
      { docker, runner: () => new Promise(() => {}) },
    );
    expect(result.status).toBe("timed-out");
    expect(result.cleanupConfirmed).toBe(true);
    expect(docker.live.size).toBe(0);
  });
  it("explicit cancellation cannot claim verified", async () => {
    const input = await fixture();
    const docker = fakeDocker();
    const controller = new AbortController();
    const result = await runNativeCodingHarness(
      { ...input, signal: controller.signal },
      {
        docker,
        runner: async (args) => {
          controller.abort();
          return edit(args);
        },
      },
    );
    expect(result.status).toBe("cancelled");
    expect(result.verified).toBe(false);
    expect(docker.live.size).toBe(0);
  });
  it("failed verifier and unconfirmed cleanup never verify", async () => {
    const input = await fixture();
    const docker = fakeDocker();
    docker.verify.mockResolvedValue({ code: 1, stdout: "", stderr: "failure" });
    const result = await runNativeCodingHarness(
      { ...input, verification: { argv: trustedArgv } },
      { docker, runner: edit },
    );
    expect(result.status).toBe("failed");
    expect(result.verified).toBe(false);
    docker.destroy.mockResolvedValue(false);
    const next = await runNativeCodingHarness(input, { docker, runner: edit });
    expect(next.status).toBe("interrupted");
    expect(next.cleanupConfirmed).toBe(false);
  });
  it("changed source prevents sourceUnchanged and verified claims", async () => {
    const input = await fixture();
    const docker = fakeDocker();
    const result = await runNativeCodingHarness(
      { ...input, verification: { argv: trustedArgv } },
      {
        docker,
        runner: async (args) => {
          await fs.writeFile(path.join(input.cwd, "answer.txt"), "concurrent\n");
          return edit(args);
        },
      },
    );
    expect(result.sourceUnchanged).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.status).toBe("failed");
  });
  it("restart reconciles unfinished run without replay", async () => {
    const input = await fixture();
    const docker = fakeDocker();
    const result = await runNativeCodingHarness(input, { docker, runner: edit });
    result.status = "running";
    await fs.writeFile(result.receiptPath, JSON.stringify(result));
    const recovered = await reconcileNativeCodingRun(result.receiptPath, docker);
    expect(recovered.status).toBe("interrupted");
    expect(recovered.verified).toBe(false);
    expect(recovered.error).toContain("no automatic replay");
  });
  it.each(["symlink", "hardlink", "fifo"])("rejects unsafe %s editor outputs", async (kind) => {
    const input = await fixture();
    const docker = fakeDocker();
    const result = await runNativeCodingHarness(input, {
      docker,
      runner: async (args) => {
        const view = resolveTrustedNativeCodingBinding(args.binding);
        const target = path.join(view.workspaceDir, "unsafe");
        if (kind === "symlink") {
          await fs.symlink(input.cwd, target);
        } else if (kind === "hardlink") {
          await fs.link(path.join(view.workspaceDir, "answer.txt"), target);
        } else {
          await exec("mkfifo", [target]);
        }
        return {
          status: "completed",
          executionStarted: true,
          childRunId: view.runId,
          childSessionKey: view.sessionKey,
        };
      },
    });
    expect(result.status).toBe("failed");
    expect(result.verified).toBe(false);
    expect(docker.live.size).toBe(0);
  });
  it("honors cancellation before source inspection or container allocation", async () => {
    const input = await fixture();
    const docker = fakeDocker();
    await expect(
      inspectNativeSource(
        input.cwd,
        input.cwd,
        AbortSignal.abort(new Error("cancelled before scan")),
      ),
    ).rejects.toThrow("cancelled before scan");
    const receipt = await runNativeCodingHarness(
      { ...input, signal: AbortSignal.abort() },
      { docker, runner: edit },
    );
    expect(receipt.status).toBe("cancelled");
    expect(docker.create).not.toHaveBeenCalled();
  });
  it("blocks unrelated cwd, default branches, dirty source and private tracked files", async () => {
    const input = await fixture();
    const other = await fixture();
    await expect(inspectNativeSource(other.cwd, input.cwd)).rejects.toThrow(
      "authorized repository",
    );
    await exec("git", ["-C", input.cwd, "branch", "-m", "main"]);
    await expect(inspectNativeSource(input.cwd, input.cwd)).rejects.toThrow("feature branch");
    await exec("git", ["-C", input.cwd, "branch", "-m", "codex/fixture"]);
    await fs.writeFile(path.join(input.cwd, "extra"), "dirty");
    await expect(inspectNativeSource(input.cwd, input.cwd)).rejects.toThrow("clean source");
    await fs.rm(path.join(input.cwd, "extra"));
    await fs.writeFile(path.join(input.cwd, ".env"), "fixture");
    await exec("git", ["-C", input.cwd, "add", ".env"]);
    await exec("git", [
      "-C",
      input.cwd,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "private",
    ]);
    await expect(inspectNativeSource(input.cwd, input.cwd)).rejects.toThrow("private output path");
  });
  it("hashes special object-property filenames and rejects oversized files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-manifest-"));
    roots.push(root);
    await fs.writeFile(path.join(root, "__proto__"), "one");
    await fs.writeFile(path.join(root, "constructor"), "two");
    const first = await snapshotNativeTree(root);
    expect(Object.keys(first)).toEqual(["__proto__", "constructor"]);
    await fs.writeFile(path.join(root, "__proto__"), "changed");
    expect(nativeManifestDigest(await snapshotNativeTree(root))).not.toBe(
      nativeManifestDigest(first),
    );
    await fs.writeFile(path.join(root, "large"), Buffer.alloc(5 * 1024 * 1024 + 1));
    await expect(snapshotNativeTree(root)).rejects.toThrow("oversized");
  });
});
