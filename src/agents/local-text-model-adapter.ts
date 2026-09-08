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
  const candidates: Record<string, unknown>[] = [];
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
              candidates.push(parsed as Record<string, unknown>);
            }
          } catch {
            // Keep searching; model runtimes may emit a short prefix before JSON.
          }
          break;
        }
      }
    }
  }
  const withKind = candidates.find((candidate) => typeof candidate.kind === "string");
  if (withKind) {
    return withKind;
  }
  const declaredKind = trimmed.match(/"kind"\s*:\s*"(plan|review|artifact)"/u)?.[1];
  if (declaredKind === "plan") {
    const plan = candidates.find(
      (candidate) => "requirements" in candidate && "missingEvidence" in candidate,
    );
    if (plan) {
      return {
        kind: "plan",
        requirements: plan.requirements,
        missingEvidence: plan.missingEvidence,
      };
    }
  }
  if (declaredKind === "review") {
    const review = candidates.find(
      (candidate) =>
        "verdict" in candidate && "criticalFindings" in candidate && "evidenceGaps" in candidate,
    );
    if (review) {
      return { kind: "review", review };
    }
  }
  if (declaredKind === "artifact") {
    const artifact = candidates.find((candidate) => "answer" in candidate && "claims" in candidate);
    if (artifact) {
      return { kind: "artifact", artifact };
    }
  }
  if (candidates[0]) {
    return candidates[0];
  }
  throw new Error("local text model output did not contain a JSON object");
}

function clipPromptText(value: string, maxLength: number): string {
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}…`;
}

function compactPromptValue(value: unknown, depth = 0): unknown {
  if (depth >= 4) {
    return typeof value === "string" ? clipPromptText(value, 240) : "[bounded]";
  }
  if (typeof value === "string") {
    return clipPromptText(value, 1_200);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((entry) => compactPromptValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 16)
        .map(([key, entry]) => [key, compactPromptValue(entry, depth + 1)]),
    );
  }
  return typeof value === "bigint"
    ? value.toString()
    : typeof value === "symbol"
      ? (value.description ?? "symbol")
      : "[unsupported]";
}

function compactQualityEvidence(request: QualityHarnessModelRequest) {
  return request.evidence.slice(0, 8).map((entry) => ({
    id: entry.id,
    text: clipPromptText(entry.text, 500),
    ...(entry.source === undefined ? {} : { source: clipPromptText(entry.source, 300) }),
  }));
}

function compactQualityDependencies(request: QualityHarnessModelRequest) {
  return Object.fromEntries(
    Object.entries(request.dependencyOutputs)
      .slice(0, 10)
      .map(([taskId, output]) => [taskId, compactPromptValue(output)]),
  );
}

function formatPromptSectionValue(value: unknown, depth = 0): string {
  const compact = compactPromptValue(value, depth);
  if (compact === null || typeof compact === "number" || typeof compact === "boolean") {
    return String(compact);
  }
  if (typeof compact === "string") {
    return compact;
  }
  if (Array.isArray(compact)) {
    return compact.map((entry) => formatPromptSectionValue(entry, depth + 1)).join("; ");
  }
  if (compact === undefined || compact === null || typeof compact !== "object") {
    return typeof compact === "bigint"
      ? compact.toString()
      : typeof compact === "symbol"
        ? (compact.description ?? "symbol")
        : "[unsupported]";
  }
  return Object.entries(compact)
    .map(([key, entry]) => `${key}=${formatPromptSectionValue(entry, depth + 1)}`)
    .join("; ");
}

function qualityStageContract(stage: QualityHarnessModelRequest["stage"]): string {
  if (stage === "intake") {
    return '{"kind":"plan","requirements":[],"missingEvidence":[]}';
  }
  if (stage === "draft" || stage === "format") {
    return '{"kind":"artifact","artifact":{"answer":"bounded answer","claims":[{"id":"claim-1","text":"supported claim","status":"supported","evidenceIds":["evidence-id"]}]}}';
  }
  return '{"kind":"review","review":{"verdict":"pass","criticalFindings":[],"evidenceGaps":[],"notes":[]}}';
}

export function buildQualityHarnessModelPrompt(request: QualityHarnessModelRequest): string {
  const contractExample = qualityStageContract(request.stage);
  const evidence = compactQualityEvidence(request);
  const dependencyOutputs = compactQualityDependencies(request);
  const repairFeedback = request.repairFeedback
    .slice(0, 8)
    .map((item) => clipPromptText(item, 300));
  const evidenceSection = clipPromptText(
    evidence
      .map((entry) => `[${entry.id}] ${entry.text}${entry.source ? ` (${entry.source})` : ""}`)
      .join(" | "),
    1_800,
  );
  const needsDependencies = [
    "risk",
    "exposure",
    "draft",
    "adversarial",
    "format",
    "precheck",
  ].includes(request.stage);
  const sections = [
    "LCX quality stage. Use the supplied evidence only.",
    `stage=${request.stage}; agent=${request.agentId}`,
    `task=${clipPromptText(request.task, 1_200)}`,
    `evidence=${evidenceSection}`,
    ...(needsDependencies
      ? [`previous=${clipPromptText(formatPromptSectionValue(dependencyOutputs), 600) || "none"}`]
      : []),
    ...(repairFeedback.length > 0
      ? [`repair=${clipPromptText(formatPromptSectionValue(repairFeedback), 600)}`]
      : []),
    `Return only one JSON object. Exact schema: ${contractExample}`,
  ];
  return sections.join("\n");
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
