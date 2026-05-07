import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type TeacherPrompt = {
  id: string;
  userMessage: string;
  sourceSummary: string;
};

type FailureCaseRecipe = {
  caseId: string;
  priority: number;
  userMessage: string;
  sourceSummary: string;
};

type FailureEvalSnapshot = {
  at: string;
  adapterPath: string;
  failedCaseIds: string[];
  passed: number;
  total: number;
  passRate: number;
};

export type FailureCurriculumOptions = {
  guardLogPath?: string;
  maxPrompts: number;
  startIndex?: number;
};

const HOME = process.env.HOME ?? os.homedir();
const DEFAULT_GUARD_LOG = path.join(
  HOME,
  ".openclaw",
  "workspace",
  "logs",
  "minimax-brain-training-guard-medium.jsonl",
);

const FAILURE_CASE_RECIPES: FailureCaseRecipe[] = [
  {
    caseId: "short_lark_commodity_learning_intake",
    priority: 120,
    userMessage:
      "用户只说“学习大宗商品”。训练本地大脑先把短请求扩成通用学习回路：确认对象范围，调本地记忆，拆原油、黄金、工业金属、农产品、美元、通胀、库存、期限结构、ETF/期货工具和风险门；最后只给人类可读总结，不甩 JSON。",
    sourceSummary:
      "targeted repair for short commodity learning intake; simple prompt must route into general commodity curriculum instead of shallow prose.",
  },
  {
    caseId: "commodity_fx_inflation_inventory_portfolio_loop",
    priority: 118,
    userMessage:
      "训练本地大脑分析大宗商品时必须连贯覆盖美元、实际利率、通胀预期、库存/库销比、期货曲线、roll yield、供需冲击、地缘事件、相关 ETF/股票传导、组合风险和反方论证；缺数据就列缺口，不给交易建议。",
    sourceSummary:
      "targeted repair for commodity FX inflation inventory portfolio loop with evidence gaps and research-only boundary.",
  },
  {
    caseId: "human_brain_finance_decomposition",
    priority: 116,
    userMessage:
      "训练本地大脑像人类金融分析师拆复杂任务：先理解目标和时间尺度，再调本地记忆和已学规则，再拆宏观、流动性、基本面、市场结构、技术 timing、量化数学、风险门、数据缺口和 review panel，最后输出中文控制室总结。",
    sourceSummary:
      "targeted repair for human-like finance decomposition with memory activation, causal layers, missing data, review, and readable summary.",
  },
  {
    caseId: "local_memory_knowledge_activation",
    priority: 114,
    userMessage:
      "训练本地大脑遇到金融问题时先激活本地永久记忆和已学规则：查相关能力卡、历史 correction、risk view、source registry 和最近 eval 失败点；只把有证据的规则带入分析，过期或冲突记忆要降权并交给 review。",
    sourceSummary:
      "targeted repair for local memory activation and stale/conflicting memory handling before finance reasoning.",
  },
  {
    caseId: "scenario_probability_no_model_math_guessing",
    priority: 112,
    userMessage:
      "用户要情景概率时，本地大脑不能凭模型口感编概率。先拆情景树、驱动变量、观测数据、先验来源、校准方法、样本外检查和缺失输入；没有数据就只给定性排序和需要的数据，不给伪精确数字。",
    sourceSummary:
      "targeted repair for scenario probability discipline; no invented model math or fake precision.",
  },
  {
    caseId: "paper_learning_internalization_absorption",
    priority: 110,
    userMessage:
      "训练本地大脑学习论文时必须走 source artifact、actual reading scope、capability card、retrieval receipt、apply validation、eval absorption 和 future application path；不能把“存了文件”说成“已经内化”。",
    sourceSummary:
      "targeted repair for paper learning internalization chain and absorption evidence separation.",
  },
  {
    caseId: "a_share_policy_flow_us_tech_spillover",
    priority: 108,
    userMessage:
      "训练本地大脑分析 A 股政策资金面到美股科技的传导：国内政策、人民币/美元流动性、北向/南向资金、指数权重、产业链、ADR/半导体链条、风险偏好和数据缺口都要串起来；research-only。",
    sourceSummary:
      "targeted repair for A-share policy flow to US tech spillover and cross-market causal mapping.",
  },
  {
    caseId: "recession_soft_landing_scenario_tree",
    priority: 106,
    userMessage:
      "训练本地大脑做 recession/soft landing 情景树：就业、通胀、收益率曲线、信用利差、盈利修正、美元流动性、风险资产 breadth 和反方证据都要拆；不要直接预测结论，先给证据框架和失效条件。",
    sourceSummary:
      "targeted repair for macro scenario-tree reasoning with evidence and invalidation conditions.",
  },
  {
    caseId: "conflicting_memory_live_model_review_governance",
    priority: 104,
    userMessage:
      "训练本地大脑处理本地记忆和大模型 review 冲突：先列冲突点、来源时间、证据强弱和是否 stale；本地记忆只提供候选规则，最终要经过 source/eval/review，不允许把旧记忆硬写进结论。",
    sourceSummary: "targeted repair for conflicting memory and live model review governance.",
  },
  {
    caseId: "source_coverage_actual_reading_scope",
    priority: 102,
    userMessage:
      "训练本地大脑回答来源覆盖时必须区分实际读过、只发现、只存档、已应用和已进入 eval 的材料；不能说全覆盖，也不能把摘要当原文阅读。",
    sourceSummary: "targeted repair for source coverage honesty and actual reading scope.",
  },
];

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function evalSnapshotFromPayload(
  payload: Record<string, unknown>,
): FailureEvalSnapshot | undefined {
  if (payload.event !== "step_non_passing" && payload.event !== "step_ok") {
    return undefined;
  }
  if (payload.name !== "candidate_hardened_eval" && payload.name !== "stable_hardened_eval") {
    return undefined;
  }
  const result = payload.result;
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const summary = (result as { summary?: unknown }).summary;
  const adapterPath = (result as { adapterPath?: unknown }).adapterPath;
  if (!summary || typeof summary !== "object" || typeof adapterPath !== "string") {
    return undefined;
  }
  const failedCaseIds = (summary as { failedCaseIds?: unknown }).failedCaseIds;
  if (!Array.isArray(failedCaseIds) || failedCaseIds.length === 0) {
    return undefined;
  }
  const passed = (summary as { passed?: unknown }).passed;
  const total = (summary as { total?: unknown }).total;
  const passRate = (summary as { passRate?: unknown }).passRate;
  return {
    at: typeof payload.at === "string" ? payload.at : "",
    adapterPath,
    failedCaseIds: failedCaseIds.filter((entry): entry is string => typeof entry === "string"),
    passed: typeof passed === "number" ? passed : 0,
    total: typeof total === "number" ? total : 0,
    passRate: typeof passRate === "number" ? passRate : 0,
  };
}

