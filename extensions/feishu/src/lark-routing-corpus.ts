import { resolveProtocolInfoQuestionKind } from "../../../src/auto-reply/reply/commands-protocol-families.js";
import type { ProtocolInfoQuestionKind } from "../../../src/auto-reply/reply/commands-protocol-families.js";
import {
  looksLikeBatchQueueScopeAsk,
  looksLikeCapabilityClaimScopeAsk,
  looksLikeClassifyWorkScopeAsk,
  looksLikeCompletionProofScopeAsk,
  looksLikeEvidenceShapeScopeAsk,
  looksLikeExecutionAuthorityScopeAsk,
  looksLikeFailureReportScopeAsk,
  looksLikeOutOfScopeBoundaryAsk,
  looksLikeProgressStatusScopeAsk,
  looksLikeResultShapeScopeAsk,
  looksLikeSourceCoverageScopeAsk,
} from "./intent-matchers.js";
import { resolveFeishuSurfaceRouting } from "./surfaces.js";
import type { FeishuChatSurfaceName } from "./surfaces.js";
import type { FeishuConfig } from "./types.js";

export type LarkRoutingFamily =
  | "control_room_aggregate"
  | "technical_timing"
  | "fundamental_research"
  | "learning_external_source"
  | "learning_capability_maintenance"
  | "knowledge_internalization_audit"
  | "ops_source_grounding"
  | "protocol_truth_surface"
  | "live_scheduling_queue"
  | "live_permission_receipt"
  | "live_probe_failure"
  | "live_stop_boundary"
  | "external_source_coverage_honesty";

export type LarkRoutingGuardMatcher =
  | "batchQueue"
  | "capabilityClaim"
  | "classifyWork"
  | "completionProof"
  | "evidenceShape"
  | "executionAuthority"
  | "failureReport"
  | "outOfScope"
  | "progressStatus"
  | "resultShape"
  | "sourceCoverage";

export type LarkRoutingTruthBoundary =
  | "dev_only"
  | "live_required"
  | "evidence_required"
  | "research_only";

export type LarkRoutingCorpusCase = {
  id: string;
  utterance: string;
  family: LarkRoutingFamily;
  expectedSurface?: FeishuChatSurfaceName;
  expectedProtocolKind?: ProtocolInfoQuestionKind;
  expectedGuardMatchers?: readonly LarkRoutingGuardMatcher[];
  mustNotRouteTo?: readonly FeishuChatSurfaceName[];
  truthBoundary: LarkRoutingTruthBoundary;
  notes?: string;
};

export type SemanticRouteCandidate = {
  family: LarkRoutingFamily | "unknown";
  score: number;
  matchedUtterance?: string;
};

export type LarkApiRouteCandidate = {
  family: LarkRoutingFamily | "unknown";
  confidence: number;
  rationale?: string;
};

export type LarkApiRouteProvider = (params: {
  utterance: string;
  families: readonly LarkRoutingFamily[];
  contracts: typeof LARK_ROUTING_FAMILY_CONTRACTS;
}) => Promise<LarkApiRouteCandidate>;

export type LarkHybridRouteCandidate = {
  deterministicPassed: boolean;
  semantic: SemanticRouteCandidate;
  api?: LarkApiRouteCandidate;
  acceptedFamily: LarkRoutingFamily | "unknown";
  source: "deterministic" | "semantic" | "api" | "unknown";
};

export type LarkRoutingFamilyScore = {
  total: number;
  deterministicPassed: number;
  semanticCandidatePassed: number;
  apiCandidatePassed: number;
};

export type LarkRoutingCorpusScore = {
  total: number;
  deterministicPassed: number;
  semanticCandidatePassed: number;
  apiCandidatePassed?: number;
  families: Record<LarkRoutingFamily, LarkRoutingFamilyScore>;
};

export const LARK_ROUTING_SEMANTIC_THRESHOLD = 0.28;
export const LARK_ROUTING_API_CONFIDENCE_THRESHOLD = 0.72;

export const LARK_ROUTING_GUARD_MATCHERS: Record<
  LarkRoutingGuardMatcher,
  (utterance: string) => boolean
