import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { parseFinanceModuleSelection } from "../../src/agents/finance-brain-orchestration.js";
import {
  buildFinanceCaseRun,
  caseflowFingerprint,
  readFinanceCaseRun,
  saveFinanceCaseRun,
} from "../../src/agents/finance-caseflow.js";
import { buildFinanceLearningModuleInput } from "../../src/agents/finance-module-execution.js";
import { FinanceResearchAssessment } from "../../src/agents/finance-research-assessment.js";
import type { FinanceResearchBatchTarget } from "../../src/agents/finance-research-batch-runner.js";
import {
  runFinanceResearchRun,
  type FinanceResearchRunOptions,
  type FinanceResearchRunReceipt,
} from "../../src/agents/finance-research-runner.js";
import {
  runQualityHarness,
  type QualityHarnessOptions,
  type QualityHarnessRequest,
  type QualityHarnessReceipt,
} from "../../src/agents/quality-harness.js";
import { openWritableFileWithinRoot, readFileWithinRoot } from "../../src/infra/fs-safe.js";
import { isPathInside } from "../../src/infra/path-guards.js";
import { runCheckpointedFinanceResearch } from "./lcx-finance-research-checkpoint-run.js";
import { DEFAULT_WORKSPACE_DIR } from "./lcx-local-paths.ts";

type CliOptions = {
  json: boolean;
  write: boolean;
  date?: string;
  caseBindings?: string;
  review: boolean;
  executeTask?: string;
  executeBatch: boolean;
  researchRequest?: string;
  researchRequestSha?: string;
  researchHost?: string;
  researchHostSha?: string;
  admissionFile?: string;
  admissionSha?: string;
};

type ResearchTask = {
  id: string;
  title: string;
  purpose: string;
  requiredFreshInputs: string[];
  output: string;
  invalidation: string[];
};

const INDEX_OPTION_UNIVERSE = ["SPX", "NDX", "QQQ", "SPY", "IWM", "VIX", "VVIX", "TLT"] as const;

const SEMICONDUCTOR_UNIVERSE = [
  "NVDA",
  "AMD",
  "AVGO",
  "TSM",
  "ASML",
  "MU",
  "ARM",
  "SMH",
  "SOXX",
] as const;

const DAILY_RESEARCH_TASKS: ResearchTask[] = [
  {
    id: "index_options_regime",
    title: "指数期权盘面",
    purpose: "判断指数风险是趋势、震荡、事件波动还是流动性冲击，不做方向押注。",
    requiredFreshInputs: [
      "SPX/NDX/QQQ/SPY 最新价格和成交量，带来源时间戳",
      "0DTE/1W/1M implied volatility、term structure、put/call skew",
      "VIX/VVIX、主要到期日、gamma exposure 或可替代公开代理",
      "FOMC/CPI/PCE/财报集中期等事件日历",
      "10Y/2Y 美债收益率、美元指数、流动性压力代理",
    ],
    output: "给出指数风险状态、关键触发器、缺口数据、失效条件和 next watch，不给买卖或仓位指令。",
    invalidation: [
      "缺少带时间戳的期权波动率或偏度数据",
      "只凭指数涨跌推断期权风险",
      "把 0DTE 噪音当成日频趋势结论",
    ],
  },
  {
    id: "semiconductor_leader_board",
    title: "半导体/AI 算力链",
    purpose: "盯住最能代表基本面和叙事变化的龙头、二线弹性、设备和存储链条。",
    requiredFreshInputs: [
      "NVDA/AMD/AVGO/TSM/ASML/MU/ARM 最新价格、成交量和相对 SMH/SOXX 强弱",
      "最新财报、指引、订单、毛利率、capex、库存或供应链证据",
      "估值口径：forward P/E、EV/Sales、gross margin trend 或明确缺失",
      "新闻和管理层表述必须标注来源、发布时间和可靠性等级",
    ],
    output: "给出强弱分层、基本面证据、估值/叙事风险、催化剂、反证和观察优先级。",
    invalidation: [
      "把单条新闻当成确定性因果",
      "没有财报/指引/订单证据就说基本面改善",
      "只因股价强就提升研究等级",
    ],
  },
  {
    id: "timely_stock_candidates",
    title: "当日候选股雷达",
    purpose: "从指数期权和半导体链条里抽出值得继续研究的候选，不输出买入清单。",
    requiredFreshInputs: [
      "相对强弱、成交量异常、期权 IV/skew 变化、事件日历",
      "财报/指引/政策/供应链/客户集中度等催化剂证据",
      "估值区间、安全边际、下行风险和拥挤度代理",
      "同业对比和反方证据",
    ],
    output: "输出 watchlist 分层：核心跟踪、需要数据、降权观察、丢弃；每个候选必须有证据和反证。",
    invalidation: ["候选变成直接推荐", "没有反证和失效条件", "只选半导体而忽略指数风险背景"],
  },
  {
    id: "risk_gate_and_learning_loop",
    title: "风险门和沉淀",
    purpose: "把每天的研究沉淀成可复用规则，而不是一次性评论。",
    requiredFreshInputs: [
      "当天被采用或被拒绝的候选理由",
      "数据冲突、来源缺失、模型分歧和错判复盘",
      "下一次可验证的相邻任务",
    ],
    output:
      "输出 reusable rule、risk boundary、invalidation condition、application example 和 application_ready/failedReason。",
    invalidation: ["把 receipt 当成已经学会", "没有相邻应用就说沉淀完成", "没有保留/降权/丢弃决定"],
  },
];

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-directed-daily-research-brief.ts [--json] [--write] [--date YYYY-MM-DD] [--case-bindings FILE] [--review [--research-host FILE --research-host-sha SHA]] [--execute-task ID | --execute-batch] [--research-request FILE --research-request-sha SHA --research-host FILE --research-host-sha SHA] [--admission-file FILE --admission-sha SHA]",
      "",
      "Builds the focused daily research product brief for index options and semiconductor/AI compute-chain research.",
      "Default plan/read does not run research. Explicit task execution reuses the bounded research owner; it does not configure paid models, send messages, train, or approve trades.",
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

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { json: false, write: false, review: false, executeBatch: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--review") {
      options.review = true;
    } else if (arg === "--execute-batch") {
      options.executeBatch = true;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--date") {
      options.date = readValue(args, index);
      index += 1;
    } else if (arg === "--case-bindings") {
      options.caseBindings = readValue(args, index);
      index += 1;
    } else if (
      [
        "--execute-task",
        "--research-request",
        "--research-request-sha",
        "--research-host",
        "--research-host-sha",
        "--admission-file",
        "--admission-sha",
      ].includes(arg)
    ) {
      const key = {
        "--execute-task": "executeTask",
        "--research-request": "researchRequest",
        "--research-request-sha": "researchRequestSha",
        "--research-host": "researchHost",
        "--research-host-sha": "researchHostSha",
        "--admission-file": "admissionFile",
        "--admission-sha": "admissionSha",
      }[arg] as
        | "executeTask"
        | "researchRequest"
        | "researchRequestSha"
        | "researchHost"
        | "researchHostSha"
        | "admissionFile"
        | "admissionSha";
      options[key] = readValue(args, index);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  if (options.review && !options.caseBindings) {
    usage();
  }
  if (
    options.executeTask || options.executeBatch
      ? !options.researchRequest ||
        !options.researchRequestSha ||
        !options.researchHost ||
        !options.researchHostSha ||
        options.caseBindings ||
        options.review ||
        (options.executeTask && options.executeBatch)
      : options.researchRequest ||
        options.researchRequestSha ||
        ((options.researchHost || options.researchHostSha) &&
          (!options.review || !options.researchHost || !options.researchHostSha))
  ) {
    usage();
  }
  if (
    Boolean(options.admissionFile) !== Boolean(options.admissionSha) ||
    ((options.admissionFile || options.admissionSha) &&
      !options.executeTask &&
      !options.executeBatch)
  ) {
    usage();
  }
  return options;
}

function dateKeyFromOption(date?: string): string {
  if (!date) {
    return new Date().toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    usage();
  }
  return date;
}

function workspaceDir(): string {
  return process.env.OPENCLAW_WORKSPACE_DIR || DEFAULT_WORKSPACE_DIR;
}

function buildVisibleBrief(dateKey: string): string {
  const taskLines = DAILY_RESEARCH_TASKS.map(
    (task, index) =>
      `${index + 1}. ${task.title}: ${task.output} 缺口先列数据和来源时间戳，不直接下结论。`,
  );
  return [
    `LCX 定向日频研究包 ${dateKey}`,
    "",
    "定位：开放问答只做入口保底，主产品每天专攻指数期权、半导体/AI 算力链和当日候选股雷达。",
    "",
    "固定研究宇宙：",
    `- 指数/期权: ${INDEX_OPTION_UNIVERSE.join(", ")}`,
    `- 半导体/AI 算力链: ${SEMICONDUCTOR_UNIVERSE.join(", ")}`,
    "",
    "每天固定产出：",
    ...taskLines,
    "",
    "硬边界：research-only；不输出买入、卖出、加仓、减仓、仓位比例或期权下注指令；所有当前数字必须带来源、时间戳、字段口径和冲突处理。",
  ].join("\n");
}

export function buildDirectedDailyResearchBrief(options: { date?: string } = {}) {
  const dateKey = dateKeyFromOption(options.date);
  return {
    ok: true,
    boundary: "local_directed_daily_research_brief_only",
    productMode: "focused_daily_research_product_not_open_ended_chat",
    executionStatus: "planning_contract_only",
    researchPacketStatus: "not_produced",
    missingForPacket: [
      "source-bound fresh inputs from finance_data_gateway",
      "executed finance research receipt linked to this brief",
      "reviewed daily research packet with explicit gaps and candidate evidence",
    ],
    date: dateKey,
    thesis:
      "The 8-positive/14-negative visible-answer fuzzer is a guardrail, not enough coverage for all future open-ended asks; daily focused research should carry the product value.",
    focus: {
      primary: "index_options_and_semiconductor_ai_compute_chain",
      secondary: "timely_stock_candidate_radar",
      cadence: "daily_low_frequency_research",
      ownerVisibleGoal:
        "Give the owner one useful daily research packet instead of forcing every value through open-ended chat.",
    },
    universe: {
      indexOptions: INDEX_OPTION_UNIVERSE,
      semiconductorAiCompute: SEMICONDUCTOR_UNIVERSE,
    },
    tasks: DAILY_RESEARCH_TASKS,
    outputContract: {
      visibleSections: [
        "one_sentence_market_state",
        "index_options_regime",
        "semiconductor_leader_board",
        "timely_stock_candidates",
        "risk_gates_and_missing_data",
        "invalidation_and_next_watch",
        "learning_sedimentation",
      ],
      requiredEvidence: [
        "source_name_or_artifact",
        "source_timestamp",
        "field_definition",
        "unit_or_currency",
        "provider_role",
        "conflict_or_missing_data_status",
      ],
      forbiddenVisibleOutputs: [
        "buy_sell_add_reduce_instruction",
        "position_percentage",
        "options_bet_instruction",
        "unverified_current_price_or_iv",
        "prediction_without_invalidation",
      ],
    },
    learningContract: {
      sourceNameAndPathRequired: true,
      reusableDecisionRuleRequired: true,
      riskBoundaryRequired: true,
      invalidationConditionRequired: true,
      applicationExampleRequired: true,
      terminalDecision: "application_ready_or_failedReason",
    },
    openQuestionBoundary: {
      qaStillUsefulForFollowups: true,
      qaGuardrailOnly:
        "Short-answer fuzzers prevent bad replies; they do not replace a focused daily research product.",
      unknownAskFallback:
        "Classify the ask, answer directly if safe, otherwise return the missing evidence and route into the daily research queue.",
    },
    visibleBrief: buildVisibleBrief(dateKey),
    notTouched: [
      "external_channel_sender",
      "provider_config",
      "protected_memory",
      "training_processes",
      "trade_execution",
    ],
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const DirectedResearchHost = z
  .object({
    accountId: z.string().trim().min(1).max(128),
    runId: z.string().trim().min(1).max(128),
    maxModelCalls: z.number().int().positive(),
    maxApiCalls: z.number().int().positive(),
  })
  .strict();
const DirectedBatchParent = DirectedResearchHost.extend({
  date: z.string(),
  asOf: z.string().datetime({ offset: true }),
  request: z.object({ path: z.string(), sha256: Hash }),
  tasks: z
    .array(
      z.object({
        taskId: z.string(),
        request: z.object({ path: z.string(), sha256: Hash }),
        allocation: z.object({
          maxApiCalls: z.number().int().nonnegative(),
          maxModelCalls: z.number().int().nonnegative(),
        }),
      }),
    )
    .length(4),
});

const TaskBinding = z.object({
  taskId: z.string(),
  caseId: z.string(),
  ref: Hash,
  caseSha256: Hash,
  snapshotFingerprint: Hash,
  ask: z.string().min(1),
  targets: z.array(z.string().min(1)).min(1),
});
const CaseBindings = z.object({
  schemaVersion: z.literal("lcx_directed_daily_case_bindings_v1"),
  date: z.string(),
  asOf: z.string().datetime({ offset: true }),
  caseDirectory: z.string().min(1),
  tasks: z.array(TaskBinding).max(4),
  parent: DirectedBatchParent.optional(),
});

/** The producer can use this original task request; a case name alone never binds a task. */
function legacyDirectedTaskAsk(taskId: string): string {
  const task = DAILY_RESEARCH_TASKS.find((item) => item.id === taskId);
  if (!task) {
    throw new Error("unknown_directed_task");
  }
  return [
    task.title,
    task.purpose,
    ...task.requiredFreshInputs,
    task.output,
    ...task.invalidation,
  ].join("\n");
}

export function buildDirectedTaskAsk(taskId: string): string {
  const ask = legacyDirectedTaskAsk(taskId);
  if (taskId !== "timely_stock_candidates") {
    return ask;
  }
  return `${ask}
Save supportingAnalysis.directedWatchlist with all four arrays: coreTracking, needsData, downrankObservation, discarded. Each entry must contain instrument, reason, evidenceIds referring to this case's original evidence, counterEvidenceIds or an explicit counterEvidenceGap, and invalidation. Instruments must belong to the supplied directed universe. Empty groups are allowed; if all groups are empty, supply an explicit evidenceGap. Keep this selected field within 4096 UTF-8 bytes. Structure and source references do not establish semantic correctness or trading authority.`;
}

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readPrivateFile(root: string, file: string): Promise<Buffer> {
  const absolute = path.resolve(root, file);
  if (!isPathInside(root, absolute)) {
    throw new Error("case_source_outside_workspace");
  }
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) {
      throw new Error("case_source_symlink");
    }
  }
  const before = await fs.stat(absolute);
  if (!before.isFile() || before.nlink !== 1 || before.size > 16 * 1024 * 1024) {
    throw new Error("case_source_invalid_file");
  }
  const bytes = await fs.readFile(absolute);
  const after = await fs.stat(absolute);
  if (
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    bytes.length !== after.size
  ) {
    throw new Error("case_source_changed");
  }
  return bytes;
}

async function readDirectedReviewHost(workspace: string, file: string, expectedSha256: string) {
  const root = await fs.realpath(workspace);
  const bytes = await readPrivateFile(root, file);
  if (bytes.length > 64 * 1024 || sha(bytes) !== Hash.parse(expectedSha256)) {
    throw new Error("directed_review_host_hash_or_size_conflict");
  }
  return DirectedResearchHost.parse(JSON.parse(bytes.toString("utf8")));
}

type CaseSection = {
  taskId: string;
  status: "read_ready" | "held";
  contentAcceptance: "review_required" | "not_observed";
  gaps: string[];
  source?: {
    caseId: string;
    runId: string;
    caseRevision: string;
    ref: string;
    sourceRef: string;
    sourceSha256: string;
    snapshotFingerprint: string;
  };
  packet?: Awaited<ReturnType<typeof readFinanceCaseRun>>["packet"];
  evidence?: Awaited<ReturnType<typeof readFinanceCaseRun>>["run"]["evidence"];
  originalSnapshot?: Awaited<ReturnType<typeof readFinanceCaseRun>>["run"]["snapshot"];
  learningApplication?: Awaited<ReturnType<typeof readDirectedLearningUsageReceipt>>;
};

