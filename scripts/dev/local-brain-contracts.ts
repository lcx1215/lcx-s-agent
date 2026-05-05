export type LocalBrainContractInput = {
  ask: string;
  sourceSummary?: string;
};

const MODULE_IDS = [
  "macro_rates_inflation",
  "credit_liquidity",
  "etf_regime",
  "company_fundamentals_value",
  "quant_math",
  "portfolio_risk_gates",
  "causal_map",
  "finance_learning_memory",
  "source_registry",
  "review_panel",
  "control_room_summary",
  "ops_audit",
] as const;

const MODULE_ID_SET = new Set<string>(MODULE_IDS);

function arrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function mergeUnique(...groups: readonly string[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const item of groups.flat()) {
    const normalized = item.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(normalized);
  }
  return merged;
}

function withoutValues(values: string[], blockedValues: readonly string[]): string[] {
  const blocked = new Set(blockedValues.map((value) => value.toLowerCase()));
  return values.filter((value) => !blocked.has(value.toLowerCase()));
}

function cleanRiskBoundaries(value: unknown): string[] {
  const blocked = new Set([
    ...MODULE_IDS,
    "language_routing_only",
    "language_routing_required",
    "risk_boundaries",
    "next_step",
    "rejected_context",
  ]);
  return arrayValue(value).filter((entry) => !blocked.has(entry));
}

function cleanModuleList(value: unknown): string[] {
  return arrayValue(value).filter((entry) => MODULE_ID_SET.has(entry));
}

function cleanMissingData(value: unknown): string[] {
  const blocked = new Set([...MODULE_IDS, "missing_data", "risk_boundaries", "next_step"]);
  return arrayValue(value).filter((entry) => !blocked.has(entry));
}

function basePlan(plan: Record<string, unknown>): Record<string, unknown> {
  return {
    ...plan,
    primary_modules: cleanModuleList(plan.primary_modules),
    supporting_modules: cleanModuleList(plan.supporting_modules),
    missing_data: cleanMissingData(plan.missing_data),
    risk_boundaries: mergeUnique(cleanRiskBoundaries(plan.risk_boundaries), [
      "research_only",
      "no_execution_authority",
      "evidence_required",
      "no_model_math_guessing",
    ]),
    rejected_context: mergeUnique(arrayValue(plan.rejected_context), [
      "old_lark_conversation_history",
      "language_routing_candidate_artifacts",
      "unsupported_execution_language",
    ]),
  };
}

function textOf(input: LocalBrainContractInput): string {
  return `${input.ask}\n${input.sourceSummary ?? ""}`;
}

function looksLikeAmbiguousRepeatOnly(text: string): boolean {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return /^(重新来一遍|重来一遍|再来一遍|从头来|从头开始|redo|restart|again)[。.!！?？\s]*$/iu.test(
    normalized,
  );
}

function looksLikeContextReset(text: string): boolean {
  return /(清除上下文|清空上下文|别接上个任务|不要接上个任务|换个题|fresh start|reset context|new task)/iu.test(
    text,
  );
}

function looksLikeExternalMissingSource(text: string): boolean {
  return (
    /(学习|learn|读|吸收|沉淀|论文|paper|网页|article|source|url|链接|本地文件|local file)/iu.test(
      text,
    ) &&
    /(没给|没有给|还没给|未提供|缺|missing|without|no link|no url|no source|no local file)/iu.test(
      text,
    )
  );
}

function looksLikeExternalCoverage(text: string): boolean {
  return (
    /(google scholar|scholar|ssrn|nber|arxiv|working paper|preprint|literature review|公开课程|顶级大学|高校|syllabus|论文|paper)/iu.test(
      text,
    ) &&
    /(覆盖|coverage|sample limits?|sampling limits?|实际读过|读过哪些|what was actually read|不要说全覆盖|别说全覆盖|未覆盖范围|source limits?|全覆盖|完整覆盖|exhaustive|comprehensive)/iu.test(
      text,
    )
  );
}