> = {
  batchQueue: looksLikeBatchQueueScopeAsk,
  capabilityClaim: looksLikeCapabilityClaimScopeAsk,
  classifyWork: looksLikeClassifyWorkScopeAsk,
  completionProof: looksLikeCompletionProofScopeAsk,
  evidenceShape: looksLikeEvidenceShapeScopeAsk,
  executionAuthority: looksLikeExecutionAuthorityScopeAsk,
  failureReport: looksLikeFailureReportScopeAsk,
  outOfScope: looksLikeOutOfScopeBoundaryAsk,
  progressStatus: looksLikeProgressStatusScopeAsk,
  resultShape: looksLikeResultShapeScopeAsk,
  sourceCoverage: looksLikeSourceCoverageScopeAsk,
};

export const LARK_ROUTING_FAMILY_CONTRACTS: Record<
  LarkRoutingFamily,
  {
    target: FeishuChatSurfaceName | "protocol_truth_surface";
    canonicalUtterances: readonly string[];
    nearMisses: readonly string[];
    fallback: "deterministic_first_then_unknown";
    liveAcceptancePhrase?: string;
  }
> = {
  control_room_aggregate: {
    target: "control_room",
    canonicalUtterances: [
      "现在整体怎么样，先给我一个总览",
      "现在最可能出错的是哪里",
      "给我一个今天的研究/学习/风控总览",
      "把今天的系统健康、学习状态、研究状态一起讲给我",
      "给我一个不粉饰的总判断",
    ],
    nearMisses: ["给我一个技术面总览", "这句话哪来的，给我出处"],
    fallback: "deterministic_first_then_unknown",
    liveAcceptancePhrase: "现在整体怎么样，先给我一个总览",
  },
  technical_timing: {
    target: "technical_daily",
    canonicalUtterances: [
      "QQQ 现在还能拿吗",
      "今天 ETF 这边先看什么",
      "给我说说长端利率和 QQQ 的关系",
      "给我一个技术面总览",
    ],
    nearMisses: ["MSFT 这次财报我最该盯什么", "给我一个知识维护总览"],
    fallback: "deterministic_first_then_unknown",
    liveAcceptancePhrase: "QQQ 现在还能拿吗",
  },
  fundamental_research: {
    target: "fundamental_research",
    canonicalUtterances: [
      "MSFT 这次财报我最该盯什么",
      "给我一个基本面总览",
      "把 AI capex 这条线给我讲清楚",
      "今天最该看的公司研究是什么",
    ],
    nearMisses: ["QQQ 现在还能拿吗", "现在网络搜索可以用吗"],
    fallback: "deterministic_first_then_unknown",
    liveAcceptancePhrase: "MSFT 这次财报我最该盯什么",
  },
  learning_external_source: {
    target: "learning_command",
    canonicalUtterances: [
      "去 Google 上学最近 agent 记忆怎么做，只留下会改你以后做法的三条",
      "去github上学习开源的值得你学的，并把值得内化的内化",
      "查一下 arxiv 上 agent workflow 的新文章，筛出以后会复用的规则",
      "网上搜一下最近金融智能体文章，别复述文章，只说哪些值得内化",
    ],
    nearMisses: ["最近学的 openclaw 更新到底有没有内化", "刚才那个结论有来源吗"],
    fallback: "deterministic_first_then_unknown",
    liveAcceptancePhrase: "去 Google 上学最近 agent 记忆怎么做，只留下会改你以后做法的三条",
  },
  learning_capability_maintenance: {
    target: "learning_command",
    canonicalUtterances: [
      "之前内部做了很多的金融学习，你应该把它们维护好并加强",
      "把已有的 ETF 学习能力和 pipeline 梳理加固一下",
      "把之前的学习管线接到 Lark 命令上，语言接口也继续加强",
      "把以前的学习能力收紧加强，连上lark接口命令",
    ],
    nearMisses: [
      "finance learning pipeline 是 dev 还是 live",
      "最近学的智能体更新到底有没有变成可复用规则",
    ],
    fallback: "deterministic_first_then_unknown",
    liveAcceptancePhrase: "把之前的学习管线接到 Lark 命令上，语言接口也继续加强",
  },
  knowledge_internalization_audit: {
    target: "knowledge_maintenance",
    canonicalUtterances: [
      "最近学的 openclaw 更新到底有没有内化",
      "前几天读那堆东西，到底留下啥了，还是过眼云烟",
      "别拿报告糊我，学完到底有没有改掉你以前那套坏习惯",
      "你最近学的那堆 agent 招数，到底哪条真进了你以后干活的规矩",
    ],
    nearMisses: ["去github上学习开源的值得你学的，并把值得内化的内化", "QQQ 现在还能拿吗"],
    fallback: "deterministic_first_then_unknown",
    liveAcceptancePhrase: "最近学的 openclaw 更新到底有没有内化",
  },
  ops_source_grounding: {
    target: "ops_audit",
    canonicalUtterances: [
      "你这句话哪来的，给我出处",
      "刚才那个结论有来源吗",
      "这条判断是你确认过的还是猜的",
      "没源没证据就说不知道，别编",
    ],
    nearMisses: ["给我一个基本面总览", "去 Google 上学最近 agent 记忆怎么做"],
    fallback: "deterministic_first_then_unknown",
    liveAcceptancePhrase: "你这句话哪来的，给我出处",
  },
  protocol_truth_surface: {
    target: "protocol_truth_surface",
    canonicalUtterances: [
      "你到底有没有搜索能力",
      "这次是不是已经落进长期记忆了",
      "哪些内部学习能力真的接上了",
      "finance learning pipeline 是 dev 还是 live",
    ],
    nearMisses: ["把已有的 ETF 学习能力和 pipeline 梳理加固一下", "给我一个审计总览"],
    fallback: "deterministic_first_then_unknown",
    liveAcceptancePhrase: "finance learning pipeline 是 dev 还是 live",
  },
  live_scheduling_queue: {
    target: "control_room",
    canonicalUtterances: [
      "先按语义家族分类这条请求：这些都做但不要并行，按优先级排队，一次只做一个；现在做到哪、还剩什么、proof 是什么，用 done / queued / next step 回答，别把 queued 说成 completed。",
      "这些任务别并行，先分类，再排队，告诉我 done、queued 和 next step，别把 queued 说成 completed。",
      "按优先级一次做一个家族，先说现在做到哪、还剩什么、proof 是什么，别把 started 说成 completed。",
    ],
    nearMisses: ["QQQ 现在还能拿吗", "你这句话哪来的，给我出处"],
    fallback: "deterministic_first_then_unknown",
    liveAcceptancePhrase: "这些任务别并行，先分类，再排队，告诉我 done、queued 和 next step",
  },
  live_permission_receipt: {
    target: "control_room",
    canonicalUtterances: [
      "你可以操控电脑做 Lark 真实对话测试，但这不等于授权 build/restart/deploy；接 live 前先定义验收短语，按固定回执格式列出测试语句、同一个 chat/thread、可见回复、是否命中、dev/live 边界和下一步。",
      "我允许你做 Lark 真实测试，但别把这个当成部署授权，先给验收短语和可见回复回执。",
      "接 live 前先列测试语句、同一个 chat/thread、可见回复、是否命中和 dev/live 边界。",
    ],
    nearMisses: ["把已有的 ETF 学习能力和 pipeline 梳理加固一下", "给我一个基本面总览"],
    fallback: "deterministic_first_then_unknown",
    liveAcceptancePhrase: "接 live 前先定义验收短语，按固定回执格式列出测试语句",
  },
  live_probe_failure: {
    target: "control_room",
    canonicalUtterances: [
      "Lark 探针发出后如果无回复、超时、旧回复、错 chat、错线程或不对应测试语句，按 blocked / proof / next step 报，不要把 only sent 或任意可见回复说成 pass。",
      "如果 Lark 没回复或者回到错线程，按 blocked 报，不要说 pass。",
      "只发出测试消息不算 completed，别把 started 说成 completed，要有对应测试语句的可见回复和 proof。",
    ],
    nearMisses: ["现在整体怎么样，先给我一个总览", "哪些工具是真的能用"],
    fallback: "deterministic_first_then_unknown",
    liveAcceptancePhrase:
      "无回复、超时、旧回复、错 chat、错线程或不对应测试语句，按 blocked / proof / next step 报",
  },
  live_stop_boundary: {
    target: "control_room",
    canonicalUtterances: [
      "撤回授权，别接 live，也别再 probe，只保留 dev patch 和本地测试；之前允许操控电脑不能继承到下一轮 restart 或 deploy。",
      "先停，不要接 live，不要 probe，不要 restart，只保留本地 dev patch。",
      "撤销刚才的 live 授权，下一轮不能继承部署或重启权限。",
    ],
    nearMisses: ["去 Google 上学最近 agent 记忆怎么做", "现在是哪个模型在回我"],
    fallback: "deterministic_first_then_unknown",
    liveAcceptancePhrase: "撤回授权，别接 live，也别再 probe",
  },
  external_source_coverage_honesty: {
    target: "learning_command",
    canonicalUtterances: [
      "去 Google 上学最近 agent 记忆怎么做，但别把看了几个来源说成完整覆盖，只留下会改你以后做法的三条",
      "去网上学习金融智能体文章时标清覆盖范围，别把抽样说成全网学完，只留下会改你以后做法的三条。",
      "去 GitHub 看同类 agent，但只能说看过哪些 repo，不能说完整覆盖所有开源。",
    ],
    nearMisses: [
      "去 Google 上学最近 agent 记忆怎么做，只留下会改你以后做法的三条",
      "刚才那个结论有来源吗",
    ],
    fallback: "deterministic_first_then_unknown",
    liveAcceptancePhrase: "别把看了几个来源说成完整覆盖",
  },
};

