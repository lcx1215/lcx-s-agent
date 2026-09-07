import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LOCAL_VISION_PROVIDER = "mlx-vlm" as const;
export const LOCAL_VISION_MODEL_REF = `${LOCAL_VISION_PROVIDER}/local` as const;
/**
 * Quality-first profile proven on the current M3/8 GB host. Keep the model id
 * replaceable: the adapter is the authority for routing, not the weights.
 */
export const DEFAULT_LOCAL_VISION_MODEL = "mlx-community/Qwen3-VL-4B-Instruct-4bit" as const;
/** Smaller profile for constrained hosts or an explicit operator override. */
export const LOW_MEMORY_LOCAL_VISION_MODEL = "mlx-community/Qwen3-VL-2B-Instruct-3bit" as const;
export const DEFAULT_LOCAL_VISION_TIMEOUT_MS = 180_000;
export const DEFAULT_LOCAL_VISION_MAX_TOKENS = 512;

export type LocalVisionModelProfile = {
  id: string;
  family: "Qwen3-VL";
  quantization: "3bit" | "4bit";
  approximateWeightGb?: number;
  role: "quality_default" | "low_memory_fallback" | "larger_host_candidate";
};

/**
 * The local candidate registry is deliberately small and evidence-bounded.
 * It records selectable profiles without turning a model into a second
 * runtime authority. Promotion still requires a real local smoke/eval.
 */
export const LOCAL_VISION_MODEL_PROFILES: readonly LocalVisionModelProfile[] = Object.freeze([
  {
    id: DEFAULT_LOCAL_VISION_MODEL,
    family: "Qwen3-VL",
    quantization: "4bit",
    approximateWeightGb: 3.09,
    role: "quality_default",
  },
  {
    id: LOW_MEMORY_LOCAL_VISION_MODEL,
    family: "Qwen3-VL",
    quantization: "3bit",
    approximateWeightGb: 1.58,
    role: "low_memory_fallback",
  },
  {
    id: "mlx-community/Qwen3-VL-8B-Instruct-4bit",
    family: "Qwen3-VL",
    quantization: "4bit",
    role: "larger_host_candidate",
  },
]);

export type LocalVisionRuntimeConfig = {
  enabled: boolean;
  pythonPath: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
};

type Environment = Record<string, string | undefined>;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isTruthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function defaultPythonPath(): string {
  return path.join(os.homedir(), ".openclaw", "local-brain-trainer", ".venv", "bin", "python");
}

function rejectCloudLocalVisionRuntime(): void {
  if (isTruthy(process.env.LCX_CLOUD_RUNTIME) && process.platform !== "darwin") {
    throw new Error(
      "mlx-vlm/local is a Mac-local vision adapter and is unavailable in the cloud runtime; configure a hosted or GPU vision model",
    );
  }
}

export function resolveLocalVisionRuntimeConfig(
  env: Environment = process.env,
): LocalVisionRuntimeConfig {
  return {
    enabled: isTruthy(env.LCX_LOCAL_VISION_ENABLED),
    pythonPath: env.LCX_LOCAL_VISION_PYTHON?.trim() || defaultPythonPath(),
    model: env.LCX_LOCAL_VISION_MODEL?.trim() || DEFAULT_LOCAL_VISION_MODEL,
    timeoutMs: positiveInteger(env.LCX_LOCAL_VISION_TIMEOUT_MS, DEFAULT_LOCAL_VISION_TIMEOUT_MS),
    maxTokens: positiveInteger(env.LCX_LOCAL_VISION_MAX_TOKENS, DEFAULT_LOCAL_VISION_MAX_TOKENS),
  };
}

export function isLocalVisionModelRef(modelRef: string | undefined): boolean {
  const normalized = (modelRef ?? "").trim().toLowerCase();
  return (
    normalized === LOCAL_VISION_MODEL_REF || normalized.startsWith(`${LOCAL_VISION_PROVIDER}/`)
  );
}

