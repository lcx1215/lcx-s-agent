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
    skillName: "lcx-promotion-and-adapter-truth-operator",
    reason:
      "the request is about selected-clean adapter truth, latest-promoted invalidation, parseRecovered, or promotion audit",
    patterns: [
      /\badapter\b/i,
      /\bpromotion\b/i,
      /parseRecovered/i,
      /latest[-_\s]?passing/i,
      /latest[-_\s]?promoted/i,
      /selected.{0,12}clean/i,
      /clean.{0,12}adapter/i,
      /晋级.{0,12}(真相|口径|审计|阻塞)/,
      /promotion.{0,12}(truth|audit|ready)/i,
      /候选.{0,12}(晋级|promotion)/,
    ],
  },
  {
    skillName: "lcx-qwen-training-operator",
    reason:
      "the request is about Qwen/local-brain training, guard, MLX, teacher quota, or training supervision",
    patterns: [
      /\bqwen\b.{0,24}(training|train|guard|eval|mlx|pid|status|进化|训练|状态)/i,
      /\bmlx\b/i,
      /本地大脑.{0,16}训练/,
      /训练.{0,16}guard/i,
      /guard.{0,16}pid/i,
      /候选.{0,12}eval/i,
      /训练.{0,16}样本/,
      /进化.{0,16}qwen/i,
    ],
  },
  {
    skillName: "lcx-module-learning-absorption-operator",
    reason:
      "the request is about online/source learning, module internalization, stored-only learning, or eval absorption",
    patterns: [
      /网上.{0,12}学习/,
      /在线.{0,12}学习/,
      /学习.{0,12}(论文|博客|采访|开源|网页|资料|source|来源)/i,
      /(论文|博客|采访|开源项目|外部资料|alternative source).{0,16}(学习|沉淀|内化|吸收)/i,
      /模块.{0,12}(学习|内化|吸收|沉淀)/,
      /eval[-_\s]?absorbed/i,
      /application[-_\s]?ready/i,
      /stored[-_\s]?only/i,
      /source registry.{0,20}(retrieval|apply|eval|absorption)/i,
      /沉淀.{0,12}(学会|内化|吸收)/,
    ],
  },
  {
    skillName: "lcx-commercial-answer-pipeline-operator",
    reason:
      "the request is about commercial answer adoption, short Lark intent expansion, bounded review, or visible reply failed reasons",
    patterns: [
      /商用.{0,12}(回答|回复|流水线|pipeline)/,
      /回答.{0,12}流水线/,
      /短句.{0,12}(意图|问询|判断|拆解)/,
      /模型答案.{0,16}(候选|审阅|靠谱|最终)/,
      /qwen.{0,16}(challenger|挑战|审阅|帮手)/i,
      /failed[-_\s]?reason/i,
      /visible.{0,12}reply/i,
      /可见.{0,12}回复.{0,12}(质量|采用|验收)/,
      /无限.{0,8}(反复|重试|改写)/,
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
      /环环相扣/,
      /精密.{0,8}(仪器|机关|机器)/,
      /自运转/,
      /自愈/,
      /自动.{0,8}(找错|修复|更新|纠错)/,
      /快照.{0,12}(自动|同步|更新|过期|旧)/,
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
      /Agent Lightning/i,
      /LongMemEval/i,
      /AgentRunbook/i,
      /LightMem/i,
      /LycheeMemory/i,
      /ClawBench/i,
      /WildClawBench/i,
      /Agent S/i,
      /外部.{0,12}(agent|智能体).{0,12}(架构|项目|开源|升级)/i,
      /五个.{0,12}(架构|项目).{0,12}(融入|内化|巩固)/,
      /未来.{0,12}(新技术|新模型|新工具|新论文|新升级|开源项目)/,
      /潜在.{0,12}(新技术|新升级|新模型|新工具)/,
      /新技术.{0,16}(融入|接入|升级|吸收|容纳)/,
      /新升级.{0,16}(融入|接入|吸收|容纳)/,
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