export const LARK_ROUTING_CORPUS: readonly LarkRoutingCorpusCase[] = [
  {
    id: "control-aggregate-001",
    utterance: "现在整体怎么样，先给我一个总览",
    family: "control_room_aggregate",
    expectedSurface: "control_room",
    truthBoundary: "evidence_required",
  },
  {
    id: "control-aggregate-002",
    utterance: "现在最可能出错的是哪里",
    family: "control_room_aggregate",
    expectedSurface: "control_room",
    truthBoundary: "evidence_required",
  },
  {
    id: "control-aggregate-003",
    utterance: "给我一个不粉饰的总判断",
    family: "control_room_aggregate",
    expectedSurface: "control_room",
    truthBoundary: "evidence_required",
  },
  {
    id: "technical-001",
    utterance: "QQQ 现在还能拿吗",
    family: "technical_timing",
    expectedSurface: "technical_daily",
    truthBoundary: "research_only",
    mustNotRouteTo: ["fundamental_research"],
  },
  {
    id: "technical-002",
    utterance: "今天 ETF 这边先看什么",
    family: "technical_timing",
    expectedSurface: "technical_daily",
    truthBoundary: "research_only",
  },
  {
    id: "technical-003",
    utterance: "给我说说长端利率和 QQQ 的关系",
    family: "technical_timing",
    expectedSurface: "technical_daily",
    truthBoundary: "research_only",
  },
  {
    id: "fundamental-001",
    utterance: "MSFT 这次财报我最该盯什么",
    family: "fundamental_research",
    expectedSurface: "fundamental_research",
    truthBoundary: "research_only",
    mustNotRouteTo: ["technical_daily"],
  },
  {
    id: "fundamental-002",
    utterance: "给我一个基本面总览",
    family: "fundamental_research",
    expectedSurface: "fundamental_research",
    truthBoundary: "research_only",
  },
  {
    id: "fundamental-003",
    utterance: "把 AI capex 这条线给我讲清楚",
    family: "fundamental_research",
    expectedSurface: "fundamental_research",
    truthBoundary: "research_only",
  },
  {
    id: "learning-external-001",
    utterance: "去 Google 上学最近 agent 记忆怎么做，只留下会改你以后做法的三条",
    family: "learning_external_source",
    expectedSurface: "learning_command",
    truthBoundary: "live_required",
  },
  {
    id: "learning-external-002",
    utterance: "网上搜一下最近金融智能体文章，别复述文章，只说哪些值得内化",
    family: "learning_external_source",
    expectedSurface: "learning_command",
    truthBoundary: "live_required",
  },
  {
    id: "learning-external-003",
    utterance: "查一下 arxiv 上 agent workflow 的新文章，筛出以后会复用的规则",
    family: "learning_external_source",
    expectedSurface: "learning_command",
    truthBoundary: "live_required",
  },
  {
    id: "learning-maintenance-001",
    utterance: "之前内部做了很多的金融学习，你应该把它们维护好并加强",
    family: "learning_capability_maintenance",
    expectedSurface: "learning_command",
    truthBoundary: "dev_only",
  },
  {
    id: "learning-maintenance-002",
    utterance: "把已有的 ETF 学习能力和 pipeline 梳理加固一下",
    family: "learning_capability_maintenance",
    expectedSurface: "learning_command",
    truthBoundary: "dev_only",
  },
  {
    id: "learning-maintenance-003",
    utterance: "把之前的学习管线接到 Lark 命令上，语言接口也继续加强",
    family: "learning_capability_maintenance",
    expectedSurface: "learning_command",
    truthBoundary: "live_required",
  },
  {
    id: "knowledge-audit-001",
    utterance: "最近学的 openclaw 更新到底有没有内化",
    family: "knowledge_internalization_audit",
    expectedSurface: "knowledge_maintenance",
    truthBoundary: "evidence_required",
  },
  {
    id: "knowledge-audit-002",
    utterance: "前几天读那堆东西，到底留下啥了，还是过眼云烟",
    family: "knowledge_internalization_audit",
    expectedSurface: "knowledge_maintenance",
    truthBoundary: "evidence_required",
  },
  {
    id: "knowledge-audit-003",
    utterance: "别拿报告糊我，学完到底有没有改掉你以前那套坏习惯",
    family: "knowledge_internalization_audit",
    expectedSurface: "knowledge_maintenance",
    truthBoundary: "evidence_required",
  },
  {
    id: "ops-grounding-001",
    utterance: "你这句话哪来的，给我出处",
    family: "ops_source_grounding",
    expectedSurface: "ops_audit",
    truthBoundary: "evidence_required",
  },
  {
    id: "ops-grounding-002",
    utterance: "刚才那个结论有来源吗",
    family: "ops_source_grounding",
    expectedSurface: "ops_audit",
    truthBoundary: "evidence_required",
  },
  {
    id: "ops-grounding-003",
    utterance: "这条判断是你确认过的还是猜的",
    family: "ops_source_grounding",
    expectedSurface: "ops_audit",
    truthBoundary: "evidence_required",
  },
  {
    id: "protocol-truth-001",
    utterance: "你到底有没有搜索能力",
    family: "protocol_truth_surface",
    expectedProtocolKind: "search_health",
    truthBoundary: "evidence_required",
  },
  {
    id: "protocol-truth-002",
    utterance: "哪些内部学习能力真的接上了",
    family: "protocol_truth_surface",
    expectedProtocolKind: "learning_capability_state",
    truthBoundary: "dev_only",
  },
  {
    id: "protocol-truth-003",
    utterance: "finance learning pipeline 是 dev 还是 live",
    family: "protocol_truth_surface",
    expectedProtocolKind: "learning_capability_state",
    truthBoundary: "live_required",
  },
  {
    id: "live-scheduling-001",
    utterance:
      "先按语义家族分类这条请求：这些都做但不要并行，按优先级排队，一次只做一个；现在做到哪、还剩什么、proof 是什么，用 done / queued / next step 回答，别把 queued 说成 completed。",
    family: "live_scheduling_queue",
    expectedGuardMatchers: [
      "classifyWork",
      "batchQueue",
      "progressStatus",
      "resultShape",
      "completionProof",
    ],
    truthBoundary: "evidence_required",
  },
  {
    id: "live-scheduling-002",
    utterance:
      "这些任务别并行，先分类，再排队，告诉我 done、queued 和 next step，别把 queued 说成 completed。",
    family: "live_scheduling_queue",
    expectedGuardMatchers: ["classifyWork", "batchQueue", "progressStatus", "resultShape"],
    truthBoundary: "evidence_required",
  },
  {
    id: "live-scheduling-003",
    utterance:
      "按优先级排队，一次只做一个家族，先说现在做到哪、还剩什么、proof 是什么，别把 started 说成 completed。",
    family: "live_scheduling_queue",
    expectedGuardMatchers: ["batchQueue", "progressStatus", "completionProof"],
    truthBoundary: "evidence_required",
  },
  {
    id: "live-permission-001",
    utterance:
      "你可以操控电脑做 Lark 真实对话测试，但这不等于授权 build/restart/deploy；接 live 前先定义验收短语，按固定回执格式列出测试语句、同一个 chat/thread、可见回复、是否命中、dev/live 边界和下一步。",
    family: "live_permission_receipt",
    expectedGuardMatchers: [
      "executionAuthority",
      "capabilityClaim",
      "evidenceShape",
      "resultShape",
    ],
    truthBoundary: "live_required",
  },
  {
    id: "live-permission-002",
    utterance: "我允许你做 Lark 真实测试，但别把这个当成部署授权，先给验收短语和可见回复回执。",
    family: "live_permission_receipt",
    expectedGuardMatchers: ["executionAuthority", "evidenceShape"],
    truthBoundary: "live_required",
  },
  {
    id: "live-permission-003",
    utterance:
      "接 live 前先按固定格式列测试语句、同一个 chat/thread、可见回复、是否命中和 dev/live 边界，这不是授权 build/restart/deploy。",
    family: "live_permission_receipt",
    expectedGuardMatchers: ["capabilityClaim", "evidenceShape", "resultShape"],
    truthBoundary: "live_required",
  },
  {
    id: "live-failure-001",
    utterance:
      "Lark 探针发出后如果无回复、超时、旧回复、错 chat、错线程或不对应测试语句，按 blocked / proof / next step 报，不要把 only sent 或任意可见回复说成 pass。",
    family: "live_probe_failure",
    expectedGuardMatchers: ["failureReport", "progressStatus", "evidenceShape"],
    truthBoundary: "live_required",
  },
  {
    id: "live-failure-002",
    utterance: "如果 Lark 没回复或者回到错线程，按 blocked 报，不要说 pass。",
    family: "live_probe_failure",
    expectedGuardMatchers: ["failureReport"],
    truthBoundary: "live_required",
  },
  {
    id: "live-failure-003",
    utterance:
      "只发出测试消息不算 completed，别把 started 说成 completed，要有对应测试语句的可见回复和 proof。",
    family: "live_probe_failure",
    expectedGuardMatchers: ["evidenceShape", "completionProof"],
    truthBoundary: "live_required",
  },
  {
    id: "live-stop-001",
    utterance:
      "撤回授权，别接 live，也别再 probe，只保留 dev patch 和本地测试；之前允许操控电脑不能继承到下一轮 restart 或 deploy。",
    family: "live_stop_boundary",
    expectedGuardMatchers: ["executionAuthority", "outOfScope"],
    truthBoundary: "live_required",
  },
  {
    id: "live-stop-002",
    utterance: "先停，不要接 live，不要 probe，不要 restart，只保留本地 dev patch。",
    family: "live_stop_boundary",
    expectedGuardMatchers: ["outOfScope"],
    truthBoundary: "live_required",
  },
  {
    id: "live-stop-003",
    utterance: "撤销刚才的 live 授权，下一轮不能继承部署或重启权限。",
    family: "live_stop_boundary",
    expectedGuardMatchers: ["executionAuthority"],
    truthBoundary: "live_required",
  },
  {
    id: "external-coverage-001",
    utterance:
      "去 Google 上学最近 agent 记忆怎么做，但别把看了几个来源说成完整覆盖，只留下会改你以后做法的三条",
    family: "external_source_coverage_honesty",
    expectedSurface: "learning_command",
    expectedGuardMatchers: ["sourceCoverage"],
    truthBoundary: "live_required",
  },
  {
    id: "external-coverage-002",
    utterance:
      "去网上学习金融智能体文章时标清覆盖范围，别把抽样说成全网学完，只留下会改你以后做法的三条。",
    family: "external_source_coverage_honesty",
    expectedSurface: "learning_command",
    expectedGuardMatchers: ["sourceCoverage"],
    truthBoundary: "live_required",
  },
  {
    id: "external-coverage-003",
    utterance: "去 GitHub 看同类 agent，但只能说看过哪些 repo，不能说完整覆盖所有开源。",
    family: "external_source_coverage_honesty",
    expectedSurface: "learning_command",
    expectedGuardMatchers: ["sourceCoverage"],
    truthBoundary: "live_required",
  },
] as const;

