import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildLocalModelProcessEnv } from "./local-model-process-env.js";
import {
  parseLocalBaseModelJson,
  type LocalTextModelRuntimeConfig,
} from "./local-text-model-adapter.js";
import type {
  LogicalAgentModelAdapter,
  ModelCallObservation,
} from "./logical-agent-model-router.js";

export type LocalTextWorkerSnapshot = {
  pid: number | null;
  protocolReady: boolean;
  weightsLoaded: boolean;
  loading: boolean;
  busy: boolean;
  lastInferenceSucceededAt: string | null;
  lastFailure: { code: string; at: string } | null;
  inferenceEvidence: "not_inference_proven" | "inference_succeeded";
};

/** A single resident process owned by the host service; requests are never replayed. */
export class LocalTextWorker {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: {
    id: string;
    resolve: (value: { text: string; pid: number }) => void;
    reject: (error: Error) => void;
  };
  private restart?: ReturnType<typeof setTimeout>;
  private supervised = false;
  private failures = 0;
  private stopping?: Promise<void>;
  private protocolReady = false;
  private weightsLoaded = false;
  private loading = false;
  private lastInferenceSucceededAt: string | null = null;
  private lastFailure: LocalTextWorkerSnapshot["lastFailure"] = null;
  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
  ) {}

  start(): void {
    this.supervised = true;
    this.ensureProcess();
  }

  /** Reads host observations only; never starts a process or loads/invokes a model. */
  snapshot(): LocalTextWorkerSnapshot {
    return {
      pid: this.child?.pid ?? null,
      protocolReady: this.protocolReady,
      weightsLoaded: this.weightsLoaded,
      loading: this.loading,
      busy: this.pending !== undefined,
      lastInferenceSucceededAt: this.lastInferenceSucceededAt,
      lastFailure: this.lastFailure ? { ...this.lastFailure } : null,
      inferenceEvidence: this.lastInferenceSucceededAt
        ? "inference_succeeded"
        : "not_inference_proven",
    };
  }

  private resetProcessState(): void {
    this.protocolReady = false;
    this.weightsLoaded = false;
    this.loading = false;
    this.lastInferenceSucceededAt = null;
  }

  private recordFailure(error: Error): void {
    if (error.message !== "local_worker_stopped") {
      this.lastFailure = { code: error.message, at: new Date().toISOString() };
    }
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.child) {
      return this.child;
    }
    this.resetProcessState();
    if (this.restart) {
      clearTimeout(this.restart);
      this.restart = undefined;
    }
    const child = spawn(this.command, [...this.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: buildLocalModelProcessEnv(process.env, { HF_HUB_OFFLINE: "1", PYTHONUNBUFFERED: "1" }),
    });
    this.child = child;
    let processFailure: Error | undefined;
    let buffered = "";
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > 2_000_000) {
        void this.kill(new Error("local_worker_output_limit"));
        return;
      }
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const response = JSON.parse(line) as {
            id?: string;
            text?: string;
            error?: string;
            ready?: boolean;
            event?: string;
            weightsLoaded?: boolean;
          };
          if (response.ready === true) {
            this.protocolReady = true;
            if (!this.pending) {
              this.setReferenced(false);
            }
          }
          if (this.pending && response.id === this.pending.id) {
            if (response.event === "loading") {
              this.loading = true;
              this.weightsLoaded = false;
              continue;
            }
            if (response.event === "loaded") {
              this.loading = false;
              this.weightsLoaded = true;
              continue;
            }
            const pending = this.pending;
            this.pending = undefined;
            this.loading = false;
            if (typeof response.weightsLoaded === "boolean") {
              this.weightsLoaded = response.weightsLoaded;
            }
            this.setReferenced(false);
            if (typeof response.text === "string") {
              this.failures = 0;
              this.lastInferenceSucceededAt = new Date().toISOString();
              pending.resolve({ text: response.text, pid: child.pid ?? 0 });
            } else {
              const error = new Error("local_worker_inference_failed");
              this.recordFailure(error);
              pending.reject(error);
            }
          }
        } catch {
          void this.kill(new Error("local_worker_protocol_invalid"));
        }
      }
    });
    child.on("error", () => {
      processFailure = new Error("local_worker_unavailable");
      this.recordFailure(processFailure);
      this.rejectPending(processFailure);
    });
    child.stdin.on("error", () => {
      if (this.child === child) {
        // A live process with a broken input pipe cannot serve another request.
        this.resetProcessState();
        void this.kill(new Error("local_worker_input_failed"));
      }
    });
    child.once("close", () => {
      if (this.child === child) {
        this.child = undefined;
        this.resetProcessState();
      }
      if (!this.stopping && !processFailure) {
        this.recordFailure(new Error("local_worker_exited"));
      }
      this.rejectPending(new Error("local_worker_exited"));
      if (this.supervised) {
        this.restart = setTimeout(
          () => this.ensureProcess(),
          Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5)),
        );
        this.restart.unref();
      }
    });
    return child;
  }

  private setReferenced(active: boolean): void {
    const child = this.child;
    if (!child) {
      return;
    }
    if (active) {
      child.ref();
    } else {
      child.unref();
    }
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      const handle = stream as typeof stream & { ref?: () => void; unref?: () => void };
      if (active) {
        handle.ref?.();
      } else {
        handle.unref?.();
      }
    }
  }

  private rejectPending(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }

  private kill(error: Error): Promise<void> {
    if (this.stopping) {
      return this.stopping;
    }
    this.recordFailure(error);
    this.rejectPending(error);
    const child = this.child;
    if (!child) {
      return Promise.resolve();
    }
    this.setReferenced(true);
    this.stopping = new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill("SIGKILL"), 750);
      child.once("close", () => {
        clearTimeout(force);
        resolve();
      });
      child.kill("SIGTERM");
    }).finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  async stop(): Promise<void> {
    this.supervised = false;
    if (this.restart) {
      clearTimeout(this.restart);
      this.restart = undefined;
    }
    await this.kill(new Error("local_worker_stopped"));
  }

  async invoke(prompt: string, maxTokens: number, timeoutMs: number, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.pending || this.stopping) {
      throw new Error("local_worker_busy");
    }
    const child = this.ensureProcess();
    this.setReferenced(true);
    const id = randomUUID();
    const onAbort = () => {
      void this.kill(new Error("local_worker_cancelled"));
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<{ text: string; pid: number }>((resolve, reject) => {
        this.pending = { id, resolve, reject };
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          void this.kill(new Error("local_worker_timeout"));
        }, timeoutMs);
        if (signal.aborted) {
          onAbort();
          return;
        }
        child.stdin.write(`${JSON.stringify({ id, prompt, maxTokens })}\n`);
      });
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      signal.removeEventListener("abort", onAbort);
    }
  }
}

