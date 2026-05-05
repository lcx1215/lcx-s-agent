import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildLarkBrainDistillationCandidate,
  LARK_BRAIN_DISTILLATION_REVIEW_DIR,
  type LarkBrainDistillationCandidate,
  type LarkBrainDistillationReviewArtifact,
} from "../../extensions/feishu/src/lark-brain-distillation-candidates.js";
import { resolveOpenClawAgentDir } from "../../src/agents/agent-paths.js";
import { resolveApiKeyForProvider } from "../../src/agents/model-auth.js";
import { loadConfig } from "../../src/config/config.js";

type CliOptions = {
  workspaceDir: string;
  write: boolean;
  json: boolean;
  mock: boolean;
  model: string;
  baseUrl: string;
  apiKey?: string;
  agentDir: string;
  source: "openclaw-agent" | "direct-api";
  openclawAgent: string;
  timeoutSeconds: number;
  limit: number;
  allowPartialWrite: boolean;
  retries: number;
  includePayloadUnstablePrompts: boolean;
  promptFile?: string;
  concurrency: number;
};

type TeacherPrompt = {
  id: string;
  userMessage: string;
  sourceSummary: string;
};

type TeacherPlan = {
  task_family: string;
  primary_modules: string[];
  supporting_modules: string[];
  required_tools: string[];
  missing_data: string[];
  risk_boundaries: string[];
  next_step: string;
  rejected_context: string[];
};

const DEFAULT_WORKSPACE = path.join(process.env.HOME ?? ".", ".openclaw", "workspace");
const DEFAULT_MODEL = process.env.MINIMAX_TEACHER_MODEL?.trim() || "MiniMax-M2.7";
const DEFAULT_BASE_URL =
  process.env.MINIMAX_ANTHROPIC_BASE_URL?.trim() || "https://api.minimax.io/anthropic";

const MODULE_TAXONOMY = [
  "macro_rates_inflation",
  "credit_liquidity",
  "etf_regime",
  "company_fundamentals_value",
  "quant_math",
  "portfolio_risk_gates",
  "causal_map",
  "finance_learning_memory",
  "source_registry",
  "review_panel",
  "control_room_summary",
  "ops_audit",
];

