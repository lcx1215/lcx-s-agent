export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

type ToolProfilePolicy = {
  allow?: string[];
  deny?: string[];
};

export type CoreToolSection = {
  id: string;
  label: string;
  tools: Array<{
    id: string;
    label: string;
    description: string;
  }>;
};

type CoreToolDefinition = {
  id: string;
  label: string;
  description: string;
  sectionId: string;
  profiles: ToolProfileId[];
  includeInOpenClawGroup?: boolean;
};

const CORE_TOOL_SECTION_ORDER: Array<{ id: string; label: string }> = [
  { id: "fs", label: "Files" },
  { id: "runtime", label: "Runtime" },
  { id: "web", label: "Web" },
  { id: "memory", label: "Memory" },
  { id: "sessions", label: "Sessions" },
  { id: "ui", label: "UI" },
  { id: "messaging", label: "Messaging" },
  { id: "automation", label: "Automation" },
  { id: "nodes", label: "Nodes" },
  { id: "agents", label: "Agents" },
  { id: "media", label: "Media" },
];

const CORE_TOOL_DEFINITIONS: CoreToolDefinition[] = [
  {
    id: "read",
    label: "read",
    description: "Read file contents",
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "write",
    label: "write",
    description: "Create or overwrite files",
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "edit",
    label: "edit",
    description: "Make precise edits",
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "apply_patch",
    label: "apply_patch",
    description: "Patch files (OpenAI)",
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "exec",
    label: "exec",
    description: "Run shell commands",
    sectionId: "runtime",
    profiles: ["coding"],
  },
  {
    id: "process",
    label: "process",
    description: "Manage background processes",
    sectionId: "runtime",
    profiles: ["coding"],
  },
  {
    id: "mcp_context",
    label: "mcp_context",
    description: "Inspect MCP config + context wiring when CLI/local context is not enough",
    sectionId: "runtime",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "aider",
    label: "aider",
    description: "Run bounded aider edits",
    sectionId: "runtime",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "web_search",
    label: "web_search",
    description: "Search the web",
    sectionId: "web",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "web_fetch",
    label: "web_fetch",
    description: "Fetch web content",
    sectionId: "web",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "memory_search",
    label: "memory_search",
    description: "Broad memory recall",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "memory_get",
    label: "memory_get",
    description: "Read memory files",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "local_memory_record",
    label: "local_memory_record",
    description: "Create or update local durable-memory cards",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_framework_core_record",
    label: "finance_framework_core_record",
    description:
      "Create or refresh one bounded finance framework core entry for a single cross-domain cognition domain",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_framework_core_inspect",
    label: "finance_framework_core_inspect",
    description:
      "Inspect the durable finance framework core contract across domains or for one specific domain",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_article_source_registry_record",
    label: "finance_article_source_registry_record",
    description:
      "Create or refresh one retained finance article source entry using only safe collection methods",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_article_source_collection_preflight",
    label: "finance_article_source_collection_preflight",
    description:
      "Preflight one finance article source or collection request and classify it as allowed, blocked, or manual_only under the safe collection contract",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_article_source_registry_inspect",
    label: "finance_article_source_registry_inspect",
    description:
      "Inspect retained finance article sources across all entries, by source type, by collection method, or by preflight status",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_external_source_adapter",
    label: "finance_external_source_adapter",
    description:
      "Normalize safe external finance source tool outputs, feed exports, and public references into local research artifacts without fetching remote content",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_learning_pipeline_orchestrator",
    label: "finance_learning_pipeline_orchestrator",
    description:
      "Run one bounded finance learning pipeline from safe source intake through extraction, capability attachment, retrieval-first capability-card recall, evidence-gated retention, inspect-ready output, retrieval receipt, and auto-refreshed retrieval review",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_learning_retrieval_review",
    label: "finance_learning_retrieval_review",
    description:
      "Summarize finance learning retrieval receipts into a daily quality review and flag weak learning that did not become retrievable",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_research_source_workbench",
    label: "finance_research_source_workbench",
    description:
      "Normalize safe manual or local finance research source inputs into local audit artifacts and return the next extraction target without fetching remote content",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_learning_capability_attach",
    label: "finance_learning_capability_attach",
    description:
      "Record bounded finance learning capability candidates from article-style learning artifacts without granting execution authority",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_article_extract_capability_input",
    label: "finance_article_extract_capability_input",
    description:
      "Extract one attach-ready finance learning capability payload from a local txt, markdown, or simple html article artifact without creating trading rules",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_learning_capability_inspect",
    label: "finance_learning_capability_inspect",
    description:
      "Inspect retained finance learning capability candidates across domains, capability types, tags, or source articles",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_learning_capability_apply",
    label: "finance_learning_capability_apply",
    description:
      "Apply retained finance learning capability cards to one bounded research question using reuse guidance, required inputs, causal checks, and risk checks",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_framework_macro_rates_inflation_producer",
    label: "finance_framework_macro_rates_inflation_producer",
    description:
      "Create a bounded macro/rates/inflation framework skeleton entry and write it into the shared finance framework contract",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_framework_etf_regime_producer",
    label: "finance_framework_etf_regime_producer",
    description:
      "Create a bounded ETF/regime framework skeleton entry and write it into the shared finance framework contract",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_framework_options_volatility_producer",
    label: "finance_framework_options_volatility_producer",
    description:
      "Create a bounded options/volatility framework skeleton entry and write it into the shared finance framework contract",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_framework_company_fundamentals_value_producer",
    label: "finance_framework_company_fundamentals_value_producer",
    description:
      "Create a bounded company fundamentals/value framework skeleton entry and write it into the shared finance framework contract",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_framework_commodities_oil_gold_producer",
    label: "finance_framework_commodities_oil_gold_producer",
    description:
      "Create a bounded commodities/oil/gold framework skeleton entry and write it into the shared finance framework contract",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_framework_fx_dollar_producer",
    label: "finance_framework_fx_dollar_producer",
    description:
      "Create a bounded FX/dollar framework skeleton entry and write it into the shared finance framework contract",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_framework_credit_liquidity_producer",
    label: "finance_framework_credit_liquidity_producer",
    description:
      "Create a bounded credit/liquidity framework skeleton entry and write it into the shared finance framework contract",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_framework_event_driven_producer",
    label: "finance_framework_event_driven_producer",
    description:
      "Create a bounded event-driven framework skeleton entry and write it into the shared finance framework contract",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_framework_portfolio_risk_gates_producer",
    label: "finance_framework_portfolio_risk_gates_producer",
    description:
      "Create a bounded portfolio/risk-gates framework skeleton entry and write it into the shared finance framework contract",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_framework_causal_map_producer",
    label: "finance_framework_causal_map_producer",
    description:
      "Create a bounded causal-map framework skeleton entry and write it into the shared finance framework contract",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_promotion_review",
    label: "finance_promotion_review",
    description: "Record deferred/rejected/ready review actions for finance promotion candidates",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_promotion_candidates",
    label: "finance_promotion_candidates",
    description: "Inspect same-day finance promotion candidates and current review state",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_doctrine_teacher_feedback",
    label: "finance_doctrine_teacher_feedback",
    description:
      "Audit one same-day finance calibration artifact through a bounded teacher model and retain structured critique",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_doctrine_teacher_feedback_review",
    label: "finance_doctrine_teacher_feedback_review",
    description:
      "Record deferred, rejected, or elevated_for_governance_review outcomes for retained finance teacher critiques",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_doctrine_teacher_feedback_elevation_handoff",
    label: "finance_doctrine_teacher_feedback_elevation_handoff",
    description:
      "Create explicit finance-governance handoffs for teacher critiques already elevated_for_governance_review",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_doctrine_teacher_feedback_elevation_handoff_status",
    label: "finance_doctrine_teacher_feedback_elevation_handoff_status",
    description:
      "Mark open teacher-elevation handoffs converted_to_candidate_input, rejected_after_handoff_review, or superseded",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_doctrine_teacher_feedback_candidate_input",
    label: "finance_doctrine_teacher_feedback_candidate_input",
    description:
      "Create a durable finance candidate-input artifact from a converted teacher-elevation handoff",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_doctrine_teacher_feedback_candidate_input_review",
    label: "finance_doctrine_teacher_feedback_candidate_input_review",
    description:
      "Record consumed_into_candidate_flow, rejected_before_candidate_flow, or superseded for one teacher candidate-input artifact",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_doctrine_teacher_feedback_candidate_input_reconciliation",
    label: "finance_doctrine_teacher_feedback_candidate_input_reconciliation",
    description:
      "Create an explicit finance-candidate reconciliation artifact for one teacher candidate-input already consumed_into_candidate_flow",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_doctrine_teacher_feedback_candidate_input_reconciliation_status",
    label: "finance_doctrine_teacher_feedback_candidate_input_reconciliation_status",
    description:
      "Mark open teacher candidate-input reconciliations linked_to_existing_candidate, created_as_new_candidate_reference, rejected_before_reconciliation, or superseded",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_promotion_bulk_review",
    label: "finance_promotion_bulk_review",
    description: "Apply bounded same-day bulk review actions to finance promotion candidates",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_promotion_decision",
    label: "finance_promotion_decision",
    description: "Record bounded manual promotion decisions for ready finance promotion candidates",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_promotion_proposal_draft",
    label: "finance_promotion_proposal_draft",
    description:
      "Create operator-reviewable proposal drafts for proposal_created finance decisions",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_promotion_proposal_status",
    label: "finance_promotion_proposal_status",
    description:
      "Mark finance promotion proposal drafts accepted_for_manual_edit, rejected, or superseded",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "finance_promotion_doctrine_edit_handoff",
    label: "finance_promotion_doctrine_edit_handoff",
    description:
      "Create operator-facing doctrine-edit handoffs for accepted finance promotion proposals",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "feishu_live_probe",
    label: "feishu_live_probe",
    description: "Send/read bounded Feishu/Lark live acceptance probes",
    sectionId: "messaging",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "lark_language_corpus_review",
    label: "lark_language_corpus_review",
    description:
      "Review pending Lark language-routing candidates and write review/patch artifacts without mutating the formal corpus",
    sectionId: "memory",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_list",
    label: "sessions_list",
    description: "List sessions",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_history",
    label: "sessions_history",
    description: "Session history",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_send",
    label: "sessions_send",
    description: "Send to session",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_spawn",
    label: "sessions_spawn",
    description: "Spawn sub-agent",
    sectionId: "sessions",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "subagents",
    label: "subagents",
    description: "Manage sub-agents",
    sectionId: "sessions",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "session_status",
    label: "session_status",
    description: "Session status",
    sectionId: "sessions",
    profiles: ["minimal", "coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "browser",
    label: "browser",
    description: "Control web browser",
    sectionId: "ui",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "canvas",
    label: "canvas",
    description: "Control canvases",
    sectionId: "ui",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "lobster_workface_app",
    label: "lobster_workface_app",
    description: "Build Lobster daily-work dashboard app",
    sectionId: "ui",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "message",
    label: "message",
    description: "Send messages",
    sectionId: "messaging",
    profiles: ["messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "cron",
    label: "cron",
    description: "Schedule tasks",
    sectionId: "automation",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "gateway",
    label: "gateway",
    description: "Gateway control",
    sectionId: "automation",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "nodes",
    label: "nodes",
    description: "Nodes + devices",
    sectionId: "nodes",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "agents_list",
    label: "agents_list",
    description: "List agents",
    sectionId: "agents",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "image",
    label: "image",
    description: "Image understanding",
    sectionId: "media",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "tts",
    label: "tts",
    description: "Text-to-speech conversion",
    sectionId: "media",
    profiles: [],
    includeInOpenClawGroup: true,
  },
];

const CORE_TOOL_BY_ID = new Map<string, CoreToolDefinition>(
  CORE_TOOL_DEFINITIONS.map((tool) => [tool.id, tool]),
);

function listCoreToolIdsForProfile(profile: ToolProfileId): string[] {
  return CORE_TOOL_DEFINITIONS.filter((tool) => tool.profiles.includes(profile)).map(
    (tool) => tool.id,
  );
}

const CORE_TOOL_PROFILES: Record<ToolProfileId, ToolProfilePolicy> = {
  minimal: {
    allow: listCoreToolIdsForProfile("minimal"),
  },
  coding: {
    allow: listCoreToolIdsForProfile("coding"),
  },
  messaging: {
    allow: listCoreToolIdsForProfile("messaging"),
  },
  full: {},
};

function buildCoreToolGroupMap() {
  const sectionToolMap = new Map<string, string[]>();
  for (const tool of CORE_TOOL_DEFINITIONS) {
    const groupId = `group:${tool.sectionId}`;
    const list = sectionToolMap.get(groupId) ?? [];
    list.push(tool.id);
    sectionToolMap.set(groupId, list);
  }
  const openclawTools = CORE_TOOL_DEFINITIONS.filter((tool) => tool.includeInOpenClawGroup).map(
    (tool) => tool.id,
  );
  return {
    "group:openclaw": openclawTools,
    ...Object.fromEntries(sectionToolMap.entries()),
  };
}

export const CORE_TOOL_GROUPS = buildCoreToolGroupMap();

export const PROFILE_OPTIONS = [
  { id: "minimal", label: "Minimal" },
  { id: "coding", label: "Coding" },
  { id: "messaging", label: "Messaging" },
  { id: "full", label: "Full" },
] as const;

export function resolveCoreToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
  if (!profile) {
    return undefined;
  }
  const resolved = CORE_TOOL_PROFILES[profile as ToolProfileId];
  if (!resolved) {
    return undefined;
  }
  if (!resolved.allow && !resolved.deny) {
    return undefined;
  }
  return {
    allow: resolved.allow ? [...resolved.allow] : undefined,
    deny: resolved.deny ? [...resolved.deny] : undefined,
  };
}

export function listCoreToolSections(): CoreToolSection[] {
  return CORE_TOOL_SECTION_ORDER.map((section) => ({
    id: section.id,
    label: section.label,
    tools: CORE_TOOL_DEFINITIONS.filter((tool) => tool.sectionId === section.id).map((tool) => ({
      id: tool.id,
      label: tool.label,
      description: tool.description,
    })),
  })).filter((section) => section.tools.length > 0);
}

export function resolveCoreToolProfiles(toolId: string): ToolProfileId[] {
  const tool = CORE_TOOL_BY_ID.get(toolId);
  if (!tool) {
    return [];
  }
  return [...tool.profiles];
}

export function isKnownCoreToolId(toolId: string): boolean {
  return CORE_TOOL_BY_ID.has(toolId);
}
