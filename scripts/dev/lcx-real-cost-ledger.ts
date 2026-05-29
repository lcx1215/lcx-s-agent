import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_WORKSPACE_DIR,
  DEFAULT_WORKSPACE_LOG_DIR,
  REAL_COST_LEDGER_LATEST_JSON_PATH,
  REAL_COST_LEDGER_LATEST_MARKDOWN_PATH,
} from "./lcx-local-paths.ts";

type JsonRecord = Record<string, unknown>;

type CostLedgerInput = {
  checkedAt: string;
  logDir: string;
  reviewRoot: string;
  councilRoot?: string;
  monthlySubscriptionCostCny?: number;
  outputPaths: {
    latestJsonPath: string;
    latestMarkdownPath: string;
  };
};

type ProviderStats = {
  calls: number;
  accepted: number;
  failedOrSkipped: number;
  estimatedTextTokens: number;
  usageTokens: number | null;
  usageEvidenceCount: number;
  providerFamily?: string;
};

function recordValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function readJsonl(filePath: string): Promise<JsonRecord[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split(/\n/u)
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return recordValue(parsed) ? [parsed as JsonRecord] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function listFiles(
  root: string,
  predicate: (filePath: string) => boolean,
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath, predicate)));
    } else if (predicate(entryPath)) {
      files.push(entryPath);
    }
  }
  return files.toSorted();
}

function estimateTokenCount(text: string): number {
  if (!text) {
    return 0;
  }
  const cjk = (text.match(/[\u3400-\u9fff]/gu) ?? []).length;
  const nonCjk = Math.max(0, text.length - cjk);
  return Math.ceil(cjk / 1.6 + nonCjk / 4);
}

function collectUsageTokens(value: unknown): number | undefined {
  let total = 0;
  let found = false;
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, nested] of Object.entries(current as JsonRecord)) {
      if (
        /^(input_tokens|output_tokens|prompt_tokens|completion_tokens|total_tokens)$/iu.test(key)
      ) {
        const amount = numberValue(nested);
        if (amount !== undefined) {
          total += amount;
          found = true;
        }
      }
      if (nested && typeof nested === "object") {
        stack.push(nested);
      }
    }
  }
  return found ? total : undefined;
}

function currency(value: number | null): string {
  return value === null ? "无账单证据" : `¥${value.toFixed(2)}`;
}

function statsFor(statsByModel: Map<string, ProviderStats>, model: string): ProviderStats {
  const existing = statsByModel.get(model);
  if (existing) {
    return existing;
  }
  const created: ProviderStats = {
    calls: 0,
    accepted: 0,
    failedOrSkipped: 0,
    estimatedTextTokens: 0,
    usageTokens: null,
    usageEvidenceCount: 0,
  };
  statsByModel.set(model, created);
  return created;
}

function addUsageEvidence(stats: ProviderStats, usageSource: unknown): number | undefined {
  const usageTokens = collectUsageTokens(usageSource);
  if (usageTokens !== undefined) {
    stats.usageTokens = (stats.usageTokens ?? 0) + usageTokens;
    stats.usageEvidenceCount += 1;
  }
  return usageTokens;
}