/** Observe an original apply usage file, not successful adjacent application or learning. */
export async function readDirectedLearningUsageReceipt(options: {
  workspaceDir: string;
  queryText: string;
  toolCallId: string;
  toolResult: unknown;
  execution?: unknown;
  recordedAt?: string;
  host?: { accountId: string; runId: string };
  signal?: AbortSignal;
}) {
  const result: {
    status: "not_observed" | "refused" | "scaffold_ready" | "failed";
    sourceReadStatus: "not_observed" | "verified" | "failed";
    source?: { path: string; sha256: string; bytes: number };
    observedToolDecision?: "refused" | "scaffold_ready";
    failureReason?: string;
    candidateCount?: number;
    observationScope?: { accountId: string; runId: string };
    gaps: string[];
  } = {
    status: "not_observed",
    sourceReadStatus: "not_observed",
    gaps: ["adjacent_task_application_not_observed"],
  };
  const summary = z
    .object({
      boundary: z.literal("finance_learning_capability_apply_read_only"),
      ok: z.boolean(),
      queryText: z.string(),
      usageReceiptPath: z.string().optional(),
      usageReceiptSource: z
        .object({ path: z.string(), sha256: Hash, bytes: z.number().int().positive() })
        .nullish(),
    })
    .safeParse(options.toolResult);
  if (!summary.success || !summary.data.usageReceiptSource) {
    result.gaps.push("learning_application_receipt_pin_not_observed");
    return result;
  }
  try {
    options.signal?.throwIfAborted();
    const pin = summary.data.usageReceiptSource;
    if (
      !/^memory\/finance-learning-apply-usage-receipts\/\d{4}-\d{2}-\d{2}\/[^/\\]+\.json$/u.test(
        pin.path,
      ) ||
      pin.bytes > 64 * 1024 ||
      pin.path !== summary.data.usageReceiptPath ||
      summary.data.queryText !== options.queryText
    ) {
      throw new Error("learning_application_receipt_reference_conflict");
    }
    const root = await fs.realpath(options.workspaceDir);
    let current = root;
    for (const part of pin.path.split("/")) {
      current = path.join(current, part);
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error("learning_application_receipt_alias");
      }
    }
    const { buffer, realPath } = await readFileWithinRoot({
      rootDir: root,
      relativePath: pin.path,
      rejectHardlinks: true,
      maxBytes: 64 * 1024,
    });
    options.signal?.throwIfAborted();
    if (realPath !== path.resolve(root, pin.path)) {
      throw new Error("learning_application_receipt_alias");
    }
    if (buffer.length !== pin.bytes || sha(buffer) !== pin.sha256) {
      throw new Error("learning_application_receipt_hash_conflict");
    }
    const usage = z
      .object({
        boundary: z.literal("finance_learning_capability_apply_usage_receipt"),
        toolCallId: z.string(),
        generatedAt: z.string().datetime(),
        queryText: z.string(),
        ok: z.boolean(),
        reason: z.string().nullable(),
        candidateCount: z.number().int().nonnegative(),
      })
      .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)));
    if (
      usage.toolCallId !== options.toolCallId ||
      usage.queryText !== options.queryText ||
      usage.ok !== summary.data.ok ||
      (options.recordedAt &&
        (!Number.isFinite(Date.parse(options.recordedAt)) ||
          Date.parse(usage.generatedAt) > Date.parse(options.recordedAt)))
    ) {
      throw new Error("learning_application_receipt_caller_or_time_conflict");
    }
    result.sourceReadStatus = "verified";
    result.source = pin;
    result.candidateCount = usage.candidateCount;
    result.observedToolDecision = usage.ok ? "scaffold_ready" : "refused";
    if (!usage.ok) {
      result.failureReason = usage.reason ?? "finance_learning_capability_apply_failed";
      result.gaps.push(result.failureReason);
    }
    const execution = z
      .object({ accountId: z.string(), runId: z.string(), taskId: z.string() })
      .safeParse(options.execution);
    if (!options.host || !execution.success) {
      result.gaps.push("learning_application_host_not_observed");
    } else if (
      execution.data.accountId !== options.host.accountId ||
      execution.data.runId !== options.host.runId ||
      execution.data.taskId !== "risk_gate_and_learning_loop"
    ) {
      throw new Error("learning_application_host_scope_conflict");
    } else if (!options.recordedAt) {
      result.gaps.push("learning_application_case_clock_not_observed");
    } else {
      result.observationScope = {
        accountId: execution.data.accountId,
        runId: execution.data.runId,
      };
      result.status = result.observedToolDecision;
    }
  } catch (error) {
    result.status = "failed";
    result.sourceReadStatus = "failed";
    delete result.source;
    delete result.observedToolDecision;
    delete result.observationScope;
    result.gaps.push(
      error instanceof Error && error.message.startsWith("learning_application_")
        ? error.message
        : "learning_application_receipt_unreadable_or_invalid",
    );
  }
  return result;
}

/** Read existing native runs only. This caller has no research/model execution route. */
function directedSourceJobGaps(
  jobs: readonly {
    status: string;
    freshnessWarnings: readonly string[];
    conflicts: readonly string[];
    missingEvidence: readonly string[];
  }[],
): string[] {
  return jobs.flatMap((job, index) =>
    job.status !== "ready" ||
    job.freshnessWarnings.length ||
    job.conflicts.length ||
    job.missingEvidence.length
      ? [
          `case_source_job:${index}:${job.status}:${[...job.freshnessWarnings, ...job.conflicts, ...job.missingEvidence].join(",")}`,
        ]
      : [],
  );
}

export async function readDirectedDailyCases(options: {
  date?: string;
  bindingsFile: string;
  workspaceDir: string;
  batchHost?: z.infer<typeof DirectedResearchHost>;
  signal?: AbortSignal;
}) {
  const brief = buildDirectedDailyResearchBrief(options);
  const requestedRoot = path.resolve(options.workspaceDir);
  const requestedBinding = path.resolve(requestedRoot, options.bindingsFile);
  let root: string;
  let bytes: Buffer | undefined;
  let bindings: z.infer<typeof CaseBindings>;
  const bindingRelativePath = path.relative(requestedRoot, requestedBinding);
  try {
    if (!isPathInside(requestedRoot, requestedBinding)) {
      throw new Error("case_source_outside_workspace");
    }
    root = await fs.realpath(requestedRoot);
    bytes = await readPrivateFile(root, bindingRelativePath);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error("binding_invalid_json_or_utf8");
    }
    const parsed = CaseBindings.safeParse(value);
    if (!parsed.success) {
      throw new Error("binding_contract_invalid");
    }
    bindings = parsed.data;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const gap = code
      ? `binding_read_failed:${code}`
      : error instanceof Error && /^(?:case_source_|binding_)/u.test(error.message)
        ? error.message
        : "binding_read_failed";
    return finishDirectedCaseRead(
      brief,
      DAILY_RESEARCH_TASKS.map((task) => ({
        taskId: task.id,
        status: "held",
        contentAcceptance: "not_observed",
        gaps: [gap],
      })),
      bytes ? { sourceRef: bindingRelativePath, sourceSha256: sha(bytes) } : undefined,
      "failed",
    );
  }
  const globalGaps: string[] = [];
  if (bindings.date !== brief.date || bindings.asOf.slice(0, 10) !== brief.date) {
    globalGaps.push("binding_date_asof_mismatch");
  }
  if (
    bindings.tasks.some((item) => !DAILY_RESEARCH_TASKS.some((task) => task.id === item.taskId)) ||
    new Set(bindings.tasks.map((item) => item.taskId)).size !== bindings.tasks.length
  ) {
    globalGaps.push("binding_unknown_or_duplicate_task");
  }
  if (bindings.parent) {
    const parent = bindings.parent;
    try {
      const originalBytes = await readPrivateFile(root, parent.request.path);
      if (sha(originalBytes) !== parent.request.sha256) {
        throw new Error("batch_parent_request_hash_conflict");
      }
      const declared = DirectedBatchRequest.parse(JSON.parse(originalBytes.toString("utf8")));
      if (
        declared.date !== parent.date ||
        declared.asOf !== parent.asOf ||
        ["accountId", "runId", "maxApiCalls", "maxModelCalls"].some(
          (key) => declared[key as keyof typeof declared] !== parent[key as keyof typeof parent],
        ) ||
        parent.tasks.some(
          (task) =>
            caseflowFingerprint(task.request) !==
            caseflowFingerprint(
              declared.tasks.find((item) => item.taskId === task.taskId)?.request,
            ),
        )
      ) {
        throw new Error("batch_parent_request_scope_conflict");
      }
    } catch (error) {
      globalGaps.push(
        error instanceof Error && error.message.startsWith("batch_parent_")
          ? error.message
          : "batch_parent_request_unreadable",
      );
    }
    if (!options.batchHost) {
      globalGaps.push("batch_host_scope_not_observed");
    } else if (
      Object.entries(options.batchHost).some(
        ([key, value]) => parent[key as keyof typeof options.batchHost] !== value,
      )
    ) {
      globalGaps.push("batch_host_scope_conflict");
    }
    if (
      parent.date !== bindings.date ||
      parent.asOf !== bindings.asOf ||
      new Set(parent.tasks.map((item) => item.taskId)).size !== 4 ||
      parent.tasks.some((item) => !DAILY_RESEARCH_TASKS.some((task) => task.id === item.taskId)) ||
      parent.tasks.reduce((sum, item) => sum + item.allocation.maxApiCalls, 0) >
        parent.maxApiCalls ||
      parent.tasks.reduce((sum, item) => sum + item.allocation.maxModelCalls, 0) >
        parent.maxModelCalls
    ) {
      globalGaps.push("batch_parent_scope_or_budget_conflict");
    }
  }
  const sections: CaseSection[] = [];
  for (const task of DAILY_RESEARCH_TASKS) {
    const section: CaseSection = {
      taskId: task.id,
      status: "held",
      contentAcceptance: "not_observed",
      gaps: [...globalGaps],
    };
    sections.push(section);
    const binding = bindings.tasks.find((item) => item.taskId === task.id);
    if (!binding) {
      section.gaps.push("task_case_not_observed");
      continue;
    }
    if (globalGaps.length) {
      continue;
    }
    try {
      const directory = path.resolve(root, bindings.caseDirectory);
      const sourcePath = path.join(directory, `${binding.ref}.json`);
      const originalBytes = await readPrivateFile(root, sourcePath);
      if (sha(originalBytes) !== binding.caseSha256) {
        throw new Error("case_source_hash_conflict");
      }
      const run = await readFinanceCaseRun(directory, binding.ref);
      if (sha(await readPrivateFile(root, sourcePath)) !== sha(originalBytes)) {
        throw new Error("case_source_changed");
      }
      if (bindings.parent) {
        const parent = bindings.parent;
        const allocated = parent.tasks.find((item) => item.taskId === task.id);
        const execution = z
          .object({
            accountId: z.string(),
            runId: z.string(),
            taskId: z.string(),
            request: z.object({ path: z.string(), sha256: Hash }),
            allocation: z.object({ maxApiCalls: z.number(), maxModelCalls: z.number() }),
          })
          .parse(run.run.execution);
        if (
          !allocated ||
          execution.accountId !== parent.accountId ||
          execution.runId !== parent.runId ||
          execution.taskId !== task.id ||
          caseflowFingerprint(execution.request) !== caseflowFingerprint(allocated.request) ||
          caseflowFingerprint(execution.allocation) !== caseflowFingerprint(allocated.allocation)
        ) {
          throw new Error("case_batch_parent_scope_or_request_conflict");
        }
        const nativeBudget = z
          .object({
            maxApiCalls: z.number().int().positive().refine(Number.isSafeInteger),
            reservedCallBudget: z.number().int().nonnegative().refine(Number.isSafeInteger),
          })
          .safeParse((run.run.snapshot.batch as Record<string, unknown> | undefined)?.budget);
        const nativeModel = z
          .object({
            maxModelCalls: z.number().int().positive().refine(Number.isSafeInteger),
            reservedModelCalls: z.number().int().nonnegative().refine(Number.isSafeInteger),
          })
          .safeParse(run.run.snapshot.modelCheckpoint);
        if (!nativeBudget.success || !nativeModel.success) {
          throw new Error("case_batch_native_budget_not_observed");
        }
        if (
          nativeBudget.data.maxApiCalls !== allocated.allocation.maxApiCalls ||
          nativeBudget.data.reservedCallBudget > allocated.allocation.maxApiCalls ||
          nativeModel.data.maxModelCalls !== allocated.allocation.maxModelCalls ||
          nativeModel.data.reservedModelCalls > allocated.allocation.maxModelCalls
        ) {
          throw new Error("case_batch_native_budget_conflict");
        }
        if (sha(await readPrivateFile(root, execution.request.path)) !== execution.request.sha256) {
          throw new Error("case_batch_request_hash_conflict");
        }
      }
      const plan = z
        .object({
          ask: z.string(),
          asOf: z.string(),
          decisionMode: z.string(),
          targets: z.array(z.object({ instrument: z.string() })),
        })
        .parse(run.run.snapshot.plan);
      if (
        run.case.id !== binding.caseId ||
        run.run.snapshotFingerprint !== binding.snapshotFingerprint
      ) {
        throw new Error("case_identity_conflict");
      }
      if (
        (binding.ask !== buildDirectedTaskAsk(task.id) &&
          !(
            task.id === "timely_stock_candidates" && binding.ask === legacyDirectedTaskAsk(task.id)
          )) ||
        plan.ask !== binding.ask ||
        run.case.question !== binding.ask ||
        run.case.definition.question !== binding.ask
      ) {
        throw new Error("case_task_ask_mismatch");
      }
      if (
        plan.asOf !== bindings.asOf ||
        run.case.asOf !== bindings.asOf ||
        run.case.definition.asOf !== bindings.asOf
      ) {
        throw new Error("case_asof_mismatch");
      }
      const targets = plan.targets.map((target) => target.instrument).toSorted();
      const universe: readonly string[] =
        task.id === "index_options_regime"
          ? INDEX_OPTION_UNIVERSE
          : task.id === "semiconductor_leader_board"
            ? SEMICONDUCTOR_UNIVERSE
            : [...INDEX_OPTION_UNIVERSE, ...SEMICONDUCTOR_UNIVERSE];
      if (
        JSON.stringify(targets) !== JSON.stringify([...binding.targets].toSorted()) ||
        new Set(targets).size !== targets.length ||
        targets.some((target) => !universe.includes(target)) ||
        caseflowFingerprint(run.case.definition.targets) !==
          caseflowFingerprint((run.run.snapshot.plan as Record<string, unknown>).targets)
      ) {
        throw new Error("case_target_scope_mismatch");
      }
      if (plan.decisionMode !== "research_only") {
        throw new Error("case_research_boundary_mismatch");
      }
      const quarterly = z
        .object({
          candidateAnalysis: z.string().optional(),
          candidateClaims: z
            .array(
              z.object({
                id: z.string(),
                text: z.string(),
                evidenceIds: z.array(z.string()),
              }),
            )
            .optional(),
        })
        .parse(run.run.snapshot.quarterlyOutput);
      const bodyClaims = run.packet.claims.map(({ id, text, evidenceIds }) => ({
        id,
        text,
        evidenceIds,
      }));
      if (
        run.packet.analysis !== quarterly.candidateAnalysis ||
        caseflowFingerprint(bodyClaims) !== caseflowFingerprint(quarterly.candidateClaims ?? [])
      ) {
        throw new Error("case_packet_snapshot_conflict");
      }
      section.source = {
        caseId: run.case.id,
        runId: run.run.id,
        caseRevision: run.case.revision,
        ref: binding.ref,
        sourceRef: path.relative(root, sourcePath),
        sourceSha256: sha(originalBytes),
        snapshotFingerprint: run.run.snapshotFingerprint,
      };
      section.packet = run.packet;
      section.evidence = run.run.evidence;
      section.originalSnapshot = run.run.snapshot;
      const snapshot = z
        .object({
          status: z.string(),
          gates: z.array(z.object({ id: z.string(), passed: z.boolean(), reason: z.string() })),
          quality: z
            .object({ status: z.string(), quality: z.object({ passed: z.boolean() }) })
            .optional(),
        })
        .parse(run.run.snapshot);
      section.gaps.push(...run.packet.gaps);
      const batch = z
        .object({
          asOf: z.string(),
          committeeEvidence: z.unknown(),
          jobs: z.array(
            z.object({
              status: z.string(),
              freshnessWarnings: z.array(z.string()),
              conflicts: z.array(z.string()),
              missingEvidence: z.array(z.string()),
            }),
          ),
        })
        .optional()
        .parse(run.run.snapshot.batch);
      if (!batch || batch.asOf !== bindings.asOf || batch.jobs.length === 0) {
        section.gaps.push("case_source_batch_missing_or_scope_conflict");
      } else {
        if (
          caseflowFingerprint(batch.committeeEvidence) !== caseflowFingerprint(run.run.evidence)
        ) {
          section.gaps.push("case_evidence_snapshot_conflict");
        }
        section.gaps.push(...directedSourceJobGaps(batch.jobs));
      }
      if (snapshot.status !== "candidate" || run.packet.status !== "candidate") {
        section.gaps.push(`case_status:${snapshot.status}/${run.packet.status}`);
      }
      for (const required of ["source", "quality"]) {
        if (!snapshot.gates.some((gate) => gate.id === required && gate.passed)) {
          section.gaps.push(`case_required_gate:${required}`);
        }
      }
      section.gaps.push(
        ...snapshot.gates.filter((gate) => !gate.passed).map((gate) => `${gate.id}:${gate.reason}`),
      );
      if (snapshot.quality?.status !== "verified" || !snapshot.quality.quality.passed) {
        section.gaps.push("case_quality_not_verified");
      }
      if (!run.packet.analysis || run.packet.claims.length === 0 || run.run.evidence.length === 0) {
        section.gaps.push("case_content_or_evidence_missing");
      }
      const evidenceIds = new Set(run.run.evidence.map((item) => item.id));
      if (
        run.packet.claims.some(
          (claim) =>
            claim.referenceStatus !== "linked" ||
            claim.evidenceIds.length === 0 ||
            claim.evidenceIds.some((id) => !evidenceIds.has(id)),
        )
      ) {
        section.gaps.push("case_claim_reference_unresolved");
      }
      if (task.id === "risk_gate_and_learning_loop") {
        const learning = z
          .object({
            nodes: z.array(
              z.object({
                moduleId: z.string(),
                toolCalls: z.array(
                  z.object({ toolName: z.string(), outputSummary: z.string().optional() }),
                ),
              }),
            ),
          })
          .safeParse(run.run.snapshot.moduleExecution);
        const calls = learning.success
          ? learning.data.nodes
              .filter((node) => node.moduleId === "finance_learning_memory")
              .flatMap((node) => node.toolCalls)
              .filter((call) => call.toolName === "finance_learning_capability_apply")
          : [];
        let toolResult: unknown;
        if (calls.length === 1 && calls[0]?.outputSummary) {
          try {
            toolResult = JSON.parse(calls[0].outputSummary);
          } catch {
            // A clipped original tool summary cannot supply a verified pin.
          }
        }
        section.learningApplication = await readDirectedLearningUsageReceipt({
          workspaceDir: root,
          queryText: buildFinanceLearningModuleInput(plan.ask, plan.asOf, run.run.evidence)
            .queryText,
          toolCallId: "finance-module:finance_learning_capability_apply",
          toolResult,
          execution: run.run.execution,
          recordedAt: run.run.recordedAt,
          host: options.batchHost,
          signal: options.signal,
        });
        section.gaps.push(...section.learningApplication.gaps);
      }
      if (!section.gaps.length) {
        section.status = "read_ready";
        section.contentAcceptance = "review_required";
      }
    } catch (error) {
      section.gaps.push(error instanceof Error ? error.message : "case_read_failed");
    }
  }
  options.signal?.throwIfAborted();
  const read = finishDirectedCaseRead(brief, sections, {
    sourceRef: bindingRelativePath,
    sourceSha256: sha(bytes),
  });
  return {
    ...read,
    ...(await recoverDirectedExecution(root, read, options.batchHost, options.signal)),
  };
}

