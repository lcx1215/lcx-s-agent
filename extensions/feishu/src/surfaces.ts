import {
  looksLikeCorrectionCarryoverAsk,
  looksLikeExplicitResearchLineContinuationAsk,
  looksLikeFinanceLearningPipelineAsk,
  looksLikeHoldingsRevalidationAsk,
  looksLikeLearningInternalizationAuditAsk,
  looksLikeLearningWorkflowAuditAsk,
  looksLikeMethodLearningTopic,
  looksLikeFinanceLearningMaintenanceAsk,
  looksLikeLearningCapabilityLarkCommandAsk,
  looksLikeSourceGroundingAsk,
  looksLikeStrategicLearningAsk,
  looksLikeVerticalFinanceLearningAsk,
  normalizeFeishuIntentText,
} from "./intent-matchers.js";
import type { FeishuConfig } from "./types.js";

export const FEISHU_CHAT_SURFACE_REGISTRY = {
  control_room: {
    roleContract: "orchestrator",
    notice:
      "Use this surface for orchestration, resets, routing decisions, and explicit control-plane coordination.",
  },
  technical_daily: {
    roleContract: "technical analyst",
    notice:
      "Use this surface for ETF / major-asset / timing-discipline analysis, current anchors, structural narrative, and pricing-gap framing.",
  },
  fundamental_research: {
    roleContract: "fundamental researcher",
    notice:
      "Use this surface for issuer fundamentals, watchlist maintenance, follow-up requests, review memos, and artifact-backed company research.",
  },
  knowledge_maintenance: {
    roleContract: "knowledge maintainer",
    notice:
      "Use this surface for learning capture, open-source study, method digestion, paper notes, and durable knowledge maintenance.",
  },
  learning_command: {
    roleContract: "learning council orchestrator",
    notice:
      "Use this surface for one-shot multi-model learning requests that broaden and parallelize learning work while keeping production decision paths strict, audited, and bounded.",
  },
  ops_audit: {
    roleContract: "ops auditor",
    notice:
      "Use this surface for operational health, probes, degraded paths, artifact errors, audit trails, and reliability investigation.",
  },
  watchtower: {
    roleContract: "repair sentinel",
    notice:
      "Use this surface for meaningful anomaly reporting, repair-ticket drafting, bounded repair handoff, and run-first supervision without interrupting daily operation.",
  },
} as const;

export type FeishuChatSurfaceName = keyof typeof FEISHU_CHAT_SURFACE_REGISTRY;
export type FeishuSpecialistSurfaceName = Exclude<FeishuChatSurfaceName, "control_room">;
export const FEISHU_CHAT_SURFACE_NAMES = Object.keys(FEISHU_CHAT_SURFACE_REGISTRY) as [
  FeishuChatSurfaceName,
  ...FeishuChatSurfaceName[],
];

export type ResolvedFeishuSurfaceRouting = {
  currentSurface?: FeishuChatSurfaceName;
  targetSurface?: FeishuChatSurfaceName;
  suppressedIntentSurface?: FeishuChatSurfaceName;
  targetChatId?: string;
  roleContract?: string;
  source: "chat_binding" | "intent_route" | "intent_route_with_chat_binding" | "none";
};

export type FeishuControlRoomOrchestrationPlan = {
  mode: "aggregate" | "expand";
  specialistSurfaces: FeishuSpecialistSurfaceName[];
  expandSurface?: FeishuSpecialistSurfaceName;
  publishMode: FeishuPublishMode;
  replyContract?:
    | "default"
    | "position_management"
    | "holdings_thesis_revalidation"
    | "learning_internalization_audit"
    | "learning_workflow_audit";
  includeDailyWorkface?: boolean;
};

export type FeishuPublishMode = "summary_only" | "classified_publish" | "draft_only";

export type FeishuClassifiedArtifactType =
  | "control_summary"
  | "technical_slice"
  | "fundamental_slice"
  | "knowledge_slice"
  | "ops_slice";

export type FeishuClassifiedArtifactConfidence = "high" | "medium" | "low";

export type FeishuClassifiedArtifact = {
  type: FeishuClassifiedArtifactType;
  heading: string;
  body: string;
  confidence?: FeishuClassifiedArtifactConfidence;
  publishRequested?: boolean;
  foundations?: string[];
};

export type FeishuClassifiedPublishRouting = {
  artifactType: FeishuClassifiedArtifactType;
  surface: FeishuChatSurfaceName;
  chatId?: string;
};

export type FeishuClassifiedPublishResult = {
  controlSummary: string;
  publishableArtifacts: FeishuClassifiedArtifact[];
  draftArtifacts: FeishuClassifiedArtifact[];
  publishTargets: FeishuClassifiedPublishRouting[];
  distributionSummary: string;
};

const FEISHU_CLASSIFIED_ARTIFACT_HEADINGS: Record<FeishuClassifiedArtifactType, string> = {
  control_summary: "Control Summary",
  technical_slice: "Technical Slice",
  fundamental_slice: "Fundamental Slice",
  knowledge_slice: "Knowledge Slice",
  ops_slice: "Ops Slice",
};

const FEISHU_CLASSIFIED_PUBLISH_ROUTES: Record<
  Exclude<FeishuClassifiedArtifactType, "control_summary">,
  FeishuChatSurfaceName
> = {
  technical_slice: "technical_daily",
  fundamental_slice: "fundamental_research",
  knowledge_slice: "knowledge_maintenance",
  ops_slice: "ops_audit",
};

function normalizeSurfaceText(text: string): string {
  return normalizeFeishuIntentText(text);
}

function isControlCommand(normalizedCommandText?: string): boolean {
  const normalizedCommand = normalizeSurfaceText(normalizedCommandText ?? "");
  return (
    normalizedCommand === "/new" ||
    normalizedCommand === "/reset" ||
    normalizedCommand.startsWith("/new ") ||
    normalizedCommand.startsWith("/reset ")
  );
}

function addIntentSurfaceIf(
  surfaces: FeishuChatSurfaceName[],
  surface: FeishuChatSurfaceName,
  matched: boolean,
): void {
  if (matched) {
    surfaces.push(surface);
  }
}

function appendNoticeLines(lines: string[], notices: string[]): void {
  lines.push(...notices);
}

const CONTROL_ROOM_GROUNDING_CONTRACT_LINES = [
  "[System: Control-room grounding contract: before claiming live-fixed, dev-fixed, started, running, completed, blocked, or unproven, first check the freshest available state evidence instead of answering from chat memory alone.]",
  "[System: Evidence order for control-room status claims: current-research-line and protected summaries first; then Feishu/Lark surface lines, work receipts, learning timebox/session state, watchtower anomalies, and recent reply-flow evidence when available.]",
  "[System: State labels must stay literal: dev-fixed means local implementation or tests only; live-fixed means migrated, built, restarted, probed, and verified through the real Lark/Feishu path; started/running/completed/blocked/unproven must not be blended into one success label.]",
  "[System: If the required evidence is missing, stale, or only inferred, say unproven or unknown in plain language and give the single next check that would resolve it.]",
];

const FEISHU_SHARED_STATUS_BOUNDARY_LINES = [
  "[System: Feishu/Lark status boundary: before claiming live-fixed, dev-fixed, started, running, completed, blocked, or unproven, use current evidence instead of chat memory alone.]",
  "[System: Treat questions like 现在在干什么, 修到哪了, 还剩多少, 是不是 live 了, 现在能用了吗, and what remains as status-readback requests. Answer them from evidence order first, not from narrative memory or optimistic progress prose.]",
  "[System: Status-readback evidence order: current repo state, scoped diff or commit receipt, targeted test or lint receipt, migration/build/restart receipt, live probe receipt, and visible Lark/Feishu reply-flow evidence. Say which layer is present and which layer is still missing.]",
  "[System: Keep status labels literal across every Feishu/Lark surface: dev-fixed means local implementation or tests; live-fixed means migrated, built, restarted, probed, and verified through the real Lark/Feishu path.]",
  "[System: If status evidence is missing, stale, or inferred, say unproven or unknown and name the next check.]",
];

