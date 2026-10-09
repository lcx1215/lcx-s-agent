import { spawn } from "node:child_process";
import { killProcessTree } from "../process/kill-tree.js";

export const DEFAULT_FINANCE_CYCLE_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_LIMIT = 1024 * 1024;

export type FinanceCycleProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  status: "succeeded" | "failed" | "timed_out" | "cancelled" | "spawn_error";
  ok: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
};

/** Owns only the spawned cycle; never uses a persisted PID to signal a process. */
export async function runFinanceCycleProcess(params: {
  argv: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  killGraceMs?: number;
}): Promise<FinanceCycleProcessResult> {
  const result: FinanceCycleProcessResult = {
    exitCode: null,
    signal: null,
    status: "failed",
    ok: false,
    stdout: "",
    stderr: "",
    outputTruncated: false,
  };
  if (
    !Number.isSafeInteger(params.timeoutMs) ||
    params.timeoutMs <= 0 ||
    params.timeoutMs > 2_147_483_647
  ) {
    throw new Error("cycle timeout must be a positive timer-safe integer");
  }
  if (params.signal?.aborted) {
    return { ...result, status: "cancelled" };
  }
  const graceMs = params.killGraceMs ?? 1000;
  let termination: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: () => void = () => {};
  try {
    const child = spawn(process.execPath, [...params.argv], {
      cwd: params.cwd,
      ...(params.env ? { env: params.env } : {}),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const full = { stdout: false, stderr: false };
    const append = (key: "stdout" | "stderr", text: string) => {
      if (full[key]) {
        return;
      }
      const remaining = OUTPUT_LIMIT - result[key].length;
      let end = Math.min(text.length, remaining);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) {
        end -= 1;
      }
      result[key] += text.slice(0, end);
      if (text.length > remaining) {
        result.outputTruncated = true;
        // Preserve a contiguous prefix; later chunks must not fill the space left by a cut glyph.
        full[key] = true;
      }
    };
    child.stdout.setEncoding("utf8").on("data", (text: string) => append("stdout", text));
    child.stderr.setEncoding("utf8").on("data", (text: string) => append("stderr", text));
    const terminate = (status: "timed_out" | "cancelled") => {
      if (termination || result.status === "spawn_error") {
        return;
      }
      result.status = status;
      if (child.pid) {
        killProcessTree(child.pid, { graceMs });
        // Keep the owner alive until the tree's escalation timer has fired, even if
        // the direct child exits while a descendant ignores SIGTERM.
        termination = new Promise((resolve) => setTimeout(resolve, graceMs + 10));
      }
    };
    stop = () => terminate("cancelled");
    params.signal?.addEventListener("abort", stop, { once: true });
    timer = setTimeout(() => terminate("timed_out"), params.timeoutMs);
    await new Promise<void>((resolve) => {
      child.once("error", (error) => {
        result.status = "spawn_error";
        append("stderr", error.message);
      });
      child.once("close", (code, signal) => {
        result.exitCode = result.status === "spawn_error" ? null : code;
        result.signal = signal;
        if (!termination && result.status !== "spawn_error") {
          result.status = code === 0 ? "succeeded" : "failed";
        }
        resolve();
      });
    });
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", stop);
    await termination;
    result.ok = result.status === "succeeded";
    return result;
  } catch (error) {
    return { ...result, status: "spawn_error", stderr: String(error).slice(0, OUTPUT_LIMIT) };
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", stop);
  }
}
