import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  LogicalAgentModelAdapter,
  ModelCallObservation,
  ModelCallRequest,
} from "./logical-agent-model-router.js";
import type { QualityHarnessModelRequest } from "./quality-harness-contract.js";

export const LOCAL_TEXT_MODEL_PROVIDER = "mlx-local" as const;
export const DEFAULT_LOCAL_TEXT_MODEL = "Qwen/Qwen3-0.6B" as const;
export const DEFAULT_LOCAL_TEXT_MODEL_MAX_TOKENS = 384;
export const DEFAULT_LOCAL_TEXT_MODEL_TIMEOUT_MS = 120_000;

export type LocalRoleShadowRequest = Readonly<{
  schemaVersion: "lcx_local_role_shadow_v1";
  runId: string;
  taskId: string;
  role: string;
  purpose: string;
  ask: string;
  evidence: readonly string[];
  dependencyOutputs: Readonly<Record<string, unknown>>;
}>;

export type LocalTextModelRuntimeConfig = Readonly<{
  pythonPath: string;
  modelId: string;
  adapterPath: string;
  maxTokens: number;
  timeoutMs: number;
  allowNetwork: boolean;
}>;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

export function resolveLocalTextModelRuntimeConfig(options: {
  adapterPath: string;
  modelId?: string;
  pythonPath?: string;
  maxTokens?: number;
  timeoutMs?: number;
  allowNetwork?: boolean;
}): LocalTextModelRuntimeConfig {
  const adapterPath = options.adapterPath.trim();
  if (!adapterPath) {
    throw new Error("local text model adapter requires an explicit adapter path");
  }
  return Object.freeze({
    pythonPath:
      options.pythonPath?.trim() ||
      path.join(os.homedir(), ".openclaw", "local-brain-trainer", ".venv", "bin", "python"),
    modelId: options.modelId?.trim() || DEFAULT_LOCAL_TEXT_MODEL,
    adapterPath,
    maxTokens: positiveInteger(options.maxTokens, DEFAULT_LOCAL_TEXT_MODEL_MAX_TOKENS),
    timeoutMs: positiveInteger(options.timeoutMs, DEFAULT_LOCAL_TEXT_MODEL_TIMEOUT_MS),
    allowNetwork: options.allowNetwork ?? process.env.LCX_LOCAL_MODEL_ALLOW_NETWORK === "1",
  });
}

function appendOutput(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length > 2_000_000) {
    throw new Error("local text model output exceeded the bounded capture size");
  }
  return next;
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

export function parseLocalModelJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  for (let searchFrom = 0; searchFrom < trimmed.length; searchFrom += 1) {
    const start = trimmed.indexOf("{", searchFrom);
    if (start < 0) {
      break;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = inString;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(trimmed.slice(start, index + 1)) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              return parsed as Record<string, unknown>;
            }
          } catch {
            // Keep searching; model runtimes may emit a short prefix before JSON.
          }
          break;
        }
      }
    }
  }
  throw new Error("local text model output did not contain a JSON object");
}

export function buildQualityHarnessModelPrompt(request: QualityHarnessModelRequest): string {
  const contractExample =
    request.stage === "intake"
      ? '{"kind":"plan","requirements":[],"missingEvidence":[]}'
      : request.stage === "draft" || request.stage === "format"
        ? '{"kind":"artifact","artifact":{"answer":"bounded answer","claims":[{"id":"claim-1","text":"supported claim","status":"supported","evidenceIds":["operator-input"]}]}}'
        : '{"kind":"review","review":{"verdict":"pass","criticalFindings":[],"evidenceGaps":[],"notes":[]}}';
  return [
    "You are a bounded LCX local model adapter.",
    "Return exactly one valid JSON object and no markdown, commentary, or think trace.",
    "Follow the requested stage contract exactly. Do not invent facts or current data.",
    `stage=${request.stage}`,
    `agent_id=${request.agentId}`,
    `task=${request.task}`,
    `instructions=${request.instructions}`,
    `exact_shape_example=${contractExample}`,
    "Use the exact top-level kind and nested field names from the example; empty arrays are valid.",
    `evidence=${JSON.stringify(request.evidence)}`,
    `shared_context=${JSON.stringify(request.sharedContext)}`,
    `dependency_outputs=${JSON.stringify(request.dependencyOutputs)}`,
    `repair_feedback=${JSON.stringify(request.repairFeedback)}`,
  ].join("\n");
}

export function buildLocalRoleShadowPrompt(request: LocalRoleShadowRequest): string {
  return [
    "You are the LCX Agent local auxiliary thought-flow model.",
    "Produce a compact planning packet for the assigned role; do not answer the user directly.",
    "/no_think",
    "Return only one valid JSON object, with no markdown, commentary, or think trace.",
    'Use this exact shape: {"task_family":"snake_case","primary_modules":[],"supporting_modules":[],"required_tools":[],"missing_data":[],"risk_boundaries":["research_only"],"next_step":"snake_case_action","rejected_context":["old_external_conversation_history"]}',
    "Do not invent current data, trade authority, external messages, or durable memory writes.",
    `role=${request.role}`,
    `purpose=${request.purpose}`,
    `task=${request.ask}`,
    `evidence=${JSON.stringify(request.evidence)}`,
    `dependency_outputs=${JSON.stringify(request.dependencyOutputs)}`,
  ].join("\n");
}