const TEACHER_PROMPTS: TeacherPrompt[] = [
  {
    id: "multi_asset_macro_portfolio_risk",
    userMessage:
      "我持有 QQQ、TLT、NVDA，未来两周担心利率、AI capex、美元流动性，先拆内部模块，不要给交易建议。",
    sourceSummary: "portfolio risk planning; no live data supplied; no execution authority.",
  },
  {
    id: "portfolio_math_missing_inputs",
    userMessage:
      "我有 QQQ、TLT、NVDA 三个仓位，想算波动、相关性、回撤和利率敏感性，但我还没给权重和价格序列。先拆模块，不要靠模型胡算。",
    sourceSummary: "quant math planning with missing weights and return series.",
  },
  {
    id: "external_source_missing",
    userMessage: "去学习这篇金融论文并沉淀成规则，但我还没给链接或本地文件。",
    sourceSummary: "external learning request without URL or local path.",
  },
  {
    id: "coverage_honesty",
    userMessage:
      "从 Google Scholar、SSRN 和 NBER 学一批前沿量化论文，但要标清实际读过哪些材料，不要说全覆盖。",
    sourceSummary: "scholarly learning request that must not claim exhaustive coverage.",
  },
  {
    id: "context_reset",
    userMessage: "清除上下文，换个题，从头开始。",
    sourceSummary: "fresh-start request; reject old Lark history.",
  },
  {
    id: "ambiguous_repeat",
    userMessage: "重新来一遍。",
    sourceSummary: "ambiguous repeat without current subject.",
  },
  {
    id: "lark_context_pollution",
    userMessage: "它刚才又像串到旧任务了，先审计是不是 Lark 上下文污染，不要继续金融分析。",
    sourceSummary: "ops audit request; not a finance research task.",
  },
  {
    id: "single_company_portfolio_transmission",
    userMessage:
      "只研究 NVDA 基本面风险：AI capex、收入质量、估值、客户集中度、对科技仓的传导，不要给买卖建议。",
    sourceSummary: "single-company fundamentals with portfolio transmission.",
  },
  {
    id: "factor_timing_overfit_guard",
    userMessage: "学一个因子择时策略，但不要给我回测神话，要说过拟合、样本外和失效条件。",
    sourceSummary: "factor timing learning with overfit and out-of-sample discipline.",
  },
  {
    id: "source_grounding_audit",
    userMessage:
      "你刚才纳斯达克那句话哪来的，给我 artifact、source 或 receipt，没有就标 unverified。",
    sourceSummary: "claim grounding audit before visible answer.",
  },
  {
    id: "local_math_then_review",
    userMessage:
      "如果本地数学模块算出来一个组合风险结论，再让三个大模型审阅，最后给我一个能看的回答。",
    sourceSummary: "local calculation plus model review orchestration request.",
  },
  {
    id: "human_brain_finance_decomposition",
    userMessage:
      "教本地大脑像正常人类分析师一样拆分复杂金融任务：先理解目标，再调本地记忆和已学规则，再按宏观、流动性、基本面、数学、风险门和审阅拆步骤，不要直接给交易建议。",
    sourceSummary:
      "teach local brain human-like complex finance task decomposition with memory activation and review handoff.",
  },
  {
    id: "daily_learning_automation",
    userMessage: "这些学习和复盘应该每次对话都自动发生，不要等我每天手动下命令。",
    sourceSummary: "automation loop planning without live sender changes.",
  },
];

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/minimax-brain-teacher-batch.ts [--write] [--json] [--mock] [--limit N] [--agent-dir DIR] [--direct-api] [--prompt-file FILE] [--concurrency N]",
      "",
      "Uses MiniMax M2.7 as a teacher to produce reviewed brain-distillation samples.",
      "Requires MINIMAX_API_KEY unless --mock is used.",
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

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    workspaceDir: DEFAULT_WORKSPACE,
    write: false,
    json: false,
    mock: false,
    model: DEFAULT_MODEL,
    baseUrl: DEFAULT_BASE_URL,
    apiKey: process.env.MINIMAX_API_KEY?.trim() || undefined,
    agentDir: resolveOpenClawAgentDir(),
    source: "openclaw-agent",
    openclawAgent: "research-minimax",
    timeoutSeconds: 600,
    limit: TEACHER_PROMPTS.length,
    allowPartialWrite: false,
    retries: 1,
    includePayloadUnstablePrompts: false,
    concurrency: 1,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workspace") {
      options.workspaceDir = readValue(args, index);
      index += 1;
    } else if (arg === "--agent-dir") {
      options.agentDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--mock") {
      options.mock = true;
    } else if (arg === "--model") {
      options.model = readValue(args, index);
      index += 1;
    } else if (arg === "--direct-api") {
      options.source = "direct-api";
    } else if (arg === "--openclaw-agent") {
      options.openclawAgent = readValue(args, index);
      index += 1;
    } else if (arg === "--timeout") {
      options.timeoutSeconds = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--base-url") {
      options.baseUrl = readValue(args, index).replace(/\/+$/u, "");
      index += 1;
    } else if (arg === "--limit") {
      options.limit = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--allow-partial-write") {
      options.allowPartialWrite = true;
    } else if (arg === "--retries") {
      options.retries = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (
      arg === "--include-unstable-short-prompts" ||
      arg === "--include-payload-unstable-prompts"
    ) {
      options.includePayloadUnstablePrompts = true;
    } else if (arg === "--prompt-file") {
      options.promptFile = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--concurrency") {
      options.concurrency = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  options.workspaceDir = path.resolve(options.workspaceDir);
  return options;
}

function buildPrompt(input: TeacherPrompt): string {
  return [
    "You are MiniMax M2.7 acting as LCX Agent's teacher for local brain distillation.",
    "Return one strict JSON object and no prose.",
    "Do not answer the finance question. Produce a planning packet for the local agent brain.",
    "The local brain should behave like a careful human analyst: clarify the objective, recall local memory and learned rules, split the problem into causal finance layers, identify missing evidence, then hand hard reasoning to review models.",
    "Use only these module ids:",
    MODULE_TAXONOMY.join(", "),
    "Required JSON keys: task_family, primary_modules, supporting_modules, required_tools, missing_data, risk_boundaries, next_step, rejected_context.",
    "Rules:",
    "- research only; no execution authority",
    "- missing source must include source_url_or_local_source_path",
    "- missing portfolio math inputs must include position_weights_and_return_series",
    "- ambiguous repeat must ask for current_subject_or_original_request and reject old_lark_conversation_history",
    "- ops audit must not become finance analysis",
    "- complex finance decomposition must include finance_learning_memory, source_registry, causal_map, portfolio_risk_gates, review_panel, and control_room_summary",
    "- next_step should describe a human-like sequence: clarify objective, recall memory, decompose finance layers, gather evidence, run review, then summarize",
    "",
    `user_message: ${input.userMessage}`,
    `source_summary: ${input.sourceSummary}`,
  ].join("\n");
}

function isTeacherPrompt(value: unknown): value is TeacherPrompt {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<Record<keyof TeacherPrompt, unknown>>;
  return (
    typeof record.id === "string" &&
    record.id.trim().length > 0 &&
    typeof record.userMessage === "string" &&
    record.userMessage.trim().length > 0 &&
    typeof record.sourceSummary === "string" &&
    record.sourceSummary.trim().length > 0
  );
}

async function loadTeacherPrompts(options: CliOptions): Promise<TeacherPrompt[]> {
  if (!options.promptFile) {
    return TEACHER_PROMPTS;
  }
  const raw = await fs.readFile(options.promptFile, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`prompt file must contain a JSON array: ${options.promptFile}`);
  }
  const prompts = parsed.filter(isTeacherPrompt).map((prompt) => ({
    id: prompt.id.trim(),
    userMessage: prompt.userMessage.trim(),
    sourceSummary: prompt.sourceSummary.trim(),
  }));
  if (prompts.length !== parsed.length || prompts.length === 0) {
    throw new Error(`prompt file contains invalid teacher prompts: ${options.promptFile}`);
  }
  return prompts;
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${stderr}\n${stdout}`));
      }
    });
  });
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`no JSON object found: ${raw.slice(0, 240)}`);
  }
  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
}

function readOpenClawAgentPayload(raw: string): string {
  const payload = parseJsonObject(raw) as {
    result?: { payloads?: Array<{ text?: string }> };
  };
  const text = payload.result?.payloads?.find((entry) => entry.text)?.text;
  if (!text) {
    throw new Error(`OpenClaw agent output missing payload text: ${raw.slice(0, 500)}`);
  }
  return text;
}

async function callMinimaxViaOpenClawAgent(
  options: CliOptions,
  input: TeacherPrompt,
): Promise<string> {
  const sessionId = `minimax-teacher-${input.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const raw = await runCommand("node", [
    "scripts/run-node.mjs",
    "agent",
    "--agent",
    options.openclawAgent,
    "--session-id",
    sessionId,
    "--model",
    `minimax-portal/${options.model}`,
    "--thinking",
    "off",
    "--message",
    buildPrompt(input),
    "--json",
    "--timeout",
    String(options.timeoutSeconds),
  ]);
  return readOpenClawAgentPayload(raw);
}

async function callMinimaxDirectApi(options: CliOptions, input: TeacherPrompt): Promise<string> {
  let apiKey = options.apiKey;
  if (!apiKey) {
    const cfg = loadConfig();
    for (const provider of ["minimax", "minimax-portal"] as const) {
      const resolved = await resolveApiKeyForProvider({
        provider,
        cfg,
        agentDir: options.agentDir,
      }).catch(() => ({ apiKey: undefined }));
      if (resolved.apiKey) {
        apiKey = resolved.apiKey;
        break;
      }
    }
  }
  if (!apiKey) {
    throw new Error(
      `No MiniMax credential resolved for agentDir ${options.agentDir}. Checked minimax and minimax-portal. Use --mock for smoke.`,
    );
  }
  const response = await fetch(`${options.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      max_tokens: 4096,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: buildPrompt(input) }],
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`MiniMax teacher call failed ${response.status}: ${text.slice(0, 500)}`);
  }
  const payload = JSON.parse(text) as { content?: Array<{ type?: string; text?: string }> };
  const contentText = payload.content?.find((entry) => entry.type === "text" || entry.text)?.text;
  if (!contentText) {
    throw new Error(`MiniMax teacher response missing text content: ${text.slice(0, 500)}`);
  }
  return contentText;
}

async function callMinimaxTeacher(options: CliOptions, input: TeacherPrompt): Promise<string> {
  return options.source === "openclaw-agent"
    ? callMinimaxViaOpenClawAgent(options, input)
    : callMinimaxDirectApi(options, input);
}

function mockTeacherPlan(input: TeacherPrompt): TeacherPlan {
  const text = `${input.userMessage}\n${input.sourceSummary}`;
  if (/重新来一遍/u.test(text)) {
    return {
      task_family: "ambiguous_repeat_without_current_subject",
      primary_modules: ["control_room_summary"],
      supporting_modules: ["ops_audit"],
      required_tools: ["review_panel"],
      missing_data: ["current_subject_or_original_request"],
      risk_boundaries: ["research_only", "no_execution_authority", "evidence_required"],
      next_step: "ask_user_for_current_subject_before_reusing_prior_context",
      rejected_context: ["old_lark_conversation_history"],
    };
  }
  if (/上下文|污染|ops audit/u.test(text)) {
    return {
      task_family: "lark_context_pollution_audit",
      primary_modules: ["ops_audit"],
      supporting_modules: ["control_room_summary", "review_panel"],
      required_tools: ["lark_loop_diagnose", "sessions_history", "review_panel"],
      missing_data: ["fresh_lark_message_id_or_visible_reply_text"],
      risk_boundaries: ["no_execution_authority", "evidence_required"],
      next_step: "inspect_lark_session_store_and_candidate_replay_before_claiming_live_fixed",
      rejected_context: ["old_lark_conversation_history"],
    };
  }
  return {
    task_family: input.id,
    primary_modules: ["finance_learning_memory", "source_registry", "review_panel"],
    supporting_modules: ["control_room_summary"],
    required_tools: ["review_panel"],
    missing_data: /没给|without|missing/u.test(text) ? ["source_url_or_local_source_path"] : [],
    risk_boundaries: ["research_only", "no_execution_authority", "evidence_required"],
    next_step: "review_teacher_plan_before_dataset_promotion",
    rejected_context: ["old_lark_conversation_history"],
  };
}

function extractJson(raw: string): TeacherPlan {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`MiniMax teacher output did not contain JSON: ${raw.slice(0, 240)}`);
  }
  return JSON.parse(raw.slice(start, end + 1)) as TeacherPlan;
}

function asArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function makeAcceptedCandidate(
  input: TeacherPrompt,
  plan: TeacherPlan,
): LarkBrainDistillationCandidate {
  const candidate = buildLarkBrainDistillationCandidate({
    source: "teacher_review",
    userMessage: input.userMessage,
    payload: JSON.stringify({ teacher: "MiniMax-M2.7", sourceSummary: input.sourceSummary }),
    createdAt: new Date().toISOString(),
    review: {
      accepted: true,
      reviewer: "minimax_m2_7_teacher",
      reason: `MiniMax M2.7 teacher plan for ${input.id}`,
    },
  });
  return {
    ...candidate,
    id: `${candidate.id}-minimax-${input.id}`,
    status: "accepted_brain_plan",
    proposedTaskFamily: plan.task_family,
    proposedPrimaryModules: asArray(plan.primary_modules),
    proposedSupportingModules: asArray(plan.supporting_modules),
    proposedRequiredTools: asArray(plan.required_tools),
    proposedMissingData: asArray(plan.missing_data),
    proposedRiskBoundaries: asArray(plan.risk_boundaries),
    proposedNextStep: String(plan.next_step ?? "review_teacher_plan_before_dataset_promotion"),
  };
}

const options = parseArgs(process.argv.slice(2));
const PROVIDER_PAYLOAD_UNSTABLE_PROMPTS = new Set([
  "context_reset",
  "ambiguous_repeat",
  "lark_context_pollution",
  "source_grounding_audit",
  "local_math_then_review",
  "daily_learning_automation",
]);
const configuredTeacherPrompts = await loadTeacherPrompts(options);
const teacherPromptPool = options.promptFile
  ? configuredTeacherPrompts
  : options.includePayloadUnstablePrompts
    ? configuredTeacherPrompts
    : configuredTeacherPrompts.filter(
        (prompt) => !PROVIDER_PAYLOAD_UNSTABLE_PROMPTS.has(prompt.id),
      );
const selectedPrompts = teacherPromptPool.slice(0, options.limit);
const acceptedCandidates: LarkBrainDistillationCandidate[] = [];
const failures: Array<{ id: string; error: string }> = [];
const directApiFallbackPromptIds: string[] = [];

async function callTeacherWithFallback(input: TeacherPrompt): Promise<string> {
  try {
    return await callMinimaxTeacher(options, input);
  } catch (error) {
    const message = String(error);
    const canFallback =
      options.source === "openclaw-agent" &&
      !options.mock &&
      Boolean(options.apiKey) &&
      message.includes("OpenClaw agent output missing payload text");
    if (!canFallback) {
      throw error;
    }
    if (!directApiFallbackPromptIds.includes(input.id)) {
      directApiFallbackPromptIds.push(input.id);
    }
    return callMinimaxDirectApi(options, input);
  }
}

function isProviderPayloadMissingFailure(failure: { error: string }): boolean {
  return failure.error.includes("OpenClaw agent output missing payload text");
}

async function processTeacherPrompt(prompt: TeacherPrompt): Promise<void> {
  let lastError: unknown;
  try {
    for (let attempt = 0; attempt <= options.retries; attempt += 1) {
      try {
        const raw = options.mock
          ? JSON.stringify(mockTeacherPlan(prompt))
          : await callTeacherWithFallback(prompt);
        acceptedCandidates.push(makeAcceptedCandidate(prompt, extractJson(raw)));
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) {
      throw lastError;
    }
  } catch (error) {
    failures.push({ id: prompt.id, error: String(error) });
  }
}

async function runPromptPool(prompts: TeacherPrompt[]): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(options.concurrency, prompts.length);
  async function worker(): Promise<void> {
    while (nextIndex < prompts.length) {
      const prompt = prompts[nextIndex];
      nextIndex += 1;
      await processTeacherPrompt(prompt);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

await runPromptPool(selectedPrompts);

const reviewedAt = new Date().toISOString();
const providerSkippedFailures = failures.filter(isProviderPayloadMissingFailure);
const hardFailures = failures.filter((failure) => !isProviderPayloadMissingFailure(failure));
const review: LarkBrainDistillationReviewArtifact = {
  schemaVersion: 1,
  boundary: "brain_distillation_review",
  reviewedAt,
  noLanguageRoutingPromotion: true,
  noLiveSenderTouched: true,
  sourceArtifacts: [`minimax_teacher_batch:${options.model}`],
  acceptedCandidates,
  rejectedCandidates: hardFailures.map((failure) => ({
    id: `minimax-teacher-rejected-${failure.id}`,
    source: "teacher_review",
    reason: failure.error,
  })),
  counts: {
    sourceArtifacts: selectedPrompts.length,
    pendingCandidates: selectedPrompts.length,
    accepted: acceptedCandidates.length,
    rejected: hardFailures.length,
    discarded: providerSkippedFailures.length,
  },
};

let reviewPath: string | undefined;
let partialWriteRefused = false;
if (options.write) {
  if (hardFailures.length > 0 && !options.allowPartialWrite) {
    partialWriteRefused = true;
  } else {
    const dateKey = reviewedAt.slice(0, 10);
    const reviewDir = path.join(options.workspaceDir, LARK_BRAIN_DISTILLATION_REVIEW_DIR, dateKey);
    await fs.mkdir(reviewDir, { recursive: true });
    reviewPath = path.join(
      reviewDir,
      `minimax-teacher-batch-${reviewedAt.replace(/[:.]/gu, "-")}.json`,
    );
    await fs.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  }
}

const result = {
  ok: hardFailures.length === 0 && acceptedCandidates.length > 0,
  boundary: "brain_distillation_review",
  mode: "additive_teacher_samples_only",
  teacher: options.model,
  source: options.mock ? "mock" : options.source,
  openclawAgent: options.source === "openclaw-agent" ? options.openclawAgent : undefined,
  directApiFallbackPromptIds,
  providerSkippedPromptIds: providerSkippedFailures.map((failure) => failure.id),
  baseUrl: options.baseUrl,
  concurrency: options.concurrency,
  mock: options.mock,
  write: options.write,
  workspaceDir: options.workspaceDir,
  agentDir: options.agentDir,
  reviewPath: reviewPath
    ? path.relative(options.workspaceDir, reviewPath).split(path.sep).join("/")
    : undefined,
  partialWriteRefused,
  acceptedCandidates: acceptedCandidates.length,
  failures: hardFailures,
  liveTouched: false,
  providerConfigTouched: false,
  originalPipelineReplaced: false,
  noLanguageRoutingPromotion: review.noLanguageRoutingPromotion,
};

process.stdout.write(
  options.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `MiniMax teacher batch accepted=${acceptedCandidates.length} failed=${failures.length} write=${options.write}\n`,
);
process.exitCode = result.ok ? 0 : 1;