function looksLikeCompanyToPortfolioRisk(text: string): boolean {
  return (
    /(公司|基本面|fundamental|capex|revenue|margin|earnings|估值|收入质量|客户集中度)/iu.test(
      text,
    ) && /(组合|持仓|仓位|科技仓|etf sleeve|portfolio|sleeve|risk|风险|传导|连接|影响)/iu.test(text)
  );
}

function looksLikePortfolioMathMissingInputs(text: string): boolean {
  return (
    /(数学|量化|波动|相关|回撤|var|dv01|beta|correlation|volatility|drawdown|利率敏感)/iu.test(
      text,
    ) &&
    /(没给|没有给|还没给|未提供|缺|missing|without|权重|价格序列|return series|weights)/iu.test(
      text,
    )
  );
}

function looksLikePortfolioMacroRisk(text: string): boolean {
  return (
    /(qqq|tlt|nvda|持仓|组合|portfolio)/iu.test(text) &&
    /(利率|ai capex|美元流动性|流动性|通胀|credit|macro|未来两周|风险)/iu.test(text)
  );
}

function looksLikeEtfTimingFramework(text: string): boolean {
  return /(低频|daily|weekly|etf|择时|timing|框架|framework)/iu.test(text);
}

function looksLikeOpsContextAudit(text: string): boolean {
  return /(上下文污染|串到旧任务|旧任务|lark.*污染|context pollution|不要继续金融分析|ops audit|审计)/iu.test(
    text,
  );
}