async function latestFailureSnapshot(logPath: string): Promise<FailureEvalSnapshot | undefined> {
  let raw = "";
  try {
    raw = await fs.readFile(logPath, "utf8");
  } catch {
    return undefined;
  }
  const snapshots = raw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(parseJsonLine)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map(evalSnapshotFromPayload)
    .filter((entry): entry is FailureEvalSnapshot => Boolean(entry));
  return snapshots.toSorted((left, right) => right.at.localeCompare(left.at))[0];
}

function fallbackRecipe(caseId: string, priority: number): FailureCaseRecipe {
  return {
    caseId,
    priority,
    userMessage: `训练本地大脑修复 eval 失败项 ${caseId}：先复述失败能力边界，再拆需要的本地记忆、金融模块、证据缺口、风险门、review handoff 和人类可读总结；research-only，不要给交易建议，不要编实时数据。`,
    sourceSummary: `generic targeted repair for local-brain eval failure ${caseId}; requires module planning, evidence gaps, review, and research-only boundary.`,
  };
}

export async function buildFailureCurriculumPrompts(
  options: FailureCurriculumOptions,
): Promise<TeacherPrompt[]> {
  if (options.maxPrompts <= 0) {
    return [];
  }
  const snapshot = await latestFailureSnapshot(options.guardLogPath ?? DEFAULT_GUARD_LOG);
  if (!snapshot) {
    return [];
  }
  const recipeByCaseId = new Map(FAILURE_CASE_RECIPES.map((recipe) => [recipe.caseId, recipe]));
  const recipes = snapshot.failedCaseIds
    .map((caseId, index) => recipeByCaseId.get(caseId) ?? fallbackRecipe(caseId, 10 - index))
    .toSorted(
      (left, right) => right.priority - left.priority || left.caseId.localeCompare(right.caseId),
    )
    .slice(0, options.maxPrompts);
  const startIndex = options.startIndex ?? 0;
  return recipes.map((recipe, index) => ({
    id: `failure_focus_${recipe.caseId}_${String(startIndex + index).padStart(5, "0")}`,
    userMessage: `${recipe.userMessage} 验收码 minimax-failure-focus-${String(startIndex + index).padStart(5, "0")}`,
    sourceSummary: [
      recipe.sourceSummary,
      `Latest failed eval adapter ${path.basename(snapshot.adapterPath)} passed ${snapshot.passed}/${snapshot.total} (${snapshot.passRate}).`,
      "Writes brain distillation review only; no live sender, provider config, language corpus, protected memory, or finance doctrine change.",
    ].join(" "),
  }));
}

export const __test = {
  DEFAULT_GUARD_LOG,
  FAILURE_CASE_RECIPES,
};