function inferIntentSurfaces(params: {
  content: string;
  normalizedCommandText?: string;
}): FeishuChatSurfaceName[] {
  const normalized = normalizeSurfaceText(params.content);
  if (!normalized && !params.normalizedCommandText) {
    return [];
  }

  if (isControlCommand(params.normalizedCommandText)) {
    return ["control_room"];
  }

  const surfaces: FeishuChatSurfaceName[] = [];
  addIntentSurfaceIf(
    surfaces,
    "knowledge_maintenance",
    /(^|\s*)(反馈：|复盘：|纠正：)/u.test(params.content),
  );
  addIntentSurfaceIf(
    surfaces,
    "control_room",
    looksLikeExplicitResearchLineContinuationAsk(normalized),
  );
  addIntentSurfaceIf(surfaces, "control_room", looksLikeLarkWorkRoleManagementAsk(normalized));
  addIntentSurfaceIf(
    surfaces,
    "control_room",
    /(live[-\s]?(?:probe|sync|council)|lark.*status|status audit|前台.*(?:超时|验收)|可见回复|visible reply|dev[- ]?fixed|live[- ]?fixed|gateway.*指向)/u.test(
      normalized,
    ) &&
      /(timeout|超时|只回复|不要扩展|不要沉默|current evidence|proof|next step|unverified|failedreason|验收码|acceptance code|live-sync-ok)/u.test(
        normalized,
      ) &&
      !/(finance_?learning|financelearningpipeline|learningintent|source memory\/articles|学习复盘|复盘回路|不重新学习|只复盘)/u.test(
        normalized,
      ),
  );
  addIntentSurfaceIf(
    surfaces,
    "control_room",
    /(queued|completed|排队|一次只能做一个|不要并行|别并行|按优先级|先分类)/u.test(normalized) &&
      /(done|queued|next step|proof|completed|完成|证据|receipt|下一步)/u.test(normalized),
  );
  addIntentSurfaceIf(
    surfaces,
    "learning_command",
    /(learning council|学习委员会|学习指令|学习命令|多模型学习|三模型学习|并行学习|批量学习|学这个并给我结论|用三个模型学|让三个模型一起学|帮我学一下|去学一下|开始学习|开始学|现在开始学|先开始学|立刻开始学|学学最近|看看最近有什么值得学|学完告诉我|学完说人话总结|金融策略|financial strategy|quant strategy|日频技术|日频策略|daily[-\s]?frequency strategy|daily[-\s]?frequency trading|金融技术|fintech|agent platform|agent platforms|智能体平台|同类agent|同类 agent|peer agents|同类平台|agent框架|agent 框架|开源策略|开源金融策略|开源金融技术|中文理解|英文理解|中英理解|双语理解|bilingual|multilingual|language understanding|language comprehension|术语映射|术语对照|翻译歧义|语义理解|自然语言理解|hermes(?:-agent)?|nous research|github cli|gh cli|memory provider|memory providers|context file|context files|skills hub|skill installer|plugin system|install(?:ation|ability)?|setup wizard|claw migrate)/u.test(
      normalized,
    ),
  );
  addIntentSurfaceIf(
    surfaces,
    "learning_command",
    /不是教我学|你自己学|自己去学/u.test(normalized),
  );
  addIntentSurfaceIf(surfaces, "learning_command", looksLikeStrategicLearningAsk(normalized));
  addIntentSurfaceIf(surfaces, "learning_command", looksLikeMethodLearningTopic(normalized));
  addIntentSurfaceIf(surfaces, "learning_command", looksLikeVerticalFinanceLearningAsk(normalized));
  addIntentSurfaceIf(surfaces, "learning_command", looksLikeFinanceLearningPipelineAsk(normalized));
  addIntentSurfaceIf(
    surfaces,
    "learning_command",
    looksLikeFinanceLearningMaintenanceAsk(normalized),
  );
  addIntentSurfaceIf(
    surfaces,
    "learning_command",
    looksLikeLearningCapabilityLarkCommandAsk(normalized),
  );
  addIntentSurfaceIf(
    surfaces,
    "knowledge_maintenance",
    looksLikeLearningInternalizationAuditAsk(normalized),
  );
  addIntentSurfaceIf(
    surfaces,
    "knowledge_maintenance",
    looksLikeLearningWorkflowAuditAsk(normalized),
  );
  addIntentSurfaceIf(
    surfaces,
    "knowledge_maintenance",
    looksLikeCorrectionCarryoverAsk(normalized),
  );
  addIntentSurfaceIf(surfaces, "ops_audit", looksLikeSourceGroundingAsk(normalized));
  addIntentSurfaceIf(
    surfaces,
    "watchtower",
    /(watchtower|repair ticket|repair run|报修|保修|维修工单|异常汇总|anomaly|hallucination spike|reply drift|quality drift|degradation|回归报警|报警工单)/u.test(
      normalized,
    ),
  );
  addIntentSurfaceIf(
    surfaces,
    "ops_audit",
    /(状态|健康|探针|probe|audit|审计|日志|log|degraded|故障|异常|重启|restart|超时|timeout|blocked|artifact error|ops|系统怎么样|系统还好吗|哪里坏了|哪里不对劲|运行情况|网络搜索可以用吗|网络搜索能用吗|搜索可以用吗|搜索能用吗|web search available|is web search available|search health|search status|hard block|高报|低报)/u.test(
      normalized,
    ),
  );
  addIntentSurfaceIf(
    surfaces,
    "fundamental_research",
    /(基本面|财报|年报|季报|指引|电话会|公司|企业|issuer|company|watchlist|follow-up|follow up|fundamental|annual report|quarterly report|investor presentation|科技财报|读财报|看看财报|公司研究|商业质量|capex|ai capex|资本开支|商业支出)/u.test(
      normalized,
    ),
  );
  addIntentSurfaceIf(
    surfaces,
    "technical_daily",
    /(非农|cpi|ppi|fomc|通胀|通胀预期|利率|美债|收益率|期限溢价|美元|油价|就业|加息|降息|qqq|tlt|spy|iwm|dxy|etf|指数|大类资产|风险|潜在收益|美股|macro|inflation|payroll|treasury|yield|duration|rates?|技术面|technical analysis|timing discipline)/u.test(
      normalized,
    ),
  );
  addIntentSurfaceIf(
    surfaces,
    "knowledge_maintenance",
    /(paper|论文|方法|method|frontier|leakage|overfitting|复现|replication|baseline|学学|学习|复盘|反馈|纠正|开源|新技术|源码|技术栈|原理|教程|文档|study|learn|open source|correction|post-hoc|post hoc|错题|错在哪|帮我复盘|帮我纠正|复盘一下|讲讲学到了什么|知识维护|内化|降级|删掉记忆)/u.test(
      normalized,
    ),
  );

  return [...new Set(surfaces)];
}

function inferIntentSurface(params: {
  content: string;
  normalizedCommandText?: string;
}): FeishuChatSurfaceName | undefined {
  return inferIntentSurfaces(params)[0];
}

