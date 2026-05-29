import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type SkillOptAutoCue = {
  matchedSkillIds: string[];
  bestSkillPaths: string[];
  promptInjection: string;
  boundary: "dev_skillopt_preflight_only";
  liveTouched: false;
  providerConfigTouched: false;
  protectedMemoryTouched: false;
};

type SkillOptAutoCueRule = {
  skillId: string;
  title: string;
  reason: string;
  patterns: RegExp[];
};

const MAX_MATCHED_SKILLOPT_CUES = 3;
const MAX_BEST_SKILL_CHARS = 1800;

const SKILLOPT_AUTO_CUE_RULES: SkillOptAutoCueRule[] = [
  {
    skillId: "finance_data_provenance_preflight",
    title: "finance data provenance preflight",
    reason:
      "the request asks for current, priced, vendor-sourced, fundamental, ETF, options, or macro numbers",
    patterns: [
      /最新.{0,12}(价格|数据|估值|财报|宏观|利率|通胀|etf|期权|持仓|成交|供应商)/i,
      /(价格|估值|财报|利率|通胀|持仓|成交量|options?|ETF).{0,16}(来源|口径|单位|时间戳|供应商|vendor)/i,
      /\b(qqq|spy|tlt|nvda|aapl|msft|tsla|amd|etf|options?)\b/i,
      /finance.{0,16}(data|provenance|gateway|source)/i,
    ],
  },
  {
    skillId: "single_stock_curve_technical_timing_preflight",
    title: "single stock curve technical timing preflight",
    reason:
      "the request asks for single-stock curve, technical timing, entry, exit, invalidation, or position timing",
    patterns: [
      /个股.{0,16}(曲线|走势|技术|买点|卖点|入场|出场|止损|仓位)/,
      /(技术面|均线|支撑|阻力|突破|回撤|趋势|timing|entry|exit).{0,16}(个股|股票|NVDA|TSLA|AAPL|MSFT)/i,
      /single.{0,8}stock.{0,16}(curve|technical|timing|entry|exit)/i,
    ],
  },
  {
    skillId: "local_memory_conflict_preflight",
    title: "local memory conflict preflight",
    reason:
      "the request depends on previous local memory, stale notes, conflict resolution, or durable recall",
    patterns: [
      /(之前|上次|记忆|memory|沉淀|旧结论|旧笔记|旧快照).{0,18}(冲突|过期|更新|引用|证明|恢复|接上)/i,
      /local.{0,8}memory.{0,16}(conflict|stale|recall|preflight)/i,
      /上下文.{0,12}(恢复|丢了|接上|延续)/,
    ],
  },
  {
    skillId: "sentiment_vendor_source_gate_preflight",
    title: "sentiment and vendor source gate preflight",
    reason:
      "the request uses weak finance sources such as interviews, blogs, podcasts, sentiment, or market-attention stories",
    patterns: [
      /(采访|访谈|博客|播客|推特|社媒|情绪|舆情|网红|投资人观点|管理层讲话).{0,18}(学习|判断|影响|催化|来源|证明)/,
      /(sentiment|blog|podcast|interview|vendor).{0,18}(source|gate|finance|market)/i,
      /alternative.{0,8}finance.{0,16}source/i,
    ],
  },
  {
    skillId: "module_learning_absorption_preflight",
    title: "module learning absorption preflight",
    reason:
      "the request asks whether a source, module, or new skill was actually internalized beyond stored-only receipts",
    patterns: [
      /(模块|module|资料|source|skill|技能|知识).{0,20}(学习|内化|吸收|沉淀|会用|真的用了|学会)/i,
      /(stored[-_\s]?only|eval[-_\s]?absorbed|application[-_\s]?ready|absorption)/i,
      /模型.{0,12}(全种吸收|权重吸收|真的学会|会用了)/,
    ],
  },
  {
    skillId: "live_lark_boundary_preflight",
    title: "live Lark boundary preflight",
    reason:
      "the request touches LiveLark, Feishu, live sidecar, live repo sync, or dev/live proof boundaries",
    patterns: [
      /(live|lark|feishu|飞书|live仓|live repo|sidecar|livelock|lock).{0,24}(连接|同步|直接用|证明|可见|回复|迁移|手动搬|格式)/i,
      /(dev|开发仓).{0,12}(live|live仓|sidecar|飞书|Lark).{0,18}(同步|迁移|漂移|直接用)/i,
      /live[-_\s]?user[-_\s]?seen/i,
    ],
  },
];

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    const resolved = path.resolve(trimmed);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      result.push(resolved);
    }
  }
  return result;
}