function finishDirectedCaseRead(
  brief: ReturnType<typeof buildDirectedDailyResearchBrief>,
  sections: CaseSection[],
  caseBindingsSource?: { sourceRef: string; sourceSha256: string },
  caseBindingReadStatus: "read" | "failed" = "read",
) {
  const missingForPacket = sections.flatMap((section) =>
    section.gaps.map((gap) => `${section.taskId}:${gap}`),
  );
  missingForPacket.push("daily_task_content_review_not_observed");
  return {
    ...brief,
    ok: caseBindingReadStatus !== "failed",
    executionStatus: "existing_cases_read_only",
    researchPacketStatus: sections.some((section) => section.status === "read_ready")
      ? "partial_sections"
      : "held",
    caseBindingsSource,
    caseBindingReadStatus,
    packetCandidateSections: sections,
    contentAcceptance: "review_required",
    executionProvenance: {
      status: "not_observed" as const,
      reason: "directed_original_execution_not_observed",
    },
    missingForPacket,
    visibleBrief: [
      brief.visibleBrief,
      "",
      "已有研究包（只读；完整日包仍待内容与任务覆盖验收）：",
      ...sections.map((section) =>
        [
          `\n${section.taskId}: ${section.status}; ${section.contentAcceptance}`,
          section.source
            ? `来源: ${section.source.sourceRef} SHA256=${section.source.sourceSha256}`
            : "来源: 未观察",
          section.status === "read_ready"
            ? (section.packet?.analysis ?? "")
            : "正文未作为可用结论采用。",
          ...(section.status === "read_ready"
            ? (section.packet?.claims.map(
                (claim) => `${claim.text} [${claim.evidenceIds.join(", ")}]`,
              ) ?? [])
            : []),
          `缺口: ${section.gaps.join("; ") || "原来源/质量门已通过，任务正文仍待审查"}`,
        ].join("\n"),
      ),
    ].join("\n"),
  };
}

const DirectedReviewInput = z.object({
  date: z.string(),
  caseBindingsSource: z.object({ sourceRef: z.string(), sourceSha256: Hash }),
  caseBindingReadStatus: z.literal("read"),
  packetCandidateSections: z
    .array(
      z.object({
        taskId: z.string(),
        status: z.enum(["read_ready", "held"]),
        gaps: z.array(z.string()),
        source: z
          .object({
            caseId: z.string(),
            runId: z.string(),
            caseRevision: z.string(),
            ref: Hash,
            sourceRef: z.string(),
            sourceSha256: Hash,
            snapshotFingerprint: Hash,
          })
          .optional(),
        packet: z
          .object({
            analysis: z.string(),
            supportingAnalysis: z
              .object({
                directedWatchlist: z.unknown().optional(),
                causalHypotheses: z.unknown().optional(),
              })
              .optional(),
            claims: z.array(
              z.object({
                id: z.string(),
                text: z.string(),
                evidenceIds: z.array(z.string()),
              }),
            ),
          })
          .optional(),
        evidence: z
          .array(
            z.object({
              id: z.string(),
              text: z.string(),
              source: z.string(),
              timestamp: z.string(),
            }),
          )
          .optional(),
      }),
    )
    .max(4),
});

const DirectedWatchlistEntry = z
  .object({
    instrument: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => value.trim().length > 0),
    reason: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => value.trim().length > 0),
    evidenceIds: z.array(z.string().min(1).max(128)).min(1).max(16),
    counterEvidenceIds: z.array(z.string().min(1).max(128)).max(16).optional(),
    counterEvidenceGap: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => value.trim().length > 0)
      .optional(),
    invalidation: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => value.trim().length > 0),
  })
  .passthrough();
const DirectedWatchlist = z
  .object({
    coreTracking: z.array(DirectedWatchlistEntry).max(32),
    needsData: z.array(DirectedWatchlistEntry).max(32),
    downrankObservation: z.array(DirectedWatchlistEntry).max(32),
    discarded: z.array(DirectedWatchlistEntry).max(32),
    evidenceGap: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => value.trim().length > 0)
      .optional(),
  })
  .passthrough();

/** Structural checks consume the original case field, never interpret missing data as a watchlist. */
function inspectDirectedWatchlist(
  section: z.infer<typeof DirectedReviewInput>["packetCandidateSections"][number],
) {
  if (section.taskId !== "timely_stock_candidates") {
    return { gaps: [] as string[] };
  }
  const value = section.packet?.supportingAnalysis?.directedWatchlist;
  const prefix = "daily_task_watchlist";
  if (value === undefined) {
    return { gaps: [`${prefix}_missing`] };
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 4096) {
    return {
      gaps: [`${prefix}_input_budget_exceeded`],
      selected: { omitted: "input_budget_exceeded", limitBytes: 4096 },
    };
  }
  const parsed = DirectedWatchlist.safeParse(value);
  if (!parsed.success) {
    return { gaps: [`${prefix}_structure_invalid`], selected: value };
  }
  const ids = new Set(section.evidence?.map((item) => item.id));
  const universe = new Set<string>([...INDEX_OPTION_UNIVERSE, ...SEMICONDUCTOR_UNIVERSE]);
  const entries = [
    parsed.data.coreTracking,
    parsed.data.needsData,
    parsed.data.downrankObservation,
    parsed.data.discarded,
  ].flat();
  const gaps: string[] = [];
  if (!entries.length && !parsed.data.evidenceGap) {
    gaps.push(`${prefix}_empty_without_evidence_gap`);
  }
  entries.forEach((entry, index) => {
    if (!universe.has(entry.instrument)) {
      gaps.push(`${prefix}_instrument_outside_universe:${index}`);
    }
    if ([...entry.evidenceIds, ...(entry.counterEvidenceIds ?? [])].some((id) => !ids.has(id))) {
      gaps.push(`${prefix}_evidence_reference_unresolved:${index}`);
    }
    if (!entry.counterEvidenceIds?.length && !entry.counterEvidenceGap) {
      gaps.push(`${prefix}_counterevidence_not_observed:${index}`);
    }
  });
  const mapEntries = (entries: z.infer<typeof DirectedWatchlistEntry>[]) =>
    entries.map((entry) => ({
      ...entry,
      evidenceIds: entry.evidenceIds.map((id) => `${section.taskId}:${id}`),
      ...(entry.counterEvidenceIds
        ? {
            counterEvidenceIds: entry.counterEvidenceIds.map((id) => `${section.taskId}:${id}`),
          }
        : {}),
    }));
  const selected = {
    ...parsed.data,
    coreTracking: mapEntries(parsed.data.coreTracking),
    needsData: mapEntries(parsed.data.needsData),
    downrankObservation: mapEntries(parsed.data.downrankObservation),
    discarded: mapEntries(parsed.data.discarded),
  };
  if (Buffer.byteLength(JSON.stringify(selected), "utf8") > 4096) {
    return {
      gaps: [...gaps, `${prefix}_input_budget_exceeded`],
      selected: { omitted: "input_budget_exceeded", limitBytes: 4096 },
    };
  }
  return { gaps, selected };
}

function inspectDirectedCausalHypotheses(
  section: z.infer<typeof DirectedReviewInput>["packetCandidateSections"][number],
): { gaps: string[]; selected?: unknown } {
  const value = section.packet?.supportingAnalysis?.causalHypotheses;
  if (value === undefined) {
    return { gaps: [] };
  }
  const field = "/packet/supportingAnalysis/causalHypotheses";
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 4096) {
    return {
      gaps: ["daily_task_causal_input_budget_exceeded"],
      selected: { omitted: "input_budget_exceeded", field, limitBytes: 4096 },
    };
  }
  const parsed = FinanceResearchAssessment.shape.causalHypotheses.safeParse(value);
  if (!parsed.success) {
    return {
      gaps: ["daily_task_causal_structure_invalid"],
      selected: { omitted: "structure_invalid", field },
    };
  }
  const ids = new Set(section.evidence?.map((item) => item.id));
  const gaps: string[] = [];
  if (new Set(parsed.data.map((item) => item.id)).size !== parsed.data.length) {
    gaps.push("daily_task_causal_duplicate_id");
  }
  if (parsed.data.some((item) => item.evidenceIds.some((id) => !ids.has(id)))) {
    gaps.push("daily_task_causal_evidence_reference_unresolved");
  }
  const selected = parsed.data.map((item) => ({
    ...item,
    evidenceIds: item.evidenceIds.map((id) => `${section.taskId}:${id}`),
  }));
  if (Buffer.byteLength(JSON.stringify(selected), "utf8") > 4096) {
    return {
      gaps: [...gaps, "daily_task_causal_input_budget_exceeded"],
      selected: { omitted: "namespaced_input_budget_exceeded", field, limitBytes: 4096 },
    };
  }
  return { gaps, selected };
}

/** Pure reconstruction from unchanged reader fields; a completion label is never sufficient. */
export function buildDirectedContentReviewInput(value: unknown) {
  const read = DirectedReviewInput.parse(value);
  const candidates = read.packetCandidateSections.filter(
    (section) => section.status === "read_ready",
  );
  if (!candidates.length) {
    throw new Error("daily_task_reviewable_sections_not_observed");
  }
  for (const section of candidates) {
    buildDirectedTaskAsk(section.taskId);
    if (
      section.gaps.length ||
      !section.source ||
      !section.packet?.analysis ||
      !section.evidence?.length
    ) {
      throw new Error("daily_task_review_input_incomplete");
    }
    const ids = new Set(section.evidence.map((item) => item.id));
    if (
      !section.packet.claims.length ||
      section.packet.claims.some(
        (claim) => !claim.evidenceIds.length || claim.evidenceIds.some((id) => !ids.has(id)),
      )
    ) {
      throw new Error("daily_task_review_claim_reference_unresolved");
    }
  }
  // Do not forward unrelated supportingAnalysis, even when other tasks persist it.
  for (const section of read.packetCandidateSections) {
    if (section.taskId !== "timely_stock_candidates" && section.packet) {
      const causalHypotheses = section.packet.supportingAnalysis?.causalHypotheses;
      section.packet.supportingAnalysis =
        causalHypotheses === undefined ? undefined : { causalHypotheses };
    }
  }
  const watchlists = new Map(
    candidates.map((section) => [section.taskId, inspectDirectedWatchlist(section)]),
  );
  const causalHypotheses = new Map(
    candidates.map((section) => [section.taskId, inspectDirectedCausalHypotheses(section)]),
  );
  const structuralGaps = [...watchlists.values(), ...causalHypotheses.values()].flatMap(
    (item) => item.gaps,
  );
  const inputFingerprint = caseflowFingerprint(read);
  const scope = {
    date: read.date,
    caseBindingsSource: read.caseBindingsSource,
    sections: candidates.map((section) => ({
      taskId: section.taskId,
      source: section.source,
      bodyFingerprint: caseflowFingerprint(section.packet),
      evidenceFingerprint: caseflowFingerprint(section.evidence),
    })),
  };
  const request: QualityHarnessRequest = {
    task: [
      `Review the supplied existing directed daily research sections for ${read.date}.`,
      `Controller-bound input SHA-256: ${inputFingerprint}.`,
      "Assess task coverage, unsupported conclusions, conflicting evidence, risk boundaries and missing data. Summaries may be rewritten; source identity is not proof of truth. Do not fetch data, execute trades, train, or claim learning acceptance. Held tasks are not reviewed.",
      ...candidates.map((section) => `${section.taskId}:\n${buildDirectedTaskAsk(section.taskId)}`),
    ].join("\n\n"),
    evidence: candidates.flatMap((section) => [
      ...(section.evidence ?? []).map((item) => ({
        id: `${section.taskId}:${item.id}`,
        source: item.source,
        text: `Source timestamp: ${item.timestamp}\n${item.text}`,
      })),
      {
        id: `${section.taskId}:directed-candidate-body`,
        source: `${section.source?.sourceRef}#packet`,
        text: JSON.stringify({
          role: "candidate_under_review_not_original_source_fact",
          taskId: section.taskId,
          source: section.source,
          analysis: section.packet?.analysis,
          ...(causalHypotheses.get(section.taskId)?.selected !== undefined
            ? {
                causalHypotheses: causalHypotheses.get(section.taskId)?.selected,
                causalStructuralGaps: causalHypotheses.get(section.taskId)?.gaps,
              }
            : {}),
          ...(section.taskId === "timely_stock_candidates"
            ? {
                directedWatchlist: watchlists.get(section.taskId)?.selected,
                structuralGaps: watchlists.get(section.taskId)?.gaps,
                evidenceIdNamespace: section.taskId,
              }
            : {}),
          claims: section.packet?.claims.map((claim) => ({
            ...claim,
            evidenceIds: claim.evidenceIds.map((id) => `${section.taskId}:${id}`),
          })),
        }),
      },
    ]),
    sharedContext: {
      directedReviewScope: scope,
      inputFingerprint,
      ...(candidates.some((section) => causalHypotheses.get(section.taskId)?.selected !== undefined)
        ? {
            causalReferenceConvention:
              "Causal hypotheses remain candidate interpretations, not source facts or identified causality. References use the same taskId prefix as original source evidence. Check alternatives and disconfirming tests.",
          }
        : {}),
      ...(watchlists.has("timely_stock_candidates")
        ? {
            structuralGaps,
            watchlistReferenceConvention:
              "Watchlist evidenceIds and counterEvidenceIds have the same taskId prefix as the original source evidence in this review. Candidate bodies are not source facts.",
          }
        : {}),
      candidateBodyEvidenceIds: candidates.map(
        (section) => `${section.taskId}:directed-candidate-body`,
      ),
    },
  };
  const sourceEvidenceIds = candidates.flatMap((section) =>
    (section.evidence ?? []).map((item) => `${section.taskId}:${item.id}`),
  );
  return { inputFingerprint, scope, request, sourceEvidenceIds, structuralGaps };
}