function normalizeSemanticText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/给我一个|先给我|告诉我|说说|讲清楚|这边|现在|今天/gu, " ")
    .replace(/[，。！？、；：,.!?;:()[\]{}"'`~\-_/\\|]+/gu, " ")
    .replace(/\s+/gu, " ");
}

function semanticTokens(text: string): Set<string> {
  const normalized = normalizeSemanticText(text);
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9]+|[\p{Script=Han}]/gu)) {
    tokens.add(match[0]);
  }
  const compact = normalized.replace(/\s+/gu, "");
  for (let index = 0; index < compact.length - 1; index += 1) {
    tokens.add(compact.slice(index, index + 2));
  }
  return tokens;
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = semanticTokens(left);
  const rightTokens = semanticTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  return intersection / Math.max(leftTokens.size, rightTokens.size);
}

export function resolveLarkSemanticRouteCandidate(
  utterance: string,
  threshold = LARK_ROUTING_SEMANTIC_THRESHOLD,
): SemanticRouteCandidate {
  let best: SemanticRouteCandidate = { family: "unknown", score: 0 };
  for (const [family, contract] of Object.entries(LARK_ROUTING_FAMILY_CONTRACTS) as Array<
    [LarkRoutingFamily, (typeof LARK_ROUTING_FAMILY_CONTRACTS)[LarkRoutingFamily]]
  >) {
    for (const exemplar of contract.canonicalUtterances) {
      const score = tokenSimilarity(utterance, exemplar);
      if (score > best.score) {
        best = { family, score, matchedUtterance: exemplar };
      }
    }
  }
  return best.score >= threshold ? best : { family: "unknown", score: best.score };
}

