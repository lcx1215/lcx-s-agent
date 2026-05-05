import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveOpenClawAgentDir } from "../../src/agents/agent-paths.js";
import { minimaxUnderstandImage } from "../../src/agents/minimax-vlm.js";
import { resolveApiKeyForProvider } from "../../src/agents/model-auth.js";
import { loadConfig } from "../../src/config/config.js";
import { normalizeSecretInput } from "../../src/utils/normalize-secret-input.js";

type Lane = "coding-plan-search" | "coding-plan-vlm";

type CliOptions = {
  lane: Lane | "all";
  write: boolean;
  mock: boolean;
  maxCalls?: number;
  durationMinutes: number;
  batchLimit: number;
  concurrency: number;
  timeoutSeconds: number;
  searchCount: number;
  apiHost: string;
  agentDir: string;
  logPath: string;
};

type CallResult = {
  lane: Lane;
  ok: boolean;
  promptId: string;
  durationMs: number;
  summary?: Record<string, unknown>;
  error?: string;
};

const HOME = process.env.HOME ?? os.homedir();
const DEFAULT_WORKSPACE = path.join(HOME, ".openclaw", "workspace");
const DEFAULT_LOG = path.join(
  DEFAULT_WORKSPACE,
  "logs",
  `minimax-provider-quota-saturator-${new Date().toISOString().slice(0, 10)}.jsonl`,
);
const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

const SEARCH_THEMES = [
  "MiniMax M2.7 coding agent tool use reliability",
  "OpenClaw agent workflow CLI observability",
  "financial research agent evidence verification",
  "quant portfolio risk control module design",
  "ETF regime timing research workflow",
  "agent memory artifact trace evaluation",
  "local model distillation planning packet",
  "multi model review hallucination reduction",
] as const;

const VLM_TASKS = [
  "Inspect this tiny generated image and return a strict JSON object with visible_content, uncertainty, and whether more visual context is required.",
  "Treat the image as a VLM smoke input for an agent tool. Return what can and cannot be inferred from it.",
  "Describe the image conservatively. If the image is too small to support claims, say so explicitly.",
  "Return a bounded visual understanding receipt: content, confidence, limitations, next_input_needed.",
] as const;

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/minimax-provider-quota-saturator.ts [--lane all|coding-plan-search|coding-plan-vlm] [--write] [--mock]",
      "",
      "Purpose:",
      "  Exercise MiniMax Coding Plan search and VLM quota lanes without writing language corpus or brain-training samples.",
      "",
      "Options:",
      "  --lane VALUE           all, coding-plan-search, or coding-plan-vlm; default all",
      "  --write                make provider calls and append receipts; default is dry-run",
      "  --mock                 write mock receipts without provider calls",
      "  --max-calls N          hard cap total attempts",
      "  --duration-minutes N   automatic run budget, default 285",
      "  --batch-limit N        attempts scheduled per round, default 12",
      "  --concurrency N        parallel provider calls, default 4",
      "  --timeout N            fetch timeout seconds, default 90",
      "  --search-count N       MiniMax search result count, default 5",
      "  --api-host URL         default https://api.minimax.io",
      "  --agent-dir DIR        OpenClaw agent dir for auth profiles",
      "  --log FILE             JSONL receipt log path",
    ].join("\n"),
  );
}

function readValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    usage();
  }
  return value;
}

function readPositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    usage();
  }
  return parsed;
}

function readLane(value: string): Lane | "all" {
  if (value === "all" || value === "coding-plan-search" || value === "coding-plan-vlm") {
    return value;
  }
  usage();
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    lane: "all",
    write: false,
    mock: false,
    durationMinutes: 285,
    batchLimit: 12,
    concurrency: 4,
    timeoutSeconds: 90,
    searchCount: 5,
    apiHost: process.env.MINIMAX_API_HOST?.trim() || "https://api.minimax.io",
    agentDir: resolveOpenClawAgentDir(),
    logPath: DEFAULT_LOG,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--lane") {
      options.lane = readLane(readValue(args, index));
      index += 1;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--mock") {
      options.mock = true;
    } else if (arg === "--max-calls") {
      options.maxCalls = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--duration-minutes") {
      options.durationMinutes = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--batch-limit") {
      options.batchLimit = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--concurrency") {
      options.concurrency = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--timeout") {
      options.timeoutSeconds = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--search-count") {
      options.searchCount = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--api-host") {
      options.apiHost = readValue(args, index).replace(/\/+$/u, "");
      index += 1;
    } else if (arg === "--agent-dir") {
      options.agentDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--log") {
      options.logPath = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  options.logPath = path.resolve(options.logPath);
  return options;
}