function resolveSkillOptWorkspaceDirs(params: {
  workspaceDir: string;
  extraWorkspaceDirs?: string[];
  includeDefaultWorkspace?: boolean;
}): string[] {
  const dirs = [params.workspaceDir, ...(params.extraWorkspaceDirs ?? [])];
  if (params.includeDefaultWorkspace !== false) {
    const envWorkspace = process.env.OPENCLAW_WORKSPACE_DIR;
    if (envWorkspace) {
      dirs.push(envWorkspace);
    }
    dirs.push(path.join(os.homedir(), ".openclaw", "workspace"));
  }
  return uniquePaths(dirs);
}

async function readBestSkill(params: {
  workspaceDirs: string[];
  skillId: string;
}): Promise<{ absolutePath: string; body: string } | null> {
  for (const workspaceDir of params.workspaceDirs) {
    const absolutePath = path.join(
      workspaceDir,
      "memory",
      "skillopt-lite",
      params.skillId,
      "best_skill.md",
    );
    try {
      const body = await fs.readFile(absolutePath, "utf8");
      if (body.trim()) {
        return { absolutePath, body };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
    }
  }
  return null;
}

function formatBestSkillExcerpt(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= MAX_BEST_SKILL_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_BEST_SKILL_CHARS).trimEnd()}\n[SkillOpt excerpt truncated]`;
}

function renderPromptInjection(params: {
  matched: Array<{
    rule: SkillOptAutoCueRule;
    bestSkillPath: string;
    bestSkillBody: string;
  }>;
}): string {
  const blocks = params.matched.map((entry, index) =>
    [
      `SkillOpt match ${index + 1}: ${entry.rule.title}`,
      `skillId: ${entry.rule.skillId}`,
      `reason: ${entry.rule.reason}`,
      `bestSkillPath: ${entry.bestSkillPath}`,
      "Apply this SOP internally before planning the answer. Do not expose SkillOpt labels, file paths, receipts, or proof jargon in the visible reply unless the user explicitly asks for protocol proof.",
      "",
      "[best_skill.md excerpt]",
      formatBestSkillExcerpt(entry.bestSkillBody),
    ].join("\n"),
  );
  return [
    "[SkillOpt-lite runtime preflight - deterministic]",
    "Boundary: dev_skillopt_preflight_only. This is an internal planning cue, not model-weight absorption, not live-user-seen proof, and not permission to touch provider config, protected memory, live sender, or trading authority.",
    "",
    ...blocks,
  ].join("\n\n");
}

export async function resolveSkillOptAutoCue(params: {
  body: string;
  workspaceDir: string;
  extraWorkspaceDirs?: string[];
  includeDefaultWorkspace?: boolean;
}): Promise<SkillOptAutoCue | null> {
  const body = params.body.trim();
  if (!body) {
    return null;
  }
  const workspaceDirs = resolveSkillOptWorkspaceDirs(params);
  const matched: Array<{
    rule: SkillOptAutoCueRule;
    bestSkillPath: string;
    bestSkillBody: string;
  }> = [];
  for (const rule of SKILLOPT_AUTO_CUE_RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(body))) {
      continue;
    }
    const bestSkill = await readBestSkill({ workspaceDirs, skillId: rule.skillId });
    if (!bestSkill) {
      continue;
    }
    matched.push({
      rule,
      bestSkillPath: bestSkill.absolutePath,
      bestSkillBody: bestSkill.body,
    });
    if (matched.length >= MAX_MATCHED_SKILLOPT_CUES) {
      break;
    }
  }
  if (matched.length === 0) {
    return null;
  }
  return {
    matchedSkillIds: matched.map((entry) => entry.rule.skillId),
    bestSkillPaths: matched.map((entry) => entry.bestSkillPath),
    promptInjection: renderPromptInjection({ matched }),
    boundary: "dev_skillopt_preflight_only",
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

export function applySkillOptAutoCueToBody(params: {
  body: string;
  cue: SkillOptAutoCue | null;
}): string {
  if (!params.cue) {
    return params.body;
  }
  return [
    params.cue.promptInjection,
    "",
    "[Original user request after SkillOpt-lite preflight]",
    params.body,
  ].join("\n");
}