export function sanitizeLarkApiRouteCandidate(
  candidate: LarkApiRouteCandidate,
  threshold = LARK_ROUTING_API_CONFIDENCE_THRESHOLD,
): LarkApiRouteCandidate {
  if (
    candidate.confidence < threshold ||
    candidate.family === "unknown" ||
    !(candidate.family in LARK_ROUTING_FAMILY_CONTRACTS)
  ) {
    return {
      family: "unknown",
      confidence: Math.max(0, Math.min(1, candidate.confidence)),
      rationale: candidate.rationale,
    };
  }
  return {
    family: candidate.family,
    confidence: Math.max(0, Math.min(1, candidate.confidence)),
    rationale: candidate.rationale,
  };
}

export function resolveLarkDeterministicCorpusCase(params: {
  cfg: FeishuConfig;
  entry: LarkRoutingCorpusCase;
}): {
  targetSurface?: FeishuChatSurfaceName;
  protocolKind?: ProtocolInfoQuestionKind;
  passed: boolean;
} {
  const protocolKind = resolveProtocolInfoQuestionKind(params.entry.utterance);
  if (params.entry.expectedProtocolKind) {
    return {
      protocolKind: protocolKind ?? undefined,
      passed: protocolKind === params.entry.expectedProtocolKind,
    };
  }

  const routing = resolveFeishuSurfaceRouting({
    cfg: params.cfg,
    chatId: params.cfg.surfaces?.control_room?.chatId ?? "oc-control",
    content: params.entry.utterance,
  });
  const blockedSurfaceHit = params.entry.mustNotRouteTo?.includes(
    routing.targetSurface as FeishuChatSurfaceName,
  );
  const surfacePassed = params.entry.expectedSurface
    ? routing.targetSurface === params.entry.expectedSurface
    : true;
  const guardsPassed =
    params.entry.expectedGuardMatchers?.every((matcher) =>
      LARK_ROUTING_GUARD_MATCHERS[matcher](params.entry.utterance),
    ) ?? true;
  return {
    targetSurface: routing.targetSurface,
    protocolKind: protocolKind ?? undefined,
    passed: surfacePassed && blockedSurfaceHit !== true && guardsPassed,
  };
}