async function resolveCodingPlanKey(options: CliOptions): Promise<string> {
  const envKey = normalizeSecretInput(
    process.env.MINIMAX_CODE_PLAN_KEY?.trim() ||
      process.env.MINIMAX_CODING_API_KEY?.trim() ||
      process.env.MINIMAX_API_KEY?.trim() ||
      "",
  );
  if (envKey) {
    return envKey;
  }
  const cfg = loadConfig();
  for (const provider of ["minimax", "minimax-portal"] as const) {
    try {
      const resolved = await resolveApiKeyForProvider({
        provider,
        cfg,
        agentDir: options.agentDir,
      });
      if (resolved.apiKey) {
        return resolved.apiKey;
      }
    } catch {}
  }
  return "";
}

function endpoint(host: string, pathname: string): string {
  try {
    return new URL(pathname, host).toString();
  } catch {
    return new URL(pathname, "https://api.minimax.io").toString();
  }
}

function lanesFor(options: CliOptions, start: number, count: number): Lane[] {
  const selected: Lane[] =
    options.lane === "all" ? ["coding-plan-search", "coding-plan-vlm"] : [options.lane];
  return Array.from(
    { length: count },
    (_unused, offset) => selected[(start + offset) % selected.length],
  );
}

async function appendLog(logPath: string, payload: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`);
}

function isProviderLimitSignal(result: CallResult): boolean {
  const haystack = `${result.error ?? ""} ${JSON.stringify(result.summary ?? {})}`.toLowerCase();
  return [
    "429",
    "rate limit",
    "ratelimit",
    "quota",
    "insufficient",
    "too many requests",
    "usage limit",
    "resource_exhausted",
    "billing",
  ].some((needle) => haystack.includes(needle));
}

function searchQuery(index: number): string {
  const theme = SEARCH_THEMES[index % SEARCH_THEMES.length];
  return `${theme} reliable implementation notes ${String(index).padStart(5, "0")}`;
}

async function callMinimaxSearch(
  options: CliOptions,
  apiKey: string,
  index: number,
): Promise<CallResult> {
  const started = Date.now();
  const promptId = `search_${String(index).padStart(6, "0")}`;
  if (options.mock) {
    return {
      lane: "coding-plan-search",
      ok: true,
      promptId,
      durationMs: Date.now() - started,
      summary: { mock: true, query: searchQuery(index), results: 2 },
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutSeconds * 1000);
  try {
    const res = await fetch(endpoint(options.apiHost, "/v1/coding_plan/search"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "MM-API-Source": "OpenClaw",
      },
      body: JSON.stringify({
        q: searchQuery(index),
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        lane: "coding-plan-search",
        ok: false,
        promptId,
        durationMs: Date.now() - started,
        error: `MiniMax search failed (${res.status} ${res.statusText}): ${text.slice(0, 400)}`,
      };
    }
    const json = JSON.parse(text) as unknown;
    const resultCount = countSearchResults(json);
    return {
      lane: "coding-plan-search",
      ok: true,
      promptId,
      durationMs: Date.now() - started,
      summary: { query: searchQuery(index), resultCount },
    };
  } catch (error) {
    return {
      lane: "coding-plan-search",
      ok: false,
      promptId,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function countSearchResults(value: unknown): number {
  if (!value || typeof value !== "object") {
    return 0;
  }
  const record = value as Record<string, unknown>;
  const candidates = [
    record.results,
    record.search_results,
    record.web_results,
    (record.data as Record<string, unknown> | undefined)?.results,
    (record.data as Record<string, unknown> | undefined)?.search_results,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.length;
    }
  }
  return 0;
}

async function callMinimaxVlm(
  options: CliOptions,
  apiKey: string,
  index: number,
): Promise<CallResult> {
  const started = Date.now();
  const promptId = `vlm_${String(index).padStart(6, "0")}`;
  const prompt = `${VLM_TASKS[index % VLM_TASKS.length]} Receipt ${promptId}.`;
  if (options.mock) {
    return {
      lane: "coding-plan-vlm",
      ok: true,
      promptId,
      durationMs: Date.now() - started,
      summary: { mock: true, contentLength: 96 },
    };
  }
  try {
    const content = await minimaxUnderstandImage({
      apiKey,
      prompt,
      imageDataUrl: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      apiHost: options.apiHost,
    });
    return {
      lane: "coding-plan-vlm",
      ok: true,
      promptId,
      durationMs: Date.now() - started,
      summary: { contentLength: content.length },
    };
  } catch (error) {
    return {
      lane: "coding-plan-vlm",
      ok: false,
      promptId,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const options = parseArgs(process.argv.slice(2));
const targetCalls = options.maxCalls ?? 1_000_000;
const deadline = Date.now() + options.durationMinutes * 60_000;
const plan = {
  ok: true,
  mode: options.write ? "execute" : "dry_run",
  boundary: "provider_quota_receipts_only",
  lane: options.lane,
  targetCalls,
  batchLimit: options.batchLimit,
  concurrency: options.concurrency,
  durationMinutes: options.durationMinutes,
  apiHost: options.apiHost,
  agentDir: options.agentDir,
  mock: options.mock,
  logPath: options.logPath,
  keyEnvOrder: ["MINIMAX_CODE_PLAN_KEY", "MINIMAX_CODING_API_KEY", "MINIMAX_API_KEY"],
  authProfileProviderFallbacks: ["minimax", "minimax-portal"],
  notTouched: [
    "live_sender",
    "provider_config",
    "protected_repo_memory",
    "formal_lark_routing_corpus",
    "brain_distillation_training_samples",
    "finance_doctrine",
  ],
};

if (!options.write) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(0);
}

const apiKey = await resolveCodingPlanKey(options);
if (!apiKey && !options.mock) {
  throw new Error(
    "MiniMax Coding Plan key required. Set MINIMAX_CODE_PLAN_KEY, MINIMAX_CODING_API_KEY, MINIMAX_API_KEY, or configure a MiniMax auth profile.",
  );
}

await appendLog(options.logPath, { event: "provider_quota_saturator_start", plan });

let attempted = 0;
let succeeded = 0;
let failed = 0;
let completedRounds = 0;
let stopReason = "target_calls_reached";

for (let round = 1; attempted < targetCalls && Date.now() < deadline; round += 1) {
  const remaining = targetCalls - attempted;
  const batchSize = Math.min(options.batchLimit, remaining);
  const laneBatch = lanesFor(options, attempted, batchSize);
  process.stdout.write(
    `\n[minimax-provider-quota] round=${round} attempted=${attempted} batch=${batchSize}\n`,
  );

  const results = await runWithConcurrency(laneBatch, options.concurrency, async (lane, offset) => {
    const index = attempted + offset;
    return lane === "coding-plan-search"
      ? await callMinimaxSearch(options, apiKey, index)
      : await callMinimaxVlm(options, apiKey, index);
  });

  for (const result of results) {
    await appendLog(options.logPath, { event: result.ok ? "call_ok" : "call_failed", ...result });
    if (result.ok) {
      succeeded += 1;
    } else {
      failed += 1;
      if (isProviderLimitSignal(result)) {
        stopReason = "provider_quota_or_rate_limit";
      }
    }
  }

  attempted += batchSize;
  completedRounds = round;
  process.stdout.write(`${JSON.stringify({ round, succeeded, failed, stopReason }, null, 2)}\n`);
  if (stopReason === "provider_quota_or_rate_limit") {
    break;
  }
}

const finalStopReason = Date.now() >= deadline ? "duration_deadline" : stopReason;
const result = {
  ok: failed === 0 || finalStopReason === "provider_quota_or_rate_limit",
  attempted,
  succeeded,
  failed,
  completedRounds,
  stopReason: finalStopReason,
  logPath: options.logPath,
  liveTouched: false,
  providerConfigTouched: false,
  corpusTouched: false,
  brainTrainingSamplesTouched: false,
};
await appendLog(options.logPath, { event: "provider_quota_saturator_complete", ...result });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