type DirectedContentReview = {
  schemaVersion: "lcx_directed_daily_content_review_v1";
  status: "failed" | "needs_review";
  inputFingerprint?: string;
  scope?: ReturnType<typeof buildDirectedContentReviewInput>["scope"];
  quality?: QualityHarnessReceipt;
  qualityCompletedAt?: string;
  gaps: string[];
  cleanup: "not_started" | "local_listener_released_model_cleanup_unconfirmed";
};

/** Explicit host seam. CLI defaults have no model adapter and never enable paid provider calls. */
export async function reviewDirectedDailyCases(
  options: Parameters<typeof readDirectedDailyCases>[0] & {
    qualityOptions?: Pick<
      QualityHarnessOptions,
      | "modelInvoker"
      | "modelRouting"
      | "modelId"
      | "taskTimeoutMs"
      | "verifierTimeoutMs"
      | "signal"
      | "createRunId"
    >;
    timeoutMs?: number;
  },
) {
  const read = await readDirectedDailyCases(options);
  let contentReview: DirectedContentReview = {
    schemaVersion: "lcx_directed_daily_content_review_v1",
    status: "failed",
    gaps: [],
    cleanup: "not_started",
  };
  const controller = new AbortController();
  const callerSignal = options.qualityOptions?.signal;
  const cancel = () =>
    controller.abort(callerSignal?.reason ?? new Error("directed_content_review_cancelled"));
  callerSignal?.addEventListener("abort", cancel, { once: true });
  if (callerSignal?.aborted) {
    cancel();
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    callerSignal?.removeEventListener("abort", cancel);
    throw new Error("directed content review timeoutMs must be > 0 and <= 120000");
  }
  const timer = setTimeout(
    () => controller.abort(new Error("directed_content_review_deadline")),
    timeoutMs,
  );
  const deadlineAt = Date.now() + timeoutMs;
  const assertReviewActive = () => {
    if (Date.now() >= deadlineAt && !controller.signal.aborted) {
      controller.abort(new Error("directed_content_review_deadline"));
    }
    controller.signal.throwIfAborted();
  };
  let abortListener: (() => void) | undefined;
  try {
    assertReviewActive();
    const input = buildDirectedContentReviewInput(read);
    assertReviewActive();
    contentReview = {
      ...contentReview,
      inputFingerprint: input.inputFingerprint,
      scope: input.scope,
      gaps: input.structuralGaps,
    };
    const ids = input.request.evidence.map((item) => item.id);
    const allowed = new Set(input.sourceEvidenceIds);
    contentReview.cleanup = "local_listener_released_model_cleanup_unconfirmed";
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    const quality = await Promise.race([
      runQualityHarness({
        ...options.qualityOptions,
        allowProviderCalls: false,
        signal: controller.signal,
        request: input.request,
        maxAttempts: 1,
        requireEvidenceCoverage: true,
        evidenceCoverage: {
          sourceEvidenceIds: ids,
          selectedEvidenceIds: ids,
          runnerOmittedEvidenceIds: [],
          runnerClippedEvidenceIds: [],
        },
        verify: ({ artifact }) => {
          const issues = [
            ...input.structuralGaps,
            ...artifact.claims.flatMap((claim) =>
              (claim.status !== "supported" || claim.evidenceIds.length > 0) &&
              claim.evidenceIds.every((id) => allowed.has(id))
                ? []
                : [`daily_task_review_claim_reference:${claim.id}`],
            ),
          ];
          return {
            status: issues.length ? "failed" : "passed",
            summary:
              "Host checks source-bound input and claim references only; semantic correctness remains a review judgment.",
            details: issues,
          };
        },
      }),
      aborted,
    ]);
    assertReviewActive();
    contentReview.quality = quality;
    contentReview.qualityCompletedAt = new Date().toISOString();
    const modelCompleted = quality.execution.modelCalls.some(
      (call) => call.outcome === "completed",
    );
    contentReview.status =
      !modelCompleted || ["failed", "blocked"].includes(quality.status) ? "failed" : "needs_review";
    contentReview.gaps = [
      ...input.structuralGaps,
      ...(modelCompleted ? [] : ["daily_task_review_model_unavailable"]),
      ...(quality.status === "verified" ? [] : [`daily_task_quality:${quality.status}`]),
      "daily_task_semantic_acceptance_not_observed",
    ];
  } catch (error) {
    contentReview.status = "failed";
    contentReview.gaps = [
      ...contentReview.gaps,
      error instanceof Error ? error.message : "daily_task_content_review_failed",
    ];
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", cancel);
    if (abortListener) {
      controller.signal.removeEventListener("abort", abortListener);
    }
  }
  return {
    ...read,
    contentReview,
    contentAcceptance: "review_required",
    missingForPacket: [
      ...read.missingForPacket.filter((gap) => gap !== "daily_task_content_review_not_observed"),
      ...contentReview.gaps,
    ],
    visibleBrief: `${read.visibleBrief}\n\n独立日包内容审阅: ${contentReview.status}; ${contentReview.quality?.status ?? "unavailable"}\n缺口: ${contentReview.gaps.join("; ")}`,
  };
}

/** The acceptance owner consumes exact reader fields and the bound original quality receipt. */
export function inspectDirectedContentReview(value: unknown) {
  const payload = z
    .object({
      contentReview: z.object({
        schemaVersion: z.literal("lcx_directed_daily_content_review_v1"),
        inputFingerprint: Hash,
        scope: z.unknown(),
        quality: z.object({
          schemaVersion: z.literal(1),
          harness: z.literal("lcx-quality"),
          runId: z.string().min(1),
          status: z.string(),
          task: z.object({ sha256: Hash, length: z.number() }),
          execution: z.object({
            evidenceMode: z.string(),
            realModelInferenceObserved: z.boolean(),
          }),
          evidenceCoverage: z.object({ passed: z.boolean() }).optional(),
          quality: z.object({ passed: z.boolean() }),
          verification: z.object({ status: z.string() }),
        }),
      }),
    })
    .safeParse(value);
  if (!payload.success) {
    return { status: "not_observed", gaps: ["daily_task_bound_content_review_not_observed"] };
  }
  try {
    const input = buildDirectedContentReviewInput(value);
    const review = payload.data.contentReview;
    if (
      review.inputFingerprint !== input.inputFingerprint ||
      caseflowFingerprint(review.scope) !== caseflowFingerprint(input.scope) ||
      review.quality.task.sha256 !==
        createHash("sha256").update(input.request.task).digest("hex") ||
      review.quality.task.length !== input.request.task.length
    ) {
      return { status: "scope_conflict", gaps: ["daily_task_content_review_scope_conflict"] };
    }
    return {
      status: "bound_receipt",
      inputFingerprint: input.inputFingerprint,
      qualityStatus: review.quality.status,
      qualityPassed: review.quality.quality.passed && input.structuralGaps.length === 0,
      verificationStatus: review.quality.verification.status,
      modelEvidenceMode: review.quality.execution.evidenceMode,
      realModelInferenceObserved: review.quality.execution.realModelInferenceObserved,
      modelInputCoverageObserved: review.quality.evidenceCoverage?.passed === true,
      gaps: [
        ...input.structuralGaps,
        "daily_task_semantic_acceptance_not_observed",
        "daily_learning_application_not_observed",
      ],
    };
  } catch {
    return { status: "scope_conflict", gaps: ["daily_task_content_review_input_invalid"] };
  }
}

const DirectedPin = z.object({ path: z.string().min(1), sha256: Hash });
const CompactDirectedTaskExecution = z.object({
  status: z.string(),
  host: DirectedResearchHost.optional(),
  request: DirectedPin.optional(),
  allocation: z.object({ maxApiCalls: z.number(), maxModelCalls: z.number() }).optional(),
  savedCase: z.object({ path: z.string(), ref: Hash }).optional(),
  bindingsFile: z.string().optional(),
  gaps: z.array(z.string()).optional(),
});
const CompactDirectedBatchExecution = z.object({
  status: z.string(),
  host: DirectedResearchHost,
  request: DirectedPin,
  tasks: z
    .array(
      z.object({
        taskId: z.string(),
        status: z.string(),
        gaps: z.array(z.string()),
        taskExecution: CompactDirectedTaskExecution.optional(),
      }),
    )
    .max(4),
});
const DirectedOwnerHistory = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  boundary: z.literal("local_directed_daily_research_brief_only"),
  caseBindingsSource: z.object({ sourceRef: z.string(), sourceSha256: Hash }),
  packetCandidateSections: z
    .array(z.object({ taskId: z.string(), source: z.unknown().optional() }))
    .max(4),
  taskExecution: CompactDirectedTaskExecution.optional(),
  batchExecution: CompactDirectedBatchExecution.optional(),
  executionProvenance: z.object({ archive: DirectedPin.optional() }).optional(),
});
type DirectedExecutionProvenance = {
  status: "verified" | "not_observed";
  reason: string;
  archive?: z.infer<typeof DirectedPin>;
  observedLatest?: z.infer<typeof DirectedPin>;
  sources?: z.infer<typeof DirectedPin>[];
  host?: z.infer<typeof DirectedResearchHost>;
};
type PreservedDirectedExecution = {
  executionProvenance: DirectedExecutionProvenance;
  taskExecution?: z.infer<typeof CompactDirectedTaskExecution>;
  batchExecution?: z.infer<typeof CompactDirectedBatchExecution>;
};

async function directedArchiveFiles(root: string, date?: string, signal?: AbortSignal) {
  const safeDirectory = async (relative: string) => {
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      signal?.throwIfAborted();
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("directed_history_directory_alias");
      }
    }
    return current;
  };
  const prefix = path.join("memory", "directed-daily-research");
  const dates = date
    ? [date]
    : (await fs.readdir(await safeDirectory(prefix)))
        .filter((item) => /^\d{4}-\d{2}-\d{2}$/u.test(item))
        .toSorted()
        .toReversed()
        .slice(0, 32);
  const files: string[] = [];
  for (const day of dates) {
    const relative = path.join(prefix, day);
    const names = await fs.readdir(await safeDirectory(relative));
    signal?.throwIfAborted();
    files.push(
      ...names
        .filter((name) => /^[a-zA-Z0-9_-]+__directed-daily-research-brief\.json$/u.test(name))
        .toSorted()
        .toReversed()
        .slice(0, 64 - files.length)
        .map((name) => path.join(relative, name)),
    );
    if (files.length >= 64) {
      break;
    }
  }
  return files;
}