function emptyFamilyScores(): Record<LarkRoutingFamily, LarkRoutingFamilyScore> {
  const scores = {} as Record<LarkRoutingFamily, LarkRoutingFamilyScore>;
  for (const family of Object.keys(LARK_ROUTING_FAMILY_CONTRACTS) as LarkRoutingFamily[]) {
    scores[family] = {
      total: 0,
      deterministicPassed: 0,
      semanticCandidatePassed: 0,
      apiCandidatePassed: 0,
    };
  }
  return scores;
}

export async function resolveLarkHybridRouteCandidate(params: {
  cfg: FeishuConfig;
  entry: LarkRoutingCorpusCase;
  apiProvider?: LarkApiRouteProvider;
}): Promise<LarkHybridRouteCandidate> {
  const deterministic = resolveLarkDeterministicCorpusCase({
    cfg: params.cfg,
    entry: params.entry,
  });
  const semantic = resolveLarkSemanticRouteCandidate(params.entry.utterance);
  const api = params.apiProvider
    ? sanitizeLarkApiRouteCandidate(
        await params.apiProvider({
          utterance: params.entry.utterance,
          families: Object.keys(LARK_ROUTING_FAMILY_CONTRACTS) as LarkRoutingFamily[],
          contracts: LARK_ROUTING_FAMILY_CONTRACTS,
        }),
      )
    : undefined;

  if (deterministic.passed) {
    return {
      deterministicPassed: true,
      semantic,
      api,
      acceptedFamily: params.entry.family,
      source: "deterministic",
    };
  }

  if (semantic.family !== "unknown") {
    return {
      deterministicPassed: false,
      semantic,
      api,
      acceptedFamily: semantic.family,
      source: "semantic",
    };
  }

  if (api && api.family !== "unknown") {
    return {
      deterministicPassed: false,
      semantic,
      api,
      acceptedFamily: api.family,
      source: "api",
    };
  }

  return {
    deterministicPassed: false,
    semantic,
    api,
    acceptedFamily: "unknown",
    source: "unknown",
  };
}

