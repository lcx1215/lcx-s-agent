import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildLocalModelProcessEnv } from "./local-model-process-env.js";
import { buildLocalScriptCommand } from "./local-model-slot.js";
import { DEFAULT_LOCAL_MODEL_PYTHON_PATH } from "./local-text-model-adapter.js";
import type {
  LogicalAgentModelAdapter,
  ModelCallObservation,
  ModelCallRequest,
} from "./logical-agent-model-router.js";
import { ModelAdapterError } from "./logical-agent-model-router.js";

/**
 * Local counterpart of a System One evaluation endpoint. It keeps the same
 * request/response shape -- state plus typed questions in, answers plus
 * probabilities out -- while running entirely on a local mlx model.
 *
 * Raw logits are not calibrated probabilities. Answers are only as trustworthy
 * as the calibration file supplied at runtime; treat `calibrated: false`
 * results as unranked, not as confidence scores.
 */

export const LOCAL_EVALUATE_SCHEMA_VERSION = "lcx_local_evaluate_v1" as const;
export const DEFAULT_LOCAL_EVALUATE_TIMEOUT_MS = 120_000;
export const DEFAULT_LOCAL_EVALUATE_MEMORY_LIMIT_MB = 3072;
const OUTPUT_LIMIT_BYTES = 2_000_000;

export type LocalEvaluatePrimitive = "choice" | "score" | "noul";

export type LocalEvaluateQuestion = Readonly<{
  type: LocalEvaluatePrimitive;
  instructions: string;
  criteria?: unknown;
}>;

export type LocalEvaluateRequest = Readonly<{
  schemaVersion: typeof LOCAL_EVALUATE_SCHEMA_VERSION;
  state: unknown;
  questions: Readonly<Record<string, LocalEvaluateQuestion>>;
}>;

export type LocalEvaluateAnswer = Readonly<{
  type: LocalEvaluatePrimitive;
  choice?: string;
  score?: number;
  probability?: number;
  probabilities: Readonly<Record<string, number>>;
  confidence?: number;
  legend?: readonly string[];
}>;

export type LocalEvaluateResult = Readonly<{
  model: string;
  answers: Readonly<Record<string, LocalEvaluateAnswer>>;
  usage: Readonly<{ prompt_tokens: number }>;
  timings: Readonly<{ load_s: number; forward_s: number; question_count: number }>;
  calibrated: boolean;
}>;

export type LocalEvaluateRuntimeConfig = Readonly<{
  pythonPath: string;
  /** Model repo id or an absolute local snapshot path. */
  model: string;
  /** Absolute path to the repository-owned evaluator script. */
  scriptPath: string;
  timeoutMs: number;
  allowNetwork: boolean;
  chatTemplate: boolean;
  memoryLimitMb: number;
  calibrationPath?: string;
}>;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isLocalEvaluateRequest(payload: unknown): payload is LocalEvaluateRequest {
  if (!isRecord(payload)) {
    return false;
  }
  if (payload.schemaVersion !== LOCAL_EVALUATE_SCHEMA_VERSION) {
    return false;
  }
  const questions = payload.questions;
  if (!isRecord(questions) || Object.keys(questions).length === 0) {
    return false;
  }
  return Object.values(questions).every(
    (question) =>
      isRecord(question) &&
      typeof question.instructions === "string" &&
      (question.type === "choice" || question.type === "score" || question.type === "noul"),
  );
}

export function resolveLocalEvaluateRuntimeConfig(options: {
  model: string;
  scriptPath: string;
  pythonPath?: string;
  timeoutMs?: number;
  allowNetwork?: boolean;
  chatTemplate?: boolean;
  memoryLimitMb?: number;
  calibrationPath?: string;
}): LocalEvaluateRuntimeConfig {
  const model = options.model.trim();
  const scriptPath = options.scriptPath.trim();
  if (!model) {
    throw new Error("local evaluate adapter requires an explicit model");
  }
  if (!scriptPath) {
    throw new Error("local evaluate adapter requires an explicit script path");
  }
  const calibrationPath = options.calibrationPath?.trim();
  return Object.freeze({
    pythonPath: options.pythonPath?.trim() || DEFAULT_LOCAL_MODEL_PYTHON_PATH,
    model,
    scriptPath,
    timeoutMs: positiveInteger(options.timeoutMs, DEFAULT_LOCAL_EVALUATE_TIMEOUT_MS),
    allowNetwork: options.allowNetwork ?? process.env.LCX_LOCAL_MODEL_ALLOW_NETWORK === "1",
    chatTemplate: options.chatTemplate ?? false,
    memoryLimitMb: positiveInteger(options.memoryLimitMb, DEFAULT_LOCAL_EVALUATE_MEMORY_LIMIT_MB),
    ...(calibrationPath ? { calibrationPath } : {}),
  });
}

function terminateChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 750);
  killTimer.unref();
}

function runEvaluateScript(
  runtime: LocalEvaluateRuntimeConfig,
  request: LocalEvaluateRequest,
  signal: AbortSignal,
): Promise<{ value: LocalEvaluateResult; transportRequestId: string }> {
  return new Promise((resolve, reject) => {
    const args = ["--model", runtime.model];
    if (runtime.calibrationPath) {
      args.push("--calibration", runtime.calibrationPath);
    }
    if (runtime.chatTemplate) {
      args.push("--chat-template");
    }

    const child = spawn(
      runtime.pythonPath,
      buildLocalScriptCommand(runtime.scriptPath, args, runtime.memoryLimitMb),
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: buildLocalModelProcessEnv(process.env, {
          PYTHONUNBUFFERED: "1",
          HF_HUB_OFFLINE: runtime.allowNetwork ? (process.env.HF_HUB_OFFLINE ?? "0") : "1",
        }),
      },
    );
    const transportRequestId = `mlx_evaluate:${child.pid ?? "unknown"}:${randomUUID()}`;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (error?: Error, value?: LocalEvaluateResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal.removeEventListener("abort", onAbort);
      if (error) {
        terminateChild(child);
        reject(error);
        return;
      }
      if (value === undefined) {
        reject(new Error("local evaluate returned no value"));
        return;
      }
      resolve({ value, transportRequestId });
    };
    const onAbort = () => finish(new Error("local evaluate invocation aborted"));
    const onChunk = (target: "stdout" | "stderr", chunk: string) => {
      if (target === "stdout") {
        stdout += chunk;
        if (stdout.length > OUTPUT_LIMIT_BYTES) {
          finish(new ModelAdapterError("output_limit"));
        }
        return;
      }
      stderr += chunk;
      if (stderr.length > OUTPUT_LIMIT_BYTES) {
        finish(new ModelAdapterError("output_limit"));
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => onChunk("stdout", chunk));
    child.stderr.on("data", (chunk: string) => onChunk("stderr", chunk));
    child.once("error", () => finish(new ModelAdapterError("process_error")));
    child.stdin.on("error", () => undefined);
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();

    child.once("close", (code) => {
      if (code !== 0) {
        // Includes the slot lock rejecting a concurrent caller: the script
        // exits non-zero with `local_model_busy` on stderr.
        finish(new ModelAdapterError("process_error"));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as Partial<LocalEvaluateResult>;
        if (!parsed.answers) {
          finish(new ModelAdapterError("output_invalid"));
          return;
        }
        finish(undefined, parsed as LocalEvaluateResult);
      } catch {
        finish(new ModelAdapterError("output_invalid"));
      }
    });

    timer = setTimeout(() => finish(new ModelAdapterError("runtime_timeout")), runtime.timeoutMs);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

export async function evaluateLocal(
  runtime: LocalEvaluateRuntimeConfig,
  request: LocalEvaluateRequest,
  signal: AbortSignal,
): Promise<LocalEvaluateResult> {
  const { value } = await runEvaluateScript(runtime, request, signal);
  return value;
}

export function createLocalEvaluateAdapter(
  runtime: LocalEvaluateRuntimeConfig,
): LogicalAgentModelAdapter {
  const observations = new Map<string, { id: string }>();
  const adapterId = `mlx-local-evaluate-${randomUUID().slice(0, 8)}`;
  return Object.freeze({
    id: adapterId,
    provider: "mlx-local",
    modelId: runtime.model,
    mode: "adapter" as const,
    capabilities: Object.freeze(["local_evaluate", "local_model_inference"]),
    requiredTools: Object.freeze([]),
    requiredSideEffects: Object.freeze(["local_compute"] as const),
    invoke: async (request: ModelCallRequest, signal: AbortSignal) => {
      if (!isLocalEvaluateRequest(request.payload)) {
        throw new ModelAdapterError("output_invalid");
      }
      const result = await runEvaluateScript(runtime, request.payload, signal);
      observations.set(request.callId, { id: result.transportRequestId });
      return result.value;
    },
    observe: (request: Omit<ModelCallRequest, "payload">): ModelCallObservation | undefined => {
      const observed = observations.get(request.callId);
      if (!observed) {
        return undefined;
      }
      observations.delete(request.callId);
      const observation: ModelCallObservation = {
        callId: request.callId,
        provider: "mlx-local",
        modelId: runtime.model,
        transportRequestId: observed.id,
        kind: "model_inference",
      };
      return observation;
    },
  });
}