/** Preserve an actual owner publication, never infer execution from reviewed case labels. */
async function recoverDirectedExecution(
  root: string,
  read: Omit<ReturnType<typeof finishDirectedCaseRead>, "executionProvenance">,
  independentHost?: z.infer<typeof DirectedResearchHost>,
  signal?: AbortSignal,
  publication?: { bytes: Buffer; path: string },
): Promise<PreservedDirectedExecution> {
  const unobserved = (reason: string): PreservedDirectedExecution => ({
    executionProvenance: { status: "not_observed", reason },
  });
  try {
    signal?.throwIfAborted();
    const latestPath = publication?.path ?? "state/lcx-directed-daily-research-brief-latest.json";
    const latest = publication?.bytes ?? (await readPrivateFile(root, latestPath));
    signal?.throwIfAborted();
    const current = DirectedOwnerHistory.parse(JSON.parse(latest.toString("utf8")));
    if (
      current.date !== read.date ||
      caseflowFingerprint(current.caseBindingsSource) !==
        caseflowFingerprint(read.caseBindingsSource)
    ) {
      return unobserved("directed_history_binding_or_date_conflict");
    }
    let archive = current.executionProvenance?.archive;
    if (!archive) {
      for (const file of await directedArchiveFiles(root, current.date, signal)) {
        const bytes = await readPrivateFile(root, file);
        signal?.throwIfAborted();
        if (sha(bytes) === sha(latest)) {
          archive = { path: file, sha256: sha(bytes) };
          break;
        }
      }
    }
    if (
      !archive ||
      !/^memory\/directed-daily-research\/\d{4}-\d{2}-\d{2}\/[^/]+__directed-daily-research-brief\.json$/u.test(
        archive.path,
      )
    ) {
      return unobserved("directed_original_archive_not_observed");
    }
    const originalBytes = await readPrivateFile(root, archive.path);
    signal?.throwIfAborted();
    if (sha(originalBytes) !== archive.sha256) {
      throw new Error("directed_original_archive_hash_conflict");
    }
    const original = DirectedOwnerHistory.parse(JSON.parse(originalBytes.toString("utf8")));
    if (Boolean(original.taskExecution) === Boolean(original.batchExecution)) {
      throw new Error("directed_original_execution_ambiguous");
    }
    const execution = original.batchExecution ?? original.taskExecution!;
    const host = execution.host;
    if (
      !host ||
      !independentHost ||
      (independentHost && caseflowFingerprint(host) !== caseflowFingerprint(independentHost))
    ) {
      throw new Error("directed_original_independent_host_not_observed_or_conflict");
    }
    if (
      original.date !== read.date ||
      caseflowFingerprint(original.caseBindingsSource) !==
        caseflowFingerprint(read.caseBindingsSource) ||
      caseflowFingerprint(
        original.packetCandidateSections.map((item) => ({
          taskId: item.taskId,
          source: item.source,
        })),
      ) !==
        caseflowFingerprint(
          read.packetCandidateSections.map((item) => ({
            taskId: item.taskId,
            source: item.source,
          })),
        )
    ) {
      throw new Error("directed_original_case_provenance_conflict");
    }
    const bindingBytes = await readPrivateFile(root, original.caseBindingsSource.sourceRef);
    signal?.throwIfAborted();
    if (sha(bindingBytes) !== original.caseBindingsSource.sourceSha256) {
      throw new Error("directed_original_bindings_hash_conflict");
    }
    const binding = CaseBindings.parse(JSON.parse(bindingBytes.toString("utf8")));
    if (
      original.batchExecution &&
      (!binding.parent ||
        caseflowFingerprint(
          DirectedResearchHost.parse({
            accountId: binding.parent.accountId,
            runId: binding.parent.runId,
            maxApiCalls: binding.parent.maxApiCalls,
            maxModelCalls: binding.parent.maxModelCalls,
          }),
        ) !== caseflowFingerprint(host) ||
        caseflowFingerprint(binding.parent.request) !==
          caseflowFingerprint(original.batchExecution.request))
    ) {
      throw new Error("directed_original_parent_conflict");
    }

    if (binding.parent) {
      const parentBytes = await readPrivateFile(root, binding.parent.request.path);
      signal?.throwIfAborted();
      if (sha(parentBytes) !== binding.parent.request.sha256) {
        throw new Error("directed_original_parent_request_hash_conflict");
      }
      const parentRequest = DirectedBatchRequest.parse(JSON.parse(parentBytes.toString("utf8")));
      if (
        parentRequest.accountId !== host.accountId ||
        parentRequest.runId !== host.runId ||
        parentRequest.maxApiCalls !== host.maxApiCalls ||
        parentRequest.maxModelCalls !== host.maxModelCalls ||
        parentRequest.date !== original.date ||
        parentRequest.asOf !== binding.asOf ||
        caseflowFingerprint(parentRequest.tasks) !==
          caseflowFingerprint(
            binding.parent.tasks.map(({ taskId, request }) => ({ taskId, request })),
          )
      ) {
        throw new Error("directed_original_parent_request_scope_conflict");
      }
    }
    // Strip parent additive fields before the strict independent-host schema.
    const executions = original.batchExecution?.tasks.map((task) => ({
      taskId: task.taskId,
      execution: task.taskExecution,
    })) ?? [{ taskId: binding.tasks[0]?.taskId, execution: original.taskExecution }];
    for (const item of executions) {
      if (item.execution?.status !== "executed") {
        continue;
      }
      const task = binding.tasks.find((task) => task.taskId === item.taskId);
      if (
        !task ||
        !item.execution.request ||
        !item.execution.savedCase ||
        item.execution.savedCase.ref !== task.ref ||
        caseflowFingerprint(item.execution.host) !== caseflowFingerprint(host)
      ) {
        throw new Error("directed_original_saved_case_conflict");
      }
      const casePath = path.join(binding.caseDirectory, `${task.ref}.json`);
      const caseBytes = await readPrivateFile(root, casePath);
      signal?.throwIfAborted();
      if (sha(caseBytes) !== task.caseSha256) {
        throw new Error("directed_original_case_hash_conflict");
      }
      const native = await readFinanceCaseRun(path.resolve(root, binding.caseDirectory), task.ref);
      signal?.throwIfAborted();
      const actual = z
        .object({
          accountId: z.string(),
          runId: z.string(),
          taskId: z.string(),
          request: DirectedPin,
        })
        .parse(native.run.execution);
      const requestBytes = await readPrivateFile(root, item.execution.request.path);
      signal?.throwIfAborted();
      if (
        actual.accountId !== host.accountId ||
        actual.runId !== host.runId ||
        actual.taskId !== item.taskId ||
        caseflowFingerprint(actual.request) !== caseflowFingerprint(item.execution.request) ||
        sha(requestBytes) !== actual.request.sha256
      ) {
        throw new Error("directed_original_request_or_scope_conflict");
      }
    }

    const sources = [
      {
        path: original.caseBindingsSource.sourceRef,
        sha256: original.caseBindingsSource.sourceSha256,
      },
      ...binding.tasks.map((task) => ({
        path: path.join(binding.caseDirectory, `${task.ref}.json`),
        sha256: task.caseSha256,
      })),
      ...(binding.parent
        ? [binding.parent.request, ...binding.parent.tasks.map((task) => task.request)]
        : original.taskExecution?.request
          ? [original.taskExecution.request]
          : []),
    ];
    for (const pin of sources) {
      if (sha(await readPrivateFile(root, pin.path)) !== pin.sha256) {
        throw new Error("directed_original_source_changed");
      }
      signal?.throwIfAborted();
    }
    if (sha(await readPrivateFile(root, latestPath)) !== sha(latest)) {
      throw new Error("directed_history_changed");
    }
    signal?.throwIfAborted();
    return {
      executionProvenance: {
        status: "verified",
        reason: "original_execution_publication_revalidated_not_semantic_acceptance",
        archive,
        observedLatest: { path: latestPath, sha256: sha(latest) },
        sources,
        host,
      },
      ...(original.taskExecution
        ? { taskExecution: original.taskExecution }
        : { batchExecution: original.batchExecution }),
    };
  } catch (error) {
    signal?.throwIfAborted();
    return unobserved(
      error instanceof Error ? error.message : "directed_original_execution_unconfirmed",
    );
  }
}

type DirectedReviewFeedback = {
  status: "forwarded_to_original_runner" | "not_consumed";
  reason: string;
  pins: z.infer<typeof DirectedPin>[];
  observedLatest?: z.infer<typeof DirectedPin>;
  upstreamRunId?: string;
  upstreamQualityRunId?: string;
  sourceScope?: z.infer<typeof DirectedResearchHost>;
  currentRunId?: string;
  diagnosticSha256?: string;
  semanticAdoption: "not_proven";
};

export async function readDirectedReviewFeedback(
  root: string,
  request: z.infer<typeof DirectedResearchRequest>,
  signal: AbortSignal,
) {
  request = DirectedResearchRequest.parse(request);
  const skipped = (reason: string) => ({
    receipt: {
      status: "not_consumed" as const,
      reason,
      pins: [],
      semanticAdoption: "not_proven" as const,
    },
    evidence: [] as NonNullable<FinanceResearchRunOptions["input"]["controllerEvidence"]>,
  });
  let latest: Buffer;
  try {
    latest = await readPrivateFile(root, "state/lcx-directed-daily-research-brief-latest.json");
  } catch (error) {
    signal.throwIfAborted();
    return skipped(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "directed_review_not_observed"
        : "directed_review_latest_unreadable",
    );
  }
  signal.throwIfAborted();
  let files: string[];
  try {
    files = [
      "state/lcx-directed-daily-research-brief-latest.json",
      ...(await directedArchiveFiles(root, undefined, signal)),
    ];
  } catch (error) {
    signal.throwIfAborted();
    return skipped(error instanceof Error ? error.message : "directed_review_archive_unreadable");
  }
  let reason = "directed_review_not_observed";
  for (const file of files) {
    signal.throwIfAborted();
    try {
      const bytes = file === files[0] ? latest : await readPrivateFile(root, file);
      signal.throwIfAborted();
      const value = z
        .object({
          date: z.string(),
          caseBindingsSource: z.object({ sourceRef: z.string(), sourceSha256: Hash }),
          executionProvenance: z.object({
            status: z.literal("verified"),
            archive: DirectedPin,
            host: DirectedResearchHost,
          }),
          contentReview: z
            .object({
              inputFingerprint: Hash,
              scope: z.unknown(),
              qualityCompletedAt: z.string().datetime({ offset: true }).optional(),
              quality: z
                .object({
                  runId: z.string(),
                  attempts: z.array(
                    z.object({ findings: z.array(z.object({ text: z.string() })) }),
                  ),
                  verification: z.object({ details: z.array(z.string()) }).passthrough(),
                })
                .passthrough(),
              gaps: z.array(z.string()),
            })
            .passthrough(),
        })
        .safeParse(JSON.parse(bytes.toString("utf8")));
      if (!value.success) {
        continue;
      }
      const previous = value.data;
      if (previous.executionProvenance.host.accountId !== request.accountId) {
        reason = "directed_review_account_conflict";
        continue;
      }
      if (previous.date > request.date) {
        reason = "directed_review_future_date";
        continue;
      }
      if (!previous.contentReview.qualityCompletedAt) {
        reason = "directed_review_completion_time_unconfirmed";
        continue;
      }
      if (Date.parse(previous.contentReview.qualityCompletedAt) > Date.parse(request.asOf)) {
        reason = "directed_review_future_completion";
        continue;
      }
      const bindingBytes = await readPrivateFile(root, previous.caseBindingsSource.sourceRef);
      signal.throwIfAborted();
      if (sha(bindingBytes) !== previous.caseBindingsSource.sourceSha256) {
        throw new Error("directed_review_bindings_hash_conflict");
      }
      const binding = CaseBindings.parse(JSON.parse(bindingBytes.toString("utf8")));
      if (Date.parse(binding.asOf) > Date.parse(request.asOf)) {
        reason = "directed_review_future_asof";
        continue;
      }
      const read = await readDirectedDailyCases({
        workspaceDir: root,
        date: previous.date,
        bindingsFile: previous.caseBindingsSource.sourceRef,
        batchHost: previous.executionProvenance.host,
        signal,
      });
      signal.throwIfAborted();

      const selected = binding.tasks.find((item) => item.taskId === request.taskId);
      const section = read.packetCandidateSections.find(
        (section) => section.taskId === request.taskId,
      );
      const verifiedLearningRefusal =
        request.taskId === "risk_gate_and_learning_loop" &&
        section?.learningApplication?.sourceReadStatus === "verified" &&
        section.learningApplication.status === "refused" &&
        section.gaps.every((gap) =>
          [
            "adjacent_task_application_not_observed",
            section.learningApplication?.failureReason,
          ].includes(gap),
        );
      if (selected && section?.status !== "read_ready" && !verifiedLearningRefusal) {
        throw new Error(
          `directed_review_source_not_current:${section?.gaps.join(";") ?? "task_not_observed"}`,
        );
      }
      const fresh = { ...read, contentReview: previous.contentReview };
      const nativeExecution = await recoverDirectedExecution(
        root,
        read,
        previous.executionProvenance.host,
        signal,
        { bytes, path: file },
      );
      signal.throwIfAborted();
      const ownerHost = nativeExecution.executionProvenance.host;
      if (nativeExecution.executionProvenance.status !== "verified" || !ownerHost) {
        throw new Error(nativeExecution.executionProvenance.reason);
      }
      const nativeTask = nativeExecution.batchExecution?.tasks.find(
        (task) => task.taskId === request.taskId,
      );
      let failedTaskRequest: z.infer<typeof DirectedPin> | undefined;
      let nativeTaskGaps: string[] = [];
      if (selected) {
        if (
          caseflowFingerprint(selected.targets.toSorted()) !==
          caseflowFingerprint(request.targets.map((item) => item.instrument).toSorted())
        ) {
          reason = "directed_review_task_or_targets_conflict";
          continue;
        }
        if (section?.status !== "read_ready" && !verifiedLearningRefusal) {
          throw new Error(
            `directed_review_source_not_current:${section?.gaps.join(";") ?? "task_not_observed"}`,
          );
        }
        const oldPlan = z
          .object({ horizonMonths: z.number().int().positive() })
          .safeParse(section.originalSnapshot?.plan);
        if (!oldPlan.success || oldPlan.data.horizonMonths !== (request.horizonMonths ?? 3)) {
          reason = "directed_review_horizon_not_applicable";
          continue;
        }
        if (verifiedLearningRefusal) {
          nativeTaskGaps = [...section.gaps];
        }
      } else {
        // A genuine native task failure needs repair precisely because no immutable Caseflow exists.
        const parentTask = binding.parent?.tasks.find((task) => task.taskId === request.taskId);
        if (
          !parentTask ||
          !nativeTask ||
          nativeTask.status !== "failed" ||
          !nativeTask.taskExecution ||
          !["held", "failed"].includes(nativeTask.taskExecution.status) ||
          nativeTask.taskExecution.savedCase ||
          !nativeTask.taskExecution.request ||
          caseflowFingerprint(nativeTask.taskExecution.host) !== caseflowFingerprint(ownerHost) ||
          caseflowFingerprint(nativeTask.taskExecution.request) !==
            caseflowFingerprint(parentTask.request)
        ) {
          reason = "directed_review_task_failure_not_observed";
          continue;
        }
        const oldRequestBytes = await readPrivateFile(root, parentTask.request.path);
        signal.throwIfAborted();
        if (sha(oldRequestBytes) !== parentTask.request.sha256) {
          throw new Error("directed_review_failed_task_request_hash_conflict");
        }
        const oldRequest = DirectedResearchRequest.parse(
          JSON.parse(oldRequestBytes.toString("utf8")),
        );
        if (
          oldRequest.accountId !== ownerHost.accountId ||
          oldRequest.runId !== ownerHost.runId ||
          oldRequest.taskId !== request.taskId ||
          oldRequest.date !== previous.date ||
          oldRequest.asOf !== binding.asOf ||
          oldRequest.maxApiCalls !== ownerHost.maxApiCalls ||
          oldRequest.maxModelCalls !== ownerHost.maxModelCalls
        ) {
          throw new Error("directed_review_failed_task_host_or_request_conflict");
        }
        if (
          caseflowFingerprint(oldRequest.targets.map((item) => item.instrument).toSorted()) !==
          caseflowFingerprint(request.targets.map((item) => item.instrument).toSorted())
        ) {
          reason = "directed_review_task_or_targets_conflict";
          continue;
        }
        if ((oldRequest.horizonMonths ?? 3) !== (request.horizonMonths ?? 3)) {
          reason = "directed_review_horizon_not_applicable";
          continue;
        }
        failedTaskRequest = parentTask.request;
        nativeTaskGaps = [...nativeTask.gaps, ...(nativeTask.taskExecution.gaps ?? [])];
        if (!nativeTaskGaps.length) {
          reason = "directed_review_failed_task_diagnostic_unobserved";
          continue;
        }
      }
      if (inspectDirectedContentReview(fresh).status !== "bound_receipt") {
        throw new Error("directed_review_current_source_or_input_conflict");
      }
      let reviewArchive =
        /^memory\/directed-daily-research\/\d{4}-\d{2}-\d{2}\/[^/]+__directed-daily-research-brief\.json$/u.test(
          file,
        )
          ? { path: file, sha256: sha(bytes) }
          : undefined;
      if (!reviewArchive) {
        for (const candidate of await directedArchiveFiles(root, previous.date, signal)) {
          const candidateBytes = await readPrivateFile(root, candidate);
          signal.throwIfAborted();
          if (sha(candidateBytes) === sha(bytes)) {
            reviewArchive = { path: candidate, sha256: sha(bytes) };
            break;
          }
        }
      }
      if (!reviewArchive) {
        return skipped("directed_review_same_bytes_archive_not_observed");
      }
      const omittedFields: Array<{
        field: string;
        fromIndex?: number;
        count: number;
        source: z.infer<typeof DirectedPin>;
      }> = [];
      const diagnosticFields = {
        kind: "historical_directed_review_diagnostic_not_market_fact",
        taskId: request.taskId,
        upstreamRunId: ownerHost.runId,
        qualityRunId: previous.contentReview.quality.runId,
        qualityCompletedAt: previous.contentReview.qualityCompletedAt,
        sourceAsOf: binding.asOf,
        reviewedTaskIds: read.packetCandidateSections
          .filter((item) => item.status === "read_ready")
          .map((item) => item.taskId),
        reviewScope: { date: previous.date, caseBindingsSource: previous.caseBindingsSource },
        scopeNote:
          "Whole-day findings are historical diagnostics; only apply decision-dependent gaps relevant to this task, never current market facts.",
        sourceCaseStatus: verifiedLearningRefusal
          ? "original_case_and_learning_refusal_revalidated_not_market_evidence"
          : failedTaskRequest
            ? "not_saved_after_native_task_failure_not_market_evidence"
            : "original_case_revalidated",
        nativeTaskGaps: [...new Set(nativeTaskGaps)],
        findings: [
          ...new Set(
            previous.contentReview.quality.attempts.flatMap((attempt) =>
              attempt.findings.map((finding) => finding.text),
            ),
          ),
        ],
        verificationDetails: [...previous.contentReview.quality.verification.details],
        gaps: previous.contentReview.gaps,
        omittedFields,
      };
      for (const [field, values] of [
        ["/contentReview/quality/verification/details", diagnosticFields.verificationDetails],
        ["/contentReview/quality/attempts", diagnosticFields.findings],
        [
          verifiedLearningRefusal
            ? `/packetCandidateSections/${DAILY_RESEARCH_TASKS.findIndex((task) => task.id === request.taskId)}/gaps`
            : `/batchExecution/tasks/${nativeExecution.batchExecution?.tasks.findIndex((task) => task.taskId === request.taskId)}/gaps`,
          diagnosticFields.nativeTaskGaps,
        ],
      ] as const) {
        let count = 0;
        while (
          Buffer.byteLength(JSON.stringify(diagnosticFields), "utf8") > 4096 &&
          values.length
        ) {
          values.pop();
          count += 1;
          const omission = omittedFields.find((item) => item.field === field);
          if (omission) {
            omission.count = count;
            if (field === "/contentReview/quality/verification/details") {
              omission.fromIndex = values.length;
            }
          } else {
            omittedFields.push({
              field,
              ...(field === "/contentReview/quality/verification/details"
                ? { fromIndex: values.length }
                : {}),
              count,
              source: reviewArchive,
            });
          }
        }
      }
      const diagnostic = JSON.stringify(diagnosticFields);
      if (Buffer.byteLength(diagnostic, "utf8") > 4096) {
        return skipped("directed_review_diagnostic_budget_exceeded");
      }
      const pins = [
        reviewArchive,
        previous.executionProvenance.archive,
        {
          path: previous.caseBindingsSource.sourceRef,
          sha256: previous.caseBindingsSource.sourceSha256,
        },
        ...binding.tasks.map((task) => ({
          path: path.join(binding.caseDirectory, `${task.ref}.json`),
          sha256: task.caseSha256,
        })),
        ...(binding.parent
          ? [binding.parent.request, ...binding.parent.tasks.map((task) => task.request)]
          : nativeExecution.taskExecution?.request
            ? [nativeExecution.taskExecution.request]
            : []),
      ];
      signal.throwIfAborted();
      return {
        receipt: {
          status: "forwarded_to_original_runner" as const,
          reason: "bound_historical_review_diagnostic_supplied_not_semantic_adoption",
          pins,
          ...(file === "state/lcx-directed-daily-research-brief-latest.json"
            ? { observedLatest: { path: file, sha256: sha(bytes) } }
            : {}),
          upstreamRunId: ownerHost.runId,
          upstreamQualityRunId: previous.contentReview.quality.runId,
          sourceScope: ownerHost,
          currentRunId: request.runId,
          diagnosticSha256: createHash("sha256").update(diagnostic).digest("hex"),
          semanticAdoption: "not_proven" as const,
        },
        evidence: [
          {
            id: `directed-review:${previous.contentReview.quality.runId}:${request.taskId}`,
            source: "directed-daily-review-diagnostic",
            timestamp: previous.contentReview.qualityCompletedAt,
            text: diagnostic,
          },
        ],
      };
    } catch (error) {
      signal.throwIfAborted();
      reason = error instanceof Error ? error.message : "directed_review_readback_failed";
      // A changed pinned source must not be replaced by another cached review of the same bytes.
      return skipped(reason);
    }
  }
  return skipped(reason);
}