export async function scoreLarkRoutingCorpusAsync(params: {
  cfg: FeishuConfig;
  corpus?: readonly LarkRoutingCorpusCase[];
  apiProvider?: LarkApiRouteProvider;
}): Promise<LarkRoutingCorpusScore> {
  const corpus = params.corpus ?? LARK_ROUTING_CORPUS;
  const families = emptyFamilyScores();
  let deterministicPassed = 0;
  let semanticCandidatePassed = 0;
  let apiCandidatePassed = 0;

  for (const entry of corpus) {
    const deterministic = resolveLarkDeterministicCorpusCase({ cfg: params.cfg, entry });
    const semantic = resolveLarkSemanticRouteCandidate(entry.utterance);
    const api = params.apiProvider
      ? sanitizeLarkApiRouteCandidate(
          await params.apiProvider({
            utterance: entry.utterance,
            families: Object.keys(LARK_ROUTING_FAMILY_CONTRACTS) as LarkRoutingFamily[],
            contracts: LARK_ROUTING_FAMILY_CONTRACTS,
          }),
        )
      : undefined;
    const familyScore = families[entry.family];
    familyScore.total += 1;
    if (deterministic.passed) {
      deterministicPassed += 1;
      familyScore.deterministicPassed += 1;
    }
    if (semantic.family === entry.family) {
      semanticCandidatePassed += 1;
      familyScore.semanticCandidatePassed += 1;
    }
    if (api?.family === entry.family) {
      apiCandidatePassed += 1;
      familyScore.apiCandidatePassed += 1;
    }
  }

  return {
    total: corpus.length,
    deterministicPassed,
    semanticCandidatePassed,
    apiCandidatePassed: params.apiProvider ? apiCandidatePassed : undefined,
    families,
  };
}

export function scoreLarkRoutingCorpus(params: {
  cfg: FeishuConfig;
  corpus?: readonly LarkRoutingCorpusCase[];
}): LarkRoutingCorpusScore {
  const corpus = params.corpus ?? LARK_ROUTING_CORPUS;
  const families = emptyFamilyScores();
  let deterministicPassed = 0;
  let semanticCandidatePassed = 0;

  for (const entry of corpus) {
    const deterministic = resolveLarkDeterministicCorpusCase({ cfg: params.cfg, entry });
    const semantic = resolveLarkSemanticRouteCandidate(entry.utterance);
    const familyScore = families[entry.family];
    familyScore.total += 1;
    if (deterministic.passed) {
      deterministicPassed += 1;
      familyScore.deterministicPassed += 1;
    }
    if (semantic.family === entry.family) {
      semanticCandidatePassed += 1;
      familyScore.semanticCandidatePassed += 1;
    }
  }

  return {
    total: corpus.length,
    deterministicPassed,
    semanticCandidatePassed,
    families,
  };
}
