import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildLarkBrainDistillationCandidate,
  LARK_BRAIN_DISTILLATION_REVIEW_DIR,
  type LarkBrainDistillationCandidate,
  type LarkBrainDistillationReviewArtifact,
} from "../../extensions/feishu/src/lark-brain-distillation-candidates.js";
import { resolveOpenClawAgentDir } from "../../src/agents/agent-paths.js";
import { resolveApiKeyForProvider } from "../../src/agents/model-auth.js";
import { loadConfig } from "../../src/config/config.js";
import { LOCAL_BRAIN_MODULE_TAXONOMY } from "./local-brain-taxonomy.js";

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

type DirectApiContentEntry = {
  type?: string;
  text?: string;
  thinking?: string;
  content?: unknown;
};

type DirectApiPayload = {
  content?: unknown;
  text?: unknown;
  output_text?: unknown;
  message?: { content?: unknown };
  choices?: Array<{
    text?: unknown;
    message?: { content?: unknown };
    delta?: { content?: unknown };
  }>;
};

const DEFAULT_WORKSPACE = path.join(process.env.HOME ?? ".", ".openclaw", "workspace");
const DEFAULT_MODEL = process.env.MINIMAX_TEACHER_MODEL?.trim() || "MiniMax-M2.7";
const DEFAULT_BASE_URL =
  process.env.MINIMAX_ANTHROPIC_BASE_URL?.trim() || "https://api.minimax.io/anthropic";

const MODULE_TAXONOMY = LOCAL_BRAIN_MODULE_TAXONOMY;

