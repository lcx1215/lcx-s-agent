import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { killProcessTree } from "../../process/kill-tree.js";

/** The owner and its ordinary descendants share one cancellable process group. */
export function executeOwnedProcess(
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number; signal: AbortSignal },
): Promise<{ stdout: string }> {
  const { signal, ...execOptions } = options;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let cancelling = false;
    const child = spawn(file, [...args], {
      cwd: execOptions.cwd,
      env: execOptions.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let outputBytes = 0;
    let outputError: Error | undefined;
    const consume = (chunk: string, capture: boolean) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > execOptions.maxBuffer) {
        outputError = new Error("owner output exceeded maxBuffer");
        abort();
      } else if (capture) {
        stdout += chunk;
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => consume(chunk, true));
    child.stderr.on("data", (chunk: string) => consume(chunk, false));
    child.on("error", (error) => {
      if (!cancelling) {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (cancelling) {
        return;
      }
      signal.removeEventListener("abort", abort);
      if (code !== 0) {
        reject(Object.assign(new Error(`owner exited ${code}`), { code, stdout }));
      } else {
        resolve({ stdout });
      }
    });
    const abort = () => {
      if (cancelling) {
        return;
      }
      cancelling = true;
      signal.removeEventListener("abort", abort);
      void (async () => {
        const pid = child.pid;
        if (!pid) {
          reject(signal.reason);
          return;
        }
        killProcessTree(pid, { graceMs: 200 });
        const deadline = Date.now() + 1_500;
        while (Date.now() < deadline) {
          try {
            process.kill(process.platform === "win32" ? pid : -pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") {
              reject(
                new Error(
                  `${String(outputError ?? signal.reason)}; ${process.platform === "win32" ? "cleanup_unconfirmed" : "process_group_cleanup_confirmed"}`,
                ),
              );
              return;
            }
          }
          await delay(20);
        }
        reject(new Error(`${String(outputError ?? signal.reason)}; cleanup_unconfirmed`));
      })();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
  });
}