export async function buildRealCostLedger(input: CostLedgerInput) {
  const logFiles = await listFiles(
    input.logDir,
    (filePath) =>
      path.basename(filePath).startsWith("minimax-quota-brain-saturator-") &&
      filePath.endsWith(".jsonl"),
  );
  let confirmedProviderCalls = 0;
  let confirmedAcceptedTeacherSamples = 0;
  let confirmedProviderFailuresOrSkips = 0;
  let confirmedUsageTokens: number | null = null;
  let confirmedUsageTokenEvidenceCount = 0;
  let teacherBatchCount = 0;
  let councilRunCount = 0;
  let councilRoleCalls = 0;
  let councilSuccessfulRoleCalls = 0;
  let councilFailedRoleCalls = 0;
  let estimatedCouncilTextTokens = 0;
  const byModel = new Map<string, ProviderStats>();

  for (const filePath of logFiles) {
    const entries = await readJsonl(filePath);
    for (const entry of entries) {
      if (
        (entry.event !== "step_ok" && entry.event !== "step_failed") ||
        entry.name !== "minimax_teacher_batch"
      ) {
        continue;
      }
      const result = recordValue(entry.result);
      if (!result || result.mock === true) {
        continue;
      }
      const accepted = numberValue(result.acceptedCandidates) ?? 0;
      const failures = arrayValue(result.failures).length;
      const skipped = arrayValue(result.providerSkippedPromptIds).length;
      const calls = accepted + failures + skipped;
      const model = stringValue(result.teacher) ?? "unknown";
      const modelStats = statsFor(byModel, model);
      modelStats.calls += calls;
      modelStats.accepted += accepted;
      modelStats.failedOrSkipped += failures + skipped;
      confirmedProviderCalls += calls;
      confirmedAcceptedTeacherSamples += accepted;
      confirmedProviderFailuresOrSkips += failures + skipped;
      teacherBatchCount += 1;
      const usageTokens = addUsageEvidence(modelStats, result);
      if (usageTokens !== undefined) {
        confirmedUsageTokens = (confirmedUsageTokens ?? 0) + usageTokens;
        confirmedUsageTokenEvidenceCount += 1;
      }
    }
  }

  const councilFiles = input.councilRoot
    ? await listFiles(input.councilRoot, (filePath) => filePath.endsWith(".json"))
    : [];
  for (const filePath of councilFiles) {
    let artifact: JsonRecord;
    try {
      artifact = JSON.parse(await fs.readFile(filePath, "utf8")) as JsonRecord;
    } catch {
      continue;
    }
    const roles = arrayValue(artifact.roles)
      .map((role) => recordValue(role))
      .filter(Boolean);
    if (roles.length === 0) {
      continue;
    }
    councilRunCount += 1;
    for (const role of roles) {
      const model =
        stringValue(role.model) ??
        stringValue(role.providerFamily) ??
        stringValue(role.role) ??
        "unknown";
      const stats = statsFor(byModel, model);
      stats.providerFamily = stringValue(role.providerFamily) ?? stats.providerFamily;
      const success = role.success === true;
      const text = stringValue(role.text) ?? stringValue(role.error) ?? "";
      const estimatedTokens = estimateTokenCount(text);
      stats.calls += 1;
      stats.estimatedTextTokens += estimatedTokens;
      estimatedCouncilTextTokens += estimatedTokens;
      councilRoleCalls += 1;
      confirmedProviderCalls += 1;
      if (success) {
        councilSuccessfulRoleCalls += 1;
        confirmedAcceptedTeacherSamples += 1;
        stats.accepted += 1;
      } else {
        councilFailedRoleCalls += 1;
        confirmedProviderFailuresOrSkips += 1;
        stats.failedOrSkipped += 1;
      }
      const usageTokens = addUsageEvidence(stats, role);
      if (usageTokens !== undefined) {
        confirmedUsageTokens = (confirmedUsageTokens ?? 0) + usageTokens;
        confirmedUsageTokenEvidenceCount += 1;
      }
    }
  }

  const reviewFiles = await listFiles(
    input.reviewRoot,
    (filePath) => filePath.endsWith(".json") && path.basename(filePath).startsWith("minimax-"),
  );
  let capturedReviewFiles = 0;
  let capturedAcceptedCandidates = 0;
  let capturedTextCharacters = 0;
  for (const filePath of reviewFiles) {
    let artifact: JsonRecord;
    try {
      artifact = JSON.parse(await fs.readFile(filePath, "utf8")) as JsonRecord;
    } catch {
      continue;
    }
    const candidates = arrayValue(artifact.acceptedCandidates);
    if (candidates.length === 0) {
      continue;
    }
    capturedReviewFiles += 1;
    for (const candidate of candidates) {
      const item = recordValue(candidate) ?? {};
      const sample = recordValue(item.sample) ?? {};
      capturedAcceptedCandidates += 1;
      capturedTextCharacters += [
        item.userMessage,
        item.candidateText,
        sample.distillableText,
        item.proposedNextStep,
      ]
        .map((part) => (typeof part === "string" ? part : ""))
        .join("\n").length;
    }
  }

  const subscriptionCost =
    input.monthlySubscriptionCostCny !== undefined &&
    Number.isFinite(input.monthlySubscriptionCostCny)
      ? input.monthlySubscriptionCostCny
      : null;
  const estimatedTeacherReviewTextTokens = Math.ceil(capturedTextCharacters / 3.2);
  const estimatedCapturedTextTokens = estimatedTeacherReviewTextTokens + estimatedCouncilTextTokens;
  const estimatedCostPerAcceptedSampleCny =
    subscriptionCost !== null && confirmedAcceptedTeacherSamples > 0
      ? subscriptionCost / confirmedAcceptedTeacherSamples
      : null;
  const modelRows = [...byModel.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([model, stats]) => ({ model, ...stats }));
  const markdown = [
    "# LCX 真实成本账本",
    "",
    `生成时间：${input.checkedAt}`,
    "",
    "一句话：真实已确认的只算日志里确实存在的调用和账单字段；旧日志没有保存供应商 usage，所以不能把估算 Token 当真钱。",
    "",
    "## 真实已确认",
    `- 三方和老师真实调用次数：${confirmedProviderCalls}`,
    `- 可用产出或已接受材料：${confirmedAcceptedTeacherSamples}`,
    `- 失败或空结果：${confirmedProviderFailuresOrSkips}`,
    `- 有 usage token 证据的批次：${confirmedUsageTokenEvidenceCount}`,
    `- 确认 usage token：${confirmedUsageTokens === null ? "旧日志未保存" : confirmedUsageTokens}`,
    `- 确认金额：${currency(subscriptionCost)}`,
    `- 三方评审文件：${councilRunCount}`,
    `- 三方角色调用：${councilRoleCalls}（成功 ${councilSuccessfulRoleCalls}，失败 ${councilFailedRoleCalls}）`,
    "",
    "## 只能估算",
    `- 已保存老师样本文件：${capturedReviewFiles}`,
    `- 已保存老师样本数：${capturedAcceptedCandidates}`,
    `- 已保存文本字符数：${capturedTextCharacters}`,
    `- 粗估老师样本文本 Token：${estimatedTeacherReviewTextTokens}`,
    `- 粗估 Kimi/MiniMax/DeepSeek 评审文本 Token：${estimatedCouncilTextTokens}`,
    `- 粗估总文本 Token：${estimatedCapturedTextTokens}`,
    `- 若把包月费摊到已接受样本，每条约：${currency(estimatedCostPerAcceptedSampleCny)}`,
    "",
    "## 按模型",
    ...modelRows.map(
      (row) =>
        `- ${row.model}：调用 ${row.calls}，可用 ${row.accepted}，失败/空结果 ${row.failedOrSkipped}，粗估文本 Token ${row.estimatedTextTokens}`,
    ),
    "",
    "## 边界",
    "- 旧 MiniMax/Kimi/DeepSeek API 响应没有统一落 usage 字段，历史精确 token 不能还原。",
    "- 本地 Qwen/MLX 训练不算 API 费用，只能另算本机时间或电费。",
    "- 如果要把包月费算进真钱，需要设置 LCX_MINIMAX_MONTHLY_COST_CNY。",
    "- 不能把估算 Token 当真钱，不能把没有账单证据的供应商费用写成确认成本。",
    "",
  ].join("\n");

  return {
    ok: true,
    kind: "lcx-real-cost-ledger",
    boundary: "dev_cost_observability_only",
    checkedAt: input.checkedAt,
    latestJsonPath: input.outputPaths.latestJsonPath,
    latestMarkdownPath: input.outputPaths.latestMarkdownPath,
    summary: {
      confirmedProviderCalls,
      confirmedAcceptedTeacherSamples,
      confirmedProviderFailuresOrSkips,
      confirmedUsageTokens,
      confirmedUsageTokenEvidenceCount,
      confirmedBilledCostCny: subscriptionCost,
      estimatedCapturedTextTokens,
      estimatedTeacherReviewTextTokens,
      estimatedCouncilTextTokens,
      estimatedCostPerAcceptedSampleCny,
      capturedTextCharacters,
      capturedReviewFiles,
      capturedAcceptedCandidates,
      teacherBatchCount,
      councilRunCount,
      councilRoleCalls,
      councilSuccessfulRoleCalls,
      councilFailedRoleCalls,
    },
    byModel: modelRows,
    sourcePaths: [input.logDir, input.reviewRoot, input.councilRoot].filter(Boolean),
    markdown,
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

export type RealCostLedger = Awaited<ReturnType<typeof buildRealCostLedger>>;

export async function writeRealCostLedger(ledger: RealCostLedger) {
  await fs.mkdir(path.dirname(REAL_COST_LEDGER_LATEST_JSON_PATH), { recursive: true });
  await fs.writeFile(REAL_COST_LEDGER_LATEST_JSON_PATH, `${JSON.stringify(ledger, null, 2)}\n`);
  await fs.writeFile(REAL_COST_LEDGER_LATEST_MARKDOWN_PATH, `${ledger.markdown}\n`);
}

function parseArgs(args: string[]) {
  const options = { json: false, write: false };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        "Usage: node --import tsx scripts/dev/lcx-real-cost-ledger.ts [--json] [--write]",
      );
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const monthlyCost = numberValue(Number(process.env.LCX_MINIMAX_MONTHLY_COST_CNY));
  const ledger = await buildRealCostLedger({
    checkedAt: new Date().toISOString(),
    logDir: DEFAULT_WORKSPACE_LOG_DIR,
    reviewRoot: path.join(DEFAULT_WORKSPACE_DIR, "memory/lark-brain-distillation-reviews"),
    councilRoot: path.join(DEFAULT_WORKSPACE_DIR, "bank/knowledge/learning-councils"),
    monthlySubscriptionCostCny: monthlyCost,
    outputPaths: {
      latestJsonPath: REAL_COST_LEDGER_LATEST_JSON_PATH,
      latestMarkdownPath: REAL_COST_LEDGER_LATEST_MARKDOWN_PATH,
    },
  });
  if (options.write) {
    await writeRealCostLedger(ledger);
  }
  process.stdout.write(options.json ? `${JSON.stringify(ledger, null, 2)}\n` : ledger.markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