const TEACHER_PROMPTS: TeacherPrompt[] = [
  {
    id: "broad_finance_module_taxonomy",
    userMessage:
      "以后我要看美股、A股、指数、ETF、加密币、原油、黄金、美元、期权波动率、事件风险、技术择时、公司基本面、组合风险和量化。先做完整金融模块地图，别把所有东西都塞进宏观/ETF/组合三个桶。",
    sourceSummary:
      "broad finance module taxonomy request; research-only; require dedicated modules and risk boundaries.",
  },
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
    id: "cross_market_us_a_index_crypto",
    userMessage:
      "未来我会同时看美股、A股、指数和加密币。请训练本地大脑做连贯分析：先动用本地记忆和已学规则，再拆宏观利率、美元/人民币流动性、美股市场结构、A股政策资金面、指数权重和趋势、加密币流动性和风险门；research-only，不要交易建议。",
    sourceSummary:
      "cross-market finance planning across US equities, China A-shares, global indices, crypto, FX/liquidity, quant checks, memory recall, and review handoff.",
  },
  {
    id: "daily_learning_automation",
    userMessage: "这些学习和复盘应该每次对话都自动发生，不要等我每天手动下命令。",
    sourceSummary: "automation loop planning without live sender changes.",
  },
  {
    id: "agent_skill_distillation_open_source",
    userMessage:
      "帮这个本地 agent 结构学习网上开源的 SKILL.md 工作流和本地已有 skills：先找候选、隔离审计、沉淀成可复用技能和本地大脑训练样本，不要改 provider config、live sender 或 protected memory。",
    sourceSummary:
      "agent-skill distillation request requiring source review, isolated local skill install, eval harness, and protected-memory guardrails.",
  },
  {
    id: "finance_skill_curriculum_bridge",
    userMessage:
      "把可学的 agent skills 转成金融研究大脑课程：美股、A股、指数、加密币都能用，但只教任务拆解、证据审计、风险门和审阅流程，不教交易执行。",
    sourceSummary:
      "turn general agent skills into a research-only finance brain curriculum across US equities, A-shares, indices, and crypto.",
  },
  {
    id: "paper_learning_internalization_absorption",
    userMessage:
      "学习 arxiv.org/abs/2601.17021 这篇组合管理论文，把 regret-guided allocation、sentiment filter 和 LLM hedging 沉淀成本地大脑可复用规则；必须确认 source artifact、capability card、retrieval receipt、apply validation，并判断是否需要加入 Qwen/local-brain eval。research-only，不要交易建议。",
    sourceSummary:
      "sourced arXiv portfolio-management paper learning request requiring source registry, actual reading scope, capability retention, retrieval/apply proof, training or eval absorption evidence, and overfit/sample-out boundaries.",
  },
  {
    id: "unverified_live_market_data_boundary",
    userMessage:
      "今天 QQQ、TLT、NVDA 和美元流动性最新怎么看？我没有给实时行情源，先拆内部模块和数据缺口，不要装作已经拿到实时数据，也不要给交易建议。",
    sourceSummary:
      "fresh live-market style request without supplied real-time source; mark live claims unverified and require timestamped data.",
  },
  {
    id: "factor_backtest_overfit_guard",
    userMessage:
      "我想学一个 ETF 因子择时策略，但不要回测神话。先拆成研究假设、过拟合检查、幸存者偏差、样本外验证、失效条件和风险门；research-only。",
    sourceSummary:
      "factor timing strategy learning request requiring overfit, survivor-bias, sample-out, invalidation, and no trade advice.",
  },
  {
    id: "crypto_high_leverage_research_boundary",
    userMessage:
      "BTC 如果突破关键位置能不能 20x 开多？不要执行，训练本地大脑把这种加密币高杠杆请求降级成 research-only 风险分析，只能当风险偏好和流动性输入。",
    sourceSummary:
      "crypto high-leverage prompt that must reject execution and high leverage while preserving market-structure analysis.",
  },
  {
    id: "sentiment_market_external_module_learning",
    userMessage:
      "如果我找到一个 GitHub 开源项目，专门分析新闻情绪和股市、指数、BTC 的关系，怎么把它加入现在的本地大脑模式？先做 source、license、验证集、样本外和 eval 设计，不要把情绪当独立 alpha。",
    sourceSummary:
      "external sentiment-market module learning request requiring source/license isolation, validation design, sample-out checks, and local-brain eval gate.",
  },
  {
    id: "company_filing_missing_evidence_gate",
    userMessage:
      "分析 NVDA 最新财报和指引，但我没有给 10-Q、10-K、earnings release 或来源。先拆模块，明确缺哪些原始证据，不要编财报细节，不要给交易建议。",
    sourceSummary:
      "company fundamentals request missing filing or earnings source; require source registry and refuse unverified filing claims.",
  },
  {
    id: "technical_timing_not_standalone_alpha",
    userMessage:
      "只看技术面能不能判断 QQQ 入场？训练本地大脑把技术面当 timing context，而不是独立 alpha：必须先要价格、成交量、breadth、宏观流动性和风险门，不要给买卖点。",
    sourceSummary:
      "technical timing prompt that must not promote chart patterns into standalone alpha or trade recommendation.",
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

export function buildPrompt(input: TeacherPrompt): string {
  return [
    "You are MiniMax M2.7 acting as LCX Agent's teacher for local brain distillation.",
    "Return one strict JSON object and no prose.",
    "Return compact machine-parseable JSON only: no markdown fences, no comments, no trailing commas, no ellipses, no placeholders.",
    "Use double-quoted JSON strings and put a comma between every object property and every array item.",
    "Keep task_family as concise snake_case, keep next_step under 160 characters, and never copy the full user prompt into JSON values.",
    "Keep primary_modules, supporting_modules, required_tools, missing_data, risk_boundaries, and rejected_context to the smallest useful arrays; prefer 3-8 items per array.",
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
    "- cross-market finance must connect US equities, A-share policy/flow, index regime, crypto market structure, FX/currency liquidity, cross-asset liquidity, quant checks, and risk gates",
    "- agent skill learning must include skill_pattern_distillation, agent_workflow_memory, source_registry, eval_harness_design, review_panel, no_protected_memory_write, no_provider_config_change, and no_live_sender_change",
    "- sourced paper learning must include finance_learning_memory, source_registry, causal_map, portfolio_risk_gates, review_panel, control_room_summary, actual_reading_scope, capability_card_or_retrieval_receipt, application_validation_receipt, training_or_eval_absorption_evidence, backtest_overfit_check_required, and sample_out_validation_required",
    "- crypto work is research-only; include no_high_leverage_crypto and never imply execution approval",
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

function collectStringLeaves(value: unknown, output: string[] = [], depth = 0): string[] {
  if (depth > 5 || value == null) {
    return output;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      output.push(trimmed);
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringLeaves(entry, output, depth + 1);
    }
    return output;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectStringLeaves(entry, output, depth + 1);
    }
  }
  return output;
}

function containsTeacherJsonHint(value: string): boolean {
  return (
    value.includes("{") &&
    /"?(task_family|primary_modules|required_tools|missing_data|risk_boundaries|next_step)"?\s*:/u.test(
      value,
    )
  );
}

export function extractMiniMaxTeacherTextFromResponse(responseText: string): string {
  const payload = JSON.parse(responseText) as DirectApiPayload;
  const content = Array.isArray(payload.content)
    ? (payload.content as DirectApiContentEntry[])
    : [];
  const preferredText = content
    .map((entry) => entry.text?.trim())
    .filter((entry): entry is string => Boolean(entry))
    .join("\n")
    .trim();
  if (preferredText) {
    return preferredText;
  }

  const choiceContent = (payload.choices ?? []).flatMap((choice) => [
    choice.text,
    choice.message?.content,
    choice.delta?.content,
  ]);
  const responseShapeFallback = [
    payload.text,
    payload.output_text,
    payload.message?.content,
    ...choiceContent,
  ]
    .flatMap((entry) => collectStringLeaves(entry))
    .filter(containsTeacherJsonHint)
    .join("\n")
    .trim();
  if (responseShapeFallback) {
    return responseShapeFallback;
  }

  const jsonBearingFallback = content
    .flatMap((entry) => [
      entry.thinking,
      ...(Array.isArray(entry.content) ? collectStringLeaves(entry.content) : []),
    ])
    .filter((entry): entry is string => typeof entry === "string" && containsTeacherJsonHint(entry))
    .join("\n")
    .trim();
  if (jsonBearingFallback) {
    return jsonBearingFallback;
  }

  const allStrings = collectStringLeaves(content).join("\n").trim();
  throw new Error(
    `MiniMax teacher response missing text content: ${allStrings.slice(0, 500) || responseText.slice(0, 500)}`,
  );
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
    signal: AbortSignal.timeout(options.timeoutSeconds * 1000),
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
  return extractMiniMaxTeacherTextFromResponse(text);
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
  if (
    /skill|skills|skill\.md|agent skill|本地 agent|本地agent|技能|工作流|harness|hermes/u.test(text)
  ) {
    return {
      task_family: "agent_skill_pattern_distillation",
      primary_modules: [
        "skill_pattern_distillation",
        "agent_workflow_memory",
        "source_registry",
        "review_panel",
      ],
      supporting_modules: [
        "eval_harness_design",
        "control_room_summary",
        "finance_learning_memory",
      ],
      required_tools: [
        "skill_harvester",
        "source_registry_lookup",
        "skill_isolation_review",
        "local_brain_eval",
        "review_panel",
      ],
      missing_data: [
        "candidate_skill_source_or_local_skill_path",
        "target_workflow_acceptance_metric",
        "license_and_write_scope_review",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "untrusted_external_skill",
        "evaluate_before_installing",
        "no_protected_memory_write",
        "no_provider_config_change",
        "no_live_sender_change",
        "no_trading_execution_skill",
      ],
      next_step:
        "collect_candidate_skill_sources_review_license_and_write_scope_then_distill_safe_workflow_into_local_skill_and_eval_case",
      rejected_context: [
        "old_lark_conversation_history",
        "cloud_skill_sharing_by_default",
        "market_alpha_claim_without_source",
      ],
    };
  }
  if (/arxiv|论文|paper|preprint|capability card|retrieval receipt|apply validation/u.test(text)) {
    return {
      task_family: "paper_learning_internalization_planning",
      primary_modules: [
        "finance_learning_memory",
        "source_registry",
        "causal_map",
        "portfolio_risk_gates",
        "review_panel",
        "control_room_summary",
      ],
      supporting_modules: ["etf_regime", "quant_math", "eval_harness_design"],
      required_tools: [
        "finance_learning_pipeline_orchestrator",
        "finance_article_source_collection_preflight",
        "finance_article_source_registry_record",
        "finance_learning_capability_apply",
        "source_registry_lookup",
        "review_panel",
      ],
      missing_data: [
        "actual_reading_scope",
        "source_artifact_path",
        "capability_card_or_retrieval_receipt",
        "application_validation_receipt",
        "training_or_eval_absorption_evidence",
        "replication_or_sample_out_evidence",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_trade_advice",
        "no_doctrine_mutation",
        "no_model_internal_learning_claim_without_eval",
        "backtest_overfit_check_required",
        "sample_out_validation_required",
      ],
      next_step:
        "verify_source_registry_and_reading_scope_then_attach_capability_run_apply_validation_and_add_eval_or_training_absorption_case",
      rejected_context: [
        "unverified_paper_summary",
        "paper_backtest_as_trade_rule",
        "model_internal_learning_claim_without_training_eval_evidence",
        "old_lark_conversation_history",
      ],
    };
  }
  if (
    (/(今天|最新|实时|当前行情|当前市场|real[- ]?time|latest)/u.test(text) ||
      /现在.{0,16}(怎么看|走势|涨跌|价格|行情|market|price)/u.test(text)) &&
    !/没有给.*(10-Q|10-K|earnings|来源)|没有.*(10-Q|10-K|earnings release|来源)|没给.*财报|缺.*财报/u.test(
      text,
    )
  ) {
    return {
      task_family: "unverified_live_market_data_research_preflight",
      primary_modules: [
        "source_registry",
        "macro_rates_inflation",
        "credit_liquidity",
        "cross_asset_liquidity",
        "etf_regime",
        "portfolio_risk_gates",
      ],
      supporting_modules: [
        "causal_map",
        "finance_learning_memory",
        "review_panel",
        "control_room_summary",
      ],
      required_tools: [
        "source_registry_lookup",
        "fresh_market_data_collection_preflight",
        "artifact_memory_recall",
        "review_panel",
      ],
      missing_data: [
        "fresh_market_data_snapshot",
        "source_timestamp_and_vendor",
        "memory_recall_scope_or_relevant_receipts",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_live_data",
        "no_trade_advice",
      ],
      next_step:
        "mark_live_market_claims_unverified_until_source_timestamp_and_fresh_data_snapshot_are_available_then_run_review",
      rejected_context: ["unverified_live_market_claim", "old_lark_conversation_history"],
    };
  }
  if (
    /因子|factor|择时|timing|策略|strategy|signal|alpha|回测|backtest/u.test(text) &&
    /过拟合|overfit|样本外|survivor|幸存者|回测神话|backtest/u.test(text) &&
    !/情绪|sentiment|新闻情绪|舆情/u.test(text)
  ) {
    return {
      task_family: "factor_timing_overfit_resistant_learning",
      primary_modules: [
        "quant_math",
        "finance_learning_memory",
        "source_registry",
        "portfolio_risk_gates",
        "review_panel",
      ],
      supporting_modules: ["causal_map", "etf_regime", "control_room_summary"],
      required_tools: [
        "finance_learning_pipeline_orchestrator",
        "source_registry_lookup",
        "quant_math",
        "review_panel",
      ],
      missing_data: [
        "strategy_source_or_research_note",
        "sample_out_validation_plan",
        "survivor_bias_and_lookahead_bias_check",
        "walk_forward_or_cross_validation_evidence",
        "failure_regime_and_invalidation_condition",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_trade_advice",
        "backtest_overfit_check_required",
        "sample_out_validation_required",
        "survivor_bias_check_required",
      ],
      next_step:
        "convert_strategy_into_hypothesis_with_bias_checks_sample_out_plan_failure_regime_and_review_before_any_reusable_rule",
      rejected_context: ["old_lark_conversation_history", "backtest_as_profit_claim"],
    };
  }
  if (/高杠杆|20x|50x|100x|leverage|开多|开空|下单|爆仓/u.test(text)) {
    return {
      task_family: "crypto_leverage_research_boundary",
      primary_modules: [
        "crypto_market_structure",
        "cross_asset_liquidity",
        "portfolio_risk_gates",
        "review_panel",
      ],
      supporting_modules: ["finance_learning_memory", "source_registry", "control_room_summary"],
      required_tools: [
        "finance_learning_capability_apply",
        "finance_framework_core_inspect",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missing_data: [
        "crypto_liquidity_volatility_custody_and_regulatory_inputs",
        "position_weights_and_risk_limits",
        "liquidation_and_leverage_exposure_map",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_high_leverage_crypto",
        "no_trade_advice",
        "risk_gate_before_action_language",
      ],
      next_step:
        "reject_execution_or_high_leverage_language_then_analyze_crypto_as_risk_sentiment_and_liquidity_input_only",
      rejected_context: [
        "old_lark_conversation_history",
        "execution_or_high_leverage_crypto_instruction",
      ],
    };
  }
  if (/情绪|sentiment|新闻情绪|舆情/u.test(text)) {
    return {
      task_family: "sentiment_market_module_learning_preflight",
      primary_modules: [
        "finance_learning_memory",
        "source_registry",
        "causal_map",
        "quant_math",
        "eval_harness_design",
        "review_panel",
      ],
      supporting_modules: [
        "us_equity_market_structure",
        "global_index_regime",
        "crypto_market_structure",
        "portfolio_risk_gates",
        "control_room_summary",
      ],
      required_tools: [
        "skill_harvester",
        "source_registry_lookup",
        "license_and_write_scope_review",
        "finance_learning_capability_apply",
        "local_brain_eval",
        "review_panel",
      ],
      missing_data: [
        "candidate_repo_url_or_local_source_path",
        "license_and_write_scope_review",
        "sentiment_data_source_and_timestamp_policy",
        "validation_dataset_and_sample_out_plan",
        "integration_acceptance_metric",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "untrusted_external_source",
        "backtest_overfit_check_required",
        "sample_out_validation_required",
        "sentiment_signal_not_standalone_alpha",
        "no_trade_advice",
      ],
      next_step:
        "review_repo_license_data_sources_and_validation_plan_then_distill_sentiment_as_one_evidence_layer_with_eval_gate",
      rejected_context: ["old_lark_conversation_history", "sentiment_as_standalone_trade_signal"],
    };
  }
  if (
    /没有给.*(10-Q|10-K|earnings|来源)|没有.*(10-Q|10-K|earnings release|来源)|没给.*财报|缺.*财报/u.test(
      text,
    )
  ) {
    return {
      task_family: "company_filing_missing_evidence_preflight",
      primary_modules: ["company_fundamentals_value", "source_registry", "portfolio_risk_gates"],
      supporting_modules: [
        "causal_map",
        "finance_learning_memory",
        "review_panel",
        "control_room_summary",
      ],
      required_tools: [
        "finance_framework_company_fundamentals_value_producer",
        "source_registry_lookup",
        "review_panel",
      ],
      missing_data: [
        "latest_10q_10k_or_earnings_release",
        "guidance_revision_margin_revenue_and_valuation_inputs",
        "source_timestamp_and_vendor",
        "portfolio_exposure_context_if_relevant",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_unverified_filing_claims",
        "no_trade_advice",
      ],
      next_step:
        "request_or_collect_filing_source_before_stating_fundamental_claims_then_route_to_review_panel",
      rejected_context: ["old_lark_conversation_history", "unverified_filing_summary"],
    };
  }
  if (/技术面|technical|均线|rsi|macd|成交量|breadth|动量|momentum/u.test(text)) {
    return {
      task_family: "technical_timing_not_standalone_alpha",
      primary_modules: [
        "etf_regime",
        "us_equity_market_structure",
        "quant_math",
        "portfolio_risk_gates",
        "review_panel",
      ],
      supporting_modules: [
        "macro_rates_inflation",
        "credit_liquidity",
        "causal_map",
        "finance_learning_memory",
        "control_room_summary",
      ],
      required_tools: [
        "finance_framework_etf_regime_producer",
        "finance_learning_capability_apply",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missing_data: [
        "price_volume_breadth_and_technical_regime_inputs",
        "macro_liquidity_context_inputs",
        "position_weights_and_risk_limits",
        "invalidation_condition_for_timing_signal",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "technical_timing_not_standalone_alpha",
        "risk_gate_before_action_language",
        "no_trade_advice",
      ],
      next_step:
        "use_technical_inputs_only_for_timing_context_after_macro_liquidity_and_risk_gate_review",
      rejected_context: ["old_lark_conversation_history", "single_factor_technical_story"],
    };
  }
  if (/美股|A股|a股|指数|加密|crypto|cross-market|跨市场/u.test(text)) {
    return {
      task_family: "cross_market_finance_research_planning",
      primary_modules: [
        "macro_rates_inflation",
        "credit_liquidity",
        "cross_asset_liquidity",
        "fx_currency_liquidity",
        "us_equity_market_structure",
        "china_a_share_policy_flow",
        "global_index_regime",
        "crypto_market_structure",
        "quant_math",
        "portfolio_risk_gates",
      ],
      supporting_modules: [
        "causal_map",
        "finance_learning_memory",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ],
      required_tools: [
        "artifact_memory_recall",
        "finance_learning_capability_apply",
        "source_registry_lookup",
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_core_inspect",
        "finance_framework_fx_dollar_producer",
        "finance_learning_capability_apply",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missing_data: [
        "memory_recall_scope_or_relevant_receipts",
        "fresh_market_data_snapshot",
        "us_equity_breadth_earnings_and_valuation_inputs",
        "china_a_share_policy_liquidity_and_northbound_inputs",
        "index_constituents_weights_and_technical_regime_inputs",
        "crypto_liquidity_volatility_custody_and_regulatory_inputs",
        "fx_dollar_yuan_and_global_liquidity_inputs",
        "position_weights_and_return_series",
        "portfolio_weights_and_risk_limits",
      ],
      risk_boundaries: [
        "research_only",
        "no_execution_authority",
        "evidence_required",
        "no_high_leverage_crypto",
        "no_unverified_cross_market_claims",
      ],
      next_step:
        "recall_local_finance_rules_then_build_cross_market_causal_map_collect_fresh_inputs_run_quant_and_review_before_control_room_summary",
      rejected_context: [
        "old_lark_conversation_history",
        "execution_or_high_leverage_crypto_instruction",
      ],
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

function stripMarkdownJsonFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
}

function findBalancedJsonObject(raw: string): string | null {
  const source = stripMarkdownJsonFence(raw);
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (start < 0) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
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
        return source.slice(start, index + 1);
      }
    }
  }
  return null;
}

function repairMissingCommas(candidate: string): string {
  return candidate
    .replace(/([}\]"])\s*\n\s*("[A-Za-z0-9_$ -]+"\s*:)/gu, "$1,\n$2")
    .replace(/"\s*\n\s*"/gu, '",\n"');
}

function parseTeacherPlanCandidate(candidate: string): TeacherPlan {
  const repaired = repairMissingCommas(candidate)
    .replace(/\[\s*\.\.\.\s*\]/gu, "[]")
    .replace(/,\s*([}\]])/gu, "$1");
  return JSON.parse(repaired) as TeacherPlan;
}

export function extractJson(raw: string): TeacherPlan {
  const balanced = findBalancedJsonObject(raw);
  if (balanced) {
    return parseTeacherPlanCandidate(balanced);
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`MiniMax teacher output did not contain JSON: ${raw.slice(0, 240)}`);
  }
  return parseTeacherPlanCandidate(raw.slice(start, end + 1));
}

function asArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

const REQUIRED_RISK_BOUNDARIES = ["research_only", "no_execution_authority"] as const;

function cleanStringArray(value: unknown): string[] {
  return [
    ...new Set(
      asArray(value)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function cleanModuleArray(value: unknown): string[] {
  const allowed = new Set(MODULE_TAXONOMY);
  return cleanStringArray(value).filter((entry) => allowed.has(entry));
}

const SAFE_REQUIRED_TOOLS = new Set([
  ...MODULE_TAXONOMY,
  "local_memory_retrieval",
  "source_registry_query",
  "actual_source_receipt",
  "review_panel",
  "local_quant_math",
  "control_room_summary",
]);

const OVERCLAIMED_TOOL_PATTERN =
  /api|feed|terminal|bloomberg|reuters|refinitiv|broker|scrap|yfinance|quandl|fred|fedwatch|cftc|finra|barra|riskmetrics|jupyter|notebook|pandas|numpy|sklearn|tensorflow|mlflow|weights|market_data|data_fetch|dashboard|parser|calculator|engine|generator|visualizer|monitor|http|www\.|\.com|internal/iu;

function cleanRequiredToolArray(value: unknown): string[] {
  return cleanStringArray(value).filter(
    (entry) => SAFE_REQUIRED_TOOLS.has(entry) && !OVERCLAIMED_TOOL_PATTERN.test(entry),
  );
}

const OVERCLAIMED_NEXT_STEP_PATTERN =
  /internet_search_engine|bloomberg|yahoo finance|fred|authenticated data feeds?|public data source|pull (?:latest|current|historical)|gather (?:latest|current|fresh)|fetch\b|retrieve .*data|obtain .*data|compute\b|time series regression|update finance_learning_memory|store in agent_workflow_memory|update source_registry|写入|沉淀到记忆|更新(?:finance_learning_memory|source_registry|causal_map)/iu;

function nextStepOverclaims(nextStep: string): boolean {
  return OVERCLAIMED_NEXT_STEP_PATTERN.test(nextStep);
}

function safeEvidenceFirstNextStep(reason: "source" | "quant" | "generic"): string {
  if (reason === "source") {
    return "Clarify the learning objective, check local memory for prior retained rules, require a source URL or local source path plus an actual reading receipt, then hand the source-gated plan to review_panel and summarize only verified reusable research rules.";
  }
  if (reason === "quant") {
    return "Clarify the requested metrics, check local memory for prior templates, require position weights, return series or price history, a fresh market-data snapshot, and a review receipt, then summarize the research-only math plan without producing portfolio numbers.";
  }
  return "Clarify the objective, check local memory for prior retained rules, list missing source and data gaps, build the causal module checklist, hand the plan to review_panel, then summarize only verified research boundaries.";
}

function canonicalRiskBoundary(entry: string): string {
  const normalized = entry
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  if (
    normalized === "research_only_no_execution_authority" ||
    normalized === "research_only_no_execution" ||
    normalized === "research_only_no_trade_execution" ||
    normalized === "research_only"
  ) {
    return "research_only";
  }
  if (
    normalized === "no_execution_authority" ||
    normalized === "no_live_trading_recommendations" ||
    normalized === "no_live_trading_or_real_money_instructions" ||
    normalized === "no_live_trading_commands" ||
    normalized === "no_trade_execution" ||
    normalized === "no_financial_advice"
  ) {
    return "no_execution_authority";
  }
  if (
    normalized === "no_high_leverage_crypto_positions" ||
    normalized === "no_high_leverage_crypto_position" ||
    normalized === "no_high_leverage_crypto"
  ) {
    return "no_high_leverage_crypto";
  }
  if (
    normalized === "no_live_market_claims" ||
    normalized === "no_unverified_live_market_data_claims"
  ) {
    return "no_unverified_live_market_data_claims";
  }
  return normalized || entry.trim();
}

export function normalizeTeacherPlan(plan: TeacherPlan): TeacherPlan {
  const primaryModules = cleanModuleArray(plan.primary_modules);
  const supportingModules = cleanModuleArray(plan.supporting_modules).filter(
    (entry) => !primaryModules.includes(entry),
  );
  const riskBoundaries = [
    ...new Set(cleanStringArray(plan.risk_boundaries).map(canonicalRiskBoundary)),
  ];
  for (const boundary of REQUIRED_RISK_BOUNDARIES) {
    if (!riskBoundaries.includes(boundary)) {
      riskBoundaries.unshift(boundary);
    }
  }
  return {
    task_family:
      typeof plan.task_family === "string" && plan.task_family.trim()
        ? plan.task_family.trim()
        : "teacher_plan_unclassified",
    primary_modules: primaryModules,
    supporting_modules: supportingModules,
    required_tools: cleanRequiredToolArray(plan.required_tools),
    missing_data: cleanStringArray(plan.missing_data),
    risk_boundaries: riskBoundaries,
    next_step:
      typeof plan.next_step === "string" && plan.next_step.trim()
        ? plan.next_step.trim()
        : "review_teacher_plan_before_dataset_promotion",
    rejected_context: cleanStringArray(plan.rejected_context),
  };
}

export function hardenTeacherPlanForPrompt(input: TeacherPrompt, plan: TeacherPlan): TeacherPlan {
  const ask = `${input.id}\n${input.userMessage}\n${input.sourceSummary}`;
  const primaryModules = [...plan.primary_modules];
  const supportingModules = [...plan.supporting_modules];
  const missingData = [...plan.missing_data];
  const riskBoundaries = [...plan.risk_boundaries];
  const rejectedContext = [...plan.rejected_context];
  let nextStep = plan.next_step;

  const ensurePrimary = (modules: string[]) => {
    for (const module of modules) {
      if (!primaryModules.includes(module)) {
        primaryModules.push(module);
      }
    }
  };
  const replacePrimary = (modules: string[]) => {
    primaryModules.splice(0, primaryModules.length, ...modules);
  };
  const ensureMissing = (items: string[]) => {
    for (const item of items) {
      if (!missingData.includes(item)) {
        missingData.push(item);
      }
    }
  };
  const ensureRisk = (items: string[]) => {
    for (const item of items) {
      if (!riskBoundaries.includes(item)) {
        riskBoundaries.push(item);
      }
    }
  };
  const ensureRejected = (items: string[]) => {
    for (const item of items) {
      if (!rejectedContext.includes(item)) {
        rejectedContext.push(item);
      }
    }
  };

  const isContextReset =
    /context_reset|ambiguous_repeat|lark_context_pollution|重新来一遍|别串|旧任务|没说清楚|上下文污染|清除上下文/u.test(
      ask,
    );
  const isEtfAsCompanyFundamentals =
    /\b(GLD|QQQ|SPY|TLT|IEF|IWM|XLK|XLF|HYG|UUP)\b/iu.test(ask) &&
    /收入质量|客户集中度|revenue quality|customer concentration|client concentration|13f holder|ev\/ebitda/iu.test(
      ask,
    );
  const isQuantInputMissing =
    /相关性|波动|回撤|收益率序列|仓位权重|权重|correlation|volatility|drawdown|return series|position weight/iu.test(
      ask,
    );
  const isSourceGated =
    /没有给 URL|没有给链接|没有给 10-Q|没有给 10-K|没有给实时行情源|source|artifact|receipt|filing/iu.test(
      ask,
    );

  if (isContextReset) {
    replacePrimary(["ops_audit", "agent_workflow_memory", "control_room_summary"]);
    ensureMissing(["current_subject_or_original_request"]);
    ensureRejected(["old_lark_conversation_history", "unstated_finance_subject"]);
    ensureRisk(["ops_audit_must_not_become_finance_analysis"]);
    nextStep =
      "Ask for the current subject or audit context pollution before doing any finance analysis.";
  }

  if (!isContextReset && isEtfAsCompanyFundamentals) {
    replacePrimary([
      "etf_regime",
      "macro_rates_inflation",
      "fx_currency_liquidity",
      "cross_asset_liquidity",
      "portfolio_risk_gates",
      "source_registry",
      "review_panel",
      "control_room_summary",
    ]);
    ensureMissing([
      "fund_or_etf_prospectus_or_fact_sheet",
      "fresh_market_data_snapshot",
      "current_position_weights",
    ]);
    ensureRisk(["evidence_required", "no_unverified_live_market_data_claims"]);
    ensureRejected(["single_company_fundamental_labels_for_etf"]);
    nextStep =
      "Treat the ETF/fund as a fund-structure and macro/liquidity research task: require prospectus or fact sheet evidence, NAV or holdings context, fresh market data, and position weights before any risk map; do not infer company revenue quality, customer concentration, filings, or valuation multiples.";
  }

  if (!isContextReset && isQuantInputMissing) {
    ensurePrimary([
      "quant_math",
      "portfolio_risk_gates",
      "source_registry",
      "control_room_summary",
    ]);
    ensureMissing([
      "position_weights_and_return_series",
      "position_weights",
      "return_series_or_price_history",
      "fresh_market_data_snapshot",
    ]);
    ensureRisk(["no_model_fabricated_portfolio_math"]);
  }

  if (
    !isContextReset &&
    /持有|未来|一周|一个月|两周|利率|美元流动性|风险偏好|latest|最新|实时|live market/iu.test(ask)
  ) {
    ensurePrimary([
      "macro_rates_inflation",
      "fx_currency_liquidity",
      "cross_asset_liquidity",
      "portfolio_risk_gates",
    ]);
    ensureMissing(["fresh_market_data_snapshot", "current_position_weights"]);
    ensureRisk(["no_unverified_live_market_data_claims"]);
  }

  if (!isContextReset && /美股|A股|指数和加密币|跨市场|crypto|BTC|加密币/iu.test(ask)) {
    ensurePrimary([
      "us_equity_market_structure",
      "china_a_share_policy_flow",
      "global_index_regime",
      "crypto_market_structure",
      "fx_currency_liquidity",
      "cross_asset_liquidity",
      "portfolio_risk_gates",
    ]);
    ensureMissing([
      "fresh_market_data_snapshot",
      "cross_asset_liquidity_inputs",
      "position_weights_and_return_series",
    ]);
    ensureRisk(["no_high_leverage_crypto", "no_unverified_cross_market_claims"]);
  }

  if (isSourceGated) {
    ensurePrimary(["source_registry", "review_panel"]);
    ensureMissing(["source_url_or_local_source_path", "actual_reading_scope_receipt"]);
    ensureRisk(["evidence_required"]);
  }

  if (primaryModules.length === 0) {
    ensurePrimary(["control_room_summary", "source_registry", "review_panel"]);
  }
  if (plan.required_tools.length === 0) {
    plan.required_tools.push("source_registry", "review_panel");
  }
  if (!isContextReset && nextStepOverclaims(nextStep)) {
    ensureRejected(["unsupported_data_fetch_or_memory_write_instruction"]);
    if (isSourceGated) {
      nextStep = safeEvidenceFirstNextStep("source");
    } else if (isQuantInputMissing) {
      nextStep = safeEvidenceFirstNextStep("quant");
    } else {
      nextStep = safeEvidenceFirstNextStep("generic");
    }
  }

  return {
    ...plan,
    primary_modules: primaryModules,
    supporting_modules: supportingModules.filter((entry) => !primaryModules.includes(entry)),
    missing_data: missingData,
    risk_boundaries: riskBoundaries,
    next_step: nextStep,
    rejected_context: rejectedContext,
  };
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

const PROVIDER_PAYLOAD_UNSTABLE_PROMPTS = new Set([
  "context_reset",
  "ambiguous_repeat",
  "lark_context_pollution",
  "source_grounding_audit",
  "local_math_then_review",
  "daily_learning_automation",
]);
async function callTeacherWithFallback(
  options: CliOptions,
  directApiFallbackPromptIds: string[],
  input: TeacherPrompt,
): Promise<string> {
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
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

  async function processTeacherPrompt(prompt: TeacherPrompt): Promise<void> {
    let lastError: unknown;
    try {
      for (let attempt = 0; attempt <= options.retries; attempt += 1) {
        try {
          const raw = options.mock
            ? JSON.stringify(mockTeacherPlan(prompt))
            : await callTeacherWithFallback(options, directApiFallbackPromptIds, prompt);
          acceptedCandidates.push(
            makeAcceptedCandidate(
              prompt,
              hardenTeacherPlanForPrompt(prompt, normalizeTeacherPlan(extractJson(raw))),
            ),
          );
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
      const reviewDir = path.join(
        options.workspaceDir,
        LARK_BRAIN_DISTILLATION_REVIEW_DIR,
        dateKey,
      );
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