const DirectedResearchRequest = DirectedResearchHost.extend({
  schemaVersion: z.literal("lcx_directed_daily_task_request_v1"),
  taskId: z.string(),
  caseId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  asOf: z.string().datetime({ offset: true }),
  horizonMonths: z.number().int().positive().optional(),
  targets: z.custom<readonly FinanceResearchBatchTarget[]>(
    (value) =>
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 32 &&
      value.every(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          typeof item.id === "string" &&
          typeof item.instrument === "string" &&
          typeof item.assetClass === "string",
      ),
  ),
  moduleSelection: z.unknown().optional(),
});

type DirectedResearchOptions = Omit<
  FinanceResearchRunOptions,
  | "input"
  | "signal"
  | "workspaceDir"
  | "modelCheckpoint"
  | "liveFetch"
  | "allowProviderCalls"
  | "moduleExecutor"
>;

const DirectedDailyAdmissionInput = z
  .object({
    host: z
      .object({
        accountId: z.string().trim().min(1).max(128),
        runId: z.string().trim().min(1).max(128),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        nowMs: z.number().int().nonnegative(),
      })
      .strict(),
    firstRun: z.literal(true).optional(),
    previous: z
      .object({ path: z.string().min(1), sha256: Hash })
      .strict()
      .optional(),
  })
  .strict();
export type DirectedDailyAdmissionInput = z.infer<typeof DirectedDailyAdmissionInput>;