export function hardenLocalBrainPlanForAsk(
  plan: Record<string, unknown>,
  input: LocalBrainContractInput,
): Record<string, unknown> {
  const text = textOf(input);
  const safe = basePlan(plan);

  if (looksLikeAmbiguousRepeatOnly(input.ask)) {
    return {
      ...safe,
      task_family: "ambiguous_repeat_without_current_subject",
      primary_modules: ["control_room_summary"],
      supporting_modules: ["ops_audit"],
      required_tools: ["review_panel"],
      missing_data: ["current_subject_or_original_request"],
      risk_boundaries: ["research_only", "no_execution_authority", "evidence_required"],
      next_step: "ask_user_for_current_subject_before_reusing_prior_context",
      rejected_context: [
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "unsupported_execution_language",
      ],
    };
  }

  if (looksLikeContextReset(text)) {
    return {
      ...safe,
      task_family: "context_reset_new_subject_required",
      primary_modules: ["control_room_summary"],
      supporting_modules: ["ops_audit"],
      required_tools: ["review_panel"],
      missing_data: ["new_subject_or_original_request"],
      risk_boundaries: ["research_only", "no_execution_authority", "evidence_required"],
      next_step: "acknowledge_context_reset_then_ask_for_new_task_subject",
      rejected_context: [
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "unsupported_execution_language",
      ],
    };
  }

  if (looksLikeOpsContextAudit(text)) {
    return {
      ...safe,
      task_family: "lark_context_pollution_audit",
      primary_modules: ["ops_audit"],
      supporting_modules: ["control_room_summary", "review_panel"],
      required_tools: ["lark_loop_diagnose", "sessions_history", "review_panel"],
      missing_data: ["fresh_lark_message_id_or_visible_reply_text"],
      risk_boundaries: ["no_execution_authority", "evidence_required"],
      next_step: "inspect_lark_session_store_and_candidate_replay_before_claiming_live_fixed",
      rejected_context: [
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "unsupported_execution_language",
      ],
    };
  }

  if (looksLikeExternalMissingSource(text)) {
    return {
      ...safe,
      task_family: "external_source_learning_missing_source",
      primary_modules: ["finance_learning_memory", "source_registry"],
      supporting_modules: ["review_panel", "control_room_summary"],
      required_tools: [
        "finance_article_source_collection_preflight",
        "finance_article_source_registry_record",
        "review_panel",
      ],
      missing_data: ["source_url_or_local_source_path"],
      risk_boundaries: ["research_only", "no_execution_authority", "evidence_required"],
      next_step: "return_source_required_failed_reason_and_ask_for_link_or_local_file",
      rejected_context: [
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "unsupported_execution_language",
      ],
    };
  }

  if (looksLikeExternalCoverage(text)) {
    return {
      ...safe,
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        "source_registry",
        "finance_learning_memory",
        "causal_map",
      ]),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "review_panel",
        "control_room_summary",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "finance_article_source_collection_preflight",
        "finance_article_source_registry_record",
        "finance_learning_retrieval_review",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "source_url_or_local_source_path",
        "actual_reading_scope",
        "source_coverage_limits",
      ]),
      risk_boundaries: mergeUnique(cleanRiskBoundaries(safe.risk_boundaries), [
        "research_only",
        "evidence_required",
        "do_not_claim_exhaustive_coverage",
        "no_execution_authority",
      ]),
      next_step:
        "collect_or_verify_source_list_then_report_actual_reading_scope_before_any_learning_claim",
      rejected_context: mergeUnique(arrayValue(safe.rejected_context), [
        "unverified_full_coverage_claim",
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "unsupported_execution_language",
      ]),
    };
  }

  if (looksLikeCompanyToPortfolioRisk(text)) {
    return {
      ...safe,
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        "company_fundamentals_value",
        "causal_map",
        "portfolio_risk_gates",
      ]),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "finance_learning_memory",
        "review_panel",
        "control_room_summary",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "finance_framework_company_fundamentals_value_producer",
        "finance_framework_causal_map_producer",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "latest_company_fundamental_inputs",
        "portfolio_weights_and_risk_limits",
        "company_to_portfolio_exposure_map",
      ]),
      next_step: "build_company_to_portfolio_causal_plan_then_require_fresh_evidence",
    };
  }

  if (looksLikePortfolioMathMissingInputs(text)) {
    return {
      ...safe,
      task_family: "portfolio_quant_math_missing_inputs",
      primary_modules: mergeUnique(
        withoutValues(arrayValue(safe.primary_modules), [
          "company_fundamentals_value",
          "causal_map",
        ]),
        ["quant_math", "portfolio_risk_gates", "etf_regime", "macro_rates_inflation"],
      ),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "finance_learning_memory",
        "review_panel",
        "control_room_summary",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "finance_framework_etf_regime_producer",
        "finance_framework_macro_rates_inflation_producer",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "position_weights_and_return_series",
      ]),
      next_step: "request_position_weights_and_return_series_before_any_local_math",
    };
  }

  if (looksLikePortfolioMacroRisk(text)) {
    return {
      ...safe,
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "company_fundamentals_value",
        "quant_math",
        "portfolio_risk_gates",
      ]),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "causal_map",
        "finance_learning_memory",
        "control_room_summary",
        "review_panel",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_etf_regime_producer",
        "finance_framework_company_fundamentals_value_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "current_rates_and_inflation_inputs",
        "current_credit_and_liquidity_inputs",
        "target_etf_price_and_regime_inputs",
        "latest_company_fundamental_inputs",
        "position_weights_and_return_series",
        "portfolio_weights_and_risk_limits",
      ]),
      next_step: "request_fresh_inputs_then_route_to_concrete_finance_modules",
    };
  }

  if (looksLikeEtfTimingFramework(text)) {
    return {
      ...safe,
      task_family: "low_frequency_etf_timing_planning",
      primary_modules: mergeUnique(arrayValue(safe.primary_modules), [
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "quant_math",
        "portfolio_risk_gates",
      ]),
      supporting_modules: mergeUnique(arrayValue(safe.supporting_modules), [
        "causal_map",
        "finance_learning_memory",
        "control_room_summary",
        "review_panel",
      ]),
      required_tools: mergeUnique(arrayValue(safe.required_tools), [
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_etf_regime_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(safe.missing_data), [
        "position_weights_and_return_series",
      ]),
      next_step: "route_to_macro_liquidity_etf_math_risk_modules_before_visible_summary",
    };
  }

  return safe;
}
