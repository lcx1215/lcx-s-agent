export type SkillAutoCue = {
  skillName: string;
  reason: string;
};

type SkillAutoCueRule = SkillAutoCue & {
  patterns: RegExp[];
};

const AUTO_CUE_RULES: SkillAutoCueRule[] = [
  {
    skillName: "cli-anything-harvester",
    reason:
      "the request is about CLI-Anything, CLI-Hub, local software CLI wrapping, or agent-native desktop control",
    patterns: [
      /\bcli[-\s]?anything\b/i,
      /\bcli[-\s]?hub\b/i,
      /\bagent[-\s]?native\b/i,
      /本地软件.{0,12}cli/i,
      /cli化/i,
      /打开电脑上的任何东西/i,
      /桌面.{0,12}控制/i,
      /软件.{0,12}智能体/i,
      /gui.{0,12}cli/i,
    ],
  },
  {
    skillName: "lcx-qwen-training-operator",
    reason:
      "the request is about Qwen/local-brain training, adapters, guard, MLX, or promotion truth",
    patterns: [
      /\bqwen\b/i,
      /\bmlx\b/i,
      /\badapter\b/i,
      /\bpromotion\b/i,
      /本地大脑.{0,16}训练/,
      /训练.{0,16}guard/i,
      /guard.{0,16}pid/i,
      /候选.{0,12}eval/i,
      /训练.{0,16}样本/,
      /进化.{0,16}qwen/i,
    ],
  },
  {
    skillName: "lcx-workflow-waterflow-auditor",
    reason:
      "the request is about whole-system workflow, waterflow, macro/micro consistency, or memory sedimentation",
    patterns: [
      /\bworkflow\b/i,
      /\bwaterflow\b/i,
      /\bhead[-\s]?tail\b/i,
      /\bmind model\b/i,
      /\bflow graph\b/i,
      /全系统/,
      /上帝视角/,
      /水路/,
      /宏观.{0,8}微观/,
      /记忆沉淀/,
      /系统.{0,12}回路/,
      /全局.{0,12}架构/,
    ],
  },
  {
    skillName: "agent-brain-eval",
    reason:
      "the request asks whether the agent learned, internalized, selected modules, or can really use a skill",
    patterns: [
      /真的.{0,8}会用/,
      /会不会.{0,8}用/,
      /是否.{0,8}学会/,
      /学会.{0,8}了吗/,
      /内化/,
      /能力.{0,12}到哪/,
      /application_ready/i,
      /receipt.{0,12}learn/i,
      /模块.{0,12}学习/,
      /技能.{0,12}会用/,
      /\bbrain eval\b/i,
    ],
  },
  {
    skillName: "lark-post-migration-probe",
    reason:
      "the request asks for post-migration Lark/Feishu live proof or live-user-seen validation",
    patterns: [
      /lark.{0,16}(迁移|probe|验收|live)/i,
      /feishu.{0,16}(迁移|probe|验收|live)/i,
      /飞书.{0,16}(迁移|探针|验收|真实)/,
      /live-user-seen/i,
      /真实.{0,8}(发消息|收消息|验证|验收)/,
    ],
  },
  {
    skillName: "lark-live-loop-debugger",
    reason: "the request is about Lark/Feishu reply-flow debugging or visible reply behavior",
    patterns: [
      /lark.{0,16}(回复|消息|回路|debug|weird|bug)/i,
      /feishu.{0,16}(回复|消息|回路|debug|weird|bug)/i,
      /飞书.{0,16}(回复|消息|回路|调试|异常)/,
      /可见.{0,8}回复/,
      /reply-flow/i,
    ],
  },
  {
    skillName: "agent-runtime-drift-auditor",
    reason:
      "the request is about dev/live/runtime drift, sidecar sync, or migration boundary checks",
    patterns: [
      /dev.{0,8}live/i,
      /live.{0,12}sidecar/i,
      /runtime.{0,8}drift/i,
      /dev仓.{0,12}live仓/,
      /同步.{0,8}live/,
      /迁移.{0,8}live/,
      /漂移/,
    ],
  },
  {
    skillName: "finance-learning-researcher",
    reason: "the request is about finance, ETF, quant, options, or source-gated market learning",
    patterns: [
      /\betf\b/i,
      /\bqqq\b/i,
      /\bspy\b/i,
      /\bnvda\b/i,
      /期权/,
      /财报/,
      /估值/,
      /宏观/,
      /金融/,
      /市场.{0,12}学习/,
      /量化/,
    ],
  },
  {
    skillName: "l5-regression-batterer",
    reason: "the request asks for L5 baseline pressure testing or aggressive regression probes",
    patterns: [/l5/i, /压力测试/, /回归.{0,8}测试/, /拷打/, /baseline.{0,8}pressure/i],
  },
  {
    skillName: "skill-harvester",
    reason: "the request is about evaluating, isolating, or installing a new external/local skill",
    patterns: [
      /新.{0,8}skill/i,
      /外部.{0,8}skill/i,
      /技能库/,
      /安装.{0,8}skill/i,
      /评估.{0,8}skill/i,
      /harvest.{0,8}skill/i,
    ],
  },
  {
    skillName: "lcx-baseline-hardening",
    reason:
      "the request asks for baseline hardening, duplicate-entry convergence, or silent-failure cleanup",
    patterns: [
      /baseline/i,
      /hardening/i,
      /静默失败/,
      /silent failure/i,
      /重复入口/,
      /收敛/,
      /屎山/,
      /打磨/,
    ],
  },
  {
    skillName: "lcx-evolution-loop",
    reason: "the request asks for LCX Agent self-improvement or evolution-loop work",
    patterns: [/自我改进/, /进化/, /evolution/i, /self[-\s]?improv/i],
  },
];

function normalizeAvailableSkillNames(skillNames: string[]): Set<string> {
  return new Set(skillNames.map((entry) => entry.trim()).filter(Boolean));
}

function hasExplicitSkillInvocation(body: string): boolean {
  const trimmed = body.trim();
  return (
    /^\/skill(?:\s|$)/i.test(trimmed) ||
    /^\/[a-z0-9_]+(?:\s|$)/i.test(trimmed) ||
    /^Use the "([^"]+)" skill for this request\./i.test(trimmed)
  );
}

export function resolveSkillAutoCue(params: {
  body: string;
  availableSkillNames: string[];
}): SkillAutoCue | null {
  const body = params.body.trim();
  if (!body || hasExplicitSkillInvocation(body)) {
    return null;
  }
  const available = normalizeAvailableSkillNames(params.availableSkillNames);
  if (available.size === 0) {
    return null;
  }
  for (const rule of AUTO_CUE_RULES) {
    if (!available.has(rule.skillName)) {
      continue;
    }
    if (rule.patterns.some((pattern) => pattern.test(body))) {
      return { skillName: rule.skillName, reason: rule.reason };
    }
  }
  return null;
}

export function applySkillAutoCueToBody(params: {
  body: string;
  cue: SkillAutoCue | null;
}): string {
  if (!params.cue) {
    return params.body;
  }
  return [
    "[Gateway skill preflight - deterministic]",
    `Matched skill: ${params.cue.skillName}`,
    `Reason: ${params.cue.reason}`,
    `Use the "${params.cue.skillName}" skill for this request if its SKILL.md is available in <available_skills>.`,
    "Leave a concise usage receipt: selected skill, why it matched, and any boundary that limited it.",
    "",
    "[Original user request]",
    params.body,
  ].join("\n");
}