async function runMlxGenerate(
  runtime: LocalTextModelRuntimeConfig,
  prompt: string,
  signal: AbortSignal,
): Promise<{ value: Record<string, unknown>; transportRequestId: string }> {
  return new Promise((resolve, reject) => {
    const args = [
      "-m",
      "mlx_lm",
      "generate",
      "--model",
      runtime.modelId,
      "--adapter-path",
      runtime.adapterPath,
      "--prompt",
      prompt,
      "--max-tokens",
      String(runtime.maxTokens),
      "--temp",
      "0",
      "--verbose",
      "false",
      "--chat-template-config",
      '{"enable_thinking":false}',
    ];
    const child = spawn(runtime.pythonPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        HF_HUB_OFFLINE: runtime.allowNetwork ? (process.env.HF_HUB_OFFLINE ?? "0") : "1",
      },
    });
    const transportRequestId = `mlx_lm:${child.pid ?? "unknown"}:${randomUUID()}`;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (error?: Error, value?: Record<string, unknown>) => {
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
        reject(new Error("local text model returned no value"));
        return;
      }
      resolve({ value, transportRequestId });
    };
    const onAbort = () => finish(new Error("local text model invocation aborted"));
    const onChunk = (target: "stdout" | "stderr", chunk: string) => {
      try {
        if (target === "stdout") {
          stdout = appendOutput(stdout, chunk);
        } else {
          stderr = appendOutput(stderr, chunk);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error("local text model output overflow"));
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => onChunk("stdout", chunk));
    child.stderr.on("data", (chunk: string) => onChunk("stderr", chunk));
    child.once("error", (error) =>
      finish(new Error(`local text model process error: ${error.name}`)),
    );
    child.once("close", (code, signalName) => {
      if (code !== 0) {
        finish(
          new Error(
            `local text model exited unsuccessfully: code=${code ?? "none"}, signal=${signalName ?? "none"}, stderr=${stderr.slice(-400)}`,
          ),
        );
        return;
      }
      try {
        finish(undefined, parseLocalModelJson(stdout));
      } catch (error) {
        finish(error instanceof Error ? error : new Error("local text model JSON parse failed"));
      }
    });
    timer = setTimeout(
      () => finish(new Error("local text model invocation timed out")),
      runtime.timeoutMs,
    );
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

function createLocalTextModelAdapter(
  runtime: LocalTextModelRuntimeConfig,
  options: {
    idPrefix: string;
    capabilities: readonly string[];
    buildPrompt: (payload: unknown) => string;
  },
): LogicalAgentModelAdapter {
  const observations = new Map<string, string>();
  const adapterId = `${options.idPrefix}-${randomUUID().slice(0, 8)}`;
  return Object.freeze({
    id: adapterId,
    provider: LOCAL_TEXT_MODEL_PROVIDER,
    modelId: runtime.modelId,
    mode: "adapter" as const,
    capabilities: Object.freeze([...options.capabilities]),
    requiredTools: Object.freeze([]),
    requiredSideEffects: Object.freeze(["local_compute"] as const),
    invoke: async (request: ModelCallRequest, signal: AbortSignal) => {
      const prompt = options.buildPrompt(request.payload);
      const result = await runMlxGenerate(runtime, prompt, signal);
      observations.set(request.callId, result.transportRequestId);
      return result.value;
    },
    observe: (request: Omit<ModelCallRequest, "payload">): ModelCallObservation | undefined => {
      const transportRequestId = observations.get(request.callId);
      if (!transportRequestId) {
        return undefined;
      }
      observations.delete(request.callId);
      return {
        callId: request.callId,
        provider: LOCAL_TEXT_MODEL_PROVIDER,
        modelId: runtime.modelId,
        transportRequestId,
        kind: "model_inference",
      };
    },
  });
}

export function createLocalQualityHarnessAdapter(
  runtime: LocalTextModelRuntimeConfig,
): LogicalAgentModelAdapter {
  return createLocalTextModelAdapter(runtime, {
    idPrefix: "mlx-local-qwen-quality",
    capabilities: ["quality_harness", "local_model_inference"],
    buildPrompt: (payload) => buildQualityHarnessModelPrompt(payload as QualityHarnessModelRequest),
  });
}

export function createLocalRoleShadowAdapter(
  runtime: LocalTextModelRuntimeConfig,
): LogicalAgentModelAdapter {
  return createLocalTextModelAdapter(runtime, {
    idPrefix: "mlx-local-qwen-role",
    capabilities: ["logical_agent_role_shadow", "local_model_inference"],
    buildPrompt: (payload) => buildLocalRoleShadowPrompt(payload as LocalRoleShadowRequest),
  });
}
