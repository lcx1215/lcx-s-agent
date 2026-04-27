import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

const { createAiderTool } = await import("./aider-tool.js");

describe("aider tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    runCommandWithTimeoutMock.mockReset();
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
    delete process.env.OPENCLAW_AIDER_BIN;
  });

  it("returns an explicit unavailable payload when aider is missing", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-aider-"));
    await fs.writeFile(path.join(workspaceDir, "app.ts"), "export const ok = true;\n", "utf8");
    runCommandWithTimeoutMock
      .mockRejectedValueOnce(Object.assign(new Error("spawn aider ENOENT"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error("spawn uvx ENOENT"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" }));

    const tool = createAiderTool({ workspaceDir });
    const result = await tool.execute("call-1", {
      prompt: "fix the bug",
      files: ["app.ts"],
    });
    const details = result.details as {
      unavailable: boolean;
      ok: boolean;
      action?: string;
      command: string;
      attemptedCommands?: string[];
    };

    expect(details.ok).toBe(false);
    expect(details.unavailable).toBe(true);
    expect(details.command).toBe("aider");
    expect(details.attemptedCommands).toEqual([
      "aider",
      "uvx --from aider-chat aider",
      "python3 -m aider",
    ]);
    expect(details.action).toContain("Install aider");
  });

  it("falls back to uvx aider when aider is not on PATH", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-aider-"));
    await fs.writeFile(path.join(workspaceDir, "app.ts"), "export const ok = true;\n", "utf8");
    runCommandWithTimeoutMock
      .mockRejectedValueOnce(Object.assign(new Error("spawn aider ENOENT"), { code: "ENOENT" }))
      .mockResolvedValueOnce({
        pid: 123,
        stdout: "done",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      });

    const tool = createAiderTool({ workspaceDir });
    const result = await tool.execute("call-fallback", {
      prompt: "tighten the validation branch",
      files: ["app.ts"],
      dryRun: true,
      timeoutSeconds: 42,
    });
    const details = result.details as {
      ok: boolean;
      command: string;
      attemptedCommands: string[];
    };

    expect(details.ok).toBe(true);
    expect(details.command).toBe("uvx --from aider-chat aider");
    expect(details.attemptedCommands).toEqual(["aider", "uvx --from aider-chat aider"]);
    expect(runCommandWithTimeoutMock).toHaveBeenNthCalledWith(
      2,
      [
        "uvx",
        "--from",
        "aider-chat",
        "aider",
        "--yes",
        "--no-auto-commits",
        "--no-dirty-commits",
        "--no-stream",
        "--file",
        "app.ts",
        "--dry-run",
        "--message",
        "tighten the validation branch",
      ],
      expect.objectContaining({
        cwd: workspaceDir,
        timeoutMs: 42_000,
      }),
    );
  });

  it("builds a bounded aider one-shot invocation", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-aider-"));
    await fs.mkdir(path.join(workspaceDir, "src"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "docs"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "src", "app.ts"), "export const ok = true;\n");
    await fs.writeFile(path.join(workspaceDir, "docs", "design.md"), "# Design\n");
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      pid: 123,
      stdout: "done",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });

    const tool = createAiderTool({ workspaceDir });
    const result = await tool.execute("call-2", {
      prompt: "tighten the validation branch",
      files: ["src/app.ts"],
      readOnlyFiles: ["docs/design.md"],
      model: "openai/gpt-5.4",
      dryRun: true,
      timeoutSeconds: 42,
    });
    const details = result.details as { ok: boolean; argv: string[]; files: string[] };

    expect(details.ok).toBe(true);
    expect(details.files).toEqual(["src/app.ts"]);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      [
        "aider",
        "--yes",
        "--no-auto-commits",
        "--no-dirty-commits",
        "--no-stream",
        "--model",
        "openai/gpt-5.4",
        "--file",
        "src/app.ts",
        "--read",
        "docs/design.md",
        "--dry-run",
        "--message",
        "tighten the validation branch",
      ],
      expect.objectContaining({
        cwd: workspaceDir,
        timeoutMs: 42_000,
      }),
    );
    expect(details.argv).toContain("--file");
  });

  it("adds remediation when uvx aider bootstrap fails on missing build tools", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-aider-"));
    await fs.writeFile(path.join(workspaceDir, "app.ts"), "export const ok = true;\n", "utf8");
    runCommandWithTimeoutMock
      .mockRejectedValueOnce(Object.assign(new Error("spawn aider ENOENT"), { code: "ENOENT" }))
      .mockResolvedValueOnce({
        pid: 123,
        stdout: "",
        stderr:
          "Failed to build scipy. Unknown compiler(s): [['gfortran']]. Did not find pkg-config by name 'pkg-config'",
        code: 1,
        signal: null,
        killed: false,
        termination: "exit",
      });

    const tool = createAiderTool({ workspaceDir });
    const result = await tool.execute("call-remediation", {
      prompt: "tighten the validation branch",
      files: ["app.ts"],
      dryRun: true,
    });
    const details = result.details as {
      ok: boolean;
      unavailable: boolean;
      command: string;
      remediation?: string;
    };

    expect(details.ok).toBe(false);
    expect(details.unavailable).toBe(false);
    expect(details.command).toBe("uvx --from aider-chat aider");
    expect(details.remediation).toContain("Install gfortran and pkg-config");
    expect(details.remediation).toContain("OPENCLAW_AIDER_BIN");
  });

  it("blocks paths outside the workspace", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-aider-"));
    const tool = createAiderTool({ workspaceDir });

    await expect(
      tool.execute("call-3", {
        prompt: "edit outside",
        files: ["../secret.txt"],
      }),
    ).rejects.toThrow("aider paths must stay inside the workspace");
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });
});