const workers = new Map<string, LocalTextWorker>();
/** The host's primary resident worker, if assembled; this never creates one. */
export function readLocalTextWorkerSnapshot(): LocalTextWorkerSnapshot | undefined {
  return workers.values().next().value?.snapshot();
}

export function localTextWorker(runtime: LocalTextModelRuntimeConfig): LocalTextWorker {
  const key = `${runtime.pythonPath}\0${runtime.modelId}`;
  let worker = workers.get(key);
  if (!worker) {
    worker = new LocalTextWorker(runtime.pythonPath, [
      fileURLToPath(new URL("../../scripts/local-model/lcx_text_worker.py", import.meta.url)),
      "--model",
      runtime.modelId,
    ]);
    workers.set(key, worker);
  }
  return worker;
}
export async function stopLocalTextWorkers(): Promise<void> {
  await Promise.all([...workers.values()].map((worker) => worker.stop()));
  workers.clear();
}

export function createResidentLocalTextAdapter(
  runtime: LocalTextModelRuntimeConfig,
  options: {
    idPrefix: string;
    capabilities: readonly string[];
    buildPrompt: (payload: unknown) => string;
  },
): LogicalAgentModelAdapter {
  const observations = new Map<string, ModelCallObservation>();
  return {
    id: `${options.idPrefix}-resident`,
    provider: "mlx-local",
    modelId: runtime.modelId,
    mode: "adapter",
    capabilities: options.capabilities,
    requiredTools: [],
    requiredSideEffects: ["local_compute"],
    roleScope: ["data_cleaning"],
    invoke: async (request, signal) => {
      const result = await localTextWorker(runtime).invoke(
        options.buildPrompt(request.payload),
        Math.min(512, runtime.maxTokens),
        Math.min(15_000, runtime.timeoutMs),
        signal,
      );
      let normalized = false;
      try {
        JSON.parse(result.text);
      } catch {
        normalized = true;
      }
      observations.set(request.callId, {
        callId: request.callId,
        provider: "mlx-local",
        modelId: runtime.modelId,
        transportRequestId: `resident_mlx:${result.pid}:${request.callId}`,
        kind: "model_inference",
        ...(normalized ? { outputNormalization: "json_extraction" as const } : {}),
      });
      return parseLocalBaseModelJson(result.text);
    },
    observe: (request) => {
      const result = observations.get(request.callId);
      observations.delete(request.callId);
      return result;
    },
  };
}