/** Read admission only: this does not reserve a date or provide cross-process exactly-once. */
export async function readDirectedDailyAdmission(options: {
  workspaceDir: string;
  date: string;
  host: Pick<z.infer<typeof DirectedResearchHost>, "accountId" | "runId">;
  admission: DirectedDailyAdmissionInput;
  signal?: AbortSignal;
}) {
  const latestPath = "state/lcx-directed-daily-research-brief-latest.json";
  let previous: { path: string; sha256: string; date?: string; runId?: string } | undefined;
  const receipt = (status: "due" | "held", reason: string) => ({
    schemaVersion: "lcx_directed_daily_admission_v1" as const,
    status,
    reason,
    host: options.admission.host,
    policy: "utc_daily_once_no_automatic_failed_retry" as const,
    previous,
    executionAuthority: false,
    reservation: "not_atomic" as const,
  });
  const active = () => options.signal?.throwIfAborted();
  try {
    active();
    const input = DirectedDailyAdmissionInput.parse(options.admission);
    if (
      input.host.accountId !== options.host.accountId ||
      input.host.runId !== options.host.runId
    ) {
      return receipt("held", "daily_admission_host_scope_conflict");
    }
    const clockDate = new Date(input.host.nowMs);
    if (
      !Number.isFinite(clockDate.getTime()) ||
      clockDate.toISOString().slice(0, 10) !== input.host.date ||
      input.host.date !== options.date
    ) {
      return receipt("held", "daily_admission_utc_date_conflict");
    }
    if (Boolean(input.firstRun) === Boolean(input.previous)) {
      return receipt("held", "daily_admission_history_choice_required");
    }
    const root = await fs.realpath(options.workspaceDir);
    active();
    let latest: Buffer;
    try {
      latest = await readPrivateFile(root, latestPath);
    } catch (error) {
      active();
      if (input.firstRun && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return receipt("due", "daily_admission_first_run_latest_absent");
      }
      return receipt("held", "daily_admission_latest_unconfirmed");
    }
    active();
    if (input.firstRun) {
      return receipt("held", "daily_admission_first_run_history_exists");
    }
    const pin = input.previous!;
    const relative = path.relative(root, path.resolve(root, pin.path));
    if (
      relative !== latestPath &&
      !/^memory\/directed-daily-research\/\d{4}-\d{2}-\d{2}\/[^/]+__directed-daily-research-brief\.json$/u.test(
        relative,
      )
    ) {
      return receipt("held", "daily_admission_previous_not_owner_receipt");
    }
    const bytes = relative === latestPath ? latest : await readPrivateFile(root, relative);
    active();
    previous = { path: relative, sha256: sha(bytes) };
    if (sha(bytes) !== pin.sha256 || sha(latest) !== pin.sha256) {
      return receipt("held", "daily_admission_previous_hash_or_latest_conflict");
    }
    const prior = z
      .object({
        ok: z.boolean(),
        boundary: z.literal("local_directed_daily_research_brief_only"),
        productMode: z.literal("focused_daily_research_product_not_open_ended_chat"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        taskExecution: z
          .object({ status: z.string(), host: DirectedResearchHost })
          .passthrough()
          .optional(),
        batchExecution: z
          .object({
            status: z.string(),
            host: DirectedResearchHost,
            tasks: z.array(
              z
                .object({
                  taskId: z.string(),
                  status: z.string(),
                  taskExecution: z
                    .object({ status: z.string(), host: DirectedResearchHost.optional() })
                    .passthrough()
                    .optional(),
                })
                .passthrough(),
            ),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .parse(JSON.parse(bytes.toString("utf8")));
    if (prior.taskExecution && prior.batchExecution) {
      return receipt("held", "daily_admission_ambiguous_previous_execution");
    }
    const executed = prior.batchExecution ?? prior.taskExecution;
    if (!executed) {
      return receipt("held", "daily_admission_previous_execution_unobserved");
    }
    previous = { ...previous, date: prior.date, runId: executed.host.runId };
    if (executed.host.accountId !== options.host.accountId) {
      return receipt("held", "daily_admission_previous_account_conflict");
    }
    const priorDate = new Date(`${prior.date}T00:00:00.000Z`);
    if (
      !Number.isFinite(priorDate.getTime()) ||
      priorDate.toISOString().slice(0, 10) !== prior.date ||
      prior.date > options.date
    ) {
      return receipt("held", "daily_admission_previous_future_or_invalid_date");
    }
    if (prior.date === options.date || executed.host.runId === options.host.runId) {
      return receipt("held", "daily_admission_duplicate_day_or_run");
    }
    const batch = prior.batchExecution;
    if (
      !prior.ok ||
      (batch
        ? batch.status !== "completed" ||
          batch.tasks.length !== DAILY_RESEARCH_TASKS.length ||
          new Set(batch.tasks.map((task) => task.taskId)).size !== DAILY_RESEARCH_TASKS.length ||
          batch.tasks.some(
            (task) =>
              !DAILY_RESEARCH_TASKS.some((expected) => expected.id === task.taskId) ||
              task.status !== "executed" ||
              task.taskExecution?.status !== "executed" ||
              task.taskExecution.host?.accountId !== batch.host.accountId ||
              task.taskExecution.host?.runId !== batch.host.runId,
          )
        : prior.taskExecution?.status !== "executed")
    ) {
      return receipt("held", "daily_admission_previous_failed_or_partial_requires_review");
    }

    if ("contentReview" in prior) {
      const review = inspectDirectedContentReview(prior);
      if (
        review.status !== "bound_receipt" ||
        review.qualityStatus !== "verified" ||
        !review.qualityPassed ||
        review.verificationStatus !== "passed"
      ) {
        return receipt(
          "held",
          "daily_admission_previous_review_failed_or_unverified_requires_review",
        );
      }
    }
    active();
    return receipt("due", "daily_admission_previous_utc_day_attempt_completed");
  } catch (error) {
    active();
    return receipt(
      "held",
      error instanceof SyntaxError
        ? "daily_admission_previous_invalid_json"
        : error instanceof z.ZodError
          ? "daily_admission_invalid_contract"
          : "daily_admission_history_unreadable",
    );
  }
}

/** Explicit one-task caller. The default brief remains a contract/reader, never a scheduler. */
export async function executeDirectedDailyResearchTask(options: {
  date?: string;
  taskId: string;
  requestPath: string;
  requestSha256: string;
  workspaceDir: string;
  host?: z.infer<typeof DirectedResearchHost>;
  hostPath?: string;
  hostSha256?: string;
  researchOptions?: DirectedResearchOptions;
  controllerEvidence?: FinanceResearchRunOptions["input"]["controllerEvidence"];
  signal?: AbortSignal;
  timeoutMs?: number;
  executionBudget?: { maxApiCalls: number; maxModelCalls: number };
  caseDirectory?: string;
  admission?: DirectedDailyAdmissionInput;
  admissionPath?: string;
  admissionSha256?: string;
}) {
  const brief = buildDirectedDailyResearchBrief({ date: options.date });
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const validDeadline = Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000;
  const deadlineAt = Date.now() + (validDeadline ? timeoutMs : 0);
  const cancel = () =>
    controller.abort(options.signal?.reason ?? new Error("directed_research_cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) {
    cancel();
  }
  const timer = setTimeout(
    () => controller.abort(new Error("directed_research_deadline")),
    validDeadline ? timeoutMs : 0,
  );
  const active = () => {
    if (Date.now() >= deadlineAt && !controller.signal.aborted) {
      controller.abort(new Error("directed_research_deadline"));
    }
    controller.signal.throwIfAborted();
  };
  let abortListener: (() => void) | undefined;
  let researchReceipt: FinanceResearchRunReceipt | undefined;
  let source: { path: string; sha256: string } | undefined;
  let verifiedHost: z.infer<typeof DirectedResearchHost> | undefined;
  let savedCase: Awaited<ReturnType<typeof saveFinanceCaseRun>> | undefined;
  let watchlistGaps: string[] = [];
  let reviewFeedback: DirectedReviewFeedback | undefined;
  let adapterAvailable: boolean | undefined;
  let admission: Awaited<ReturnType<typeof readDirectedDailyAdmission>> | undefined;
  let admissionPin: { path: string; sha256: string } | undefined;
  const body = async () => {
    if (!validDeadline) {
      throw new Error("directed_research_invalid_deadline");
    }
    active();
    if (
      ((options.admissionPath !== undefined || options.admissionSha256 !== undefined) &&
        (!options.admissionPath || !options.admissionSha256)) ||
      (options.admission !== undefined &&
        (options.admissionPath !== undefined || options.admissionSha256 !== undefined))
    ) {
      throw new Error("directed_admission_ambiguous_or_incomplete_input");
    }
    const requestedRoot = path.resolve(options.workspaceDir);
    const root = await fs.realpath(requestedRoot);
    active();
    const readPinned = async (file: string, expected: string) => {
      Hash.parse(expected);
      const relative = path.relative(requestedRoot, path.resolve(requestedRoot, file));
      const bytes = await readPrivateFile(root, relative);
      active();
      if (bytes.length > 64 * 1024) {
        throw new Error("directed_research_manifest_too_large");
      }
      if (sha(bytes) !== expected) {
        throw new Error("directed_research_manifest_hash_conflict");
      }
      return { bytes, relative };
    };
    const manifest = await readPinned(options.requestPath, options.requestSha256);
    source = { path: manifest.relative, sha256: sha(manifest.bytes) };
    const request = DirectedResearchRequest.parse(JSON.parse(manifest.bytes.toString("utf8")));
    if (options.host && options.hostPath) {
      throw new Error("directed_research_ambiguous_host");
    }
    let hostBytes: Buffer | undefined;
    if (options.hostPath && options.hostSha256) {
      const pinned = await readPinned(options.hostPath, options.hostSha256);
      hostBytes = pinned.bytes;
      verifiedHost = DirectedResearchHost.parse(JSON.parse(hostBytes.toString("utf8")));
      if (pinned.relative === manifest.relative) {
        throw new Error("directed_research_host_not_independent");
      }
    } else if (options.host) {
      verifiedHost = DirectedResearchHost.parse(options.host);
    } else {
      throw new Error("directed_research_host_scope_unavailable");
    }
    if (
      request.accountId !== verifiedHost.accountId ||
      request.runId !== verifiedHost.runId ||
      request.maxModelCalls !== verifiedHost.maxModelCalls ||
      request.maxApiCalls !== verifiedHost.maxApiCalls
    ) {
      throw new Error("directed_research_host_scope_conflict");
    }
    if (
      request.taskId !== options.taskId ||
      request.date !== brief.date ||
      request.asOf.slice(0, 10) !== brief.date
    ) {
      throw new Error("directed_research_task_date_conflict");
    }
    let admissionInput = options.admission;
    if (options.admissionPath && options.admissionSha256) {
      const pinned = await readPinned(options.admissionPath, options.admissionSha256);
      admissionPin = { path: pinned.relative, sha256: sha(pinned.bytes) };
      admissionInput = DirectedDailyAdmissionInput.parse(JSON.parse(pinned.bytes.toString("utf8")));
    }
    if (admissionInput) {
      admission = await readDirectedDailyAdmission({
        workspaceDir: root,
        date: brief.date,
        host: verifiedHost,
        admission: admissionInput,
        signal: controller.signal,
      });
      active();
      if (admission.status === "held") {
        throw new Error(admission.reason);
      }
    }
    const executionBudget = options.executionBudget ?? verifiedHost;
    if (
      !["maxApiCalls", "maxModelCalls"].every((key) => {
        const value = executionBudget[key as "maxApiCalls" | "maxModelCalls"];
        return (
          Number.isSafeInteger(value) &&
          value > 0 &&
          value <= verifiedHost![key as "maxApiCalls" | "maxModelCalls"]
        );
      })
    ) {
      throw new Error("directed_research_effective_budget_invalid");
    }
    const ask = buildDirectedTaskAsk(request.taskId);
    const universe =
      request.taskId === "index_options_regime"
        ? [...INDEX_OPTION_UNIVERSE]
        : request.taskId === "semiconductor_leader_board"
          ? [...SEMICONDUCTOR_UNIVERSE]
          : [...INDEX_OPTION_UNIVERSE, ...SEMICONDUCTOR_UNIVERSE];
    if (
      new Set(request.targets.map((t) => t.id)).size !== request.targets.length ||
      request.targets.some((t) => !new Set<string>(universe).has(t.instrument))
    ) {
      throw new Error("directed_research_target_outside_task");
    }
    const moduleSelection = parseFinanceModuleSelection(request.moduleSelection);
    const financeStateDir = options.researchOptions?.financeStateDir
      ? await fs.realpath(options.researchOptions.financeStateDir)
      : undefined;
    active();
    if (financeStateDir && !isPathInside(root, financeStateDir)) {
      throw new Error("directed_research_finance_scope_outside_workspace");
    }
    const runRelative = path.join("state", "directed-daily-research-runs", randomUUID());
    const caseDirectory = options.caseDirectory ?? path.join(runRelative, "cases");
    if (options.caseDirectory) {
      const normalized = path.relative(root, path.resolve(root, options.caseDirectory));
      if (
        !/^state\/directed-daily-research-batches\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/cases$/u.test(
          normalized.split(path.sep).join("/"),
        )
      ) {
        throw new Error("directed_research_case_scope_outside_batch");
      }
      let parentPath = root;
      for (const segment of normalized.split(path.sep)) {
        parentPath = path.join(parentPath, segment);
        const stat = await fs.lstat(parentPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw error;
        });
        active();
        if (stat?.isSymbolicLink()) {
          throw new Error("directed_research_case_scope_alias");
        }
        if (!stat) {
          break;
        }
      }
    }

    const marker = await openWritableFileWithinRoot({
      rootDir: root,
      relativePath: path.join(runRelative, "host.json"),
      truncateExisting: false,
    });
    try {
      active();
      if (marker.openedRealPath !== path.join(root, runRelative, "host.json")) {
        throw new Error("directed_research_write_path_alias");
      }
      await marker.handle.writeFile(JSON.stringify({ host: verifiedHost, request: source }) + "\n");
    } finally {
      await marker.handle.close();
    }
    active();
    adapterAvailable =
      options.researchOptions?.modelRouting !== undefined ||
      options.researchOptions?.modelInvoker !== undefined;

    let feedback = await readDirectedReviewFeedback(root, request, controller.signal);
    if (feedback.evidence.length && (options.controllerEvidence?.length ?? 0) >= 24) {
      feedback = {
        receipt: {
          status: "not_consumed",
          reason: "directed_review_controller_evidence_budget_exceeded",
          pins: [],
          semanticAdoption: "not_proven",
        },
        evidence: [],
      };
    }
    active();
    reviewFeedback = feedback.receipt;
    researchReceipt = await runCheckpointedFinanceResearch(
      {
        ...options.researchOptions,
        batchOptions: {
          ...options.researchOptions?.batchOptions,
          maxApiCalls: executionBudget.maxApiCalls,
        },
        input: {
          ask,
          asOf: request.asOf,
          horizonMonths: request.horizonMonths,
          targets: request.targets,
          moduleSelection,
          executeModules: true,
          decisionMode: "research_only",
          controllerEvidence: [...(options.controllerEvidence ?? []), ...feedback.evidence],
        },
        workspaceDir: root,
        financeStateDir,
        signal: controller.signal,
        // No environment/model configuration is installed here. Without a model,
        // the original planning branch provides its actual unavailable receipt.
        liveFetch: adapterAvailable,
        qualityEnabled: true,
        allowProviderCalls: false,
        moduleExecutor: undefined,
      },
      {
        directory: path.join(root, runRelative, "checkpoints"),
        runTimeoutMs: Math.max(1, deadlineAt - Date.now()),
        maxModelCalls: executionBudget.maxModelCalls,
      },
      runFinanceResearchRun,
    );
    active();
    await readPinned(options.requestPath, options.requestSha256);
    if (options.hostPath && hostBytes) {
      await readPinned(options.hostPath, options.hostSha256!);
    }
    if (options.admissionPath && options.admissionSha256) {
      await readPinned(options.admissionPath, options.admissionSha256);
    }

    for (const pin of [
      ...reviewFeedback.pins,
      ...(reviewFeedback.observedLatest ? [reviewFeedback.observedLatest] : []),
    ]) {
      if (sha(await readPrivateFile(root, pin.path)) !== pin.sha256) {
        throw new Error("directed_review_feedback_changed_before_publication");
      }
      active();
    }
    active();
    if (
      researchReceipt.status !== "candidate" ||
      !researchReceipt.gates.every((gate) => gate.passed)
    ) {
      throw new Error(
        `directed_research_not_candidate:${researchReceipt.status}:${researchReceipt.gates
          .filter((g) => !g.passed)
          .map((g) => g.id + ":" + g.reason)
          .join(";")}`,
      );
    }
    // Allocate a new safe directory before the existing immutable Caseflow writer.
    const caseMarker = await openWritableFileWithinRoot({
      rootDir: root,
      relativePath: path.join(caseDirectory, "scope.json"),
      truncateExisting: false,
    });
    try {
      if (caseMarker.openedRealPath !== path.join(root, caseDirectory, "scope.json")) {
        throw new Error("directed_research_write_path_alias");
      }
    } finally {
      await caseMarker.handle.close();
    }
    active();
    const frozen = buildFinanceCaseRun({
      caseId: request.caseId,
      receipt: researchReceipt,
      execution: {
        mode: "explicit_directed_task",
        accountId: verifiedHost.accountId,
        runId: verifiedHost.runId,
        taskId: request.taskId,
        request: source,
        allocation: {
          maxApiCalls: executionBudget.maxApiCalls,
          maxModelCalls: executionBudget.maxModelCalls,
        },
        noExecutionAuthority: true,
      },
      budget: {
        maxApiCalls: executionBudget.maxApiCalls,
      },
    });
    if (request.taskId === "timely_stock_candidates") {
      watchlistGaps = inspectDirectedWatchlist({
        taskId: request.taskId,
        status: "read_ready",
        gaps: [],
        packet: {
          analysis: frozen.packet.analysis ?? "",
          claims: frozen.packet.claims,
          supportingAnalysis: {
            directedWatchlist: frozen.packet.supportingAnalysis?.directedWatchlist,
          },
        },
        evidence: frozen.run.evidence,
      }).gaps;
      active();
      if (watchlistGaps.length) {
        throw new Error(watchlistGaps.join(";"));
      }
    }
    savedCase = await saveFinanceCaseRun(path.join(root, caseDirectory), frozen);
    active();
    const nativeBytes = await readPrivateFile(root, savedCase.path);
    active();
    const bindings = {
      schemaVersion: "lcx_directed_daily_case_bindings_v1",
      date: brief.date,
      asOf: request.asOf,
      caseDirectory,
      tasks: [
        {
          taskId: request.taskId,
          caseId: request.caseId,
          ref: savedCase.ref,
          caseSha256: sha(nativeBytes),
          snapshotFingerprint: frozen.run.snapshotFingerprint,
          ask,
          targets: researchReceipt.plan.targets.map((t) => t.instrument),
        },
      ],
    };
    const bindingPath = path.join(runRelative, "bindings.json");
    const opened = await openWritableFileWithinRoot({
      rootDir: root,
      relativePath: bindingPath,
      truncateExisting: false,
    });
    try {
      active();
      if (opened.openedRealPath !== path.join(root, bindingPath)) {
        throw new Error("directed_research_write_path_alias");
      }
      await opened.handle.writeFile(JSON.stringify(bindings, null, 2) + "\n");
    } finally {
      await opened.handle.close();
    }
    active();
    const readback = await readDirectedDailyCases({
      date: brief.date,
      bindingsFile: bindingPath,
      workspaceDir: root,
      batchHost: verifiedHost,
    });
    active();
    return {
      ...readback,
      ...(admission
        ? {
            scheduleAdmission: {
              ...admission,
              ...(admissionPin ? { inputFile: admissionPin } : {}),
              consumer: {
                owner:
                  "scripts/operator/lcx-directed-daily-research-brief.ts#executeDirectedDailyResearchTask",
                request: source,
                scope: verifiedHost,
                taskId: options.taskId,
              },
            },
          }
        : {}),
      taskExecution: {
        status: "executed" as const,
        taskId: request.taskId,
        host: verifiedHost,
        allocation: {
          maxApiCalls: executionBudget.maxApiCalls,
          maxModelCalls: executionBudget.maxModelCalls,
        },
        request: source,
        input: researchReceipt.plan,
        researchReceipt,
        reviewFeedback,
        savedCase,
        bindingsFile: bindingPath,
        modelAvailability: adapterAvailable
          ? "supplied_original_adapter"
          : "unavailable_no_source_fetch",
        deadlineMs: timeoutMs,
        cleanup: "local_listener_released_upstream_cleanup_unconfirmed",
        notObserved: [
          ...(admission ? [] : ["schedule_due_gate"]),
          "four_task_daily_packet",
          "module_content_feedback",
          "learning_application",
        ],
      },
    };
  };
  try {
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abortListener, { once: true });
      if (controller.signal.aborted) {
        abortListener();
      }
    });
    return await Promise.race([body(), aborted]);
  } catch (error) {
    const gap =
      error instanceof SyntaxError
        ? "directed_research_manifest_invalid_json"
        : error instanceof z.ZodError
          ? "directed_research_manifest_invalid_contract"
          : error instanceof Error
            ? error.message
            : "directed_research_failed";
    controller.abort(new Error("directed_research_failure_cleanup"));
    const failureGaps = [
      ...(watchlistGaps.length ? watchlistGaps : [gap]),
      ...directedSourceJobGaps(researchReceipt?.batch?.jobs ?? []),
    ];
    const readback = finishDirectedCaseRead(
      brief,
      DAILY_RESEARCH_TASKS.map((task) => ({
        taskId: task.id,
        status: "held",
        contentAcceptance: "not_observed",
        gaps: task.id === options.taskId ? failureGaps : ["task_case_not_observed"],
      })),
      undefined,
      "failed",
    );
    return {
      ...readback,
      ...(admission
        ? {
            scheduleAdmission: {
              ...admission,
              ...(admissionPin ? { inputFile: admissionPin } : {}),
              consumer: {
                owner:
                  "scripts/operator/lcx-directed-daily-research-brief.ts#executeDirectedDailyResearchTask",
                request: source,
                scope: verifiedHost,
                taskId: options.taskId,
              },
            },
          }
        : {}),
      taskExecution: {
        status:
          admission?.status === "held" || watchlistGaps.length
            ? ("held" as const)
            : ("failed" as const),
        taskId: options.taskId,
        host: verifiedHost,
        request: source,
        researchReceipt,
        reviewFeedback,
        savedCase,
        modelAvailability:
          adapterAvailable === undefined
            ? "not_observed"
            : adapterAvailable
              ? "supplied_original_adapter"
              : "unavailable_no_source_fetch",
        gaps: failureGaps,
        deadlineMs: timeoutMs,
        cleanup: "local_listener_released_upstream_cleanup_unconfirmed",
        notObserved: [
          ...(admission ? [] : ["schedule_due_gate"]),
          "four_task_daily_packet",
          "module_content_feedback",
          "learning_application",
        ],
      },
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    if (abortListener) {
      controller.signal.removeEventListener("abort", abortListener);
    }
  }
}

const DirectedBatchRequest = DirectedResearchHost.extend({
  schemaVersion: z.literal("lcx_directed_daily_batch_request_v1"),
  date: z.string(),
  asOf: z.string().datetime({ offset: true }),
  tasks: z
    .array(z.object({ taskId: z.string(), request: z.object({ path: z.string(), sha256: Hash }) }))
    .length(4),
});

/** Explicit bounded use of the existing task caller; optional admission never creates a scheduler. */
export async function executeDirectedDailyResearchBatch(
  options: Omit<
    Parameters<typeof executeDirectedDailyResearchTask>[0],
    "taskId" | "executionBudget" | "caseDirectory"
  >,
) {
  const brief = buildDirectedDailyResearchBrief({ date: options.date });
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadlineAt = Date.now() + timeoutMs;
  const cancel = () =>
    controller.abort(options.signal?.reason ?? new Error("directed_batch_cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) {
    cancel();
  }
  const timer = setTimeout(
    () => controller.abort(new Error("directed_batch_deadline")),
    Math.max(0, timeoutMs),
  );
  const active = () => {
    if (Date.now() >= deadlineAt && !controller.signal.aborted) {
      controller.abort(new Error("directed_batch_deadline"));
    }
    controller.signal.throwIfAborted();
  };
  const summarizeTask = (
    execution: Awaited<ReturnType<typeof executeDirectedDailyResearchTask>>["taskExecution"],
  ) => {
    const native = execution.researchReceipt;
    return {
      status: execution.status,
      host: execution.host,
      request: execution.request,
      allocation: execution.status === "executed" ? execution.allocation : undefined,
      savedCase: execution.savedCase,
      modelAvailability: execution.modelAvailability,
      reviewFeedback: execution.reviewFeedback,
      researchReceipt: native
        ? {
            status: native.status,
            gates: native.gates,
            batch: native.batch
              ? { status: native.batch.status, budget: native.batch.budget }
              : undefined,
            modelCheckpoint: native.modelCheckpoint,
            candidateAnalysisSha256: native.quarterlyOutput.candidateAnalysis
              ? createHash("sha256").update(native.quarterlyOutput.candidateAnalysis).digest("hex")
              : undefined,
          }
        : undefined,
    };
  };
  const tasks: {
    taskId: string;
    status: "not_executed" | "executed" | "failed";
    gaps: string[];
    taskExecution?: ReturnType<typeof summarizeTask>;
  }[] = DAILY_RESEARCH_TASKS.map((task) => ({
    taskId: task.id,
    status: "not_executed",
    gaps: ["task_not_executed"],
  }));
  let host: z.infer<typeof DirectedResearchHost> | undefined;
  let admission: Awaited<ReturnType<typeof readDirectedDailyAdmission>> | undefined;
  let admissionPin: { path: string; sha256: string } | undefined;
  let parent: z.infer<typeof DirectedBatchParent> | undefined;
  let currentTask: string | undefined;
  let abortListener: (() => void) | undefined;
  let allocatedApiCalls = 0;
  let allocatedModelCalls = 0;
  const evidence = (status: "completed" | "partial" | "failed" | "held") => ({
    status,
    host,
    request: parent?.request,
    tasks,
    allocation: {
      maxApiCalls: host?.maxApiCalls,
      maxModelCalls: host?.maxModelCalls,
      allocatedApiCalls,
      allocatedModelCalls,
      policy: "non_refundable_per_task_caps",
    },
    deadlineMs: timeoutMs,
    notObserved: [
      ...(admission ? [] : ["schedule_due_gate"]),
      "module_content_feedback",
      "learning_application",
      "natural_semantic_acceptance",
    ],
    cleanup: "local_listener_released_upstream_cleanup_unconfirmed",
  });
  const body = async () => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
      throw new Error("directed_batch_invalid_deadline");
    }
    active();
    if (
      ((options.admissionPath !== undefined || options.admissionSha256 !== undefined) &&
        (!options.admissionPath || !options.admissionSha256)) ||
      (options.admission !== undefined &&
        (options.admissionPath !== undefined || options.admissionSha256 !== undefined))
    ) {
      throw new Error("directed_admission_ambiguous_or_incomplete_input");
    }
    const requestedRoot = path.resolve(options.workspaceDir);
    const root = await fs.realpath(requestedRoot);
    const readPinned = async (file: string, expected: string) => {
      active();
      Hash.parse(expected);
      const relative = path.relative(requestedRoot, path.resolve(requestedRoot, file));
      const bytes = await readPrivateFile(root, relative);
      active();
      if (bytes.length > 64 * 1024) {
        throw new Error("directed_batch_manifest_too_large");
      }
      if (sha(bytes) !== expected) {
        throw new Error("directed_batch_manifest_hash_conflict");
      }
      return { bytes, ref: { path: relative, sha256: expected } };
    };
    const manifest = await readPinned(options.requestPath, options.requestSha256);
    const request = DirectedBatchRequest.parse(JSON.parse(manifest.bytes.toString("utf8")));
    if (options.host && options.hostPath) {
      throw new Error("directed_batch_ambiguous_host");
    }
    if (options.hostPath && options.hostSha256) {
      const pinned = await readPinned(options.hostPath, options.hostSha256);
      if (pinned.ref.path === manifest.ref.path) {
        throw new Error("directed_batch_host_not_independent");
      }
      host = DirectedResearchHost.parse(JSON.parse(pinned.bytes.toString("utf8")));
    } else if (options.host) {
      host = DirectedResearchHost.parse(options.host);
    } else {
      throw new Error("directed_batch_host_scope_unavailable");
    }
    if (Object.entries(host).some(([key, value]) => request[key as keyof typeof host] !== value)) {
      throw new Error("directed_batch_host_scope_conflict");
    }
    if (
      request.date !== brief.date ||
      request.asOf.slice(0, 10) !== brief.date ||
      new Set(request.tasks.map((task) => task.taskId)).size !== 4 ||
      request.tasks.some(
        (task) => !DAILY_RESEARCH_TASKS.some((original) => original.id === task.taskId),
      )
    ) {
      throw new Error("directed_batch_task_date_conflict");
    }
    const caseIds = new Set<string>();
    const pinnedTasks = [];
    for (const original of DAILY_RESEARCH_TASKS) {
      const selected = request.tasks.find((task) => task.taskId === original.id)!;
      const pinned = await readPinned(selected.request.path, selected.request.sha256);
      if (
        pinned.ref.path === manifest.ref.path ||
        (options.hostPath &&
          path.resolve(requestedRoot, pinned.ref.path) ===
            path.resolve(requestedRoot, options.hostPath))
      ) {
        throw new Error("directed_batch_task_manifest_not_independent");
      }
      const task = DirectedResearchRequest.parse(JSON.parse(pinned.bytes.toString("utf8")));
      if (
        task.taskId !== selected.taskId ||
        task.date !== request.date ||
        task.asOf !== request.asOf ||
        Object.entries(host).some(([key, value]) => task[key as keyof typeof host] !== value)
      ) {
        throw new Error("directed_batch_task_scope_conflict");
      }
      if (caseIds.has(task.caseId)) {
        throw new Error("directed_batch_duplicate_case_id");
      }
      caseIds.add(task.caseId);
      pinnedTasks.push({
        taskId: selected.taskId,
        request: pinned.ref,
        allocation: { maxApiCalls: 0, maxModelCalls: 0 },
      });
    }
    parent = {
      ...host,
      date: request.date,
      asOf: request.asOf,
      request: manifest.ref,
      tasks: pinnedTasks,
    };
    let admissionInput = options.admission;
    if (options.admissionPath && options.admissionSha256) {
      const pinned = await readPinned(options.admissionPath, options.admissionSha256);
      admissionPin = pinned.ref;
      admissionInput = DirectedDailyAdmissionInput.parse(JSON.parse(pinned.bytes.toString("utf8")));
    }
    if (admissionInput) {
      admission = await readDirectedDailyAdmission({
        workspaceDir: root,
        date: brief.date,
        host,
        admission: admissionInput,
        signal: controller.signal,
      });
      active();
      if (admission.status === "held") {
        throw new Error(admission.reason);
      }
    }
    const runRelative = path.join("state", "directed-daily-research-batches", randomUUID());
    const caseDirectory = path.join(runRelative, "cases");
    const marker = await openWritableFileWithinRoot({
      rootDir: root,
      relativePath: path.join(runRelative, "host.json"),
      truncateExisting: false,
    });
    try {
      active();
      if (marker.openedRealPath !== path.join(root, runRelative, "host.json")) {
        throw new Error("directed_batch_write_path_alias");
      }
      await marker.handle.writeFile(JSON.stringify({ host, request: manifest.ref }) + "\n");
    } finally {
      await marker.handle.close();
    }
    const bindings: z.infer<typeof CaseBindings> = {
      schemaVersion: "lcx_directed_daily_case_bindings_v1",
      date: request.date,
      asOf: request.asOf,
      caseDirectory,
      parent,
      tasks: [],
    };
    for (const [index, task] of parent.tasks.entries()) {
      active();
      const remainingTasks = parent.tasks.length - index;
      const api = host.maxApiCalls - allocatedApiCalls;
      const model = host.maxModelCalls - allocatedModelCalls;
      if (api <= 0 || model <= 0) {
        tasks[index] = {
          taskId: task.taskId,
          status: "not_executed",
          gaps: ["shared_batch_budget_exhausted"],
        };
        continue;
      }
      task.allocation = {
        maxApiCalls: Math.max(1, Math.floor(api / remainingTasks)),
        maxModelCalls: Math.max(1, Math.floor(model / remainingTasks)),
      };
      allocatedApiCalls += task.allocation.maxApiCalls;
      allocatedModelCalls += task.allocation.maxModelCalls;
      currentTask = task.taskId;
      const result = await executeDirectedDailyResearchTask({
        ...options,
        admission: undefined,
        admissionPath: undefined,
        admissionSha256: undefined,
        host: options.host ? host : undefined,
        taskId: task.taskId,
        requestPath: task.request.path,
        requestSha256: task.request.sha256,
        caseDirectory,
        executionBudget: task.allocation,
        signal: controller.signal,
        timeoutMs: Math.max(1, deadlineAt - Date.now()),
      });
      active();
      const execution = result.taskExecution;
      tasks[index] = {
        taskId: task.taskId,
        status:
          execution.status === "held"
            ? execution.researchReceipt
              ? "failed"
              : "not_executed"
            : execution.status,
        gaps: execution.status !== "executed" ? execution.gaps : [],
        taskExecution: summarizeTask(execution),
      };
      if (execution.status === "executed") {
        const nativeBindings = CaseBindings.parse(
          JSON.parse((await readPrivateFile(root, execution.bindingsFile)).toString("utf8")),
        );
        active();
        if (
          nativeBindings.caseDirectory !== caseDirectory ||
          nativeBindings.tasks.length !== 1 ||
          nativeBindings.tasks[0]?.taskId !== task.taskId
        ) {
          throw new Error("directed_batch_native_binding_conflict");
        }
        bindings.tasks.push(...nativeBindings.tasks);
      }
      currentTask = undefined;
      if (controller.signal.aborted) {
        active();
      }
    }
    await readPinned(options.requestPath, options.requestSha256);
    if (options.hostPath && options.hostSha256) {
      await readPinned(options.hostPath, options.hostSha256);
    }
    active();
    const bindingPath = path.join(runRelative, "bindings.json");
    const opened = await openWritableFileWithinRoot({
      rootDir: root,
      relativePath: bindingPath,
      truncateExisting: false,
    });
    try {
      active();
      if (opened.openedRealPath !== path.join(root, bindingPath)) {
        throw new Error("directed_batch_write_path_alias");
      }
      await readPinned(options.requestPath, options.requestSha256);
      if (options.hostPath && options.hostSha256) {
        await readPinned(options.hostPath, options.hostSha256);
      }
      if (options.admissionPath && options.admissionSha256) {
        await readPinned(options.admissionPath, options.admissionSha256);
      }
      active();
      await opened.handle.writeFile(JSON.stringify(bindings, null, 2) + "\n");
    } finally {
      await opened.handle.close();
    }
    active();
    const readback = await readDirectedDailyCases({
      date: request.date,
      bindingsFile: bindingPath,
      workspaceDir: root,
      batchHost: host,
    });
    active();
    const sections = readback.packetCandidateSections.map((section) => {
      const task = tasks.find((item) => item.taskId === section.taskId)!;
      return task.status === "executed"
        ? section
        : { ...section, gaps: [...section.gaps, ...task.gaps] };
    });
    return {
      ...finishDirectedCaseRead(
        brief,
        sections,
        readback.caseBindingsSource,
        readback.caseBindingReadStatus,
      ),
      bindingsFile: bindingPath,
      ...(admission
        ? {
            scheduleAdmission: {
              ...admission,
              ...(admissionPin ? { inputFile: admissionPin } : {}),
              consumer: {
                owner:
                  "scripts/operator/lcx-directed-daily-research-brief.ts#executeDirectedDailyResearchBatch",
                request: parent?.request,
                scope: host,
                taskIds: parent?.tasks.map((task) => task.taskId),
              },
            },
          }
        : {}),
      batchExecution: evidence(
        tasks.every((task) => task.status === "executed")
          ? "completed"
          : tasks.some((task) => task.status === "executed")
            ? "partial"
            : "failed",
      ),
    };
  };
  try {
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abortListener, { once: true });
      if (controller.signal.aborted) {
        abortListener();
      }
    });
    return await Promise.race([body(), aborted]);
  } catch (error) {
    const gap =
      error instanceof SyntaxError
        ? "directed_batch_manifest_invalid_json"
        : error instanceof z.ZodError
          ? "directed_batch_manifest_invalid_contract"
          : error instanceof Error
            ? error.message
            : "directed_batch_failed";
    controller.abort(new Error("directed_batch_failure_cleanup"));
    if (currentTask) {
      const index = tasks.findIndex((task) => task.taskId === currentTask);
      tasks[index] = { taskId: currentTask, status: "failed", gaps: [gap] };
    }
    return {
      ...finishDirectedCaseRead(
        brief,
        tasks.map((task) => ({
          taskId: task.taskId,
          status: "held",
          contentAcceptance: "not_observed",
          gaps: task.gaps,
        })),
        undefined,
        "failed",
      ),
      ...(admission
        ? {
            scheduleAdmission: {
              ...admission,
              ...(admissionPin ? { inputFile: admissionPin } : {}),
              consumer: {
                owner:
                  "scripts/operator/lcx-directed-daily-research-brief.ts#executeDirectedDailyResearchBatch",
                request: parent?.request,
                scope: host,
                taskIds: parent?.tasks.map((task) => task.taskId),
              },
            },
          }
        : {}),
      batchExecution: {
        ...evidence(admission?.status === "held" ? "held" : "failed"),
        gaps: [gap],
      },
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    if (abortListener) {
      controller.signal.removeEventListener("abort", abortListener);
    }
  }
}