export function resolveLocalVisionModelId(
  modelId: string | undefined,
  env: Environment = process.env,
): string {
  const normalized = modelId?.trim();
  if (
    !normalized ||
    normalized.toLowerCase() === "local" ||
    normalized.toLowerCase() === "default"
  ) {
    return env.LCX_LOCAL_VISION_MODEL?.trim() || DEFAULT_LOCAL_VISION_MODEL;
  }
  return normalized;
}

function imageSuffix(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".png";
  }
}

function describeProcessError(error: unknown, stderr?: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const detail = stderr?.trim();
  return new Error(detail ? `${message}: ${detail.slice(-1200)}` : message);
}

function repetitionKey(segment: string): string {
  return segment
    .replace(/^\s*[-*]?\s*\d+[.)]?\s*/u, "")
    .replace(/\d+(?:\.\d+)?/gu, "#")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

const REPETITION_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "by",
  "for",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "with",
]);

function semanticTokens(segment: string): Set<string> {
  return new Set(
    (segment.toLowerCase().match(/[a-z0-9\u4e00-\u9fff]+/gu) ?? []).filter(
      (token) => !REPETITION_STOP_WORDS.has(token),
    ),
  );
}

function tokenSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (left.size + right.size - intersection);
}

export function collapseRepeatedVisionText(text: string): string {
  const segments = text
    .split(/\r?\n|(?<=[.!?。！？])\s+(?=\D)/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const kept: string[] = [];
  const keptSemanticTokens: Set<string>[] = [];
  let previousKey = "";
  for (const segment of segments) {
    const key = repetitionKey(segment);
    const tokens = semanticTokens(segment);
    if (
      (key && key === previousKey) ||
      (tokens.size >= 8 &&
        keptSemanticTokens.some((previous) => tokenSimilarity(tokens, previous) >= 0.72))
    ) {
      continue;
    }
    kept.push(segment);
    keptSemanticTokens.push(tokens);
    previousKey = key;
  }
  return kept.join(" ").trim();
}

export async function runLocalVisionVlm(params: {
  images: Array<{ base64: string; mimeType: string }>;
  prompt: string;
  modelId?: string;
  pythonPath?: string;
  timeoutMs?: number;
  maxTokens?: number;
}): Promise<{ text: string; model: string; pythonPath: string }> {
  rejectCloudLocalVisionRuntime();
  if (params.images.length === 0) {
    throw new Error("local vision requires at least one image");
  }
  if (!params.prompt.trim()) {
    throw new Error("local vision requires a non-empty prompt");
  }

  const runtime = resolveLocalVisionRuntimeConfig();
  const model = resolveLocalVisionModelId(params.modelId);
  const pythonPath = params.pythonPath?.trim() || runtime.pythonPath;
  const timeoutMs = params.timeoutMs ?? runtime.timeoutMs;
  const maxTokens = params.maxTokens ?? runtime.maxTokens;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-local-vision-"));

  try {
    const imagePaths: string[] = [];
    for (const [index, image] of params.images.entries()) {
      const base64 = image.base64.trim();
      if (!base64) {
        throw new Error(`local vision image ${index + 1} is empty`);
      }
      const imagePath = path.join(tempDir, `input-${index + 1}${imageSuffix(image.mimeType)}`);
      await fs.writeFile(imagePath, Buffer.from(base64, "base64"));
      imagePaths.push(imagePath);
    }

    const args = [
      "-m",
      "mlx_vlm",
      "generate",
      "--model",
      model,
      "--image",
      ...imagePaths,
      "--prompt",
      params.prompt,
      "--output-modality",
      "text",
      "--max-tokens",
      String(maxTokens),
      "--temperature",
      "0",
      "--no-verbose",
    ];
    let stdout = "";
    try {
      const result = await execFileAsync(pythonPath, args, {
        cwd: tempDir,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (error) {
      const stderr =
        error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
      throw describeProcessError(error, stderr);
    }

    const text = collapseRepeatedVisionText(stdout.trim());
    if (!text) {
      throw new Error(`local vision returned no text (${model})`);
    }
    return { text, model, pythonPath };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