function resolveExpandSurface(content: string): FeishuSpecialistSurfaceName | undefined {
  const normalized = normalizeSurfaceText(content);
  if (/(^|\s)(expand technical|展开技术|展开 technical|细说技术|详细技术)/u.test(normalized)) {
    return "technical_daily";
  }
  if (
    /(^|\s)(expand fundamental|展开基本面|展开 fundamental|细说基本面|详细基本面)/u.test(normalized)
  ) {
    return "fundamental_research";
  }
  if (/(^|\s)(expand ops|展开运维|展开审计|细说运维|详细运维)/u.test(normalized)) {
    return "ops_audit";
  }
  if (/(^|\s)(expand knowledge|展开知识|展开学习|细说知识|详细知识|详细学习)/u.test(normalized)) {
    return "knowledge_maintenance";
  }
  return undefined;
}

function looksLikeBroadControlRoomAsk(content: string): boolean {
  const normalized = normalizeSurfaceText(content);
  return /(今天|today|总览|总结|概览|overview|brief|简报|该关注|值得关注|重点|盘面|市场|研究重点|what matters|what should|整体怎么样|先看什么|先抓什么|最危险的点|一句话说清|一句话的现状判断|总判断|最短版)/u.test(
    normalized,
  );
}

function looksLikeBroadControlRoomRiskAsk(content: string): boolean {
  const normalized = normalizeSurfaceText(content);
  return /(最可能出错|最容易错|最危险的点|哪里在漂|到底有没有用|有没有用|没什么用|红队一下|先红队|哪里最容易出错|哪里最可能出错|哪里最值得怀疑|值得怀疑|可能是假的|定时炸弹|可疑的锚点|最像过拟合|值得降权|该删的噪音|低质量学习|最该警惕的一条偏差|hard block|proxy|不够硬|有没有内化|可复用规则|复用规则|最值钱|应该降级|应该删掉|改善最大|最不稳定|恢复失败|失败说成成功|高报|低报|值不值得扩新功能|最该修什么|哪条链会掉|先验哪条|最不值得信|表面稳定实际在漂|假繁荣|不粉饰)/u.test(
    normalized,
  );
}

function looksLikeMetaControlRoomAggregateAsk(content: string): boolean {
  const normalized = normalizeSurfaceText(content);
  const hasMetaCue =
    /(控制室|系统健康|学习状态|研究状态|研究\/学习\/风控|学习债|研究债|学习有效性|系统稳定性|研究质量|最近七天|现状判断|总判断|最短版|睡觉八小时|明天只验一条链|哪条链会掉|最该修什么|值不值得扩新功能|最不值得信|假繁荣|不粉饰)/u.test(
      normalized,
    );
  const hasAggregateCue =
    /(总览|总结|简报|日报|一句话|讲给我|一起讲|一起说|先说结论|先告诉我|先给我|给我一个|哪条|哪里|有没有|最|该先补)/u.test(
      normalized,
    );
  return hasMetaCue && hasAggregateCue;
}

export function looksLikeLarkWorkRoleManagementAsk(content: string): boolean {
  const normalized = normalizeSurfaceText(content);
  const roleCue =
    /(机器人|角色|工位|分工|work\s*role|workrole|role lane|小明|小李|小王|小美|小赵)/u.test(
      normalized,
    );
  const managementCue =
    /(新增|增加|添加|加一个|加个|创建|设一个|删掉|删除|减少|移除|停用|禁用|恢复|重置|列出|展示|看看|改成|更新|负责)/u.test(
      normalized,
    );
  return roleCue && managementCue;
}

export function looksLikeDailyOperatingBrief(content: string): boolean {
  const normalized = normalizeSurfaceText(content);
  return /(日报|daily report|daily brief|briefing|健康报告|卓越报告|运营报告|operating report|health report|morning brief|morning report|工作面板|工作面表|dashboard|看板|昨天学了什么|昨天纠正了什么|昨天干了什么|今天学了什么|今天纠正了什么)/u.test(
    normalized,
  );
}

function looksLikePositionManagementAsk(content: string): boolean {
  const normalized = normalizeSurfaceText(content);
  return /(买|买入|卖|卖出|加仓|减仓|持有|持仓|补仓|止盈|止损|要不要买|要不要卖|该不该买|该不该卖|该不该加|该不该减|should i buy|should i sell|should i add|should i reduce|should i hold|add to position|reduce position|current holdings|risk\/reward on)/u.test(
    normalized,
  );
}

function resolveRequestedPublishMode(content: string): FeishuPublishMode | undefined {
  const normalized = normalizeSurfaceText(content);
  if (
    /(draft only|只做草稿|只出草稿|先别发|不要发布|不要分发|仅草稿|hold as draft|只保留草稿)/u.test(
      normalized,
    )
  ) {
    return "draft_only";
  }
  if (/(summary only|只要总结|只给总结|只发总结|只回主群|summary-first only)/u.test(normalized)) {
    return "summary_only";
  }
  return undefined;
}