export async function writeBrief(
  payload: { date: string; visibleBrief: string },
  options?: { workspaceDir: string },
) {
  z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .parse(payload.date);
  const root = await fs.realpath(options?.workspaceDir ?? workspaceDir());
  const dateDir = path.join(root, "memory", "directed-daily-research", payload.date);
  const stateDir = path.join(root, "state");
  const stamp = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
  const jsonPath = path.join(dateDir, `${stamp}__directed-daily-research-brief.json`);
  const markdownPath = path.join(dateDir, `${stamp}__directed-daily-research-brief.md`);
  const latestJsonPath = path.join(stateDir, "lcx-directed-daily-research-brief-latest.json");
  const latestMarkdownPath = path.join(stateDir, "lcx-directed-daily-research-brief-latest.md");
  const metadata = z
    .object({
      executionProvenance: z
        .object({
          archive: DirectedPin.optional(),
          observedLatest: DirectedPin.optional(),
          sources: z.array(DirectedPin).max(16).optional(),
        })
        .optional(),
      taskExecution: z
        .object({
          reviewFeedback: z
            .object({ pins: z.array(DirectedPin), observedLatest: DirectedPin.optional() })
            .optional(),
        })
        .passthrough()
        .optional(),
      batchExecution: z
        .object({
          tasks: z
            .array(
              z
                .object({
                  taskExecution: z
                    .object({
                      reviewFeedback: z
                        .object({
                          pins: z.array(DirectedPin),
                          observedLatest: DirectedPin.optional(),
                        })
                        .optional(),
                    })
                    .passthrough()
                    .optional(),
                })
                .passthrough(),
            )
            .max(4),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .parse(payload);
  const pins = [
    ...(metadata.executionProvenance?.archive ? [metadata.executionProvenance.archive] : []),
    ...(metadata.executionProvenance?.observedLatest
      ? [metadata.executionProvenance.observedLatest]
      : []),
    ...(metadata.executionProvenance?.sources ?? []),
    ...(metadata.taskExecution?.reviewFeedback?.pins ?? []),
    ...(metadata.taskExecution?.reviewFeedback?.observedLatest
      ? [metadata.taskExecution.reviewFeedback.observedLatest]
      : []),
    ...(metadata.batchExecution?.tasks.flatMap(
      (task) => task.taskExecution?.reviewFeedback?.pins ?? [],
    ) ?? []),
  ];
  for (const pin of pins) {
    if (sha(await readPrivateFile(root, pin.path)) !== pin.sha256) {
      throw new Error("directed_publication_pinned_source_changed");
    }
  }
  for (const [file, bytes] of [
    [jsonPath, `${JSON.stringify(payload, null, 2)}\n`],
    [markdownPath, `${payload.visibleBrief}\n`],
    [latestJsonPath, `${JSON.stringify(payload, null, 2)}\n`],
    [latestMarkdownPath, `${payload.visibleBrief}\n`],
  ]) {
    const opened = await openWritableFileWithinRoot({
      rootDir: root,
      relativePath: path.relative(root, file),
      truncateExisting: file === latestJsonPath || file === latestMarkdownPath,
    });
    try {
      // The original safe opener creates with O_EXCL; existing archive bytes are never overwritten.
      if ((file === jsonPath || file === markdownPath) && !opened.createdForWrite) {
        throw new Error("directed_publication_archive_exists");
      }
      if (opened.openedRealPath !== file) {
        throw new Error("directed_publication_alias");
      }
      await opened.handle.writeFile(bytes);
    } finally {
      await opened.handle.close();
    }
  }
  return {
    jsonPath,
    markdownPath,
    latestJsonPath,
    latestMarkdownPath,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const payload = options.executeBatch
    ? await executeDirectedDailyResearchBatch({
        date: options.date,
        requestPath: options.researchRequest!,
        requestSha256: options.researchRequestSha!,
        hostPath: options.researchHost!,
        hostSha256: options.researchHostSha!,
        admissionPath: options.admissionFile,
        admissionSha256: options.admissionSha,
        workspaceDir: workspaceDir(),
      })
    : options.executeTask
      ? await executeDirectedDailyResearchTask({
          date: options.date,
          taskId: options.executeTask,
          requestPath: options.researchRequest!,
          requestSha256: options.researchRequestSha!,
          hostPath: options.researchHost!,
          hostSha256: options.researchHostSha!,
          admissionPath: options.admissionFile,
          admissionSha256: options.admissionSha,
          workspaceDir: workspaceDir(),
        })
      : options.caseBindings
        ? await (options.review ? reviewDirectedDailyCases : readDirectedDailyCases)({
            date: options.date,
            bindingsFile: options.caseBindings,
            workspaceDir: workspaceDir(),
            batchHost: options.researchHost
              ? await readDirectedReviewHost(
                  workspaceDir(),
                  options.researchHost,
                  options.researchHostSha!,
                )
              : undefined,
          })
        : buildDirectedDailyResearchBrief({ date: options.date });
  const written = options.write ? await writeBrief(payload) : undefined;
  const output = written ? { ...payload, written } : payload;
  process.stdout.write(
    options.json ? `${JSON.stringify(output, null, 2)}\n` : `${payload.visibleBrief}\n`,
  );
}
