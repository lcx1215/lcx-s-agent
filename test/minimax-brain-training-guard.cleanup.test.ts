import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
afterEach(() => vi.useRealTimers());
it.each(["confirmed", "unconfirmed", "late_success", "idle"])(
  "confirms original training child cleanup: %s",
  async (mode) => {
    vi.useFakeTimers();
    const source = await fs.readFile(
      new URL("../scripts/operator/minimax-brain-training-guard.ts", import.meta.url),
      "utf8",
    );
    const ast = ts.createSourceFile("guard.ts", source, ts.ScriptTarget.Latest, true);
    const fn = ast.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === "runCommand",
    );
    if (!fn) {
      throw new Error("original owner missing");
    }
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    const write = vi.fn();
    const context = vm.createContext({
      spawn: () => child,
      Date,
      setTimeout,
      clearTimeout,
      WORKTREE_CWD: "/private/fixture",
      process: { env: {}, stdout: { write }, stderr: { write } },
    });
    vm.runInContext(
      ts.transpileModule(fn.getText(ast) + "\nglobalThis.invoke=runCommand;", {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      context,
    );
    const invoke = context.invoke as (
      command: string,
      args: string[],
      options: object,
    ) => Promise<{ timedOut: boolean; cleanupStatus: string; stdout: string }>;
    let settled = false;
    const pending = invoke("fixture", [], {
      allowFailure: true,
      ...(mode === "idle" ? { idleTimeoutMs: 10 } : { timeoutMs: 10 }),
    });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const check =
      mode === "unconfirmed"
        ? expect(pending).rejects.toMatchObject({
            cause: { cleanupStatus: "cleanup_unconfirmed", timedOut: true },
          })
        : expect(pending).resolves.toMatchObject({
            timedOut: true,
            cleanupStatus: "local_child_closed",
            stdout: "",
          });
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.stdout.write("late result");
    expect(write).not.toHaveBeenCalled();
    if (mode !== "unconfirmed") {
      child.emit("close", mode === "late_success" ? 0 : null);
    } else {
      await vi.advanceTimersByTimeAsync(1000);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    }
    await check;
    expect(vi.getTimerCount()).toBe(0);
  },
);