function resolveConfiguredSurfaceByChatId(params: {
  cfg: FeishuConfig | undefined;
  chatId: string;
}): FeishuChatSurfaceName | undefined {
  const normalizedChatId = params.chatId.trim();
  if (!normalizedChatId) {
    return undefined;
  }

  const matches: FeishuChatSurfaceName[] = [];
  for (const surfaceName of Object.keys(FEISHU_CHAT_SURFACE_REGISTRY) as FeishuChatSurfaceName[]) {
    const surfaceCfg = params.cfg?.surfaces?.[surfaceName];
    if (surfaceCfg?.enabled === false) {
      continue;
    }
    if (surfaceCfg?.chatId?.trim() === normalizedChatId) {
      matches.push(surfaceName);
    }
  }

  // A duplicated chat binding is not a unique "current surface". Preserve explicit
  // intent routing, but do not pretend the incoming chat maps to a single surface.
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveFeishuSurfaceRouting(params: {
  cfg?: FeishuConfig;
  chatId: string;
  content: string;
  normalizedCommandText?: string;
}): ResolvedFeishuSurfaceRouting {
  const currentSurface = resolveConfiguredSurfaceByChatId({
    cfg: params.cfg,
    chatId: params.chatId,
  });
  const intentSurfaces = inferIntentSurfaces({
    content: params.content,
    normalizedCommandText: params.normalizedCommandText,
  });
  const intentSurface = intentSurfaces[0];

  // A specialist chat is a dedicated working lane. Once the incoming chat is
  // explicitly bound to that surface, keep turns inside that lane instead of
  // letting keyword matches silently hop to another workflow.
  if (currentSurface && currentSurface !== "control_room") {
    const targetChatId = params.cfg?.surfaces?.[currentSurface]?.chatId?.trim() || undefined;
    const suppressedIntentSurface = intentSurfaces.find((surface) => surface !== currentSurface);
    return {
      currentSurface,
      targetSurface: currentSurface,
      suppressedIntentSurface,
      targetChatId,
      roleContract: FEISHU_CHAT_SURFACE_REGISTRY[currentSurface].roleContract,
      source: "chat_binding",
    };
  }

  const targetSurface = intentSurface ?? currentSurface;

  if (!targetSurface) {
    return { source: "none" };
  }

  const targetChatId = params.cfg?.surfaces?.[targetSurface]?.chatId?.trim() || undefined;

  return {
    currentSurface,
    targetSurface,
    targetChatId,
    roleContract: FEISHU_CHAT_SURFACE_REGISTRY[targetSurface].roleContract,
    source:
      currentSurface && intentSurface && currentSurface !== intentSurface
        ? "intent_route_with_chat_binding"
        : intentSurface
          ? "intent_route"
          : "chat_binding",
  };
}

export function resolveFeishuControlRoomOrchestration(params: {
  currentSurface?: FeishuChatSurfaceName;
  targetSurface?: FeishuChatSurfaceName;
  content: string;
  normalizedCommandText?: string;
}): FeishuControlRoomOrchestrationPlan | undefined {
  if (params.currentSurface !== "control_room") {
    return undefined;
  }

  if (isControlCommand(params.normalizedCommandText) && params.targetSurface === "control_room") {
    return undefined;
  }

  const expandSurface = resolveExpandSurface(params.content);
  if (expandSurface) {
    return {
      mode: "expand",
      specialistSurfaces: [expandSurface],
      expandSurface,
      publishMode: "summary_only",
    };
  }

  const requestedPublishMode = resolveRequestedPublishMode(params.content);
  if (looksLikeLarkWorkRoleManagementAsk(params.content)) {
    return {
      mode: "aggregate",
      specialistSurfaces: ["ops_audit"],
      publishMode: "summary_only",
      replyContract: "default",
    };
  }

  if (looksLikeStrategicLearningAsk(params.content)) {
    return {
      mode: "aggregate",
      specialistSurfaces: ["learning_command"],
      publishMode: requestedPublishMode ?? "classified_publish",
      replyContract: "default",
    };
  }

  if (looksLikeMethodLearningTopic(params.content)) {
    return {
      mode: "aggregate",
      specialistSurfaces: ["learning_command"],
      publishMode: requestedPublishMode ?? "classified_publish",
      replyContract: "default",
    };
  }

  if (looksLikeVerticalFinanceLearningAsk(params.content)) {
    return {
      mode: "aggregate",
      specialistSurfaces: ["learning_command"],
      publishMode: requestedPublishMode ?? "classified_publish",
      replyContract: "default",
    };
  }

  if (looksLikeFinanceLearningPipelineAsk(params.content)) {
    return {
      mode: "aggregate",
      specialistSurfaces: ["learning_command"],
      publishMode: requestedPublishMode ?? "classified_publish",
      replyContract: "default",
    };
  }

  if (looksLikeFinanceLearningMaintenanceAsk(params.content)) {
    return {
      mode: "aggregate",
      specialistSurfaces: ["learning_command"],
      publishMode: requestedPublishMode ?? "classified_publish",
      replyContract: "default",
    };
  }

  if (looksLikeLearningCapabilityLarkCommandAsk(params.content)) {
    return {
      mode: "aggregate",
      specialistSurfaces: ["learning_command"],
      publishMode: requestedPublishMode ?? "classified_publish",
      replyContract: "default",
    };
  }

  if (looksLikeLearningInternalizationAuditAsk(params.content)) {
    return {
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: requestedPublishMode ?? "classified_publish",
      replyContract: "learning_internalization_audit",
    };
  }

  if (looksLikeLearningWorkflowAuditAsk(params.content)) {
    return {
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: requestedPublishMode ?? "classified_publish",
      replyContract: "learning_workflow_audit",
    };
  }

  if (looksLikeCorrectionCarryoverAsk(params.content)) {
    return {
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance"],
      publishMode: requestedPublishMode ?? "classified_publish",
      replyContract: "default",
    };
  }

  if (looksLikeSourceGroundingAsk(params.content)) {
    return {
      mode: "aggregate",
      specialistSurfaces: ["ops_audit"],
      publishMode: requestedPublishMode ?? "classified_publish",
      replyContract: "default",
    };
  }

  if (looksLikeHoldingsRevalidationAsk(params.content)) {
    return {
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
      publishMode: requestedPublishMode ?? "summary_only",
      replyContract: "holdings_thesis_revalidation",
    };
  }

  if (looksLikePositionManagementAsk(params.content)) {
    const inferredSpecialists = inferIntentSurfaces({
      content: params.content,
      normalizedCommandText: params.normalizedCommandText,
    }).filter((surface): surface is FeishuSpecialistSurfaceName => surface !== "control_room");

    return {
      mode: "aggregate",
      specialistSurfaces:
        inferredSpecialists.length > 0 ? inferredSpecialists : ["technical_daily"],
      publishMode: "summary_only",
      replyContract: "position_management",
    };
  }

  if (looksLikeDailyOperatingBrief(params.content)) {
    return {
      mode: "aggregate",
      specialistSurfaces: [
        "technical_daily",
        "fundamental_research",
        "knowledge_maintenance",
        "ops_audit",
      ],
      publishMode: requestedPublishMode ?? "classified_publish",
      replyContract: "default",
      includeDailyWorkface: true,
    };
  }

  if (looksLikeBroadControlRoomRiskAsk(params.content)) {
    return {
      mode: "aggregate",
      specialistSurfaces: [
        "technical_daily",
        "fundamental_research",
        "knowledge_maintenance",
        "ops_audit",
      ],
      publishMode: requestedPublishMode ?? "classified_publish",
      replyContract: "default",
      includeDailyWorkface: true,
    };
  }

  if (looksLikeMetaControlRoomAggregateAsk(params.content)) {
    return {
      mode: "aggregate",
      specialistSurfaces: [
        "technical_daily",
        "fundamental_research",
        "knowledge_maintenance",
        "ops_audit",
      ],
      publishMode: requestedPublishMode ?? "classified_publish",
      replyContract: "default",
      includeDailyWorkface: true,
    };
  }

  const inferredSpecialists = inferIntentSurfaces({
    content: params.content,
    normalizedCommandText: params.normalizedCommandText,
  }).filter((surface): surface is FeishuSpecialistSurfaceName => surface !== "control_room");

  if (inferredSpecialists.length > 0) {
    return {
      mode: "aggregate",
      specialistSurfaces: inferredSpecialists,
      publishMode: requestedPublishMode ?? "classified_publish",
      replyContract: "default",
    };
  }

  if (!looksLikeBroadControlRoomAsk(params.content)) {
    return undefined;
  }

  return {
    mode: "aggregate",
    specialistSurfaces: [
      "technical_daily",
      "fundamental_research",
      "knowledge_maintenance",
      "ops_audit",
    ],
    publishMode: requestedPublishMode ?? "classified_publish",
    replyContract: "default",
    includeDailyWorkface: true,
  };
}

function parseArtifactConfidence(value: string): FeishuClassifiedArtifactConfidence | undefined {
  const normalized = normalizeSurfaceText(value);
  if (normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }
  return undefined;
}

function parseArtifactPublishRequest(value: string): boolean | undefined {
  const normalized = normalizeSurfaceText(value);
  if (["yes", "true", "publish"].includes(normalized)) {
    return true;
  }
  if (["no", "false", "draft"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function extractArtifactMetadata(lines: string[]): {
  confidence?: FeishuClassifiedArtifactConfidence;
  publishRequested?: boolean;
  foundations?: string[];
  contentLines: string[];
} {
  let confidence: FeishuClassifiedArtifactConfidence | undefined;
  let publishRequested: boolean | undefined;
  let foundations: string[] | undefined;
  const contentLines = [...lines];

  while (contentLines.length > 0) {
    const line = contentLines[0]?.trim();
    if (!line) {
      contentLines.shift();
      continue;
    }
    const confidenceMatch = /^confidence:\s*(.+)$/iu.exec(line);
    if (confidenceMatch) {
      confidence = parseArtifactConfidence(confidenceMatch[1]) ?? confidence;
      contentLines.shift();
      continue;
    }
    const publishMatch = /^publish:\s*(.+)$/iu.exec(line);
    if (publishMatch) {
      publishRequested = parseArtifactPublishRequest(publishMatch[1]) ?? publishRequested;
      contentLines.shift();
      continue;
    }
    const foundationsMatch = /^foundations:\s*(.+)$/iu.exec(line);
    if (foundationsMatch) {
      const parsed = foundationsMatch[1]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      foundations = parsed.length > 0 ? parsed : foundations;
      contentLines.shift();
      continue;
    }
    break;
  }

  return { confidence, publishRequested, foundations, contentLines };
}

function containsLowFidelityLanguage(text: string): boolean {
  return /(low-fidelity|low fidelity|provisional|stale|prior|illustrative|weak evidence)/iu.test(
    text,
  );
}

export function parseFeishuClassifiedArtifacts(text: string): FeishuClassifiedArtifact[] {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return [];
  }

  const headingPattern =
    /^##\s+(Control Summary|Technical Slice|Fundamental Slice|Knowledge Slice|Ops Slice)\s*$/gim;
  const matches = [...normalizedText.matchAll(headingPattern)];
  if (matches.length === 0) {
    return [];
  }

  const headingToType = Object.fromEntries(
    Object.entries(FEISHU_CLASSIFIED_ARTIFACT_HEADINGS).map(([type, heading]) => [
      heading.toLowerCase(),
      type as FeishuClassifiedArtifactType,
    ]),
  );

  return matches
    .map((match, index) => {
      const heading = match[1] ?? "";
      const type = headingToType[heading.toLowerCase()];
      if (!type || match.index === undefined) {
        return null;
      }
      const bodyStart = match.index + match[0].length;
      const bodyEnd =
        index + 1 < matches.length
          ? (matches[index + 1].index ?? normalizedText.length)
          : normalizedText.length;
      const rawBody = normalizedText.slice(bodyStart, bodyEnd).trim();
      const { confidence, publishRequested, foundations, contentLines } = extractArtifactMetadata(
        rawBody.split(/\r?\n/),
      );
      const body = contentLines.join("\n").trim();
      if (!body) {
        return null;
      }
      return {
        type,
        heading,
        body,
        confidence,
        publishRequested,
        foundations,
      } satisfies FeishuClassifiedArtifact;
    })
    .flatMap((artifact) => (artifact ? [artifact] : []));
}

function buildDistributionSummary(params: {
  publishableArtifacts: FeishuClassifiedArtifact[];
  draftArtifacts: FeishuClassifiedArtifact[];
}): string {
  const published = params.publishableArtifacts.map((artifact) => artifact.heading.toLowerCase());
  const drafts = params.draftArtifacts.map((artifact) => artifact.heading.toLowerCase());
  if (published.length === 0 && drafts.length === 0) {
    return "Distribution: summary only.";
  }
  const parts: string[] = [];
  if (published.length > 0) {
    parts.push(`published ${published.join(", ")}`);
  }
  if (drafts.length > 0) {
    parts.push(`held as draft ${drafts.join(", ")}`);
  }
  return `Distribution: ${parts.join("; ")}.`;
}

export function resolveFeishuClassifiedPublishResult(params: {
  cfg?: FeishuConfig;
  publishMode: FeishuPublishMode;
  specialistSurfaces: FeishuSpecialistSurfaceName[];
  text: string;
}): FeishuClassifiedPublishResult {
  const artifacts = parseFeishuClassifiedArtifacts(params.text);
  const controlSummary =
    artifacts.find((artifact) => artifact.type === "control_summary")?.body ?? params.text.trim();
  const allowedArtifactTypes = new Set(
    params.specialistSurfaces.map((surface) => {
      switch (surface) {
        case "technical_daily":
          return "technical_slice" as const;
        case "fundamental_research":
          return "fundamental_slice" as const;
        case "knowledge_maintenance":
        case "learning_command":
        case "watchtower":
          return "knowledge_slice" as const;
        case "ops_audit":
          return "ops_slice" as const;
      }
    }),
  );

  const specialistArtifacts = artifacts.filter(
    (artifact) => artifact.type !== "control_summary" && allowedArtifactTypes.has(artifact.type),
  );

  const publishableArtifacts: FeishuClassifiedArtifact[] = [];
  const draftArtifacts: FeishuClassifiedArtifact[] = [];
  const publishTargets: FeishuClassifiedPublishRouting[] = [];

  for (const artifact of specialistArtifacts) {
    const surface =
      artifact.type === "control_summary"
        ? undefined
        : FEISHU_CLASSIFIED_PUBLISH_ROUTES[artifact.type];
    if (!surface) {
      continue;
    }
    const chatId = params.cfg?.surfaces?.[surface]?.chatId?.trim() || undefined;
    const publishable =
      params.publishMode === "classified_publish" &&
      artifact.publishRequested === true &&
      artifact.confidence !== "low" &&
      !containsLowFidelityLanguage(artifact.body) &&
      Boolean(chatId);

    if (publishable) {
      publishableArtifacts.push(artifact);
      publishTargets.push({ artifactType: artifact.type, surface, chatId });
      continue;
    }

    draftArtifacts.push(artifact);
  }

  return {
    controlSummary,
    publishableArtifacts,
    draftArtifacts,
    publishTargets,
    distributionSummary: buildDistributionSummary({ publishableArtifacts, draftArtifacts }),
  };
}

export function buildFeishuSurfaceNotice(
  routing: ResolvedFeishuSurfaceRouting | undefined,
): string | undefined {
  const targetSurface = routing?.targetSurface;
  if (!targetSurface) {
    return undefined;
  }

  const descriptor = FEISHU_CHAT_SURFACE_REGISTRY[targetSurface];
  const lines = [
    `[System: Feishu operating surface target = ${targetSurface}.]`,
    `[System: Surface role contract = ${descriptor.roleContract}. ${descriptor.notice}]`,
  ];

  if (targetSurface !== "control_room") {
    appendNoticeLines(lines, [
      `[System: This is a dedicated ${targetSurface} working lane. Stay inside this lane by default. If the operator wants mixed work, cross-surface coordination, or a re-route, tell them to use control_room instead of silently switching workflows.]`,
      `[System: If a request mixes this lane with another domain, answer only the part that belongs to ${targetSurface}, say in one plain sentence what you are not handling here, and point the operator back to control_room for cross-surface orchestration.]`,
    ]);
  }

  appendNoticeLines(lines, [
    "[System: In Feishu, terse continuation or approval turns such as 继续, 下一步, 按优先级学, 扎实补好, 好的, ok, or continue usually mean keep the current lane and answer with the next bounded step in plain language first. Do not silently escalate those turns into long code generation, file creation, or workspace-write workflows unless the operator explicitly asks to implement, write, save, create a file, or patch something.]",
    "[System: Before acting, classify the operator's work intent from the current message: direct answer, bounded continuation, learning or research, correction or review, search or health check, or explicit implementation. Then stay inside that one mode unless the operator clearly asks for mixed work.]",
    "[System: If the work intent is ambiguous, default to the smallest useful mode that keeps progress visible: answer or bounded next-step guidance first, not silent escalation into implementation.]",
  ]);
  appendNoticeLines(lines, FEISHU_SHARED_STATUS_BOUNDARY_LINES);

  if (targetSurface === "control_room") {
    appendNoticeLines(lines, [
      "[System: Lark visible-role boundary: if the operator asks to add, remove, list, reset, or rename visible robots/roles such as 小明/小李/小王, treat them as display/work-role lanes under one primary brain, not separate brains or separate learning systems.]",
      "[System: Use feishu_work_roles for explicit visible-role registry changes when available. Never claim this created a real separate Lark bot/app or a separate learning system.]",
    ]);
  }

  if (
    targetSurface === "control_room" ||
    targetSurface === "knowledge_maintenance" ||
    targetSurface === "learning_command"
  ) {
    appendNoticeLines(lines, [
      "[System: Self-build boundary: you may directly create or update low-risk artifacts such as HOOK notes, correction notes, weekly reviews, learning summaries, follow-up checklists, anomaly notes, specialist usage guides, reply-template drafts, and repair or upgrade ticket drafts when they improve daily Lobster operation.]",
      "[System: Do not directly rewrite high-risk core layers such as provider-routing main paths, hard risk gates, shared-summary protection, fundamental review-chain core contracts, classified-publish safety boundaries, watchtower threshold logic, or quant-math formulas. For those, generate a compact repair or upgrade ticket instead.]",
      "[System: If a requested improvement touches production safety boundaries or a core contract, default to proposal or ticket, not direct self-modification. Use a compact ticket with: Problem, Why it matters, Evidence, Smallest safe scope, Out of scope, Suggested owner.]",
      "[System: Never pretend a write succeeded when it did not. If artifact persistence fails, say it is understood for the current session but not yet in long-term storage.]",
    ]);
  }

  if (targetSurface === "learning_command") {
    appendNoticeLines(lines, [
      "[System: Speak human-first. Start with 2-4 plain-language bullets that tell the operator what was learned, what is still doubtful, and what matters next. Only then give the five required council sections.]",
      "[System: Learning council mode is active. One user instruction should trigger a three-role learning process with stable lane labels: Kimi = synthesis lane, MiniMax = challenge / counter-argument / weakness-detection lane, DeepSeek = extraction / lesson-transfer lane.]",
      "[System: Treat Kimi / MiniMax / DeepSeek as stable council lane labels, not as proof of which provider actually ran. If runtime receipts or artifacts show a different provider/model behind a lane, preserve the lane label for structure but report the actual runtime provider/model honestly.]",
      "[System: Do not fake a council by writing one blended answer in three cosmetic sections. Make the role split real and explicit.]",
      "[System: Use exactly these five sections in order: 1. Kimi synthesis, 2. MiniMax challenge, 3. DeepSeek extraction, 4. Council consensus, 5. Follow-up checklist.]",
      "[System: Treat that five-part structure as a required output schema, not a style suggestion. Missing any required section means the council output is incomplete.]",
      "[System: Do not write 模型一 / 模型二 / 模型三, model one / two / three, or replace the three named model roles with generic analytical frames such as valuation model, risk model, or flow model.]",
      "[System: Kimi synthesis should state the main narrative, strongest evidence, and any freshness caveat. MiniMax challenge should directly attack weak premises, overclaims, hidden assumptions, and counter-cases. DeepSeek extraction should turn the material into compact lessons, checklists, and candidate follow-ups. If runtime receipts are present, keep the lane semantics but do not let an outdated vendor assumption overwrite the actual provider/model.]",
      "[System: Council consensus must explicitly separate: agreed points, disagreement, evidence that is still weak, and what cannot yet be concluded.]",
      "[System: Council consensus must contain these explicit subfields: agreements, disagreements, and evidence gaps. Do not collapse them into one blended paragraph.]",
      "[System: If this turn does not actually contain separately attributable Kimi, MiniMax, and DeepSeek role outputs, do not pretend it does. State plainly that true learning-council fan-out did not occur yet, then give only a provisional single-pass learning note instead of fake council output.]",
      "[System: Follow-up checklist should name the next variables, documents, or observations to track. Do not turn it into direct trading instructions or pseudo-execution triggers.]",
      "[System: Restrict learning scope to high-value domains only: ETF / major asset / regime, macro / rates / risk appetite, high-quality fundamentals, timing discipline, risk-control lessons, portfolio decision quality, post-hoc review of prior recommendations, and bounded data-science / statistics method learning that improves low-frequency research discipline such as regression sanity checks, out-of-sample logic, cross-validation mindset, and robustness testing.]",
      "[System: Do not optimize for becoming a generic super-agent. Stable finance-domain usefulness comes first: fewer errors, cleaner iteration, and better cumulative judgment beat broad capability theater.]",
      "[System: If a learning request is mostly about agent tooling, platform design, or open-source patterns, keep it bounded and only retain what clearly improves Lobster's finance research workflow, filtering, timing discipline, or risk control.]",
      "[System: If the user asks to maintain, consolidate, or strengthen prior finance-learning work, start by preserving and inspecting existing finance learning artifacts, capability candidates, pipeline receipts, and promotion handoff state. Do not restart from a blank learning plan unless the existing artifacts are missing or malformed.]",
      "[System: If the user asks to learn a concrete finance capability, quant factor/timing strategy, ETF risk-control method, portfolio discipline, regime framework, or local/manual finance source into the Lobster brain, route it through finance_learning_pipeline_orchestrator when a safe local/manual source is available. Preserve the raw user wording as learningIntent, require safe source intake, and expect retrievalReceiptPath plus retrievalReviewPath before calling the learning internalized.]",
      "[System: If the user asks to connect or harden learning capability through Lark / Feishu language commands, treat the Lark wording as the user-facing entrypoint and the finance learning pipeline as the backend capability. Name the intended command family, the routed surface, the reusable tool path such as finance_learning_capability_inspect or finance_learning_pipeline_orchestrator, and the proof still needed before calling it live-fixed.]",
      "[System: For external-source learning requests such as Google/web search, arXiv/papers, blogs/docs, GitHub/repos, peer agents, competitor systems, or benchmark examples, do not produce a source tour. Convert source material into bounded adoption knowledge: retain, discard, replay trigger, next eval, compatibility risk, and one verifiable next step for Lobster.]",
      "[System: If the user asks whether GitHub trending/open-source project features can be added or whether LCX Agent already has an internal embryo, route the feature through github_project_capability_intake before proposing implementation. Require a repo URL, README/docs summary, or selected feature summary; do not install, clone-run, or execute unfamiliar repo code.]",
      "[System: For another-agent, GitHub CLI, install/setup/migration, context-file, skills/plugin, or memory-provider topic, distill it as bounded adoption knowledge: what Lobster should adopt now, what to skip, what compatibility risk to watch, and one next patch or install step it can verify locally.]",
      "[System: A valid extra learning lane is bilingual Chinese/English comprehension for Lobster itself: finance and system terminology mapping, ambiguity reduction, workflow-trigger understanding, and plain-language reporting. Do not turn this into generic language tutoring or fake mastery claims.]",
      "[System: If the user says 日频技术 or 日频策略 without extra qualifiers, interpret it as finance or quant methods for daily-frequency research by default, not Japanese-language technology or generic HFT hype. If some ambiguity remains, state your finance interpretation first instead of falling back to a generic clarification-only reply.]",
      "[System: When the topic is portfolio decision quality, prefer compact reusable outputs around seven foundations: portfolio sizing discipline, risk transmission, outcome review, behavior-error correction, low-frequency execution hygiene, business quality, and catalyst mapping.]",
      "[System: Numeric discipline applies here too. If data freshness is weak or not freshly verified in this turn, mark numbers as provisional / low-fidelity / prior, or omit them. Do not use precise figures to create false authority.]",
      "[System: If search, browsing, or source coverage looks weak for one role, keep that limit explicit. Let the remaining roles rescue the council where possible, but preserve an honest reliability note instead of pretending coverage was broad.]",
      "[System: Prohibited in learning-council output unless the user explicitly asks: model one / two / three framing, direct trading advice, point targets, support/resistance calls, 'tonight's data decides direction' language, or any precise number presented without a freshness or provisional label.]",
      "[System: Before finalizing, self-audit the output: verify the five required sections exist, verify MiniMax contains a real challenge, verify Council consensus includes evidence gaps, and verify no unlabelled high-specificity numbers or pseudo-trading guidance slipped through.]",
      "[System: Production safety boundary: learning outputs are not direct execution decisions, must not auto-promote into final trading actions or doctrine, and must not weaken production memory or hard-risk gates.]",
      "[System: If the user requests a timeboxed or duration-bound learning session such as 学一个小时 or 持续学习 30 分钟, do not pretend a persistent background study session started unless this path actually has one. State explicitly whether the request was downgraded to a single audited learning pass.]",
    ]);
  }

  if (targetSurface === "watchtower") {
    appendNoticeLines(lines, [
      "[System: Watchtower mode is active. This surface exists to keep the system usable while it runs, not to pause operation for every flaw.]",
      "[System: Be short, hard, and executable. Lead with one plain-language alert line, not a long narrative.]",
      "[System: Report only meaningful anomalies: reply-quality drift, hallucination risk under weak freshness, repeated provider/search degradation, production-path inconsistency, learning drift, or infrastructure instability.]",
      "[System: Do not spam polish issues. Lower-priority wording or formatting flaws may be recorded briefly, but should not interrupt normal operation.]",
      "[System: Prefer structured repair-ticket candidates with these fields when evidence is sufficient: Category, Foundation Template, Problem, Evidence, Impact, Suggested scope, Suggested owner.]",
      "[System: Suggested scope must stay bounded. Favor prompt/policy hardening, routing fixes, or the smallest safe patch. Do not propose broad refactors, new providers, new memory architecture, or automatic self-editing.]",
      "[System: Use a fixed watchtower report structure when evidence is sufficient: Severity, Category, Foundation Template, Problem, Evidence, Impact, Operator action, and optional Repair ticket candidate.]",
      "[System: Use exact field labels when possible: Alert, Severity, Category, Foundation Template, Problem, Evidence, Impact, Operator action, and optional Repair ticket candidate.]",
      "[System: Repair ticket candidates should stay compact and structured: Category, Problem, Evidence, Impact, Suggested scope, Suggested owner.]",
      "[System: If evidence is weak or the issue is just polish, mark it as observe_only instead of escalating. Prefer one meaningful anomaly note over a noisy complaint stream.]",
      "[System: Operator action must be a bounded next step the human can approve or defer, such as approve repair run, observe only, verify again tomorrow, or inspect one narrow seam. Do not give generic hand-wavy advice.]",
      "[System: Do not let watchtower replies turn into essays, market commentary, or support-bot apologies. Keep them concise, evidence-led, and repair-oriented.]",
      "[System: Production safety boundary: watchtower may detect, summarize, and prepare bounded repair handoff, but must not directly rewrite doctrine, memory, or execution behavior without explicit approval.]",
    ]);
  }

  if (targetSurface === "ops_audit") {
    appendNoticeLines(lines, [
      "[System: For source-grounding or evidence challenges, separate verified evidence, missing evidence, and inferred claims. If the source or verification is absent, say unknown or unverified instead of filling the gap.]",
    ]);
  }

  if (targetSurface === "knowledge_maintenance") {
    appendNoticeLines(lines, [
      "[System: When summarizing learning, correction, or review work, speak in plain language first: what changed, what was corrected, and what the operator should keep in mind now. Keep workflow or note-taking mechanics secondary.]",
    ]);
  }

  if (routing.targetChatId) {
    lines.push(`[System: Configured target chat for this surface = ${routing.targetChatId}.]`);
  }

  if (routing.currentSurface && routing.currentSurface !== targetSurface) {
    lines.push(
      `[System: This message arrived via configured surface ${routing.currentSurface} but is explicitly routed to ${targetSurface}. Preserve the current stable intake path and treat this as front-end routing, not a model guess.]`,
    );
  }

  if (
    routing.currentSurface &&
    routing.currentSurface === targetSurface &&
    routing.suppressedIntentSurface
  ) {
    lines.push(
      `[System: This specialist lane is pinned to ${targetSurface}. The incoming text also contained cues for ${routing.suppressedIntentSurface}, but that alternate intent was intentionally suppressed to prevent cross-talk. Treat those cues as context only; do not switch workflows inside this chat.]`,
    );
  }

  return lines.join("\n");
}

export function buildFeishuControlRoomOrchestrationNotice(
  plan: FeishuControlRoomOrchestrationPlan | undefined,
): string | undefined {
  if (!plan) {
    return undefined;
  }

  const surfaces = plan.specialistSurfaces.join(", ");
  if (plan.mode === "expand" && plan.expandSurface) {
    return [
      "[System: Control-room orchestration mode is active.]",
      `[System: Publish mode = ${plan.publishMode}.]`,
      `[System: Expand follow-up detected. Deepen only this specialist slice: ${plan.expandSurface}.]`,
      ...CONTROL_ROOM_GROUNDING_CONTRACT_LINES,
      "[System: Keep the reply in the control room. Start with one clear summary sentence, then expand only the requested specialist detail. Do not tell the user to manually message another group.]",
      "[System: Sound like an orchestrator, not a confused support bot. Stay concrete and brief.]",
      "[System: Keep workflow or file-maintenance notes secondary. Do not lead with internal status or file-update phrasing.]",
    ].join("\n");
  }

  const lines = [
    "[System: Control-room orchestration mode is active.]",
    `[System: Publish mode = ${plan.publishMode}.]`,
    `[System: Internally fan this request out to the relevant specialist surfaces: ${surfaces}.]`,
    ...CONTROL_ROOM_GROUNDING_CONTRACT_LINES,
    "[System: Optimize for a normal user. Do not make the user remember multiple groups or internal topology.]",
    "[System: Return one clear control-room summary first. Keep it simple for a non-technical user: what matters, what to watch, and what action or next step is most sensible.]",
    "[System: For daily or morning reports, combine the seven decision foundations into one concise brief when relevant: market/risk picture, position sizing, cross-asset transmission, outcome review, behavior drift, business quality follow-ups, catalyst map, plus operational health.]",
    "[System: For broad requests, give a useful low-fidelity overview first instead of a clarification-first response. Use the best available current state and mention the top missing context briefly only if it materially limits confidence.]",
    "[System: If a provider, search, or freshness layer is unavailable, acknowledge it briefly in one short phrase and continue with the best grounded summary you can give. Do not turn the reply into an error report.]",
    "[System: When freshness or provider reliability is weak, do not present high-specificity market figures, exact levels, exact percentages, or exact point estimates as if they were fresh facts from this turn.]",
    "[System: In low-fidelity or degraded-data mode, prefer directional wording, scenario framing, and missing-anchor language over precise numeric claims. If a numeric anchor is not freshly verified in this turn, either omit it or explicitly label it as stale / prior / illustrative rather than current.]",
    "[System: Do not make file-maintenance actions such as 'updated research.md', 'added section', or similar script-style bookkeeping the main user-facing phrasing. Describe the research outcome in plain language first.]",
    "[System: If real-time freshness is weak, stale, cached, or provider-limited, label the view as low-fidelity or provisional and keep claims modest. Do not present it like a high-confidence read.]",
    "[System: In low-fidelity mode, keep confidence discipline tight: no precise trading-style conviction, no pseudo-live market color, and no concrete buy/sell language that depends on unverified fresh data.]",
    "[System: Treat this as decision support, not prediction theater. Prefer clearer filtering, timing discipline, and hard risk framing over hype.]",
    "[System: Sound like an orchestrator: calm, clear, and decisive. Do not sound like a support escalation bot or a confused tool wrapper.]",
    "[System: Specialist detail is optional. Do not tell the user to manually message other groups. If a deeper dive would help, mention the follow-up pattern: expand technical / expand fundamental / expand ops / expand knowledge.]",
    "[System: If the operator asks to add, remove, list, reset, or change visible Lark robots/roles such as 小明/小李/小王, use the feishu_work_roles tool when available. Keep the reply boundary explicit: one primary brain, one unified learning system, dynamic visible role lanes only.]",
    "[System: When publish mode is classified_publish or draft_only, format the response with exact top-level sections using markdown headings: ## Control Summary, ## Technical Slice, ## Fundamental Slice, ## Knowledge Slice, ## Ops Slice.]",
    "[System: Control Summary is mandatory and must stay human-first. Specialist slices are optional and should appear only when they materially add value.]",
    "[System: Every specialist slice must begin with metadata lines before the body: publish: yes|no, confidence: high|medium|low, and when relevant foundations: <one-or-two dominant foundation templates>.]",
    "[System: For specialist slices, prefer naming the one or two dominant foundations that actually drive the slice, such as portfolio-sizing-discipline, risk-transmission, outcome-review, behavior-error-correction, execution-hygiene, business-quality, or catalyst-map.]",
    "[System: Do not auto-publish low-confidence, low-fidelity, provisional, or weak-evidence noise. Mark those slices publish: no so they remain draft-only.]",
  ];

  if (
    plan.replyContract !== "learning_internalization_audit" &&
    plan.replyContract !== "learning_workflow_audit" &&
    plan.replyContract !== "holdings_thesis_revalidation"
  ) {
    lines.splice(
      10,
      0,
      "[System: Treat internal workflow or progress state as secondary. Mention it only briefly after the human-first summary when it materially helps the user.]",
    );
    appendNoticeLines(lines, [
      "[System: Keep internal workflow status secondary. The control-room summary should confirm distribution briefly at the end, not lead with workflow or routing details.]",
    ]);
  }

  if (plan.includeDailyWorkface) {
    appendNoticeLines(lines, [
      "[System: For daily workface or health-style asks, assume the user wants a human-readable operating brief in plain language: what was learned yesterday, what was corrected, where the system is drifting, how much model effort was spent, and what deserves attention next.]",
      "[System: If you mention workface, scorecard, or validation radar, translate them into plain operator language first. Do not make the user decode internal artifact names.]",
    ]);
  }

  if (plan.replyContract === "position_management") {
    appendNoticeLines(lines, [
      "[System: This is a control-room position-management question. Keep the answer in control_room, do not auto-publish specialist slices, and use this fixed structure in order: current stance, key reasons, main counter-case / risk, action triggers, confidence, one-line summary.]",
      "[System: In current stance, use plain labels like hold, watch, reduce, do not add yet, or add only if conditions trigger. In action triggers, separate what would justify adding, what would justify reducing, and what means wait.]",
      "[System: Explicitly apply the portfolio sizing discipline template: name any concentration risk, distinguish conviction from actual size, and default low confidence toward smaller size or wait.]",
      "[System: If the question depends on macro or cross-asset context, apply the risk transmission template: identify the live driver, the transmission path, the assets most exposed, and one invalidation path.]",
      "[System: Use exact markdown headings when possible: ## Current Stance, ## Key Reasons, ## Main Counter-Case / Risk, ## Action Triggers, ## Confidence, ## One-Line Summary.]",
      "[System: Current stance should be one clear label only, not a blended paragraph. Key reasons should stay to the top 2-3 reasons. Action triggers must be split into Add / Reduce / Wait.]",
      "[System: Confidence should be low, medium, or high plus one short justification. One-line summary should be one sentence, not a second essay.]",
      "[System: Use execution hygiene discipline too: if event risk, liquidity, or volatility makes the setup noisy, say wait explicitly instead of forcing action.]",
      "[System: Also check the behavior-error-correction template: name any urgency theater, confirmation bias, narrative overreach, or discomfort-with-waiting that could be distorting the stance.]",
      "[System: If the position depends on a known event path, use the catalyst-map template too: separate what would truly confirm, what would truly break, and what is mostly noise.]",
    ]);
  }

  if (plan.replyContract === "holdings_thesis_revalidation") {
    appendNoticeLines(lines, [
      "[System: This is a control-room holdings-thesis revalidation question, not a fresh stance-from-scratch request and not a generic position-management answer.]",
      "[System: Internal durable-state evidence is primary here: retrieve the prior holding analysis, old thesis summary, current-research-line when present, correction notes, and any reusable hold/reduce lessons before forming a fresh view.]",
      "[System: Use knowledge_maintenance to recover the old logic and correction trail, technical_daily to re-check the live driver and risk-transmission path, and fundamental_research to re-check business or issuer reality. Do not let one slice silently replace the others.]",
      "[System: Load memory/local-memory/workflow-universal-finance-decision-under-uncertainty.md and use it as the internal decision frame here: lock the horizon, write one base_case, one bull_case, one bear_case, a subjective probability split, the main drivers, the key unknown, what changes my mind, action versus no-action, conviction_or_sizing, and invalidation.]",
      "[System: Make four doctrine fields externally visible even in the concise control-room answer: the current base_case, the live bear_case, what_changes_my_mind, and why_no_action_may_be_better when the evidence is too weak for forced action.]",
      "[System: Use these exact short labels when they are present in the final control-room answer: Base case:, Bear case:, What changes my mind:, Why no action may be better:.]",
      "[System: If this is a later revalidation with enough fresh evidence to review the earlier stance, also append these exact short calibration labels: Observed outcome:, Closest scenario:, Change-my-mind triggered:, Conviction looked:. If the evidence is not strong enough for posterior review, skip them instead of faking calibration.]",
      "[System: Keep calibration label values bounded and machine-readable: Closest scenario = base_case / bear_case / unclear; Change-my-mind triggered = yes / no / unclear; Conviction looked = too_high / too_low / about_right / unclear.]",
      "[System: Apply the seven-foundation discipline selectively: portfolio-sizing-discipline for size/hold-vs-add humility, risk-transmission for live macro/market path, behavior-error-correction for urgency theater or stubbornness, catalyst-map for real confirm/break events, and business-quality when issuer structure matters.]",
      "[System: Keep the control-room answer concise and evidence-first: 1. current base_case and what still holds from the old thesis, 2. live bear_case and what has weakened or broken, 3. what fresh evidence matters most now, 4. what_changes_my_mind plus invalidation, 5. one short next-step judgment including why_no_action_may_be_better when conviction is not high enough.]",
      "[System: If the old thesis or durable anchor cannot be found, say that explicitly and lower confidence instead of pretending this was a true revalidation.]",
    ]);
  }

  if (plan.replyContract === "learning_internalization_audit") {
    appendNoticeLines(lines, [
      "[System: This is a control-room learning-internalization audit. Do not dilute it into a broad market/system overview.]",
      "[System: Internal durable-state evidence is primary here, not secondary: check the latest learning outputs, protected summaries when present, latest learning carryover cue, reusable rules, and correction notes before answering.]",
      "[System: Use this fixed order when possible: what genuinely stuck, what still looks shallow, what evidence shows reusable-behavior change, what should be downgraded or discarded, one short next step.]",
    ]);
  }

  if (plan.replyContract === "learning_workflow_audit") {
    appendNoticeLines(lines, [
      "[System: This is a control-room learning-workflow audit. Do not collapse it into a generic control-room recap.]",
      "[System: Workflow and durable-state evidence are primary here, not secondary: check the latest learning outputs, learning carryover cue, protected summaries when present, and timebox/session receipts or status before answering.]",
      "[System: Use this fixed order when possible: what reached durable memory versus report-only output, latest workflow state, what evidence shows future-behavior change, where the workflow is stuck or overstating success, one short next step.]",
    ]);
  }

  return lines.join("\n");
}
