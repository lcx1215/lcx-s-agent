type LearningRecallArtifactSpec = {
  noteName: string;
  promptOrder: number;
  producerOrder: number;
  bootstrapOrder: number;
  bootstrapHeading: string;
  bootstrapMaxChars?: number;
};

export const LEARNING_RECALL_ARTIFACT_SPECS = [
  {
    noteName: "learning-weekly-review",
    promptOrder: 7,
    producerOrder: 0,
    bootstrapOrder: 6,
    bootstrapHeading: "Latest Weekly Summary",
  },
  {
    noteName: "learning-upgrade",
    promptOrder: 6,
    producerOrder: 1,
    bootstrapOrder: 5,
    bootstrapHeading: "Priority Learning Upgrade",
    bootstrapMaxChars: 500,
  },
  {
    noteName: "learning-long-term-catalog",
    promptOrder: 5,
    producerOrder: 2,
    bootstrapOrder: 7,
    bootstrapHeading: "Long-Term Learning Catalog",
    bootstrapMaxChars: 650,
  },
  {
    noteName: "learning-durable-skills",
    promptOrder: 4,
    producerOrder: 3,
    bootstrapOrder: 4,
    bootstrapHeading: "Priority Durable Skills",
    bootstrapMaxChars: 650,
  },
  {
    noteName: "learning-trigger-map",
    promptOrder: 1,
    producerOrder: 4,
    bootstrapOrder: 0,
    bootstrapHeading: "Priority Learning Trigger Map",
    bootstrapMaxChars: 650,
  },
  {
    noteName: "learning-rehearsal-queue",
    promptOrder: 2,
    producerOrder: 5,
    bootstrapOrder: 1,
    bootstrapHeading: "Priority Learning Rehearsal Queue",
    bootstrapMaxChars: 650,
  },
  {
    noteName: "learning-transfer-bridges",
    promptOrder: 3,
    producerOrder: 6,
    bootstrapOrder: 2,
    bootstrapHeading: "Priority Learning Transfer Bridges",
    bootstrapMaxChars: 650,
  },
  {
    noteName: "learning-relevance-gate",
    promptOrder: 0,
    producerOrder: 7,
    bootstrapOrder: 3,
    bootstrapHeading: "Priority Learning Relevance Gate",
    bootstrapMaxChars: 650,
  },
] as const satisfies readonly LearningRecallArtifactSpec[];

export type LearningRecallMemoryNote = (typeof LEARNING_RECALL_ARTIFACT_SPECS)[number]["noteName"];

export const LEARNING_RECALL_MEMORY_NOTES = LEARNING_RECALL_ARTIFACT_SPECS.toSorted(
  (left, right) => left.promptOrder - right.promptOrder,
).map((spec) => spec.noteName) as readonly LearningRecallMemoryNote[];

export const LEARNING_WEEKLY_MEMORY_NOTES = LEARNING_RECALL_ARTIFACT_SPECS.toSorted(
  (left, right) => left.producerOrder - right.producerOrder,
).map((spec) => spec.noteName) as readonly LearningRecallMemoryNote[];

export const LEARNING_BOOTSTRAP_PRIORITY_SECTIONS = LEARNING_RECALL_ARTIFACT_SPECS.toSorted(
  (left, right) => left.bootstrapOrder - right.bootstrapOrder,
).map((spec) => ({
  noteName: spec.noteName,
  heading: spec.bootstrapHeading,
  maxChars: "bootstrapMaxChars" in spec ? spec.bootstrapMaxChars : undefined,
})) as readonly {
  noteName: LearningRecallMemoryNote;
  heading: string;
  maxChars?: number;
}[];

export const FUNDAMENTAL_PLANNING_MEMORY_NOTES = [
  "fundamental-collection-follow-up-tracker",
  "fundamental-review-memo",
  "fundamental-target-reports",
  "fundamental-collection-packets",
  "fundamental-manifest-patch-review",
  "fundamental-dossier-drafts",
  "fundamental-target-deliverables",
  "fundamental-target-workfiles",
  "fundamental-target-packets",
  "fundamental-review-workbench",
  "fundamental-review-plan",
  "fundamental-review-brief",
  "fundamental-review-queue",
  "fundamental-risk-handoff",
  "fundamental-scoring-gate",
  "fundamental-snapshot",
  "fundamental-snapshot-bridge",
  "fundamental-readiness",
  "fundamental-intake",
] as const;

export const FUNDAMENTAL_WORKSPACE_ARTIFACTS = [
  "intake",
  "manifest",
  "readiness",
  "snapshot-input",
  "snapshot",
  "scoring-gate",
  "risk-handoff",
  "review-queue",
  "review-brief",
  "review-plan",
  "review-workbench",
  "target-packets",
  "target-workfiles",
  "target-deliverables",
  "dossier-drafts",
  "manifest-patch-reviews",
  "collection-packets",
  "target-reports",
  "review-memos",
  "collection-follow-up-trackers",
] as const;

type FundamentalReviewChainStageSpec = {
  stageName: string;
  jsonDir: string;
};

export const FUNDAMENTAL_ARTIFACT_STAGE_SPECS = [
  {
    stageName: "fundamental-readiness",
    jsonDir: "bank/fundamental/readiness",
  },
  {
    stageName: "fundamental-snapshot-bridge",
    jsonDir: "bank/fundamental/snapshot-inputs",
  },
  {
    stageName: "fundamental-snapshot",
    jsonDir: "bank/fundamental/snapshots",
  },
  {
    stageName: "fundamental-scoring-gate",
    jsonDir: "bank/fundamental/scoring-gates",
  },
  {
    stageName: "fundamental-risk-handoff",
    jsonDir: "bank/fundamental/risk-handoffs",
  },
  {
    stageName: "fundamental-review-queue",
    jsonDir: "bank/fundamental/review-queues",
  },
  {
    stageName: "fundamental-review-brief",
    jsonDir: "bank/fundamental/review-briefs",
  },
  {
    stageName: "fundamental-review-plan",
    jsonDir: "bank/fundamental/review-plans",
  },
  {
    stageName: "fundamental-review-workbench",
    jsonDir: "bank/fundamental/review-workbenches",
  },
  {
    stageName: "fundamental-target-packets",
    jsonDir: "bank/fundamental/target-packets",
  },
  {
    stageName: "fundamental-target-workfiles",
    jsonDir: "bank/fundamental/target-workfiles",
  },
  {
    stageName: "fundamental-target-deliverables",
    jsonDir: "bank/fundamental/target-deliverables",
  },
  {
    stageName: "fundamental-target-reports",
    jsonDir: "bank/fundamental/target-reports",
  },
  {
    stageName: "fundamental-review-memo",
    jsonDir: "bank/fundamental/review-memos",
  },
  {
    stageName: "fundamental-collection-packets",
    jsonDir: "bank/fundamental/collection-packets",
  },
  {
    stageName: "fundamental-collection-follow-up-tracker",
    jsonDir: "bank/fundamental/collection-follow-up-trackers",
  },
  {
    stageName: "fundamental-manifest-patch-review",
    jsonDir: "bank/fundamental/manifest-patch-reviews",
  },
  {
    stageName: "fundamental-dossier-drafts",
    jsonDir: "bank/fundamental/dossier-drafts",
  },
] as const satisfies readonly FundamentalReviewChainStageSpec[];

export type FundamentalArtifactStage =
  (typeof FUNDAMENTAL_ARTIFACT_STAGE_SPECS)[number]["stageName"];

export type FundamentalReviewChainStage = Extract<
  FundamentalArtifactStage,
  | "fundamental-review-queue"
  | "fundamental-review-brief"
  | "fundamental-review-plan"
  | "fundamental-review-workbench"
>;

export const FRONTIER_METHOD_MEMORY_NOTES = [
  "frontier-upgrade prompts",
  "weekly methods reviews",
  "replication backlog notes",
  "frontier research cards",
  "prior leakage and overfitting audits",
] as const;

type FrontierRecallArtifactSpec = {
  noteName: string;
  producerOrder: number;
  bootstrapOrder: number;
  bootstrapHeading: string;
  bootstrapMaxChars?: number;
};

export const FRONTIER_RECALL_ARTIFACT_SPECS = [
  {
    noteName: "frontier-upgrade",
    producerOrder: 1,
    bootstrapOrder: 0,
    bootstrapHeading: "Priority Frontier Upgrade",
    bootstrapMaxChars: 500,
  },
  {
    noteName: "frontier-methods-weekly-review",
    producerOrder: 0,
    bootstrapOrder: 1,
    bootstrapHeading: "Latest Weekly Methods Review",
    bootstrapMaxChars: 600,
  },
  {
    noteName: "frontier-replication-backlog",
    producerOrder: 2,
    bootstrapOrder: 2,
    bootstrapHeading: "Latest Replication Backlog",
    bootstrapMaxChars: 600,
  },
] as const satisfies readonly FrontierRecallArtifactSpec[];

export type FrontierRecallMemoryNote = (typeof FRONTIER_RECALL_ARTIFACT_SPECS)[number]["noteName"];

export const FRONTIER_WEEKLY_MEMORY_NOTES = FRONTIER_RECALL_ARTIFACT_SPECS.toSorted(
  (left, right) => left.producerOrder - right.producerOrder,
).map((spec) => spec.noteName) as readonly FrontierRecallMemoryNote[];

export const FRONTIER_BOOTSTRAP_PRIORITY_SECTIONS = FRONTIER_RECALL_ARTIFACT_SPECS.toSorted(
  (left, right) => left.bootstrapOrder - right.bootstrapOrder,
).map((spec) => ({
  noteName: spec.noteName,
  heading: spec.bootstrapHeading,
  maxChars: spec.bootstrapMaxChars,
})) as readonly {
  noteName: FrontierRecallMemoryNote;
  heading: string;
  maxChars?: number;
}[];

export const FRONTIER_RESEARCH_CARD_PREFIX = "frontier-research-";
const FRONTIER_RESEARCH_CARD_FILENAME_RE = new RegExp(
  `^(\\d{4}-\\d{2}-\\d{2})-${FRONTIER_RESEARCH_CARD_PREFIX}.+\\.md$`,
  "u",
);

export type FrontierResearchCardArtifact = {
  sessionKey: string;
  sessionId: string;
  title: string;
  materialType: string;
  methodFamily: string;
  problemStatement: string;
  methodSummary: string;
  claimedContribution: string;
  dataSetup: string;
  evaluationProtocol: string;
  keyResults: string;
  possibleLeakagePoints: string;
  overfittingRisks: string;
  replicationCost: string;
  relevanceToLobster: string;
  adoptableIdeas: string;
  doNotCopyBlindly: string;
  foundationTemplate: string;
  verdict: string;
  sessionTraceLines: string[];
};

export type ParsedFrontierResearchCardArtifact = FrontierResearchCardArtifact & {
  name: string;
  date: string;
};

export const OPERATING_REVIEW_MEMORY_NOTES = [
  "current-research-line",
  "unified risk views",
  "daily risk-audit snapshots",
  "branch summaries",
  "intake/fetch/review logs",
  "weekly learning loops",
] as const;

type OperatingWeeklyArtifactSpec = {
  noteName: string;
  extension: "md";
};

export const OPERATING_WEEKLY_ARTIFACT_SPECS = [
  {
    noteName: "lobster-weekly-review",
    extension: "md",
  },
  {
    noteName: "portfolio-answer-scorecard",
    extension: "md",
  },
] as const satisfies readonly OperatingWeeklyArtifactSpec[];

export type OperatingWeeklyArtifactName =
  (typeof OPERATING_WEEKLY_ARTIFACT_SPECS)[number]["noteName"];

type MemoryHygieneArtifactSpec = {
  noteName: string;
  relativeDir: string;
  extension: "md" | "json";
};

export const MEMORY_HYGIENE_ARTIFACT_SPECS = [
  {
    noteName: "memory-hygiene-weekly",
    relativeDir: "memory",
    extension: "md",
  },
  {
    noteName: "provisional-ledger",
    relativeDir: "memory/provisional",
    extension: "md",
  },
  {
    noteName: "rejected-ledger",
    relativeDir: "memory/rejected",
    extension: "md",
  },
  {
    noteName: "anti-patterns",
    relativeDir: "memory/anti-patterns",
    extension: "md",
  },
  {
    noteName: "trash-candidates",
    relativeDir: "bank/trash",
    extension: "json",
  },
] as const satisfies readonly MemoryHygieneArtifactSpec[];

export type MemoryHygieneArtifactName = (typeof MEMORY_HYGIENE_ARTIFACT_SPECS)[number]["noteName"];

type KnowledgeValidationArtifactSpec = {
  noteName: string;
  extension: "md";
};

export const KNOWLEDGE_VALIDATION_WEEKLY_ARTIFACT_SPECS = [
  {
    noteName: "knowledge-validation-weekly",
    extension: "md",
  },
] as const satisfies readonly KnowledgeValidationArtifactSpec[];

export type KnowledgeValidationWeeklyArtifactName =
  (typeof KNOWLEDGE_VALIDATION_WEEKLY_ARTIFACT_SPECS)[number]["noteName"];

export type ParsedOperatingWeeklyArtifactFilename = {
  weekKey: string;
  noteName: OperatingWeeklyArtifactName;
};

export type ParsedKnowledgeValidationWeeklyArtifactFilename = {
  weekKey: string;
  noteName: KnowledgeValidationWeeklyArtifactName;
};

export type PortfolioAnswerScorecardArtifact = {
  weekKey: string;
  rangeLabel: string;
  sessionKey: string;
  signalsReviewed: number;
  averageScore: string;
  dimensionScoreLines: string[];
  mainFailureModeLines: string[];
  nextUpgradeFocusLines: string[];
};

export type ParsedPortfolioAnswerScorecardArtifact = {
  weekKey: string;
  averageScore: string;
  nextUpgradeFocus: string;
  improveTarget: string;
};

export type KnowledgeValidationWeeklyArtifact = {
  weekKey: string;
  rangeLabel: string;
  sessionKey: string;
  validationNotes: number;
  benchmarkNotes: number;
  dailyRealTaskNotes: number;
  benchmarkCoverageLines: string[];
  dailyRealTaskCoverageLines: string[];
  capabilityCoverageLines: string[];
  strongestDomainLines: string[];
  weakestDomainLines: string[];
  hallucinationProneLines: string[];
  correctionCandidateLines: string[];
  repairTicketCandidateLines: string[];
  nextValidationFocusLines: string[];
};

export type ParsedKnowledgeValidationWeeklyArtifact = {
  weekKey: string;
  strongestDomain: string;
  weakestDomain: string;
  hallucinationDomain: string;
};

export type ParsedLobsterWorkfaceFilename = {
  dateKey: string;
};

export type LobsterWorkfaceArtifact = {
  targetDateKey: string;
  sessionKey: string;
  learningItems: number;
  correctionNotes: number;
  watchtowerSignals: number;
  codexEscalations: number;
  activeSurfaceLanes?: number;
  portfolioScorecard?: string;
  totalTokens: string;
  estimatedCost: string;
  dashboardSnapshotLines: string[];
  validationRadarLines: string[];
  feishuLanePanelLines: string[];
  sevenDayOperatingViewLines: string[];
  yesterdayLearnedLines: string[];
  yesterdayWorkReceiptLines?: string[];
  selfRepairSignalLines?: string[];
  yesterdayCorrectedLines: string[];
  yesterdayWatchtowerLines: string[];
  codexEscalationLines: string[];
  portfolioAnswerScorecardLines: string[];
  tokenDashboardLeadLine: string;
  tokenDashboardModelLines: string[];
  tokenTrendLines: string[];
  readingGuideLines: string[];
};

export type ParsedLobsterWorkfaceArtifact = {
  dateKey: string;
  learningItems: string;
  correctionNotes: string;
  watchtowerSignals: string;
  codexEscalations: string;
  activeSurfaceLanes?: string;
  portfolioScorecard?: string;
  totalTokens: string;
  estimatedCost: string;
  strongestDomain?: string;
  weakestDomain?: string;
  hallucinationWatch?: string;
  learningKeep?: string;
  learningDiscard?: string;
  learningImproveLobster?: string;
  learningReplay?: string;
  learningNextEval?: string;
  laneMeterRows: string[];
};

export type FeishuSurfaceLineArtifact = {
  surface: string;
  chatId: string;
  laneKey: string;
  lastUpdated: string;
  sessionKey: string;
  recentTurnEntries: string[];
};

export type ParsedFeishuSurfaceLineArtifact = {
  surface: string;
  chatId: string;
  laneKey: string;
  lastUpdated: string;
  sessionKey: string;
  recentTurnEntries: string[];
};

export type FeishuWorkReceiptArtifact = {
  handledAt: string;
  surface: string;
  chatId: string;
  sessionKey: string;
  messageId: string;
  userMessage: string;
  requestedAction: string;
  scope: string;
  timeframe: string;
  outputShape: string;
  repairDisposition: string;
  readPathLines: string[];
  finalReplySummary: string;
  financeDoctrineProof?: {
    consumer: string;
    doctrineFieldsUsed: string[];
    outputEvidenceLines: string[];
    proves: string;
    doesNotProve: string;
  };
};

export type ParsedFeishuWorkReceiptArtifact = {
  handledAt: string;
  surface: string;
  chatId: string;
  sessionKey: string;
  messageId: string;
  userMessage: string;
  requestedAction: string;
  scope: string;
  timeframe: string;
  outputShape: string;
  repairDisposition: string;
  readPathLines: string[];
  finalReplySummary: string;
  financeDoctrineProof?: {
    consumer: string;
    doctrineFieldsUsed: string[];
    outputEvidenceLines: string[];
    proves: string;
    doesNotProve: string;
  };
};

export type FeishuFinanceDoctrineCalibrationArtifact = {
  reviewDate: string;
  consumer: string;
  linkedReceipt: string;
  observedOutcome: string;
  scenarioClosestToOutcome: "base_case" | "bear_case" | "unclear";
  baseCaseDirectionallyCloser: "yes" | "no" | "unclear";
  changeMyMindTriggered: "yes" | "no" | "unclear";
  convictionLooksTooHighOrLow: "too_high" | "too_low" | "about_right" | "unclear";
  notes: string;
};

export type ParsedFeishuFinanceDoctrineCalibrationArtifact =
  FeishuFinanceDoctrineCalibrationArtifact;

export type FeishuFinanceDoctrineTeacherFeedbackArtifact = {
  generatedAt: string;
  teacherTask: "finance_calibration_audit";
  feedbacks: Array<{
    feedbackId: string;
    sourceArtifact: string;
    teacherModel: string;
    critiqueType:
      | "missing_causal_chain"
      | "overconfident_conviction"
      | "missing_bear_case"
      | "weak_no_action_justification"
      | "weak_instrument_choice"
      | "weak_risk_gate";
    critiqueText: string;
    suggestedCandidateText: string;
    evidenceNeeded: string;
    riskOfAdopting: string;
    recommendedNextAction: string;
  }>;
};

export type ParsedFeishuFinanceDoctrineTeacherFeedbackArtifact =
  FeishuFinanceDoctrineTeacherFeedbackArtifact;

export type FeishuFinanceDoctrineTeacherReviewArtifact = {
  reviewedAt: string;
  sourceTeacherFeedbackArtifact: string;
  reviews: Array<{
    feedbackId: string;
    sourceArtifact: string;
    reviewOutcome: "deferred" | "rejected" | "elevated_for_governance_review";
  }>;
};

export type ParsedFeishuFinanceDoctrineTeacherReviewArtifact =
  FeishuFinanceDoctrineTeacherReviewArtifact;

export type FeishuFinanceDoctrineTeacherElevationHandoffArtifact = {
  handedOffAt: string;
  sourceTeacherFeedbackArtifact: string;
  sourceTeacherReviewArtifact: string;
  handoffs: Array<{
    handoffId: string;
    feedbackId: string;
    critiqueType: FeishuFinanceDoctrineTeacherFeedbackArtifact["feedbacks"][number]["critiqueType"];
    critiqueText: string;
    suggestedCandidateText: string;
    evidenceNeeded: string;
    riskOfAdopting: string;
    targetGovernancePath: string;
    operatorNextAction: string;
    status:
      | "open"
      | "converted_to_candidate_input"
      | "rejected_after_handoff_review"
      | "superseded";
  }>;
};

export type ParsedFeishuFinanceDoctrineTeacherElevationHandoffArtifact =
  FeishuFinanceDoctrineTeacherElevationHandoffArtifact;

export type FeishuFinanceDoctrineTeacherCandidateInputArtifact = {
  createdAt: string;
  sourceTeacherElevationHandoffArtifact: string;
  sourceTeacherFeedbackArtifact: string;
  sourceTeacherReviewArtifact: string;
  candidateInputs: Array<{
    candidateInputId: string;
    handoffId: string;
    feedbackId: string;
    critiqueType: FeishuFinanceDoctrineTeacherFeedbackArtifact["feedbacks"][number]["critiqueType"];
    critiqueText: string;
    suggestedCandidateText: string;
    evidenceNeeded: string;
    riskOfAdopting: string;
    targetGovernancePath: string;
    operatorNextAction: string;
  }>;
};

export type ParsedFeishuFinanceDoctrineTeacherCandidateInputArtifact =
  FeishuFinanceDoctrineTeacherCandidateInputArtifact;

export type FeishuFinanceDoctrineTeacherCandidateInputReviewArtifact = {
  reviewedAt: string;
  sourceTeacherCandidateInputArtifact: string;
  reviews: Array<{
    candidateInputId: string;
    handoffId: string;
    feedbackId: string;
    targetGovernancePath: string;
    reviewOutcome: "consumed_into_candidate_flow" | "rejected_before_candidate_flow" | "superseded";
  }>;
};

export type ParsedFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact =
  FeishuFinanceDoctrineTeacherCandidateInputReviewArtifact;

export type FeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact = {
  reconciledAt: string;
  sourceTeacherCandidateInputArtifact: string;
  sourceTeacherCandidateInputReviewArtifact: string;
  reconciliations: Array<{
    reconciliationId: string;
    sourceTeacherCandidateInputArtifact: string;
    sourceTeacherCandidateInputReviewArtifact: string;
    candidateInputId: string;
    targetFinanceCandidatePath: string;
    reconciliationMode: "link_existing_candidate" | "new_candidate_reference";
    reconciliationNotes: string;
    status:
      | "open"
      | "linked_to_existing_candidate"
      | "created_as_new_candidate_reference"
      | "rejected_before_reconciliation"
      | "superseded";
  }>;
};

export type ParsedFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact =
  FeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact;

export const FINANCE_FRAMEWORK_CORE_DOMAINS = [
  "macro_rates_inflation",
  "etf_regime",
  "options_volatility",
  "company_fundamentals_value",
  "commodities_oil_gold",
  "fx_dollar",
  "credit_liquidity",
  "event_driven",
  "portfolio_risk_gates",
  "causal_map",
] as const;

export const FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES = [
  "research_only",
  "watch_only",
  "candidate_for_review",
  "no_action",
] as const;

export const FINANCE_FRAMEWORK_CONFIDENCE_OR_CONVICTION_LEVELS = [
  "low",
  "medium",
  "high",
  "mixed",
] as const;

export type FinanceFrameworkCoreDomain = (typeof FINANCE_FRAMEWORK_CORE_DOMAINS)[number];
export type FinanceFrameworkAllowedActionAuthority =
  (typeof FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES)[number];
export type FinanceFrameworkConfidenceOrConviction =
  (typeof FINANCE_FRAMEWORK_CONFIDENCE_OR_CONVICTION_LEVELS)[number];

export const FINANCE_LEARNING_CAPABILITY_TYPES = [
  "analysis_method",
  "research_framework",
  "data_collection_method",
  "indicator_method",
  "risk_method",
  "causal_mapping_method",
] as const;

export const FINANCE_LEARNING_CAPABILITY_TAGS = [
  "sentiment_analysis",
  "factor_research",
  "tactical_timing",
  "leverage_research",
  "alternative_data_ingestion",
  "fundamentals_research",
  "event_catalyst_mapping",
  "volatility_research",
  "risk_gate_design",
  "causal_mapping",
] as const;

export const FINANCE_LEARNING_SOURCE_TYPES = [
  "wechat_public_account_article",
  "public_web_article",
  "licensed_research_excerpt",
  "manual_learning_note",
  "internal_research_note",
] as const;

export const FINANCE_LEARNING_COLLECTION_METHODS = [
  "manual_review",
  "public_article_capture",
  "public_wechat_capture",
  "licensed_excerpt_capture",
  "internal_note_capture",
] as const;

export const FINANCE_LEARNING_EVIDENCE_LEVELS = [
  "hypothesis",
  "anecdotal",
  "case_study",
  "replicated",
  "mixed",
] as const;

export const FINANCE_ARTICLE_SOURCE_TYPES = [
  "wechat_public_account_source",
  "public_web_source",
  "rss_public_feed_source",
  "licensed_research_source",
  "internal_research_source",
  "manual_article_source",
] as const;

export const FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS = [
  "manual_paste",
  "local_file",
  "user_provided_url",
  "rss_or_public_feed_if_available",
  "browser_assisted_manual_collection",
] as const;

export type FinanceLearningCapabilityType = (typeof FINANCE_LEARNING_CAPABILITY_TYPES)[number];
export type FinanceLearningCapabilityTag = (typeof FINANCE_LEARNING_CAPABILITY_TAGS)[number];
export type FinanceLearningSourceType = (typeof FINANCE_LEARNING_SOURCE_TYPES)[number];
export type FinanceLearningCollectionMethod = (typeof FINANCE_LEARNING_COLLECTION_METHODS)[number];
export type FinanceLearningEvidenceLevel = (typeof FINANCE_LEARNING_EVIDENCE_LEVELS)[number];
export type FinanceArticleSourceType = (typeof FINANCE_ARTICLE_SOURCE_TYPES)[number];
export type FinanceArticleSourceCollectionMethod =
  (typeof FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS)[number];

export const FINANCE_EVIDENCE_CATEGORIES = [
  "equity_market_evidence",
  "etf_regime_evidence",
  "macro_rates_evidence",
  "inflation_evidence",
  "liquidity_evidence",
  "credit_evidence",
  "options_volatility_evidence",
  "fundamentals_evidence",
  "valuation_evidence",
  "commodity_evidence",
  "fx_dollar_evidence",
  "event_catalyst_evidence",
  "portfolio_risk_evidence",
  "causal_chain_evidence",
  "alternative_data_evidence",
  "sentiment_evidence",
  "backtest_or_empirical_evidence",
  "implementation_evidence",
  "compliance_evidence",
] as const;

export type FinanceEvidenceCategory = (typeof FINANCE_EVIDENCE_CATEGORIES)[number];

export type FinanceLearningCapabilityCandidateArtifact = {
  updatedAt: string;
  frameworkContractPath: string;
  candidates: Array<{
    candidateId: string;
    sourceArticlePath: string;
    title: string;
    sourceType: FinanceLearningSourceType;
    collectionMethod: FinanceLearningCollectionMethod;
    authorSourceName?: string;
    publishDate?: string;
    extractionSummary: string;
    rawNotes: string;
    capabilityName: string;
    capabilityType: FinanceLearningCapabilityType;
    relatedFinanceDomains: FinanceFrameworkCoreDomain[];
    capabilityTags: FinanceLearningCapabilityTag[];
    evidenceCategories: FinanceEvidenceCategory[];
    evidenceSummary: string;
    methodSummary: string;
    requiredDataSources: string[];
    causalOrMechanisticClaim: string;
    evidenceLevel: FinanceLearningEvidenceLevel;
    implementationRequirements: string;
    riskAndFailureModes: string;
    overfittingOrSpuriousRisk: string;
    complianceOrCollectionNotes: string;
    suggestedAttachmentPoint: string;
    allowedActionAuthority: FinanceFrameworkAllowedActionAuthority;
  }>;
};

export type ParsedFinanceLearningCapabilityCandidateArtifact =
  FinanceLearningCapabilityCandidateArtifact;

export type FinanceArticleSourceRegistryArtifact = {
  updatedAt: string;
  sources: Array<{
    sourceName: string;
    sourceType: FinanceArticleSourceType;
    sourceUrlOrIdentifier: string;
    allowedCollectionMethods: FinanceArticleSourceCollectionMethod[];
    requiresManualInput: boolean;
    complianceNotes: string;
    rateLimitNotes: string;
    freshnessExpectation: string;
    reliabilityNotes: string;
    extractionTarget: string;
    allowedActionAuthority: FinanceFrameworkAllowedActionAuthority;
    isPubliclyAccessible?: boolean;
  }>;
};

export type ParsedFinanceArticleSourceRegistryArtifact = FinanceArticleSourceRegistryArtifact;

export type FinanceFrameworkCoreContractArtifact = {
  updatedAt: string;
  entries: Array<{
    domain: FinanceFrameworkCoreDomain;
    sourceArtifacts: string[];
    evidenceCategories: FinanceEvidenceCategory[];
    evidenceSummary: string;
    baseCase: string;
    bullCase: string;
    bearCase: string;
    keyCausalChain: string;
    upstreamDrivers: string[];
    downstreamAssetImpacts: string[];
    confidenceOrConviction: FinanceFrameworkConfidenceOrConviction;
    whatChangesMyMind: string;
    noActionReason: string;
    riskGateNotes: string;
    allowedActionAuthority: FinanceFrameworkAllowedActionAuthority;
  }>;
};

export type ParsedFinanceFrameworkCoreContractArtifact = FinanceFrameworkCoreContractArtifact;

export type FeishuFinanceDoctrinePromotionCandidateArtifact = {
  generatedAt: string;
  consumer: string;
  windowDays: number;
  windowStartDate: string;
  windowEndDate: string;
  totalCalibrationNotes: number;
  candidates: Array<{
    candidateKey: string;
    signal:
      | "closest_scenario"
      | "base_case_directionally_closer"
      | "change_my_mind_triggered"
      | "conviction_looks";
    observedValue: string;
    occurrences: number;
    reviewState: "unreviewed" | "deferred" | "rejected" | "ready_for_manual_promotion";
    reviewNotes?: string;
    candidateText: string;
    notEnoughForPromotion: string;
  }>;
};

export type ParsedFeishuFinanceDoctrinePromotionCandidateArtifact =
  FeishuFinanceDoctrinePromotionCandidateArtifact;

export type FeishuFinanceDoctrinePromotionReviewArtifact = {
  reviewedAt: string;
  consumer: string;
  linkedCandidateArtifact: string;
  reviews: Array<{
    candidateKey: string;
    reviewState: "unreviewed" | "deferred" | "rejected" | "ready_for_manual_promotion";
    reviewNotes?: string;
  }>;
};

export type ParsedFeishuFinanceDoctrinePromotionReviewArtifact =
  FeishuFinanceDoctrinePromotionReviewArtifact;

export type FeishuFinanceDoctrinePromotionDecisionArtifact = {
  decidedAt: string;
  consumer: string;
  linkedCandidateArtifact: string;
  linkedReviewArtifact: string;
  decisions: Array<{
    candidateKey: string;
    decisionOutcome:
      | "proposal_created"
      | "deferred_after_promotion_review"
      | "rejected_after_promotion_review";
    reviewStateAtDecision: "ready_for_manual_promotion";
    decisionNotes?: string;
  }>;
};

export type ParsedFeishuFinanceDoctrinePromotionDecisionArtifact =
  FeishuFinanceDoctrinePromotionDecisionArtifact;

export type FeishuFinanceDoctrinePromotionProposalArtifact = {
  draftedAt: string;
  consumer: string;
  sourceDecisionArtifact: string;
  linkedCandidateArtifact: string;
  linkedReviewArtifact: string;
  proposals: Array<{
    proposalId: string;
    candidateKey: string;
    sourceCandidateText: string;
    proposedDoctrineChange: string;
    rationaleFromCalibration: string;
    riskOrCounterargument: string;
    operatorNextAction: string;
    status: "draft" | "accepted_for_manual_edit" | "rejected" | "superseded";
  }>;
};

export type ParsedFeishuFinanceDoctrinePromotionProposalArtifact =
  FeishuFinanceDoctrinePromotionProposalArtifact;

export type FeishuFinanceDoctrineEditHandoffArtifact = {
  handedOffAt: string;
  consumer: string;
  sourceProposalArtifact: string;
  sourceDecisionArtifact?: string;
  linkedCandidateArtifact?: string;
  linkedReviewArtifact?: string;
  handoffs: Array<{
    handoffId: string;
    proposalId: string;
    candidateKey: string;
    proposedDoctrineChange: string;
    rationaleFromCalibration: string;
    riskOrCounterargument: string;
    targetDoctrineOrCard: string;
    manualEditChecklist: string;
    operatorDecisionNeeded: string;
    status: "open" | "applied_manually" | "rejected_after_edit_review" | "superseded";
  }>;
};

export type ParsedFeishuFinanceDoctrineEditHandoffArtifact =
  FeishuFinanceDoctrineEditHandoffArtifact;

export type ParsedFeishuWorkReceiptFilename = {
  dateStr: string;
  timeSlug: string;
  noteSlug: string;
};

export type FeishuSurfaceLanePanelArtifact = {
  activeLanes: number;
  laneMeterLines: string[];
};

export type ParsedFeishuSurfaceLanePanelArtifact = {
  activeLanes?: number;
  laneMeterLines: string[];
};

export type FeishuSurfaceLaneHealthArtifact = {
  status: string;
  activeLanes: number;
  crowdedChats: string[];
  busiestLane?: string;
  guidanceLines: string[];
};

export type ParsedFeishuSurfaceLaneHealthArtifact = {
  status: string;
  activeLanes: number;
  crowdedChats: string[];
  busiestLane?: string;
};

const KNOWLEDGE_VALIDATION_NOTE_FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2})-knowledge-validation-(.+)\.md$/u;
const LEARNING_REVIEW_NOTE_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})-review-(.+)\.md$/u;
const LEARNING_COUNCIL_NOTE_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})-learning-council-(.+)\.md$/u;
const LEARNING_COUNCIL_ADOPTION_LEDGER_FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2})-learning-council-adoption-(.+)\.md$/u;
const CORRECTION_NOTE_FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2})-correction-note-([A-Za-z0-9-]+)-([0-9]{6}-[0-9]{3,}Z)\.md$/u;
const LOBSTER_WORKFACE_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})-lobster-workface\.md$/u;
const FEISHU_WORK_RECEIPT_FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2})-feishu-work-receipt-([0-9]{6}-[0-9]{3,}Z)-(.+)\.md$/u;
const FEISHU_FINANCE_DOCTRINE_CALIBRATION_FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2})-feishu-finance-doctrine-calibration-([0-9]{6}-[0-9]{3,}Z)-(.+)\.md$/u;
const FEISHU_FINANCE_DOCTRINE_TEACHER_FEEDBACK_FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2})-feishu-finance-doctrine-teacher-feedback\.md$/u;
const FEISHU_FINANCE_DOCTRINE_TEACHER_REVIEW_FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2})-feishu-finance-doctrine-teacher-review\.md$/u;
const FEISHU_FINANCE_DOCTRINE_TEACHER_ELEVATION_HANDOFFS_FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2})-feishu-finance-doctrine-teacher-elevation-handoffs\.md$/u;
const FEISHU_FINANCE_DOCTRINE_PROMOTION_CANDIDATES_FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2})-feishu-finance-doctrine-promotion-candidates\.md$/u;
const FEISHU_FINANCE_DOCTRINE_PROMOTION_REVIEW_FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2})-feishu-finance-doctrine-promotion-review\.md$/u;
const FEISHU_FINANCE_DOCTRINE_PROMOTION_DECISIONS_FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2})-feishu-finance-doctrine-promotion-decisions\.md$/u;
const FEISHU_FINANCE_DOCTRINE_PROMOTION_PROPOSALS_FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2})-feishu-finance-doctrine-promotion-proposals\.md$/u;
const FEISHU_FINANCE_DOCTRINE_EDIT_HANDOFFS_FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2})-feishu-finance-doctrine-edit-handoffs\.md$/u;

export type KnowledgeValidationType = "benchmark" | "daily_real_task";
export type LearningCouncilMemoryNoteStatus =
  | "full"
  | "full_with_mutable_fact_warnings"
  | "degraded";

export type ParsedKnowledgeValidationNoteFilename = {
  dateStr: string;
  noteSlug: string;
};

export type ParsedLearningReviewNoteFilename = {
  dateStr: string;
  noteSlug: string;
};

export type LearningReviewMemoryNoteArtifact = {
  dateStr: string;
  timeStr: string;
  sessionKey: string;
  sessionId: string;
  topic: string;
  problem: string;
  workingAnswer: string;
  mistakePattern: string;
  corePrinciple: string;
  microDrill: string;
  transferHint: string;
  foundationTemplate: string;
  whyItMatters: string;
  sessionTraceLines: string[];
};

export type ParsedLearningReviewMemoryNote = {
  name: string;
  date: string;
  noteSlug: string;
  sessionKey: string;
  sessionId: string;
  topic: string;
  problem: string;
  workingAnswer: string;
  mistakePattern: string;
  corePrinciple: string;
  microDrill: string;
  transferHint: string;
  foundationTemplate: string;
  whyItMatters: string;
};

export type ParsedKnowledgeValidationNote = {
  name: string;
  date: string;
  noteSlug: string;
  validationType: KnowledgeValidationType;
  capabilityFamily: string;
  benchmarkFamily: string;
  taskFamily: string;
  domain: string;
  confidenceMode: string;
  factualQuality: number;
  reasoningQuality: number;
  hallucinationRisk: string;
  verdict: string;
  correctionCandidate: string;
  repairTicketCandidate: string;
};

export type ParsedLearningCouncilMemoryNoteFilename = {
  dateStr: string;
  noteSlug: string;
};

export type LearningCouncilMemoryNoteArtifact = {
  stem: string;
  generatedAt: string;
  status: string;
  userMessage: string;
  mutableFactWarnings: number;
  failedRolesSummary: string;
  finalReplySnapshot: string;
  keeperLines?: string[];
  discardLines?: string[];
  lobsterImprovementLines?: string[];
  rehearsalTriggerLines?: string[];
  nextEvalCueLines?: string[];
  runPacket?: LearningCouncilRunPacket;
};

export type LearningCouncilRunPacket = {
  objective: string;
  protectedAnchorsPresent: string[];
  protectedAnchorsMissing: string[];
  currentFocus?: string;
  topDecision?: string;
  recallOrder?: string;
  latestCarryoverSource?: string;
  localMemoryCardPaths: string[];
  keepLines: string[];
  discardLines: string[];
  lobsterImprovementLines: string[];
  currentBracketLines: string[];
  ruledOutLines: string[];
  highestInfoNextCheckLines: string[];
  replayTriggerLines: string[];
  nextEvalCueLines: string[];
  recoveryReadOrder: string[];
};

export type LearningCouncilAdoptionCueType =
  | "keep"
  | "discard"
  | "lobster_improvement"
  | "replay_trigger"
  | "next_eval"
  | "current_bracket"
  | "ruled_out"
  | "highest_info_next_check";

export type LearningCouncilAdoptionState = "adopted_now" | "candidate_for_reuse" | "ignored";

export type LearningCouncilAdoptionLedgerEntry = {
  source: string;
  cueType: LearningCouncilAdoptionCueType;
  text: string;
  adoptedState: string;
  reusedLater: boolean;
  downrankedOrFailed: boolean;
  linkedArtifactOrReceipt: string;
  notes: string;
};

export type LearningCouncilAdoptionLedgerArtifact = {
  stem: string;
  generatedAt: string;
  status: string;
  userMessage: string;
  sourceArtifact: string;
  entries: LearningCouncilAdoptionLedgerEntry[];
};

export type LearningCouncilRuntimeArtifact = {
  version: number;
  generatedAt: string;
  messageId: string;
  userMessage: string;
  status: string;
  mutableFactWarnings: string[];
  roles: unknown[];
  rescues?: unknown[];
  runPacket?: LearningCouncilRunPacket;
  finalReply: string;
};

export type ParsedLearningCouncilMemoryNote = {
  name: string;
  date: string;
  noteSlug: string;
  generatedAt: string;
  status: string;
  userMessage: string;
  mutableFactWarnings: number;
  failedRolesSummary: string;
  finalReplySnapshot: string;
  keeperLines: string[];
  discardLines: string[];
  lobsterImprovementLines: string[];
  rehearsalTriggerLines: string[];
  nextEvalCueLines: string[];
};

export type ParsedLearningCouncilAdoptionLedgerFilename = {
  dateStr: string;
  noteSlug: string;
};

export type ParsedLearningCouncilAdoptionLedger = {
  name: string;
  date: string;
  noteSlug: string;
  generatedAt: string;
  status: string;
  userMessage: string;
  sourceArtifact: string;
  entries: LearningCouncilAdoptionLedgerEntry[];
};

export type ParsedLearningCouncilRuntimeArtifact = {
  generatedAt: string;
  generatedDateKey: string;
  messageId: string;
  userMessage: string;
  status: string;
  runPacket?: LearningCouncilRunPacket;
  finalReply: string;
};

export type MarketIntelligenceConfidenceBand = "low" | "medium" | "guarded_high";

export type MarketIntelligenceMaterialChangeFlag = "material" | "no_material_change" | "unclear";

export type MarketIntelligenceHypothesis = {
  id: string;
  label: string;
  stance: "bullish" | "bearish" | "mixed";
  thesis: string;
  keyDrivers: string[];
};

export type MarketIntelligenceChallengeFinding = {
  thesisId: string;
  finding: string;
  severity: "low" | "medium" | "high";
  evidenceNeeded: string;
};

export type MarketIntelligenceSurvivorThesis = {
  thesisId: string;
  label: string;
  whySurvived: string;
};

export type MarketIntelligenceSkillReceipt = {
  skillName: string;
  status:
    | "not_needed"
    | "activated_existing"
    | "installed_and_used"
    | "install_failed"
    | "denied"
    | "use_failed";
  reason: string;
  installId?: string;
  message?: string;
  warnings?: string[];
};

export type MarketIntelligenceRoutingStage = {
  model: string;
  ran: boolean;
  skippedReason?: string;
  degraded?: boolean;
};

export type MarketIntelligenceRuntimeArtifact = {
  version: 1;
  generatedAt: string;
  messageId: string;
  userMessage: string;
  topicKey: string;
  fingerprint: string;
  materialChangeFlag: MarketIntelligenceMaterialChangeFlag;
  materialChangeReasons: string[];
  noMaterialChange: boolean;
  confidenceBand: MarketIntelligenceConfidenceBand;
  anchor: {
    lineStatus?: CurrentResearchLineStatus;
    currentFocus?: string;
    topDecision?: string;
    currentSessionSummary?: string;
    nextStep?: string;
    researchGuardrail?: string;
  };
  sourceContext: {
    sourceRefs: string[];
    sourceDigests: string[];
    skillReceipt: MarketIntelligenceSkillReceipt;
  };
  routing: {
    scout: MarketIntelligenceRoutingStage;
    synthesizer: MarketIntelligenceRoutingStage;
    challenger: MarketIntelligenceRoutingStage;
    arbiter: MarketIntelligenceRoutingStage;
    distiller: {
      mode: "deterministic";
    };
  };
  hypothesisSet: MarketIntelligenceHypothesis[];
  evidenceGaps: string[];
  challengeFindings: MarketIntelligenceChallengeFinding[];
  survivorTheses: MarketIntelligenceSurvivorThesis[];
  followUpCandidates: string[];
  doNotContinueReason?: string;
  comparedAgainst?: {
    generatedAt: string;
    artifactPath: string;
    fingerprint: string;
    fingerprintMatched: boolean;
  };
  distillation: {
    retainedResidueLines: string[];
    downrankedLines: string[];
    operatorSummaryLines: string[];
    memoryNotePath: string;
  };
  finalReply: string;
};

export type ParsedMarketIntelligenceRuntimeArtifact = {
  generatedAt: string;
  generatedDateKey: string;
  messageId: string;
  userMessage: string;
  topicKey: string;
  fingerprint: string;
  materialChangeFlag: MarketIntelligenceMaterialChangeFlag;
  noMaterialChange: boolean;
  confidenceBand: MarketIntelligenceConfidenceBand;
  sourceRefs: string[];
  sourceDigests: string[];
  skillReceipt: MarketIntelligenceSkillReceipt;
  hypothesisSet: MarketIntelligenceHypothesis[];
  evidenceGaps: string[];
  challengeFindings: MarketIntelligenceChallengeFinding[];
  survivorTheses: MarketIntelligenceSurvivorThesis[];
  followUpCandidates: string[];
  doNotContinueReason?: string;
  comparedAgainstArtifactPath?: string;
  retainedResidueLines: string[];
  memoryNotePath: string;
  finalReply: string;
};

export type ParsedCorrectionNoteFilename = {
  dateStr: string;
  issueKey: string;
  timeSlug: string;
};

export type CorrectionNoteArtifact = {
  dateStr: string;
  timeStr: string;
  sessionKey: string;
  sessionId: string;
  issueKey: string;
  memoryTier: string;
  priorClaimOrBehavior: string;
  foundationTemplate: string;
  whatWasWrong: string;
  evidenceOrUserObservedFailure: string;
  replacementRule: string;
  confidenceDowngrade: string;
  repeatedIssueSignal: string;
  sessionTraceLines: string[];
};

export type ParsedCorrectionNoteArtifact = {
  date: string;
  time: string;
  sessionKey: string;
  sessionId: string;
  issueKey: string;
  memoryTier: string;
  priorClaimOrBehavior: string;
  foundationTemplate: string;
  whatWasWrong: string;
  evidenceOrUserObservedFailure: string;
  replacementRule: string;
  confidenceDowngrade: string;
  repeatedIssueSignal: string;
  sessionTraceLines: string[];
};

export type RepairTicketArtifact = {
  titleValue: string;
  category: string;
  issueKey: string;
  foundationTemplate: string;
  occurrences: number;
  lastSeen: string;
  problem: string;
  evidenceLines: string[];
  impactLine: string;
  suggestedScopeLine: string;
  extraMetadataLines?: string[];
  generatedAt?: string;
};

export type ParsedRepairTicketArtifact = {
  titleValue: string;
  category: string;
  issueKey: string;
  foundationTemplate: string;
  occurrences: number;
  lastSeen: string;
  lastSeenDateKey: string;
  problem: string;
  evidenceLines: string[];
  impactLine: string;
  suggestedScopeLine: string;
};

export type ParsedWatchtowerAnomalyRecord = {
  category: string;
  severity: string;
  source: string;
  problem: string;
  foundationTemplate: string;
  occurrenceCount: number;
  lastSeenAt: string;
  lastSeenDateKey: string;
};

export type CodexEscalationArtifact = {
  titleValue: string;
  category: string;
  issueKey: string;
  source: string;
  severity: string;
  foundationTemplate: string;
  occurrences: number;
  lastSeen: string;
  repairTicketPath: string;
  anomalyRecordPath?: string;
  problem: string;
  evidenceLines: string[];
  impactLine: string;
  suggestedScopeLine: string;
  generatedAt: string;
};

export type ParsedCodexEscalationArtifact = {
  titleValue: string;
  category: string;
  issueKey: string;
  source: string;
  severity: string;
  foundationTemplate: string;
  occurrences: number;
  lastSeen: string;
  lastSeenDateKey: string;
  repairTicketPath: string;
  anomalyRecordPath?: string;
  problem: string;
  evidenceLines: string[];
  impactLine: string;
  suggestedScopeLine: string;
  generatedAt: string;
  generatedDateKey: string;
};

export const WATCHTOWER_ARTIFACT_DIRS = {
  anomalies: "bank/watchtower/anomalies",
  repairTickets: "bank/watchtower/repair-tickets",
  codexEscalations: "bank/watchtower/codex-escalations",
} as const;

export function extractIsoDateKey(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const normalized = value.trim();
  return /^\d{4}-\d{2}-\d{2}/u.test(normalized) ? normalized.slice(0, 10) : "";
}

export type WatchtowerArtifactKind = keyof typeof WATCHTOWER_ARTIFACT_DIRS;

export const KNOWLEDGE_ARTIFACT_DIRS = {
  learningCouncils: "bank/knowledge/learning-councils",
  marketIntelligence: "bank/knowledge/market-intelligence",
} as const;

export type KnowledgeArtifactKind = keyof typeof KNOWLEDGE_ARTIFACT_DIRS;

export function formatRecallList(items: readonly string[]): string {
  if (items.length === 0) {
    return "";
  }
  if (items.length === 1) {
    return items[0] ?? "";
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

export function buildLearningRecallFilename(
  weekKey: string,
  noteName: LearningRecallMemoryNote,
): string {
  return `${weekKey}-${noteName}.md`;
}

export function buildFrontierRecallFilename(
  weekKey: string,
  noteName: FrontierRecallMemoryNote,
): string {
  return `${weekKey}-${noteName}.md`;
}

export function buildOperatingWeeklyArtifactFilename(
  weekKey: string,
  noteName: OperatingWeeklyArtifactName,
): string {
  const spec = OPERATING_WEEKLY_ARTIFACT_SPECS.find((entry) => entry.noteName === noteName);
  if (!spec) {
    throw new Error(`Unknown operating weekly artifact: ${noteName}`);
  }
  return `${weekKey}-${spec.noteName}.${spec.extension}`;
}

function escapeRegexFragment(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

export function parseOperatingWeeklyArtifactFilename(
  filename: string,
  noteName?: OperatingWeeklyArtifactName,
): ParsedOperatingWeeklyArtifactFilename | undefined {
  const specs = noteName
    ? OPERATING_WEEKLY_ARTIFACT_SPECS.filter((entry) => entry.noteName === noteName)
    : OPERATING_WEEKLY_ARTIFACT_SPECS;
  for (const spec of specs) {
    const escapedName = escapeRegexFragment(spec.noteName);
    const match = filename.match(
      new RegExp(`^(\\d{4}-W\\d{2})-${escapedName}\\.${spec.extension}$`, "u"),
    );
    if (match) {
      return {
        weekKey: match[1],
        noteName: spec.noteName,
      };
    }
  }
  return undefined;
}

export function isOperatingWeeklyArtifactFilename(
  filename: string,
  noteName: OperatingWeeklyArtifactName,
): boolean {
  return Boolean(parseOperatingWeeklyArtifactFilename(filename, noteName));
}

export function buildMemoryHygieneArtifactRelativePath(
  weekKey: string,
  noteName: MemoryHygieneArtifactName,
): string {
  const spec = MEMORY_HYGIENE_ARTIFACT_SPECS.find((entry) => entry.noteName === noteName);
  if (!spec) {
    throw new Error(`Unknown memory hygiene artifact: ${noteName}`);
  }
  return `${spec.relativeDir}/${weekKey}-${spec.noteName}.${spec.extension}`;
}

export function buildKnowledgeValidationWeeklyArtifactFilename(
  weekKey: string,
  noteName: KnowledgeValidationWeeklyArtifactName = "knowledge-validation-weekly",
): string {
  const spec = KNOWLEDGE_VALIDATION_WEEKLY_ARTIFACT_SPECS.find(
    (entry) => entry.noteName === noteName,
  );
  if (!spec) {
    throw new Error(`Unknown knowledge validation artifact: ${noteName}`);
  }
  return `${weekKey}-${spec.noteName}.${spec.extension}`;
}

export function parseKnowledgeValidationWeeklyArtifactFilename(
  filename: string,
  noteName: KnowledgeValidationWeeklyArtifactName = "knowledge-validation-weekly",
): ParsedKnowledgeValidationWeeklyArtifactFilename | undefined {
  const specs = KNOWLEDGE_VALIDATION_WEEKLY_ARTIFACT_SPECS.filter(
    (entry) => entry.noteName === noteName,
  );
  for (const spec of specs) {
    const escapedName = escapeRegexFragment(spec.noteName);
    const match = filename.match(
      new RegExp(`^(\\d{4}-W\\d{2})-${escapedName}\\.${spec.extension}$`, "u"),
    );
    if (match) {
      return {
        weekKey: match[1],
        noteName: spec.noteName,
      };
    }
  }
  return undefined;
}

export function isKnowledgeValidationWeeklyArtifactFilename(
  filename: string,
  noteName: KnowledgeValidationWeeklyArtifactName = "knowledge-validation-weekly",
): boolean {
  return Boolean(parseKnowledgeValidationWeeklyArtifactFilename(filename, noteName));
}

export function buildKnowledgeValidationNoteFilename(params: {
  dateStr: string;
  noteSlug: string;
}): string {
  return `${params.dateStr}-knowledge-validation-${params.noteSlug}.md`;
}

export function buildLobsterWorkfaceFilename(dateKey: string): string {
  return `${dateKey}-lobster-workface.md`;
}

export type CurrentResearchLineStatus = "active" | "paused" | "superseded" | "ready_to_resume";

export type ParsedCurrentResearchLineArtifact = {
  updatedAt?: string;
  currentFocus: string;
  lineStatus: CurrentResearchLineStatus;
  topDecision: string;
  currentSessionSummary?: string;
  latestReviewMemoState?: string;
  latestFollowUpState?: string;
  nextStep: string;
  researchGuardrail: string;
  memoryStateContract?: string;
  freshness?: string;
  primaryAnchor?: string;
  anchorDate?: string;
  drillDownOnlyBefore?: string;
  currentSession?: {
    source?: string;
    sessionId?: string;
    intake?: string;
  };
};

function normalizeArtifactContent(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/^<!-- operating-loop-write-guard: .*? -->\n?/u, "");
}

function readSimpleKeyLine(content: string, key: string): string | undefined {
  const escapedKey = escapeRegexFragment(key);
  const match = content.match(new RegExp(`^(?:-\\s+)?${escapedKey}:\\s*(.+)$`, "mu"));
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function normalizeCurrentResearchLineStatus(params: {
  rawStatus?: string;
  currentSessionSummary?: string;
}): CurrentResearchLineStatus | undefined {
  const normalized = params.rawStatus?.trim().toLowerCase();
  if (!normalized) {
    return params.currentSessionSummary && params.currentSessionSummary !== "none"
      ? "active"
      : "ready_to_resume";
  }
  if (
    normalized === "active" ||
    normalized === "paused" ||
    normalized === "superseded" ||
    normalized === "ready_to_resume"
  ) {
    return normalized;
  }
  return undefined;
}

function readFirstSectionBullet(content: string, heading: string): string | undefined {
  const escapedHeading = escapeRegexFragment(heading);
  const sectionMatch = content.match(
    new RegExp(`^## ${escapedHeading}\\n([\\s\\S]*?)(?=\\n## |$)`, "mu"),
  );
  if (!sectionMatch?.[1]) {
    return undefined;
  }
  const bulletMatch = sectionMatch[1].match(/^- (.+)$/mu);
  const value = bulletMatch?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function parseCurrentResearchLineArtifact(
  content: string,
): ParsedCurrentResearchLineArtifact | undefined {
  const normalized = normalizeArtifactContent(content);
  if (!normalized.startsWith("# Current Research Line")) {
    return undefined;
  }

  const currentFocus = readSimpleKeyLine(normalized, "current_focus");
  const currentSessionSummary = readSimpleKeyLine(normalized, "current_session_summary");
  const lineStatus = normalizeCurrentResearchLineStatus({
    rawStatus: readSimpleKeyLine(normalized, "line_status"),
    currentSessionSummary,
  });
  const topDecision = readSimpleKeyLine(normalized, "top_decision");
  const nextStep =
    readSimpleKeyLine(normalized, "next_step") ?? readFirstSectionBullet(normalized, "Next Step");
  const researchGuardrail =
    readSimpleKeyLine(normalized, "research_guardrail") ??
    readSimpleKeyLine(normalized, "guardrail") ??
    readFirstSectionBullet(normalized, "Guardrails");

  if (!currentFocus || !lineStatus || !topDecision || !nextStep || !researchGuardrail) {
    return undefined;
  }

  return {
    updatedAt: readSimpleKeyLine(normalized, "updated_at"),
    currentFocus,
    lineStatus,
    topDecision,
    currentSessionSummary,
    latestReviewMemoState:
      readSimpleKeyLine(normalized, "latest_review_memo_state") ??
      readSimpleKeyLine(normalized, "review_memo_status"),
    latestFollowUpState:
      readSimpleKeyLine(normalized, "latest_follow_up_state") ??
      readSimpleKeyLine(normalized, "follow_up_tracker_status"),
    nextStep,
    researchGuardrail,
    memoryStateContract: readSimpleKeyLine(normalized, "memory_state_contract"),
    freshness: readSimpleKeyLine(normalized, "freshness"),
    primaryAnchor: readSimpleKeyLine(normalized, "primary_anchor"),
    anchorDate: readSimpleKeyLine(normalized, "anchor_date"),
    drillDownOnlyBefore: readSimpleKeyLine(normalized, "drill_down_only_before"),
    currentSession: {
      source: readSimpleKeyLine(normalized, "source"),
      sessionId: readSimpleKeyLine(normalized, "session_id"),
      intake: readSimpleKeyLine(normalized, "intake"),
    },
  };
}

function buildIsoTimeSlug(value: string): string {
  const normalized = value.trim();
  const match = normalized.match(/T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/u);
  if (!match) {
    return "000000-000Z";
  }
  return `${match[1]}${match[2]}${match[3]}-${match[4]}Z`;
}

function sanitizeWorkReceiptSlug(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildFeishuWorkReceiptFilename(params: {
  handledAt: string;
  surface: string;
  messageId: string;
}): string {
  const dateStr = extractIsoDateKey(params.handledAt) || "unknown-date";
  const timeSlug = buildIsoTimeSlug(params.handledAt);
  const noteSlug =
    sanitizeWorkReceiptSlug(`${params.surface}-${params.messageId}`) || "work-receipt";
  return `${dateStr}-feishu-work-receipt-${timeSlug}-${noteSlug}.md`;
}

export function parseFeishuWorkReceiptFilename(
  filename: string,
): ParsedFeishuWorkReceiptFilename | undefined {
  const match = filename.match(FEISHU_WORK_RECEIPT_FILENAME_RE);
  if (!match) {
    return undefined;
  }
  return {
    dateStr: match[1],
    timeSlug: match[2],
    noteSlug: match[3],
  };
}

export function isFeishuWorkReceiptFilename(filename: string): boolean {
  return Boolean(parseFeishuWorkReceiptFilename(filename));
}

export function buildFeishuFinanceDoctrineCalibrationFilename(params: {
  reviewDate: string;
  consumer: string;
  linkedReceipt: string;
}): string {
  const dateStr = extractIsoDateKey(params.reviewDate) || "unknown-date";
  const timeSlug = buildIsoTimeSlug(params.reviewDate);
  const noteSlug =
    sanitizeWorkReceiptSlug(`${params.consumer}-${params.linkedReceipt}`) ||
    "finance-doctrine-calibration";
  return `${dateStr}-feishu-finance-doctrine-calibration-${timeSlug}-${noteSlug}.md`;
}

export function parseFeishuFinanceDoctrineCalibrationFilename(
  filename: string,
): ParsedFeishuWorkReceiptFilename | undefined {
  const match = filename.match(FEISHU_FINANCE_DOCTRINE_CALIBRATION_FILENAME_RE);
  if (!match) {
    return undefined;
  }
  return {
    dateStr: match[1],
    timeSlug: match[2],
    noteSlug: match[3],
  };
}

export function isFeishuFinanceDoctrineCalibrationFilename(filename: string): boolean {
  return Boolean(parseFeishuFinanceDoctrineCalibrationFilename(filename));
}

export function buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateStr: string): string {
  return `${dateStr}-feishu-finance-doctrine-promotion-candidates.md`;
}

export function parseFeishuFinanceDoctrinePromotionCandidatesFilename(
  filename: string,
): { dateStr: string } | undefined {
  const match = filename.match(FEISHU_FINANCE_DOCTRINE_PROMOTION_CANDIDATES_FILENAME_RE);
  if (!match) {
    return undefined;
  }
  return {
    dateStr: match[1],
  };
}

export function isFeishuFinanceDoctrinePromotionCandidatesFilename(filename: string): boolean {
  return Boolean(parseFeishuFinanceDoctrinePromotionCandidatesFilename(filename));
}

export function buildFeishuFinanceDoctrinePromotionReviewFilename(dateStr: string): string {
  return `${dateStr}-feishu-finance-doctrine-promotion-review.md`;
}

export function parseFeishuFinanceDoctrinePromotionReviewFilename(
  filename: string,
): { dateStr: string } | undefined {
  const match = filename.match(FEISHU_FINANCE_DOCTRINE_PROMOTION_REVIEW_FILENAME_RE);
  if (!match) {
    return undefined;
  }
  return {
    dateStr: match[1],
  };
}

export function isFeishuFinanceDoctrinePromotionReviewFilename(filename: string): boolean {
  return Boolean(parseFeishuFinanceDoctrinePromotionReviewFilename(filename));
}

export function buildFeishuFinanceDoctrinePromotionDecisionsFilename(dateStr: string): string {
  return `${dateStr}-feishu-finance-doctrine-promotion-decisions.md`;
}

export function parseFeishuFinanceDoctrinePromotionDecisionsFilename(
  filename: string,
): { dateStr: string } | undefined {
  const match = filename.match(FEISHU_FINANCE_DOCTRINE_PROMOTION_DECISIONS_FILENAME_RE);
  if (!match) {
    return undefined;
  }
  return {
    dateStr: match[1],
  };
}

export function isFeishuFinanceDoctrinePromotionDecisionsFilename(filename: string): boolean {
  return Boolean(parseFeishuFinanceDoctrinePromotionDecisionsFilename(filename));
}

export function buildFeishuFinanceDoctrinePromotionProposalsFilename(dateStr: string): string {
  return `${dateStr}-feishu-finance-doctrine-promotion-proposals.md`;
}

export function parseFeishuFinanceDoctrinePromotionProposalsFilename(
  filename: string,
): { dateStr: string } | undefined {
  const match = filename.match(FEISHU_FINANCE_DOCTRINE_PROMOTION_PROPOSALS_FILENAME_RE);
  if (!match) {
    return undefined;
  }
  return {
    dateStr: match[1],
  };
}

export function isFeishuFinanceDoctrinePromotionProposalsFilename(filename: string): boolean {
  return Boolean(parseFeishuFinanceDoctrinePromotionProposalsFilename(filename));
}

export function buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateStr: string): string {
  return `${dateStr}-feishu-finance-doctrine-teacher-feedback.md`;
}

export function parseFeishuFinanceDoctrineTeacherFeedbackFilename(
  filename: string,
): { dateStr: string } | undefined {
  const match = filename.match(FEISHU_FINANCE_DOCTRINE_TEACHER_FEEDBACK_FILENAME_RE);
  if (!match) {
    return undefined;
  }
  return {
    dateStr: match[1],
  };
}

export function isFeishuFinanceDoctrineTeacherFeedbackFilename(filename: string): boolean {
  return Boolean(parseFeishuFinanceDoctrineTeacherFeedbackFilename(filename));
}

export function buildFeishuFinanceDoctrineTeacherReviewFilename(dateStr: string): string {
  return `${dateStr}-feishu-finance-doctrine-teacher-review.md`;
}

export function parseFeishuFinanceDoctrineTeacherReviewFilename(
  filename: string,
): { dateStr: string } | undefined {
  const match = filename.match(FEISHU_FINANCE_DOCTRINE_TEACHER_REVIEW_FILENAME_RE);
  if (!match) {
    return undefined;
  }
  return {
    dateStr: match[1],
  };
}

export function isFeishuFinanceDoctrineTeacherReviewFilename(filename: string): boolean {
  return Boolean(parseFeishuFinanceDoctrineTeacherReviewFilename(filename));
}

export function buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename(
  dateStr: string,
): string {
  return `${dateStr}-feishu-finance-doctrine-teacher-elevation-handoffs.md`;
}

export function buildFeishuFinanceDoctrineTeacherCandidateInputsFilename(dateStr: string): string {
  return `${dateStr}-feishu-finance-doctrine-teacher-candidate-inputs.md`;
}

export function buildFeishuFinanceDoctrineTeacherCandidateInputReviewFilename(
  dateStr: string,
): string {
  return `${dateStr}-feishu-finance-doctrine-teacher-candidate-input-review.md`;
}

export function buildFeishuFinanceDoctrineTeacherCandidateInputReconciliationFilename(
  dateStr: string,
): string {
  return `${dateStr}-feishu-finance-doctrine-teacher-candidate-input-reconciliation.md`;
}

export function buildFinanceFrameworkCoreContractPath(): string {
  return "memory/local-memory/finance-framework-core-contract.md";
}

export function buildFinanceLearningCapabilityCandidatesPath(): string {
  return "memory/local-memory/finance-learning-capability-candidates.md";
}

export function buildFinanceArticleSourceRegistryPath(): string {
  return "memory/local-memory/finance-article-source-registry.md";
}

export function parseFeishuFinanceDoctrineTeacherElevationHandoffsFilename(
  filename: string,
): { dateStr: string } | undefined {
  const match = filename.match(FEISHU_FINANCE_DOCTRINE_TEACHER_ELEVATION_HANDOFFS_FILENAME_RE);
  if (!match) {
    return undefined;
  }
  return {
    dateStr: match[1],
  };
}

export function isFeishuFinanceDoctrineTeacherElevationHandoffsFilename(filename: string): boolean {
  return Boolean(parseFeishuFinanceDoctrineTeacherElevationHandoffsFilename(filename));
}

export function buildFeishuFinanceDoctrineEditHandoffsFilename(dateStr: string): string {
  return `${dateStr}-feishu-finance-doctrine-edit-handoffs.md`;
}

export function parseFeishuFinanceDoctrineEditHandoffsFilename(
  filename: string,
): { dateStr: string } | undefined {
  const match = filename.match(FEISHU_FINANCE_DOCTRINE_EDIT_HANDOFFS_FILENAME_RE);
  if (!match) {
    return undefined;
  }
  return {
    dateStr: match[1],
  };
}

export function isFeishuFinanceDoctrineEditHandoffsFilename(filename: string): boolean {
  return Boolean(parseFeishuFinanceDoctrineEditHandoffsFilename(filename));
}

export function parseLobsterWorkfaceFilename(
  filename: string,
): ParsedLobsterWorkfaceFilename | undefined {
  const match = filename.match(LOBSTER_WORKFACE_FILENAME_RE);
  if (!match) {
    return undefined;
  }
  return {
    dateKey: match[1],
  };
}

export function isLobsterWorkfaceFilename(filename: string): boolean {
  return Boolean(parseLobsterWorkfaceFilename(filename));
}

export function parseKnowledgeValidationNoteFilename(
  filename: string,
): ParsedKnowledgeValidationNoteFilename | undefined {
  const match = filename.match(KNOWLEDGE_VALIDATION_NOTE_FILENAME_RE);
  if (!match) {
    return undefined;
  }
  return {
    dateStr: match[1],
    noteSlug: match[2],
  };
}

export function isKnowledgeValidationNoteFilename(filename: string): boolean {
  return Boolean(parseKnowledgeValidationNoteFilename(filename));
}

export function parseLearningReviewNoteFilename(
  filename: string,
): ParsedLearningReviewNoteFilename | undefined {
  const match = filename.match(LEARNING_REVIEW_NOTE_FILENAME_RE);
  if (!match) {
    return undefined;
  }
  return {
    dateStr: match[1],
    noteSlug: match[2],
  };
}

export function isLearningReviewNoteFilename(filename: string): boolean {
  return Boolean(parseLearningReviewNoteFilename(filename));
}

export function buildLearningCouncilMemoryNoteFilename(params: {
  dateStr: string;
  noteSlug: string;
}): string {
  return `${params.dateStr}-learning-council-${params.noteSlug}.md`;
}

export function buildLearningCouncilAdoptionLedgerFilename(params: {
  dateStr: string;
  noteSlug: string;
}): string {
  return `${params.dateStr}-learning-council-adoption-${params.noteSlug}.md`;
}

export function buildMarketIntelligenceMemoryNoteFilename(params: {
  dateStr: string;
  noteSlug: string;
}): string {
  return `${params.dateStr}-market-intelligence-${params.noteSlug}.md`;
}

export function buildKnowledgeArtifactDir(kind: KnowledgeArtifactKind): string {
  return KNOWLEDGE_ARTIFACT_DIRS[kind];
}

export function buildLearningCouncilArtifactJsonRelativePath(stem: string): string {
  return `${buildKnowledgeArtifactDir("learningCouncils")}/${stem}.json`;
}

export function buildLearningCouncilArtifactMarkdownRelativePath(stem: string): string {
  return `${buildKnowledgeArtifactDir("learningCouncils")}/${stem}.md`;
}

export function buildMarketIntelligenceArtifactJsonRelativePath(stem: string): string {
  return `${buildKnowledgeArtifactDir("marketIntelligence")}/${stem}.json`;
}

export function buildMarketIntelligenceArtifactMarkdownRelativePath(stem: string): string {
  return `${buildKnowledgeArtifactDir("marketIntelligence")}/${stem}.md`;
}

export function parseLearningCouncilMemoryNoteFilename(
  filename: string,
): ParsedLearningCouncilMemoryNoteFilename | undefined {
  const match = filename.match(LEARNING_COUNCIL_NOTE_FILENAME_RE);
  if (!match) {
    return undefined;
  }
  return {
    dateStr: match[1],
    noteSlug: match[2],
  };
}

export function isLearningCouncilMemoryNoteFilename(filename: string): boolean {
  return Boolean(parseLearningCouncilMemoryNoteFilename(filename));
}

export function parseLearningCouncilAdoptionLedgerFilename(
  filename: string,
): ParsedLearningCouncilAdoptionLedgerFilename | undefined {
  const match = filename.match(LEARNING_COUNCIL_ADOPTION_LEDGER_FILENAME_RE);
  if (!match) {
    return undefined;
  }
  return {
    dateStr: match[1],
    noteSlug: match[2],
  };
}

export function isLearningCouncilAdoptionLedgerFilename(filename: string): boolean {
  return Boolean(parseLearningCouncilAdoptionLedgerFilename(filename));
}

export function buildCorrectionNoteFilename(params: {
  dateStr: string;
  issueKey: string;
  timeSlug: string;
}): string {
  return `${params.dateStr}-correction-note-${params.issueKey}-${params.timeSlug}.md`;
}

export function parseCorrectionNoteFilename(
  filename: string,
): ParsedCorrectionNoteFilename | undefined {
  const match = filename.match(CORRECTION_NOTE_FILENAME_RE);
  if (!match) {
    return undefined;
  }
  return {
    dateStr: match[1],
    issueKey: match[2],
    timeSlug: match[3],
  };
}

export function isCorrectionNoteFilename(filename: string): boolean {
  return Boolean(parseCorrectionNoteFilename(filename));
}

export function buildWatchtowerArtifactDir(kind: WatchtowerArtifactKind): string {
  return WATCHTOWER_ARTIFACT_DIRS[kind];
}

export function buildWatchtowerAnomalyRecordRelativePath(params: {
  category: string;
  fingerprint: string;
}): string {
  return `${buildWatchtowerArtifactDir("anomalies")}/${params.category}-${params.fingerprint}.json`;
}

export function buildWatchtowerAnomalyRepairTicketRelativePath(params: {
  category: string;
  fingerprint: string;
}): string {
  return `${buildWatchtowerArtifactDir("repairTickets")}/${params.category}-${params.fingerprint}.md`;
}

export function buildCorrectionLoopRepairTicketRelativePath(issueKey: string): string {
  return `${buildWatchtowerArtifactDir("repairTickets")}/${issueKey}.md`;
}

export function buildWatchtowerCodexEscalationRelativePath(params: {
  category: string;
  issueKey: string;
}): string {
  return `${buildWatchtowerArtifactDir("codexEscalations")}/${params.category}-${params.issueKey}.md`;
}

export function renderRepairTicketArtifact(params: RepairTicketArtifact): string {
  return [
    `# Repair Ticket Candidate: ${params.titleValue}`,
    "",
    `- **Category**: ${params.category}`,
    `- **Issue Key**: ${params.issueKey}`,
    `- **Foundation Template**: ${params.foundationTemplate}`,
    `- **Occurrences**: ${params.occurrences}`,
    `- **Last Seen**: ${params.lastSeen}`,
    ...(params.extraMetadataLines ?? []),
    "",
    "## Problem",
    `- ${params.problem}`,
    "",
    "## Evidence",
    ...params.evidenceLines.map((line) => `- ${line}`),
    "",
    "## Impact",
    `- ${params.impactLine}`,
    "",
    "## Suggested Scope",
    `- ${params.suggestedScopeLine}`,
    ...(params.generatedAt ? ["", "## Generated At", `- ${params.generatedAt}`] : []),
    "",
  ].join("\n");
}

export function renderCodexEscalationArtifact(params: CodexEscalationArtifact): string {
  return [
    `# Codex Escalation Packet: ${params.titleValue}`,
    "",
    `- **Category**: ${params.category}`,
    `- **Issue Key**: ${params.issueKey}`,
    `- **Source**: ${params.source}`,
    `- **Severity**: ${params.severity}`,
    `- **Foundation Template**: ${params.foundationTemplate}`,
    `- **Occurrences**: ${params.occurrences}`,
    `- **Last Seen**: ${params.lastSeen}`,
    `- **Repair Ticket Path**: ${params.repairTicketPath}`,
    `- **Anomaly Record Path**: ${params.anomalyRecordPath ?? "none"}`,
    "",
    "## Problem",
    `- ${params.problem}`,
    "",
    "## Evidence",
    ...params.evidenceLines.map((line) => `- ${line}`),
    "",
    "## Impact",
    `- ${params.impactLine}`,
    "",
    "## Suggested Scope",
    `- ${params.suggestedScopeLine}`,
    "",
    "## Invocation Boundary",
    "- Wake Codex only through an explicit operator-configured command.",
    "- Default behavior is packet-only; no external wake happens when the command is unset.",
    "",
    "## Generated At",
    `- ${params.generatedAt}`,
    "",
  ].join("\n");
}

export function parseRepairTicketArtifact(content: string): ParsedRepairTicketArtifact | undefined {
  const titleValue = content.match(/^# Repair Ticket Candidate: ([^\n]+)/m)?.[1]?.trim();
  const category = content.match(/- \*\*Category\*\*: ([^\n]+)/)?.[1]?.trim();
  const issueKey = content.match(/- \*\*Issue Key\*\*: ([^\n]+)/)?.[1]?.trim();
  const foundationTemplate = content.match(/- \*\*Foundation Template\*\*: ([^\n]+)/)?.[1]?.trim();
  const occurrencesRaw = content.match(/- \*\*Occurrences\*\*: ([^\n]+)/)?.[1]?.trim();
  const lastSeen = content.match(/- \*\*Last Seen\*\*: ([^\n]+)/)?.[1]?.trim();
  const problem = content.match(/## Problem\n- ([^\n]+)/)?.[1]?.trim();
  const evidenceBlock = content.match(/## Evidence\n([\s\S]*?)\n## Impact/u)?.[1] ?? "";
  const impactLine = content.match(/## Impact\n- ([^\n]+)/)?.[1]?.trim();
  const suggestedScopeLine = content.match(/## Suggested Scope\n- ([^\n]+)/)?.[1]?.trim();
  const occurrences = Number(occurrencesRaw ?? "NaN");
  const lastSeenDateKey = extractIsoDateKey(lastSeen);
  if (
    !titleValue ||
    !category ||
    !issueKey ||
    !foundationTemplate ||
    !Number.isFinite(occurrences) ||
    !lastSeen ||
    !lastSeenDateKey ||
    !problem ||
    !impactLine ||
    !suggestedScopeLine
  ) {
    return undefined;
  }
  const evidenceLines = evidenceBlock
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());

  return {
    titleValue,
    category,
    issueKey,
    foundationTemplate,
    occurrences,
    lastSeen,
    lastSeenDateKey,
    problem,
    evidenceLines,
    impactLine,
    suggestedScopeLine,
  };
}

export function parseCodexEscalationArtifact(
  content: string,
): ParsedCodexEscalationArtifact | undefined {
  const titleValue = content.match(/^# Codex Escalation Packet: ([^\n]+)/m)?.[1]?.trim();
  const category = content.match(/- \*\*Category\*\*: ([^\n]+)/)?.[1]?.trim();
  const issueKey = content.match(/- \*\*Issue Key\*\*: ([^\n]+)/)?.[1]?.trim();
  const source = content.match(/- \*\*Source\*\*: ([^\n]+)/)?.[1]?.trim();
  const severity = content.match(/- \*\*Severity\*\*: ([^\n]+)/)?.[1]?.trim();
  const foundationTemplate = content.match(/- \*\*Foundation Template\*\*: ([^\n]+)/)?.[1]?.trim();
  const occurrencesRaw = content.match(/- \*\*Occurrences\*\*: ([^\n]+)/)?.[1]?.trim();
  const lastSeen = content.match(/- \*\*Last Seen\*\*: ([^\n]+)/)?.[1]?.trim();
  const repairTicketPath = content.match(/- \*\*Repair Ticket Path\*\*: ([^\n]+)/)?.[1]?.trim();
  const anomalyRecordPathRaw = content
    .match(/- \*\*Anomaly Record Path\*\*: ([^\n]+)/)?.[1]
    ?.trim();
  const problem = content.match(/## Problem\n- ([^\n]+)/)?.[1]?.trim();
  const evidenceBlock = content.match(/## Evidence\n([\s\S]*?)\n## Impact/u)?.[1] ?? "";
  const impactLine = content.match(/## Impact\n- ([^\n]+)/)?.[1]?.trim();
  const suggestedScopeLine = content.match(/## Suggested Scope\n- ([^\n]+)/)?.[1]?.trim();
  const generatedAt = content.match(/## Generated At\n- ([^\n]+)/)?.[1]?.trim();
  const occurrences = Number(occurrencesRaw ?? "NaN");
  const lastSeenDateKey = extractIsoDateKey(lastSeen);
  const generatedDateKey = extractIsoDateKey(generatedAt);
  if (
    !titleValue ||
    !category ||
    !issueKey ||
    !source ||
    !severity ||
    !foundationTemplate ||
    !Number.isFinite(occurrences) ||
    !lastSeen ||
    !lastSeenDateKey ||
    !repairTicketPath ||
    !problem ||
    !impactLine ||
    !suggestedScopeLine ||
    !generatedAt ||
    !generatedDateKey
  ) {
    return undefined;
  }
  const evidenceLines = evidenceBlock
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());

  return {
    titleValue,
    category,
    issueKey,
    source,
    severity,
    foundationTemplate,
    occurrences,
    lastSeen,
    lastSeenDateKey,
    repairTicketPath,
    anomalyRecordPath:
      anomalyRecordPathRaw && anomalyRecordPathRaw !== "none" ? anomalyRecordPathRaw : undefined,
    problem,
    evidenceLines,
    impactLine,
    suggestedScopeLine,
    generatedAt,
    generatedDateKey,
  };
}

export function parseWatchtowerAnomalyRecord(
  content: string,
): ParsedWatchtowerAnomalyRecord | undefined {
  let parsed: {
    category?: unknown;
    severity?: unknown;
    source?: unknown;
    problem?: unknown;
    foundationTemplate?: unknown;
    occurrenceCount?: unknown;
    lastSeenAt?: unknown;
  };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    return undefined;
  }

  const lastSeenAt =
    typeof parsed.lastSeenAt === "string" && parsed.lastSeenAt.trim().length > 0
      ? parsed.lastSeenAt.trim()
      : "";
  const lastSeenDateKey = extractIsoDateKey(lastSeenAt);
  const occurrenceCount =
    typeof parsed.occurrenceCount === "number" && Number.isFinite(parsed.occurrenceCount)
      ? parsed.occurrenceCount
      : 1;

  return {
    category:
      typeof parsed.category === "string" && parsed.category.trim().length > 0
        ? parsed.category.trim()
        : "unknown",
    severity:
      typeof parsed.severity === "string" && parsed.severity.trim().length > 0
        ? parsed.severity.trim()
        : "unknown",
    source:
      typeof parsed.source === "string" && parsed.source.trim().length > 0
        ? parsed.source.trim()
        : "unknown",
    problem:
      typeof parsed.problem === "string" && parsed.problem.trim().length > 0
        ? parsed.problem.trim()
        : "No anomaly problem captured.",
    foundationTemplate:
      typeof parsed.foundationTemplate === "string" && parsed.foundationTemplate.trim().length > 0
        ? parsed.foundationTemplate.trim()
        : "general",
    occurrenceCount,
    lastSeenAt,
    lastSeenDateKey,
  };
}

function parseValidationNumber(value: string, fallback: number): number {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseKnowledgeValidationNote(params: {
  filename: string;
  content: string;
}): ParsedKnowledgeValidationNote | undefined {
  const parsedName = parseKnowledgeValidationNoteFilename(params.filename);
  if (!parsedName) {
    return undefined;
  }
  const extract = (pattern: RegExp, fallback: string) =>
    params.content.match(pattern)?.[1]?.trim() || fallback;
  const validationType = extract(/- validation_type:\s*([^\n]+)/, "daily_real_task");
  if (validationType !== "benchmark" && validationType !== "daily_real_task") {
    return undefined;
  }

  return {
    name: params.filename,
    date: parsedName.dateStr,
    noteSlug: parsedName.noteSlug,
    validationType,
    capabilityFamily: extract(/- capability_family:\s*([^\n]+)/, "finance"),
    benchmarkFamily: extract(/- benchmark_family:\s*([^\n]+)/, "none"),
    taskFamily: extract(/- task_family:\s*([^\n]+)/, "none"),
    domain: extract(/- domain:\s*([^\n]+)/, "unknown"),
    confidenceMode: extract(/- confidence_mode:\s*([^\n]+)/, "low_fidelity"),
    factualQuality: parseValidationNumber(extract(/- factual_quality:\s*([^\n]+)/, "0"), 0),
    reasoningQuality: parseValidationNumber(extract(/- reasoning_quality:\s*([^\n]+)/, "0"), 0),
    hallucinationRisk: extract(/- hallucination_risk:\s*([^\n]+)/, "unknown"),
    verdict: extract(/- verdict:\s*([^\n]+)/, "mixed"),
    correctionCandidate: extract(/## Correction Candidate\n- ([^\n]+)/, "none"),
    repairTicketCandidate: extract(/## Repair Ticket Candidate\n- ([^\n]+)/, "none"),
  };
}

export function renderFrontierResearchCardArtifact(
  artifact: FrontierResearchCardArtifact,
  params: { dateStr: string; timeStr: string },
): string {
  return [
    `# Frontier Research Card: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- **Session Key**: ${artifact.sessionKey}`,
    `- **Session ID**: ${artifact.sessionId}`,
    "",
    "## Research Card",
    `- title: ${artifact.title}`,
    `- material_type: ${artifact.materialType}`,
    `- method_family: ${artifact.methodFamily}`,
    `- problem_statement: ${artifact.problemStatement}`,
    `- method_summary: ${artifact.methodSummary}`,
    `- claimed_contribution: ${artifact.claimedContribution}`,
    `- data_setup: ${artifact.dataSetup}`,
    `- evaluation_protocol: ${artifact.evaluationProtocol}`,
    `- key_results: ${artifact.keyResults}`,
    `- possible_leakage_points: ${artifact.possibleLeakagePoints}`,
    `- overfitting_risks: ${artifact.overfittingRisks}`,
    `- replication_cost: ${artifact.replicationCost}`,
    `- relevance_to_lobster: ${artifact.relevanceToLobster}`,
    `- adoptable_ideas: ${artifact.adoptableIdeas}`,
    `- do_not_copy_blindly: ${artifact.doNotCopyBlindly}`,
    `- foundation_template: ${artifact.foundationTemplate}`,
    `- verdict: ${artifact.verdict}`,
    "",
    "## Session Trace",
    ...artifact.sessionTraceLines.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

export function parseFrontierResearchCardArtifact(params: {
  filename: string;
  content: string;
}): ParsedFrontierResearchCardArtifact | undefined {
  const parsedName = params.filename.match(FRONTIER_RESEARCH_CARD_FILENAME_RE);
  if (!parsedName) {
    return undefined;
  }
  const extract = (pattern: RegExp, fallback: string) =>
    params.content.match(pattern)?.[1]?.trim() || fallback;
  return {
    name: params.filename,
    date: parsedName[1],
    sessionKey: extract(/- \*\*Session Key\*\*: ([^\n]+)/, "unknown"),
    sessionId: extract(/- \*\*Session ID\*\*: ([^\n]+)/, "unknown"),
    title: extract(/^- title:\s*(.+)$/m, "Untitled research card"),
    materialType: extract(/^- material_type:\s*(.+)$/m, "paper"),
    methodFamily: extract(/^- method_family:\s*(.+)$/m, "frontier-method"),
    problemStatement: extract(/^- problem_statement:\s*(.+)$/m, "Method-heavy research session"),
    methodSummary: extract(/^- method_summary:\s*(.+)$/m, "No method summary captured."),
    claimedContribution: extract(
      /^- claimed_contribution:\s*(.+)$/m,
      "No claimed contribution captured.",
    ),
    dataSetup: extract(/^- data_setup:\s*(.+)$/m, "No data setup captured."),
    evaluationProtocol: extract(
      /^- evaluation_protocol:\s*(.+)$/m,
      "No evaluation protocol captured.",
    ),
    keyResults: extract(/^- key_results:\s*(.+)$/m, "No key results captured."),
    possibleLeakagePoints: extract(
      /^- possible_leakage_points:\s*(.+)$/m,
      "No leakage note captured.",
    ),
    overfittingRisks: extract(/^- overfitting_risks:\s*(.+)$/m, "No overfitting note captured."),
    replicationCost: extract(/^- replication_cost:\s*(.+)$/m, "medium"),
    relevanceToLobster: extract(
      /^- relevance_to_lobster:\s*(.+)$/m,
      "No relevance-to-lobster note captured.",
    ),
    adoptableIdeas: extract(/^- adoptable_ideas:\s*(.+)$/m, "No adoptable idea captured."),
    doNotCopyBlindly: extract(
      /^- do_not_copy_blindly:\s*(.+)$/m,
      "Do not promote novelty without leakage, cost, and target-alignment checks.",
    ),
    foundationTemplate: extract(/^- foundation_template:\s*(.+)$/m, "execution-hygiene"),
    verdict: extract(/^- verdict:\s*(.+)$/m, "watch_for_followup"),
    sessionTraceLines: extractSectionBulletLines(params.content, "Session Trace"),
  };
}

export function renderLearningCouncilMemoryNote(
  artifact: LearningCouncilMemoryNoteArtifact,
): string {
  return [
    `# Learning Council Note: ${artifact.stem}`,
    "",
    `- **Generated At**: ${artifact.generatedAt}`,
    `- **Status**: ${artifact.status}`,
    `- **User Message**: ${artifact.userMessage}`,
    `- **Mutable Fact Warnings**: ${artifact.mutableFactWarnings}`,
    `- **Failed Roles**: ${artifact.failedRolesSummary}`,
    "",
    "## Audit Boundary",
    "- This is a bounded learning artifact, not a direct trading instruction or doctrine update.",
    "",
    ...(artifact.runPacket
      ? [
          "## Run Packet",
          `- objective: ${artifact.runPacket.objective}`,
          `- protected_anchors_present: ${artifact.runPacket.protectedAnchorsPresent.length > 0 ? artifact.runPacket.protectedAnchorsPresent.join(", ") : "none"}`,
          `- protected_anchors_missing: ${artifact.runPacket.protectedAnchorsMissing.length > 0 ? artifact.runPacket.protectedAnchorsMissing.join(", ") : "none"}`,
          ...(artifact.runPacket.currentFocus
            ? [`- current_focus: ${artifact.runPacket.currentFocus}`]
            : []),
          ...(artifact.runPacket.topDecision
            ? [`- top_decision: ${artifact.runPacket.topDecision}`]
            : []),
          ...(artifact.runPacket.recallOrder
            ? [`- recall_order: ${artifact.runPacket.recallOrder}`]
            : []),
          ...(artifact.runPacket.latestCarryoverSource
            ? [`- latest_carryover_source: ${artifact.runPacket.latestCarryoverSource}`]
            : []),
          `- local_memory_cards: ${artifact.runPacket.localMemoryCardPaths.length > 0 ? artifact.runPacket.localMemoryCardPaths.join(", ") : "none"}`,
          `- lobster_improvement: ${artifact.runPacket.lobsterImprovementLines.length > 0 ? artifact.runPacket.lobsterImprovementLines.join(" | ") : "none"}`,
          `- current_bracket: ${artifact.runPacket.currentBracketLines.length > 0 ? artifact.runPacket.currentBracketLines.join(" | ") : "none"}`,
          `- ruled_out: ${artifact.runPacket.ruledOutLines.length > 0 ? artifact.runPacket.ruledOutLines.join(" | ") : "none"}`,
          `- highest_info_next_checks: ${artifact.runPacket.highestInfoNextCheckLines.length > 0 ? artifact.runPacket.highestInfoNextCheckLines.join(" | ") : "none"}`,
          `- recovery_read_order: ${artifact.runPacket.recoveryReadOrder.length > 0 ? artifact.runPacket.recoveryReadOrder.join(" -> ") : "none"}`,
          "",
        ]
      : []),
    "## Final Reply Snapshot",
    artifact.finalReplySnapshot,
    "",
    ...(artifact.keeperLines && artifact.keeperLines.length > 0
      ? ["## Distilled Keep", ...artifact.keeperLines.map((line) => `- ${line}`), ""]
      : []),
    ...(artifact.discardLines && artifact.discardLines.length > 0
      ? ["## Distilled Discard", ...artifact.discardLines.map((line) => `- ${line}`), ""]
      : []),
    ...(artifact.runPacket?.lobsterImprovementLines &&
    artifact.runPacket.lobsterImprovementLines.length > 0
      ? [
          "## Lobster Improvement Feedback",
          ...artifact.runPacket.lobsterImprovementLines.map((line) => `- ${line}`),
          "",
        ]
      : []),
    ...(artifact.runPacket?.currentBracketLines && artifact.runPacket.currentBracketLines.length > 0
      ? [
          "## Decision Bracket",
          ...artifact.runPacket.currentBracketLines.map((line) => `- ${line}`),
          "",
        ]
      : []),
    ...(artifact.runPacket?.ruledOutLines && artifact.runPacket.ruledOutLines.length > 0
      ? ["## Ruled Out", ...artifact.runPacket.ruledOutLines.map((line) => `- ${line}`), ""]
      : []),
    ...(artifact.runPacket?.highestInfoNextCheckLines &&
    artifact.runPacket.highestInfoNextCheckLines.length > 0
      ? [
          "## Highest-Information Next Checks",
          ...artifact.runPacket.highestInfoNextCheckLines.map((line) => `- ${line}`),
          "",
        ]
      : []),
    ...(artifact.rehearsalTriggerLines && artifact.rehearsalTriggerLines.length > 0
      ? [
          "## Distilled Rehearsal Triggers",
          ...artifact.rehearsalTriggerLines.map((line) => `- ${line}`),
          "",
        ]
      : []),
    ...(artifact.nextEvalCueLines && artifact.nextEvalCueLines.length > 0
      ? ["## Distilled Next Eval", ...artifact.nextEvalCueLines.map((line) => `- ${line}`), ""]
      : []),
  ].join("\n");
}

export function renderLearningCouncilAdoptionLedger(
  artifact: LearningCouncilAdoptionLedgerArtifact,
): string {
  return [
    `# Learning Council Adoption Ledger: ${artifact.stem}`,
    "",
    `- **Generated At**: ${artifact.generatedAt}`,
    `- **Status**: ${artifact.status}`,
    `- **User Message**: ${artifact.userMessage}`,
    `- **Source Artifact**: ${artifact.sourceArtifact}`,
    "",
    "## Adoption Entries",
    ...(artifact.entries.length > 0
      ? artifact.entries.flatMap((entry, index) => [
          `### Entry ${index + 1}`,
          `- source: ${entry.source}`,
          `- cue_type: ${entry.cueType}`,
          `- text: ${entry.text}`,
          `- adopted_state: ${entry.adoptedState}`,
          `- reused_later: ${entry.reusedLater ? "yes" : "no"}`,
          `- downranked_or_failed: ${entry.downrankedOrFailed ? "yes" : "no"}`,
          `- linked_artifact_or_receipt: ${entry.linkedArtifactOrReceipt}`,
          `- notes: ${entry.notes || "none"}`,
          "",
        ])
      : ["- none", ""]),
  ].join("\n");
}

export function renderCorrectionNoteArtifact(artifact: CorrectionNoteArtifact): string {
  return [
    `# Correction Note: ${artifact.dateStr} ${artifact.timeStr} UTC`,
    "",
    `- **Session Key**: ${artifact.sessionKey}`,
    `- **Session ID**: ${artifact.sessionId}`,
    `- **Issue Key**: ${artifact.issueKey}`,
    `- **Memory Tier**: ${artifact.memoryTier}`,
    "",
    "## Prior Claim Or Behavior",
    `- ${artifact.priorClaimOrBehavior}`,
    "",
    "## Foundation Template",
    `- ${artifact.foundationTemplate}`,
    "",
    "## What Was Wrong",
    `- ${artifact.whatWasWrong}`,
    "",
    "## Evidence Or User-Observed Failure",
    `- ${artifact.evidenceOrUserObservedFailure}`,
    "",
    "## Replacement Rule",
    `- ${artifact.replacementRule}`,
    "",
    "## Confidence Downgrade",
    `- ${artifact.confidenceDowngrade}`,
    "",
    "## Follow-Up",
    `- repeated_issue_signal: ${artifact.repeatedIssueSignal}`,
    "",
    "## Session Trace",
    ...artifact.sessionTraceLines.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

function extractSectionBulletLines(content: string, heading: string): string[] {
  const block =
    content.match(
      new RegExp(`## ${escapeRegexFragment(heading)}\\r?\\n([\\s\\S]*?)(?:\\r?\\n## |$)`, "u"),
    )?.[1] ?? "";
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}

function extractFirstSectionBullet(content: string, heading: string, fallback: string): string {
  return extractSectionBulletLines(content, heading)[0] ?? fallback;
}

export function renderPortfolioAnswerScorecardArtifact(
  artifact: PortfolioAnswerScorecardArtifact,
): string {
  return [
    `# Portfolio Answer Scorecard: ${artifact.weekKey}`,
    "",
    `- **Window**: ${artifact.rangeLabel}`,
    `- **Session Key**: ${artifact.sessionKey}`,
    `- **Signals Reviewed**: ${artifact.signalsReviewed}`,
    `- **Average Score**: ${artifact.averageScore}`,
    "",
    "## Dimension Scores",
    ...artifact.dimensionScoreLines,
    "",
    "## Main Failure Modes",
    ...artifact.mainFailureModeLines,
    "",
    "## Next Upgrade Focus",
    ...artifact.nextUpgradeFocusLines,
    "",
  ].join("\n");
}

export function parsePortfolioAnswerScorecardArtifact(
  content: string,
): ParsedPortfolioAnswerScorecardArtifact | undefined {
  const weekKey = content.match(/^# Portfolio Answer Scorecard: ([^\r\n]+)/m)?.[1]?.trim();
  if (!weekKey) {
    return undefined;
  }
  const averageScore = content.match(/- \*\*Average Score\*\*: ([^\n]+)/)?.[1]?.trim() ?? "unknown";
  const nextUpgradeFocus = extractFirstSectionBullet(
    content,
    "Next Upgrade Focus",
    "do-now: keep using the fixed position-answer contract.",
  );
  const improveTarget =
    nextUpgradeFocus.match(/^do-now:\s*improve ([^.\n]+)/i)?.[1]?.trim() ?? nextUpgradeFocus;
  return {
    weekKey,
    averageScore,
    nextUpgradeFocus,
    improveTarget,
  };
}

export type ParsedLearningUpgradeArtifact = {
  window: string;
  mainFailureToAvoid: string;
  defaultMethodToApply: string;
  stableTopicToReuse: string;
  topTopicToReinforce: string;
  doNow: string;
  doNext: string;
  park: string;
  nextMicroDrill: string;
  transferReminder: string;
  dominantFoundationTemplate: string;
};

export type ParsedLearningDurableSkillsArtifact = {
  defaultTopic: string;
  defaultMethod: string;
  commonFailure: string;
  nextDrill: string;
};

export type ParsedLearningTriggerMapArtifact = {
  topic: string;
  whenYouSee: string;
  apply: string;
  avoid: string;
  transferTo: string;
};

export type ParsedLearningRehearsalQueueArtifact = {
  doNowLine: string;
};

export type ParsedLearningTransferBridgesArtifact = {
  topic: string;
  transferTo: string;
  reuseRule: string;
  invalidIf: string;
};

export type ParsedLearningRelevanceGateArtifact = {
  primaryCall: string;
};

function extractLearningSectionEntry(
  content: string,
  heading: string,
): { title: string; bulletMap: Map<string, string> } | undefined {
  const headingBlock =
    content.match(
      new RegExp(`## ${escapeRegexFragment(heading)}\\r?\\n([\\s\\S]*?)(?:\\r?\\n## |$)`, "u"),
    )?.[1] ?? "";
  const source = headingBlock.trim().length > 0 ? headingBlock : content;
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const titleLine = lines.find((line) => line.startsWith("### "));
  if (!titleLine) {
    return undefined;
  }
  const bulletMap = new Map<string, string>();
  for (const line of lines) {
    const bulletMatch = line.match(/^- ([a-z_]+):\s*(.+)$/u);
    if (!bulletMatch) {
      continue;
    }
    bulletMap.set(bulletMatch[1], bulletMatch[2].trim());
  }
  return {
    title: titleLine.slice(4).trim(),
    bulletMap,
  };
}

export function parseLearningUpgradeArtifact(
  content: string,
): ParsedLearningUpgradeArtifact | undefined {
  const heading = content.match(/^# Learning Upgrade Prompt: ([^\r\n]+)/m)?.[1]?.trim();
  if (!heading) {
    return undefined;
  }
  return {
    window: extractBulletValue(content, "Window") ?? "unknown window",
    mainFailureToAvoid: extractBulletValue(content, "Main Failure To Avoid") ?? "",
    defaultMethodToApply: extractBulletValue(content, "Default Method To Apply") ?? "",
    stableTopicToReuse: extractBulletValue(content, "Stable Topic To Reuse") ?? "",
    topTopicToReinforce: extractBulletValue(content, "Top Topic To Reinforce") ?? "",
    doNow: extractBulletValue(content, "Do Now") ?? "",
    doNext: extractBulletValue(content, "Do Next") ?? "",
    park: extractBulletValue(content, "Park") ?? "",
    nextMicroDrill: extractBulletValue(content, "Next Micro-Drill") ?? "",
    transferReminder: extractBulletValue(content, "Transfer Reminder") ?? "",
    dominantFoundationTemplate: extractBulletValue(content, "Dominant Foundation Template") ?? "",
  };
}

export function parseLearningDurableSkillsArtifact(
  content: string,
): ParsedLearningDurableSkillsArtifact | undefined {
  const heading = content.match(/^# Learning Durable Skills: ([^\r\n]+)/m)?.[1]?.trim();
  if (!heading) {
    return undefined;
  }
  const entry = extractLearningSectionEntry(content, "Reusable Skill Entries");
  if (!entry) {
    return undefined;
  }
  return {
    defaultTopic: entry.title,
    defaultMethod: entry.bulletMap.get("default_method") ?? "",
    commonFailure: entry.bulletMap.get("common_failure") ?? "",
    nextDrill: entry.bulletMap.get("next_drill") ?? "",
  };
}

export function parseLearningTriggerMapArtifact(
  content: string,
): ParsedLearningTriggerMapArtifact | undefined {
  const heading = content.match(/^# Learning Trigger Map: ([^\r\n]+)/m)?.[1]?.trim();
  if (!heading) {
    return undefined;
  }
  const entry = extractLearningSectionEntry(content, "Trigger Entries");
  if (!entry) {
    return undefined;
  }
  return {
    topic: entry.title,
    whenYouSee: entry.bulletMap.get("when_you_see") ?? "",
    apply: entry.bulletMap.get("apply") ?? "",
    avoid: entry.bulletMap.get("avoid") ?? "",
    transferTo: entry.bulletMap.get("transfer_to") ?? "",
  };
}

export function parseLearningRehearsalQueueArtifact(
  content: string,
): ParsedLearningRehearsalQueueArtifact | undefined {
  const heading = content.match(/^# Learning Rehearsal Queue: ([^\r\n]+)/m)?.[1]?.trim();
  if (!heading) {
    return undefined;
  }
  return {
    doNowLine: extractFirstSectionBullet(content, "Do Now", ""),
  };
}

export function parseLearningTransferBridgesArtifact(
  content: string,
): ParsedLearningTransferBridgesArtifact | undefined {
  const heading = content.match(/^# Learning Transfer Bridges: ([^\r\n]+)/m)?.[1]?.trim();
  if (!heading) {
    return undefined;
  }
  const entry = extractLearningSectionEntry(content, "Bridge Entries");
  if (!entry) {
    return undefined;
  }
  return {
    topic: entry.title,
    transferTo: entry.bulletMap.get("transfer_to") ?? "",
    reuseRule: entry.bulletMap.get("reuse_rule") ?? "",
    invalidIf: entry.bulletMap.get("invalid_if") ?? "",
  };
}

export function parseLearningRelevanceGateArtifact(
  content: string,
): ParsedLearningRelevanceGateArtifact | undefined {
  const heading = content.match(/^# Learning Relevance Gate: ([^\r\n]+)/m)?.[1]?.trim();
  if (!heading) {
    return undefined;
  }
  return {
    primaryCall: extractFirstSectionBullet(content, "Primary Call", ""),
  };
}

export function buildPortfolioAnswerScorecardControlRoomSummary(params: {
  filename: string;
  content: string;
}): string {
  const parsed = parsePortfolioAnswerScorecardArtifact(params.content);
  if (!parsed) {
    return `Portfolio scorecard (${params.filename}): latest weekly scorecard available.`;
  }
  return `Portfolio scorecard (${parsed.weekKey}): average ${parsed.averageScore}, focus ${parsed.improveTarget}.`;
}

function extractBulletValue(content: string, label: string): string | undefined {
  return content
    .match(new RegExp(`- \\*\\*${escapeRegexFragment(label)}\\*\\*: ([^\\r\\n]+)`, "u"))?.[1]
    ?.trim();
}

function extractSectionLabeledValue(
  content: string,
  heading: string,
  label: string,
): string | undefined {
  const prefix = `${label}: `;
  return extractSectionBulletLines(content, heading)
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

export function renderLobsterWorkfaceArtifact(artifact: LobsterWorkfaceArtifact): string {
  return [
    `# Lobster Workface: ${artifact.targetDateKey}`,
    "",
    "- **Scope**: yesterday operating view",
    `- **Session Key**: ${artifact.sessionKey}`,
    `- **Learning Items**: ${artifact.learningItems}`,
    `- **Correction Notes**: ${artifact.correctionNotes}`,
    `- **Watchtower Signals**: ${artifact.watchtowerSignals}`,
    `- **Codex Escalations**: ${artifact.codexEscalations}`,
    ...(artifact.activeSurfaceLanes !== undefined
      ? [`- **Active Surface Lanes**: ${artifact.activeSurfaceLanes}`]
      : []),
    ...(artifact.portfolioScorecard
      ? [`- **Portfolio Scorecard**: ${artifact.portfolioScorecard}`]
      : []),
    `- **Total Tokens**: ${artifact.totalTokens}`,
    `- **Estimated Cost**: ${artifact.estimatedCost}`,
    "",
    "## Dashboard Snapshot",
    ...artifact.dashboardSnapshotLines,
    "",
    "## Validation Radar",
    ...artifact.validationRadarLines,
    "",
    "## Feishu Lane Panel",
    ...artifact.feishuLanePanelLines,
    "",
    "## 7-Day Operating View",
    ...artifact.sevenDayOperatingViewLines,
    "",
    "## Yesterday Learned",
    ...artifact.yesterdayLearnedLines,
    "",
    "## Yesterday Work Receipts",
    ...(artifact.yesterdayWorkReceiptLines ?? [
      "- No structured Feishu work receipt was captured yesterday.",
    ]),
    "",
    "## Self-Repair Signals",
    ...(artifact.selfRepairSignalLines ?? [
      "- No self-repair or repair-ticket signal was captured yesterday.",
    ]),
    "",
    "## Yesterday Corrected",
    ...artifact.yesterdayCorrectedLines,
    "",
    "## Yesterday Watchtower",
    ...artifact.yesterdayWatchtowerLines,
    "",
    "## Codex Escalations",
    ...artifact.codexEscalationLines,
    "",
    "## Portfolio Answer Scorecard",
    ...artifact.portfolioAnswerScorecardLines,
    "",
    "## Token Dashboard",
    artifact.tokenDashboardLeadLine,
    ...artifact.tokenDashboardModelLines,
    "",
    "### 7-Day Token Trend",
    ...artifact.tokenTrendLines,
    "",
    "## Reading Guide",
    ...artifact.readingGuideLines,
    "",
  ].join("\n");
}

export function parseLobsterWorkfaceArtifact(
  content: string,
): ParsedLobsterWorkfaceArtifact | undefined {
  const dateKey = content.match(/^# Lobster Workface: ([^\r\n]+)/m)?.[1]?.trim();
  if (!dateKey) {
    return undefined;
  }
  const lanePanelLines = extractSectionBulletLines(content, "Feishu Lane Panel");
  return {
    dateKey,
    learningItems: extractBulletValue(content, "Learning Items") ?? "0",
    correctionNotes: extractBulletValue(content, "Correction Notes") ?? "0",
    watchtowerSignals: extractBulletValue(content, "Watchtower Signals") ?? "0",
    codexEscalations: extractBulletValue(content, "Codex Escalations") ?? "0",
    activeSurfaceLanes:
      extractBulletValue(content, "Active Surface Lanes") ??
      extractSectionLabeledValue(content, "Feishu Lane Panel", "Active Lanes"),
    portfolioScorecard: extractBulletValue(content, "Portfolio Scorecard"),
    totalTokens: extractBulletValue(content, "Total Tokens") ?? "0",
    estimatedCost: extractBulletValue(content, "Estimated Cost") ?? "$0.0000",
    strongestDomain: extractSectionLabeledValue(content, "Validation Radar", "Strongest Domain"),
    weakestDomain: extractSectionLabeledValue(content, "Validation Radar", "Weakest Domain"),
    hallucinationWatch: extractSectionLabeledValue(
      content,
      "Validation Radar",
      "Hallucination Watch",
    ),
    learningKeep: extractSectionLabeledValue(content, "Yesterday Learned", "keep"),
    learningDiscard: extractSectionLabeledValue(content, "Yesterday Learned", "discard"),
    learningImproveLobster: extractSectionLabeledValue(
      content,
      "Yesterday Learned",
      "improve lobster",
    ),
    learningReplay: extractSectionLabeledValue(content, "Yesterday Learned", "replay"),
    learningNextEval: extractSectionLabeledValue(content, "Yesterday Learned", "next eval"),
    laneMeterRows: lanePanelLines
      .filter(
        (line) =>
          !/^Active Lanes:/i.test(line) &&
          !/^No active Feishu surface lanes are recorded yet\.?$/i.test(line),
      )
      .slice(0, 2),
  };
}

export function buildLobsterWorkfaceLearningCarryoverCue(
  workfaceContent?: string,
): string | undefined {
  if (!workfaceContent) {
    return undefined;
  }
  const parsed = parseLobsterWorkfaceArtifact(workfaceContent);
  if (!parsed) {
    return undefined;
  }
  const lines = [
    parsed.learningKeep ? `- retain: ${parsed.learningKeep}` : undefined,
    parsed.learningDiscard ? `- discard: ${parsed.learningDiscard}` : undefined,
    parsed.learningReplay ? `- replay: ${parsed.learningReplay}` : undefined,
    parsed.learningNextEval ? `- next eval: ${parsed.learningNextEval}` : undefined,
  ].filter((line): line is string => Boolean(line));
  if (lines.length === 0) {
    return undefined;
  }
  return lines.join("\n");
}

export function buildLobsterWorkfaceControlRoomSummary(params: {
  filename: string;
  content: string;
}): string {
  const parsed = parseLobsterWorkfaceArtifact(params.content);
  const date = parsed?.dateKey ?? params.filename.replace(/-lobster-workface\.md$/u, "");
  const lanePanel =
    parsed?.activeSurfaceLanes || (parsed?.laneMeterRows.length ?? 0) > 0
      ? `lane panel ${[
          parsed?.activeSurfaceLanes
            ? `${parsed.activeSurfaceLanes} active lane${parsed.activeSurfaceLanes === "1" ? "" : "s"}`
            : undefined,
          parsed?.laneMeterRows.length
            ? `meter ${parsed.laneMeterRows
                .map((line) => line.replace(/\s*·\s*session[\s\S]*$/u, "").trim())
                .join("; ")}`
            : undefined,
        ]
          .filter(Boolean)
          .join(", ")}`
      : undefined;
  const scorecardPart = parsed?.portfolioScorecard
    ? `, scorecard ${parsed.portfolioScorecard}`
    : "";
  const validationPart = parsed?.weakestDomain ? `, weakest ${parsed.weakestDomain}` : "";
  const riskPart = parsed?.hallucinationWatch
    ? `, hallucination watch ${parsed.hallucinationWatch}`
    : "";
  const lanePart = lanePanel ? `, ${lanePanel}` : "";
  const distilledLearningPart = [
    parsed?.learningKeep ? `retained ${parsed.learningKeep}` : undefined,
    parsed?.learningDiscard ? `discarded ${parsed.learningDiscard}` : undefined,
    parsed?.learningReplay ? `replay ${parsed.learningReplay}` : undefined,
    parsed?.learningNextEval ? `next eval ${parsed.learningNextEval}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const learningPart = distilledLearningPart ? `, ${distilledLearningPart}` : "";
  return `Workface (${date}): learned ${parsed?.learningItems ?? "0"}, corrected ${parsed?.correctionNotes ?? "0"}, watchtower ${parsed?.watchtowerSignals ?? "0"}${learningPart}${scorecardPart}${validationPart}${riskPart}${lanePart}, tokens ${parsed?.totalTokens ?? "0"}, estimated cost ${parsed?.estimatedCost ?? "$0.0000"}.`;
}

export function buildKnowledgeValidationWeeklyControlRoomSummary(
  content: string,
): string | undefined {
  const parsed = parseKnowledgeValidationWeeklyArtifact(content);
  if (!parsed) {
    return undefined;
  }
  const parts = [
    parsed.strongestDomain ? `strongest ${parsed.strongestDomain}` : undefined,
    parsed.weakestDomain ? `weakest ${parsed.weakestDomain}` : undefined,
    parsed.hallucinationDomain ? `hallucination watch ${parsed.hallucinationDomain}` : undefined,
  ].filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  return `Validation radar: ${parts.join("; ")}.`;
}

export function renderFeishuSurfaceLineArtifact(artifact: FeishuSurfaceLineArtifact): string {
  return [
    `# Feishu Surface Line: ${artifact.surface} / ${artifact.chatId}`,
    "",
    `- **Surface**: ${artifact.surface}`,
    `- **Chat**: ${artifact.chatId}`,
    `- **Lane Key**: ${artifact.laneKey}`,
    `- **Last Updated**: ${artifact.lastUpdated}`,
    `- **Current Session Key**: ${artifact.sessionKey}`,
    "",
    "## Recent Turns",
    ...artifact.recentTurnEntries,
    "",
  ].join("\n");
}

export function parseFeishuSurfaceLineArtifact(
  content: string,
): ParsedFeishuSurfaceLineArtifact | undefined {
  const surface = content.match(/- \*\*Surface\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const chatId = content.match(/- \*\*Chat\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const laneKey = content.match(/- \*\*Lane Key\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const lastUpdated = content.match(/- \*\*Last Updated\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const sessionKey = content.match(/- \*\*Current Session Key\*\*: ([^\r\n]+)/)?.[1]?.trim();
  if (!surface || !chatId || !laneKey || !lastUpdated || !sessionKey) {
    return undefined;
  }
  return {
    surface,
    chatId,
    laneKey,
    lastUpdated,
    sessionKey,
    recentTurnEntries:
      content
        .match(/## Recent Turns\r?\n([\s\S]*)$/u)?.[1]
        ?.split(/\n(?=### )/u)
        .map((entry) => entry.trim())
        .filter(Boolean) ?? [],
  };
}

export function renderFeishuWorkReceiptArtifact(artifact: FeishuWorkReceiptArtifact): string {
  return [
    `# Feishu Work Receipt: ${artifact.surface} / ${artifact.chatId}`,
    "",
    `- **Handled At**: ${artifact.handledAt}`,
    `- **Surface**: ${artifact.surface}`,
    `- **Chat**: ${artifact.chatId}`,
    `- **Session Key**: ${artifact.sessionKey}`,
    `- **Message ID**: ${artifact.messageId}`,
    `- **Requested Action**: ${artifact.requestedAction}`,
    `- **Scope**: ${artifact.scope}`,
    `- **Timeframe**: ${artifact.timeframe}`,
    `- **Output Shape**: ${artifact.outputShape}`,
    `- **Repair Disposition**: ${artifact.repairDisposition}`,
    "",
    "## Read Path",
    ...artifact.readPathLines,
    "",
    "## User Ask",
    `- ${artifact.userMessage}`,
    "",
    "## Final Reply Summary",
    `- ${artifact.finalReplySummary}`,
    ...(artifact.financeDoctrineProof
      ? [
          "",
          "## Finance Doctrine Proof",
          `- Consumer: ${artifact.financeDoctrineProof.consumer}`,
          `- Doctrine Fields Used: ${artifact.financeDoctrineProof.doctrineFieldsUsed.join(", ")}`,
          ...artifact.financeDoctrineProof.outputEvidenceLines.map((line) => `- Output: ${line}`),
          `- Proves: ${artifact.financeDoctrineProof.proves}`,
          `- Does Not Prove: ${artifact.financeDoctrineProof.doesNotProve}`,
        ]
      : []),
    "",
  ].join("\n");
}

export function parseFeishuWorkReceiptArtifact(
  content: string,
): ParsedFeishuWorkReceiptArtifact | undefined {
  const handledAt = content.match(/- \*\*Handled At\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const surface = content.match(/- \*\*Surface\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const chatId = content.match(/- \*\*Chat\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const sessionKey = content.match(/- \*\*Session Key\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const messageId = content.match(/- \*\*Message ID\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const requestedAction = content.match(/- \*\*Requested Action\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const scope = content.match(/- \*\*Scope\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const timeframe = content.match(/- \*\*Timeframe\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const outputShape = content.match(/- \*\*Output Shape\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const repairDisposition = content.match(/- \*\*Repair Disposition\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const userMessage = extractSectionBulletLines(content, "User Ask")[0]?.trim();
  const finalReplySummary = extractSectionBulletLines(content, "Final Reply Summary")[0]?.trim();
  const financeDoctrineProofLines = extractSectionBulletLines(content, "Finance Doctrine Proof");
  const financeDoctrineProofConsumer = financeDoctrineProofLines
    .find((line) => line.startsWith("Consumer: "))
    ?.slice("Consumer: ".length)
    .trim();
  const financeDoctrineProofFields = financeDoctrineProofLines
    .find((line) => line.startsWith("Doctrine Fields Used: "))
    ?.slice("Doctrine Fields Used: ".length)
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  const financeDoctrineProofOutputLines = financeDoctrineProofLines
    .filter((line) => line.startsWith("Output: "))
    .map((line) => line.slice("Output: ".length).trim())
    .filter(Boolean);
  const financeDoctrineProofProves = financeDoctrineProofLines
    .find((line) => line.startsWith("Proves: "))
    ?.slice("Proves: ".length)
    .trim();
  const financeDoctrineProofDoesNotProve = financeDoctrineProofLines
    .find((line) => line.startsWith("Does Not Prove: "))
    ?.slice("Does Not Prove: ".length)
    .trim();
  if (
    !handledAt ||
    !surface ||
    !chatId ||
    !sessionKey ||
    !messageId ||
    !requestedAction ||
    !scope ||
    !timeframe ||
    !outputShape ||
    !repairDisposition ||
    !userMessage ||
    !finalReplySummary
  ) {
    return undefined;
  }
  return {
    handledAt,
    surface,
    chatId,
    sessionKey,
    messageId,
    userMessage,
    requestedAction,
    scope,
    timeframe,
    outputShape,
    repairDisposition,
    readPathLines: extractSectionBulletLines(content, "Read Path"),
    finalReplySummary,
    financeDoctrineProof:
      financeDoctrineProofConsumer &&
      financeDoctrineProofFields &&
      financeDoctrineProofFields.length > 0 &&
      financeDoctrineProofOutputLines.length > 0 &&
      financeDoctrineProofProves &&
      financeDoctrineProofDoesNotProve
        ? {
            consumer: financeDoctrineProofConsumer,
            doctrineFieldsUsed: financeDoctrineProofFields,
            outputEvidenceLines: financeDoctrineProofOutputLines,
            proves: financeDoctrineProofProves,
            doesNotProve: financeDoctrineProofDoesNotProve,
          }
        : undefined,
  };
}

export function renderFeishuFinanceDoctrineCalibrationArtifact(
  artifact: FeishuFinanceDoctrineCalibrationArtifact,
): string {
  return [
    "# Feishu Finance Doctrine Calibration",
    "",
    `- **Review Date**: ${artifact.reviewDate}`,
    `- **Consumer**: ${artifact.consumer}`,
    `- **Linked Receipt**: ${artifact.linkedReceipt}`,
    `- **Observed Outcome**: ${artifact.observedOutcome}`,
    `- **Scenario Closest To Outcome**: ${artifact.scenarioClosestToOutcome}`,
    `- **Base Case Directionally Closer**: ${artifact.baseCaseDirectionallyCloser}`,
    `- **Change My Mind Triggered**: ${artifact.changeMyMindTriggered}`,
    `- **Conviction Looks Too High Or Low**: ${artifact.convictionLooksTooHighOrLow}`,
    "",
    "## Notes",
    `- ${artifact.notes}`,
    "",
  ].join("\n");
}

export function parseFeishuFinanceDoctrineCalibrationArtifact(
  content: string,
): ParsedFeishuFinanceDoctrineCalibrationArtifact | undefined {
  const reviewDate = content.match(/- \*\*Review Date\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const consumer = content.match(/- \*\*Consumer\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const linkedReceipt = content.match(/- \*\*Linked Receipt\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const observedOutcome = content.match(/- \*\*Observed Outcome\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const scenarioClosestToOutcome = content
    .match(/- \*\*Scenario Closest To Outcome\*\*: ([^\r\n]+)/)?.[1]
    ?.trim() as FeishuFinanceDoctrineCalibrationArtifact["scenarioClosestToOutcome"] | undefined;
  const baseCaseDirectionallyCloser = content
    .match(/- \*\*Base Case Directionally Closer\*\*: ([^\r\n]+)/)?.[1]
    ?.trim() as FeishuFinanceDoctrineCalibrationArtifact["baseCaseDirectionallyCloser"] | undefined;
  const changeMyMindTriggered = content
    .match(/- \*\*Change My Mind Triggered\*\*: ([^\r\n]+)/)?.[1]
    ?.trim() as FeishuFinanceDoctrineCalibrationArtifact["changeMyMindTriggered"] | undefined;
  const convictionLooksTooHighOrLow = content
    .match(/- \*\*Conviction Looks Too High Or Low\*\*: ([^\r\n]+)/)?.[1]
    ?.trim() as FeishuFinanceDoctrineCalibrationArtifact["convictionLooksTooHighOrLow"] | undefined;
  const notes = extractSectionBulletLines(content, "Notes")[0]?.trim();
  if (
    !reviewDate ||
    !consumer ||
    !linkedReceipt ||
    !observedOutcome ||
    !scenarioClosestToOutcome ||
    !baseCaseDirectionallyCloser ||
    !changeMyMindTriggered ||
    !convictionLooksTooHighOrLow ||
    !notes
  ) {
    return undefined;
  }
  return {
    reviewDate,
    consumer,
    linkedReceipt,
    observedOutcome,
    scenarioClosestToOutcome,
    baseCaseDirectionallyCloser,
    changeMyMindTriggered,
    convictionLooksTooHighOrLow,
    notes,
  };
}

export function renderFeishuFinanceDoctrineTeacherFeedbackArtifact(
  artifact: FeishuFinanceDoctrineTeacherFeedbackArtifact,
): string {
  return [
    "# Feishu Finance Doctrine Teacher Feedback",
    "",
    `- **Generated At**: ${artifact.generatedAt}`,
    `- **Teacher Task**: ${artifact.teacherTask}`,
    "",
    "## Feedback",
    ...(artifact.feedbacks.length > 0
      ? artifact.feedbacks.flatMap((feedback, index) => [
          `### Feedback ${index + 1}`,
          `- **Feedback ID**: ${feedback.feedbackId}`,
          `- **Source Artifact**: ${feedback.sourceArtifact}`,
          `- **Teacher Model**: ${feedback.teacherModel}`,
          `- **Critique Type**: ${feedback.critiqueType}`,
          `- **Critique Text**: ${feedback.critiqueText}`,
          `- **Suggested Candidate Text**: ${feedback.suggestedCandidateText}`,
          `- **Evidence Needed**: ${feedback.evidenceNeeded}`,
          `- **Risk Of Adopting**: ${feedback.riskOfAdopting}`,
          `- **Recommended Next Action**: ${feedback.recommendedNextAction}`,
          "",
        ])
      : ["- No teacher feedback has been recorded yet.", ""]),
  ].join("\n");
}

export function parseFeishuFinanceDoctrineTeacherFeedbackArtifact(
  content: string,
): ParsedFeishuFinanceDoctrineTeacherFeedbackArtifact | undefined {
  const generatedAt = content.match(/- \*\*Generated At\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const teacherTask = content.match(/- \*\*Teacher Task\*\*: ([^\r\n]+)/)?.[1]?.trim() as
    | "finance_calibration_audit"
    | undefined;
  if (!generatedAt || teacherTask !== "finance_calibration_audit") {
    return undefined;
  }
  const feedbacks = [
    ...content.matchAll(/### Feedback \d+\n([\s\S]*?)(?=\n### Feedback \d+\n|\n?$)/gu),
  ]
    .map((match) => match[1]?.trim())
    .filter(Boolean)
    .map((block) => {
      const feedbackId = block.match(/- \*\*Feedback ID\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const sourceArtifact = block.match(/- \*\*Source Artifact\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const teacherModel = block.match(/- \*\*Teacher Model\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const critiqueType = normalizeFinanceDoctrineTeacherFeedbackCritiqueType(
        block.match(/- \*\*Critique Type\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      const critiqueText = block.match(/- \*\*Critique Text\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const suggestedCandidateText = block
        .match(/- \*\*Suggested Candidate Text\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const evidenceNeeded = block.match(/- \*\*Evidence Needed\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const riskOfAdopting = block.match(/- \*\*Risk Of Adopting\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const recommendedNextAction = block
        .match(/- \*\*Recommended Next Action\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      if (
        !feedbackId ||
        !sourceArtifact ||
        !teacherModel ||
        !critiqueType ||
        !critiqueText ||
        !suggestedCandidateText ||
        !evidenceNeeded ||
        !riskOfAdopting ||
        !recommendedNextAction
      ) {
        return undefined;
      }
      return {
        feedbackId,
        sourceArtifact,
        teacherModel,
        critiqueType,
        critiqueText,
        suggestedCandidateText,
        evidenceNeeded,
        riskOfAdopting,
        recommendedNextAction,
      };
    })
    .filter(
      (feedback): feedback is FeishuFinanceDoctrineTeacherFeedbackArtifact["feedbacks"][number] =>
        Boolean(feedback),
    );
  return {
    generatedAt,
    teacherTask,
    feedbacks,
  };
}

export function renderFeishuFinanceDoctrineTeacherReviewArtifact(
  artifact: FeishuFinanceDoctrineTeacherReviewArtifact,
): string {
  return [
    "# Feishu Finance Doctrine Teacher Review",
    "",
    `- **Reviewed At**: ${artifact.reviewedAt}`,
    `- **Source Teacher Feedback Artifact**: ${artifact.sourceTeacherFeedbackArtifact}`,
    "",
    "## Reviews",
    ...(artifact.reviews.length > 0
      ? artifact.reviews.flatMap((review, index) => [
          `### Review ${index + 1}`,
          `- **Feedback ID**: ${review.feedbackId}`,
          `- **Source Artifact**: ${review.sourceArtifact}`,
          `- **Review Outcome**: ${review.reviewOutcome}`,
          "",
        ])
      : ["- No teacher review state has been recorded yet.", ""]),
  ].join("\n");
}

export function parseFeishuFinanceDoctrineTeacherReviewArtifact(
  content: string,
): ParsedFeishuFinanceDoctrineTeacherReviewArtifact | undefined {
  const reviewedAt = content.match(/- \*\*Reviewed At\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const sourceTeacherFeedbackArtifact = content
    .match(/- \*\*Source Teacher Feedback Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  if (!reviewedAt || !sourceTeacherFeedbackArtifact) {
    return undefined;
  }
  const reviews = [...content.matchAll(/### Review \d+\n([\s\S]*?)(?=\n### Review \d+\n|\n?$)/gu)]
    .map((match) => match[1]?.trim())
    .filter(Boolean)
    .map((block) => {
      const feedbackId = block.match(/- \*\*Feedback ID\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const sourceArtifact = block.match(/- \*\*Source Artifact\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const reviewOutcome = normalizeFinanceDoctrineTeacherReviewOutcome(
        block.match(/- \*\*Review Outcome\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      if (!feedbackId || !sourceArtifact || !reviewOutcome) {
        return undefined;
      }
      return {
        feedbackId,
        sourceArtifact,
        reviewOutcome,
      };
    })
    .filter((review): review is FeishuFinanceDoctrineTeacherReviewArtifact["reviews"][number] =>
      Boolean(review),
    );
  return {
    reviewedAt,
    sourceTeacherFeedbackArtifact,
    reviews,
  };
}

export function renderFeishuFinanceDoctrineTeacherElevationHandoffArtifact(
  artifact: FeishuFinanceDoctrineTeacherElevationHandoffArtifact,
): string {
  return [
    "# Feishu Finance Doctrine Teacher Elevation Handoffs",
    "",
    `- **Handed Off At**: ${artifact.handedOffAt}`,
    `- **Source Teacher Feedback Artifact**: ${artifact.sourceTeacherFeedbackArtifact}`,
    `- **Source Teacher Review Artifact**: ${artifact.sourceTeacherReviewArtifact}`,
    "",
    "## Handoffs",
    ...(artifact.handoffs.length > 0
      ? artifact.handoffs.flatMap((handoff, index) => [
          `### Handoff ${index + 1}`,
          `- **Handoff ID**: ${handoff.handoffId}`,
          `- **Feedback ID**: ${handoff.feedbackId}`,
          `- **Critique Type**: ${handoff.critiqueType}`,
          `- **Critique Text**: ${handoff.critiqueText}`,
          `- **Suggested Candidate Text**: ${handoff.suggestedCandidateText}`,
          `- **Evidence Needed**: ${handoff.evidenceNeeded}`,
          `- **Risk Of Adopting**: ${handoff.riskOfAdopting}`,
          `- **Target Governance Path**: ${handoff.targetGovernancePath}`,
          `- **Operator Next Action**: ${handoff.operatorNextAction}`,
          `- **Status**: ${handoff.status}`,
          "",
        ])
      : ["- No teacher elevation handoff has been recorded yet.", ""]),
  ].join("\n");
}

export function parseFeishuFinanceDoctrineTeacherElevationHandoffArtifact(
  content: string,
): ParsedFeishuFinanceDoctrineTeacherElevationHandoffArtifact | undefined {
  const handedOffAt = content.match(/- \*\*Handed Off At\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const sourceTeacherFeedbackArtifact = content
    .match(/- \*\*Source Teacher Feedback Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  const sourceTeacherReviewArtifact = content
    .match(/- \*\*Source Teacher Review Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  if (!handedOffAt || !sourceTeacherFeedbackArtifact || !sourceTeacherReviewArtifact) {
    return undefined;
  }
  const handoffs = [
    ...content.matchAll(/### Handoff \d+\n([\s\S]*?)(?=\n### Handoff \d+\n|\n?$)/gu),
  ]
    .map((match) => match[1]?.trim())
    .filter(Boolean)
    .map((block) => {
      const handoffId = block.match(/- \*\*Handoff ID\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const feedbackId = block.match(/- \*\*Feedback ID\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const critiqueType = normalizeFinanceDoctrineTeacherFeedbackCritiqueType(
        block.match(/- \*\*Critique Type\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      const critiqueText = block.match(/- \*\*Critique Text\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const suggestedCandidateText = block
        .match(/- \*\*Suggested Candidate Text\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const evidenceNeeded = block.match(/- \*\*Evidence Needed\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const riskOfAdopting = block.match(/- \*\*Risk Of Adopting\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const targetGovernancePath = block
        .match(/- \*\*Target Governance Path\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const operatorNextAction = block
        .match(/- \*\*Operator Next Action\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const status = normalizeFinanceDoctrineTeacherElevationHandoffStatus(
        block.match(/- \*\*Status\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      if (
        !handoffId ||
        !feedbackId ||
        !critiqueType ||
        !critiqueText ||
        !suggestedCandidateText ||
        !evidenceNeeded ||
        !riskOfAdopting ||
        !targetGovernancePath ||
        !operatorNextAction ||
        !status
      ) {
        return undefined;
      }
      return {
        handoffId,
        feedbackId,
        critiqueType,
        critiqueText,
        suggestedCandidateText,
        evidenceNeeded,
        riskOfAdopting,
        targetGovernancePath,
        operatorNextAction,
        status,
      };
    })
    .filter(
      (
        handoff,
      ): handoff is FeishuFinanceDoctrineTeacherElevationHandoffArtifact["handoffs"][number] =>
        Boolean(handoff),
    );
  return {
    handedOffAt,
    sourceTeacherFeedbackArtifact,
    sourceTeacherReviewArtifact,
    handoffs,
  };
}

export function renderFeishuFinanceDoctrineTeacherCandidateInputArtifact(
  artifact: FeishuFinanceDoctrineTeacherCandidateInputArtifact,
): string {
  return [
    "# Feishu Finance Doctrine Teacher Candidate Inputs",
    "",
    `- **Created At**: ${artifact.createdAt}`,
    `- **Source Teacher Elevation Handoff Artifact**: ${artifact.sourceTeacherElevationHandoffArtifact}`,
    `- **Source Teacher Feedback Artifact**: ${artifact.sourceTeacherFeedbackArtifact}`,
    `- **Source Teacher Review Artifact**: ${artifact.sourceTeacherReviewArtifact}`,
    "",
    "## Candidate Inputs",
    ...(artifact.candidateInputs.length > 0
      ? artifact.candidateInputs.flatMap((candidateInput, index) => [
          `### Candidate Input ${index + 1}`,
          `- **Candidate Input ID**: ${candidateInput.candidateInputId}`,
          `- **Handoff ID**: ${candidateInput.handoffId}`,
          `- **Feedback ID**: ${candidateInput.feedbackId}`,
          `- **Critique Type**: ${candidateInput.critiqueType}`,
          `- **Critique Text**: ${candidateInput.critiqueText}`,
          `- **Suggested Candidate Text**: ${candidateInput.suggestedCandidateText}`,
          `- **Evidence Needed**: ${candidateInput.evidenceNeeded}`,
          `- **Risk Of Adopting**: ${candidateInput.riskOfAdopting}`,
          `- **Target Governance Path**: ${candidateInput.targetGovernancePath}`,
          `- **Operator Next Action**: ${candidateInput.operatorNextAction}`,
          "",
        ])
      : ["- No teacher candidate input has been recorded yet.", ""]),
  ].join("\n");
}

export function parseFeishuFinanceDoctrineTeacherCandidateInputArtifact(
  content: string,
): ParsedFeishuFinanceDoctrineTeacherCandidateInputArtifact | undefined {
  const createdAt = content.match(/- \*\*Created At\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const sourceTeacherElevationHandoffArtifact = content
    .match(/- \*\*Source Teacher Elevation Handoff Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  const sourceTeacherFeedbackArtifact = content
    .match(/- \*\*Source Teacher Feedback Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  const sourceTeacherReviewArtifact = content
    .match(/- \*\*Source Teacher Review Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  if (
    !createdAt ||
    !sourceTeacherElevationHandoffArtifact ||
    !sourceTeacherFeedbackArtifact ||
    !sourceTeacherReviewArtifact
  ) {
    return undefined;
  }
  const candidateInputs = [
    ...content.matchAll(
      /### Candidate Input \d+\n([\s\S]*?)(?=\n### Candidate Input \d+\n|\n?$)/gu,
    ),
  ]
    .map((match) => match[1]?.trim())
    .filter(Boolean)
    .map((block) => {
      const candidateInputId = block.match(/- \*\*Candidate Input ID\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const handoffId = block.match(/- \*\*Handoff ID\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const feedbackId = block.match(/- \*\*Feedback ID\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const critiqueType = normalizeFinanceDoctrineTeacherFeedbackCritiqueType(
        block.match(/- \*\*Critique Type\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      const critiqueText = block.match(/- \*\*Critique Text\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const suggestedCandidateText = block
        .match(/- \*\*Suggested Candidate Text\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const evidenceNeeded = block.match(/- \*\*Evidence Needed\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const riskOfAdopting = block.match(/- \*\*Risk Of Adopting\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const targetGovernancePath = block
        .match(/- \*\*Target Governance Path\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const operatorNextAction = block
        .match(/- \*\*Operator Next Action\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      if (
        !candidateInputId ||
        !handoffId ||
        !feedbackId ||
        !critiqueType ||
        !critiqueText ||
        !suggestedCandidateText ||
        !evidenceNeeded ||
        !riskOfAdopting ||
        !targetGovernancePath ||
        !operatorNextAction
      ) {
        return undefined;
      }
      return {
        candidateInputId,
        handoffId,
        feedbackId,
        critiqueType,
        critiqueText,
        suggestedCandidateText,
        evidenceNeeded,
        riskOfAdopting,
        targetGovernancePath,
        operatorNextAction,
      };
    })
    .filter(
      (
        candidateInput,
      ): candidateInput is FeishuFinanceDoctrineTeacherCandidateInputArtifact["candidateInputs"][number] =>
        Boolean(candidateInput),
    );
  return {
    createdAt,
    sourceTeacherElevationHandoffArtifact,
    sourceTeacherFeedbackArtifact,
    sourceTeacherReviewArtifact,
    candidateInputs,
  };
}

export function renderFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact(
  artifact: FeishuFinanceDoctrineTeacherCandidateInputReviewArtifact,
): string {
  return [
    "# Feishu Finance Doctrine Teacher Candidate Input Review",
    "",
    `- **Reviewed At**: ${artifact.reviewedAt}`,
    `- **Source Teacher Candidate Input Artifact**: ${artifact.sourceTeacherCandidateInputArtifact}`,
    "",
    "## Reviews",
    ...(artifact.reviews.length > 0
      ? artifact.reviews.flatMap((review, index) => [
          `### Review ${index + 1}`,
          `- **Candidate Input ID**: ${review.candidateInputId}`,
          `- **Handoff ID**: ${review.handoffId}`,
          `- **Feedback ID**: ${review.feedbackId}`,
          `- **Target Governance Path**: ${review.targetGovernancePath}`,
          `- **Review Outcome**: ${review.reviewOutcome}`,
          "",
        ])
      : ["- No teacher candidate-input review state has been recorded yet.", ""]),
  ].join("\n");
}

export function parseFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact(
  content: string,
): ParsedFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact | undefined {
  const reviewedAt = content.match(/- \*\*Reviewed At\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const sourceTeacherCandidateInputArtifact = content
    .match(/- \*\*Source Teacher Candidate Input Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  if (!reviewedAt || !sourceTeacherCandidateInputArtifact) {
    return undefined;
  }
  const reviews = [...content.matchAll(/### Review \d+\n([\s\S]*?)(?=\n### Review \d+\n|\n?$)/gu)]
    .map((match) => match[1]?.trim())
    .filter(Boolean)
    .map((block) => {
      const candidateInputId = block.match(/- \*\*Candidate Input ID\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const handoffId = block.match(/- \*\*Handoff ID\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const feedbackId = block.match(/- \*\*Feedback ID\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const targetGovernancePath = block
        .match(/- \*\*Target Governance Path\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const reviewOutcome = normalizeFinanceDoctrineTeacherCandidateInputReviewOutcome(
        block.match(/- \*\*Review Outcome\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      if (
        !candidateInputId ||
        !handoffId ||
        !feedbackId ||
        !targetGovernancePath ||
        !reviewOutcome
      ) {
        return undefined;
      }
      return {
        candidateInputId,
        handoffId,
        feedbackId,
        targetGovernancePath,
        reviewOutcome,
      };
    })
    .filter(
      (
        review,
      ): review is FeishuFinanceDoctrineTeacherCandidateInputReviewArtifact["reviews"][number] =>
        Boolean(review),
    );
  return {
    reviewedAt,
    sourceTeacherCandidateInputArtifact,
    reviews,
  };
}

export function renderFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact(
  artifact: FeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact,
): string {
  return [
    "# Feishu Finance Doctrine Teacher Candidate Input Reconciliation",
    "",
    `- **Reconciled At**: ${artifact.reconciledAt}`,
    `- **Source Teacher Candidate Input Artifact**: ${artifact.sourceTeacherCandidateInputArtifact}`,
    `- **Source Teacher Candidate Input Review Artifact**: ${artifact.sourceTeacherCandidateInputReviewArtifact}`,
    "",
    "## Reconciliations",
    ...(artifact.reconciliations.length > 0
      ? artifact.reconciliations.flatMap((reconciliation, index) => [
          `### Reconciliation ${index + 1}`,
          `- **Reconciliation ID**: ${reconciliation.reconciliationId}`,
          `- **Source Teacher Candidate Input Artifact**: ${reconciliation.sourceTeacherCandidateInputArtifact}`,
          `- **Source Teacher Candidate Input Review Artifact**: ${reconciliation.sourceTeacherCandidateInputReviewArtifact}`,
          `- **Candidate Input ID**: ${reconciliation.candidateInputId}`,
          `- **Target Finance Candidate Path**: ${reconciliation.targetFinanceCandidatePath}`,
          `- **Reconciliation Mode**: ${reconciliation.reconciliationMode}`,
          `- **Reconciliation Notes**: ${reconciliation.reconciliationNotes}`,
          `- **Status**: ${reconciliation.status}`,
          "",
        ])
      : ["- No teacher candidate-input reconciliation has been recorded yet.", ""]),
  ].join("\n");
}

export function parseFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact(
  content: string,
): ParsedFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact | undefined {
  const reconciledAt = content.match(/- \*\*Reconciled At\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const sourceTeacherCandidateInputArtifact = content
    .match(/- \*\*Source Teacher Candidate Input Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  const sourceTeacherCandidateInputReviewArtifact = content
    .match(/- \*\*Source Teacher Candidate Input Review Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  if (
    !reconciledAt ||
    !sourceTeacherCandidateInputArtifact ||
    !sourceTeacherCandidateInputReviewArtifact
  ) {
    return undefined;
  }
  const reconciliations = [
    ...content.matchAll(/### Reconciliation \d+\n([\s\S]*?)(?=\n### Reconciliation \d+\n|\n?$)/gu),
  ]
    .map((match) => match[1]?.trim())
    .filter(Boolean)
    .map((block) => {
      const reconciliationId = block.match(/- \*\*Reconciliation ID\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const reconciliationSourceTeacherCandidateInputArtifact = block
        .match(/- \*\*Source Teacher Candidate Input Artifact\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const reconciliationSourceTeacherCandidateInputReviewArtifact = block
        .match(/- \*\*Source Teacher Candidate Input Review Artifact\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const candidateInputId = block.match(/- \*\*Candidate Input ID\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const targetFinanceCandidatePath = block
        .match(/- \*\*Target Finance Candidate Path\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const reconciliationMode = normalizeFinanceDoctrineTeacherCandidateInputReconciliationMode(
        block.match(/- \*\*Reconciliation Mode\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      const reconciliationNotes = block
        .match(/- \*\*Reconciliation Notes\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const status = normalizeFinanceDoctrineTeacherCandidateInputReconciliationStatus(
        block.match(/- \*\*Status\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      if (
        !reconciliationId ||
        !reconciliationSourceTeacherCandidateInputArtifact ||
        !reconciliationSourceTeacherCandidateInputReviewArtifact ||
        !candidateInputId ||
        !targetFinanceCandidatePath ||
        !reconciliationMode ||
        !reconciliationNotes ||
        !status
      ) {
        return undefined;
      }
      return {
        reconciliationId,
        sourceTeacherCandidateInputArtifact: reconciliationSourceTeacherCandidateInputArtifact,
        sourceTeacherCandidateInputReviewArtifact:
          reconciliationSourceTeacherCandidateInputReviewArtifact,
        candidateInputId,
        targetFinanceCandidatePath,
        reconciliationMode,
        reconciliationNotes,
        status,
      };
    })
    .filter(
      (
        reconciliation,
      ): reconciliation is FeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact["reconciliations"][number] =>
        Boolean(reconciliation),
    );
  return {
    reconciledAt,
    sourceTeacherCandidateInputArtifact,
    sourceTeacherCandidateInputReviewArtifact,
    reconciliations,
  };
}

export function renderFinanceFrameworkCoreContractArtifact(
  artifact: FinanceFrameworkCoreContractArtifact,
): string {
  return [
    "# Finance Framework Core Contract",
    "",
    `- **Updated At**: ${artifact.updatedAt}`,
    "",
    "## Domain Entries",
    ...(artifact.entries.length > 0
      ? artifact.entries.flatMap((entry, index) => [
          `### Domain Entry ${index + 1}`,
          `- **Domain**: ${entry.domain}`,
          `- **Base Case**: ${entry.baseCase}`,
          `- **Bull Case**: ${entry.bullCase}`,
          `- **Bear Case**: ${entry.bearCase}`,
          `- **Key Causal Chain**: ${entry.keyCausalChain}`,
          `- **Evidence Summary**: ${entry.evidenceSummary}`,
          `- **Confidence Or Conviction**: ${entry.confidenceOrConviction}`,
          `- **What Changes My Mind**: ${entry.whatChangesMyMind}`,
          `- **No Action Reason**: ${entry.noActionReason}`,
          `- **Risk Gate Notes**: ${entry.riskGateNotes}`,
          `- **Allowed Action Authority**: ${entry.allowedActionAuthority}`,
          "#### Source Artifacts",
          ...(entry.sourceArtifacts.length > 0
            ? entry.sourceArtifacts.map((item) => `- ${item}`)
            : ["- none"]),
          "#### Evidence Categories",
          ...(entry.evidenceCategories.length > 0
            ? entry.evidenceCategories.map((item) => `- ${item}`)
            : ["- none"]),
          "#### Upstream Drivers",
          ...(entry.upstreamDrivers.length > 0
            ? entry.upstreamDrivers.map((item) => `- ${item}`)
            : ["- none"]),
          "#### Downstream Asset Impacts",
          ...(entry.downstreamAssetImpacts.length > 0
            ? entry.downstreamAssetImpacts.map((item) => `- ${item}`)
            : ["- none"]),
          "",
        ])
      : ["- No finance framework domain entry has been recorded yet.", ""]),
  ].join("\n");
}

export function parseFinanceFrameworkCoreContractArtifact(
  content: string,
): ParsedFinanceFrameworkCoreContractArtifact | undefined {
  const updatedAt = content.match(/- \*\*Updated At\*\*: ([^\r\n]+)/)?.[1]?.trim();
  if (!updatedAt) {
    return undefined;
  }
  const entryBlocks = [
    ...content.matchAll(/### Domain Entry \d+\n([\s\S]*?)(?=\n### Domain Entry \d+\n|\n?$)/gu),
  ]
    .map((match) => match[1]?.trim())
    .filter(Boolean);
  const entries = entryBlocks
    .map((block) => {
      const domain = normalizeFinanceFrameworkCoreDomain(
        block.match(/- \*\*Domain\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      const baseCase = block.match(/- \*\*Base Case\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const bullCase = block.match(/- \*\*Bull Case\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const bearCase = block.match(/- \*\*Bear Case\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const keyCausalChain = block.match(/- \*\*Key Causal Chain\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const evidenceSummary = block.match(/- \*\*Evidence Summary\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const confidenceOrConviction = normalizeFinanceFrameworkConfidenceOrConviction(
        block.match(/- \*\*Confidence Or Conviction\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      const whatChangesMyMind = block
        .match(/- \*\*What Changes My Mind\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const noActionReason = block.match(/- \*\*No Action Reason\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const riskGateNotes = block.match(/- \*\*Risk Gate Notes\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const allowedActionAuthority = normalizeFinanceFrameworkAllowedActionAuthority(
        block.match(/- \*\*Allowed Action Authority\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      const sourceArtifacts = extractSectionList(block, "#### Source Artifacts");
      const evidenceCategories = extractSectionList(block, "#### Evidence Categories")
        .map((item) => normalizeFinanceEvidenceCategory(item))
        .filter((item): item is FinanceEvidenceCategory => Boolean(item));
      const upstreamDrivers = extractSectionList(block, "#### Upstream Drivers");
      const downstreamAssetImpacts = extractSectionList(block, "#### Downstream Asset Impacts");
      if (
        !domain ||
        !baseCase ||
        !bullCase ||
        !bearCase ||
        !keyCausalChain ||
        !evidenceSummary ||
        !confidenceOrConviction ||
        !whatChangesMyMind ||
        !noActionReason ||
        !riskGateNotes ||
        !allowedActionAuthority ||
        sourceArtifacts.length === 0 ||
        evidenceCategories.length === 0 ||
        upstreamDrivers.length === 0 ||
        downstreamAssetImpacts.length === 0
      ) {
        return undefined;
      }
      return {
        domain,
        sourceArtifacts,
        evidenceCategories,
        evidenceSummary,
        baseCase,
        bullCase,
        bearCase,
        keyCausalChain,
        upstreamDrivers,
        downstreamAssetImpacts,
        confidenceOrConviction,
        whatChangesMyMind,
        noActionReason,
        riskGateNotes,
        allowedActionAuthority,
      };
    })
    .filter((entry): entry is FinanceFrameworkCoreContractArtifact["entries"][number] =>
      Boolean(entry),
    );
  if (entryBlocks.length > 0 && entries.length !== entryBlocks.length) {
    return undefined;
  }
  return {
    updatedAt,
    entries,
  };
}

export function renderFinanceLearningCapabilityCandidateArtifact(
  artifact: FinanceLearningCapabilityCandidateArtifact,
): string {
  return [
    "# Finance Learning Capability Candidates",
    "",
    `- **Updated At**: ${artifact.updatedAt}`,
    `- **Framework Contract Path**: ${artifact.frameworkContractPath}`,
    "",
    "## Capability Candidates",
    ...(artifact.candidates.length > 0
      ? artifact.candidates.flatMap((candidate, index) => [
          `### Capability Candidate ${index + 1}`,
          `- **Candidate Id**: ${candidate.candidateId}`,
          `- **Source Article Path**: ${candidate.sourceArticlePath}`,
          `- **Title**: ${candidate.title}`,
          `- **Source Type**: ${candidate.sourceType}`,
          `- **Collection Method**: ${candidate.collectionMethod}`,
          `- **Author Source Name**: ${candidate.authorSourceName ?? ""}`,
          `- **Publish Date**: ${candidate.publishDate ?? ""}`,
          `- **Extraction Summary**: ${candidate.extractionSummary}`,
          `- **Raw Notes**: ${candidate.rawNotes}`,
          `- **Capability Name**: ${candidate.capabilityName}`,
          `- **Capability Type**: ${candidate.capabilityType}`,
          `- **Evidence Summary**: ${candidate.evidenceSummary}`,
          `- **Method Summary**: ${candidate.methodSummary}`,
          `- **Causal Or Mechanistic Claim**: ${candidate.causalOrMechanisticClaim}`,
          `- **Evidence Level**: ${candidate.evidenceLevel}`,
          `- **Implementation Requirements**: ${candidate.implementationRequirements}`,
          `- **Risk And Failure Modes**: ${candidate.riskAndFailureModes}`,
          `- **Overfitting Or Spurious Risk**: ${candidate.overfittingOrSpuriousRisk}`,
          `- **Compliance Or Collection Notes**: ${candidate.complianceOrCollectionNotes}`,
          `- **Suggested Attachment Point**: ${candidate.suggestedAttachmentPoint}`,
          `- **Allowed Action Authority**: ${candidate.allowedActionAuthority}`,
          "#### Related Finance Domains",
          ...(candidate.relatedFinanceDomains.length > 0
            ? candidate.relatedFinanceDomains.map((item) => `- ${item}`)
            : ["- none"]),
          "#### Capability Tags",
          ...(candidate.capabilityTags.length > 0
            ? candidate.capabilityTags.map((item) => `- ${item}`)
            : ["- none"]),
          "#### Evidence Categories",
          ...(candidate.evidenceCategories.length > 0
            ? candidate.evidenceCategories.map((item) => `- ${item}`)
            : ["- none"]),
          "#### Required Data Sources",
          ...(candidate.requiredDataSources.length > 0
            ? candidate.requiredDataSources.map((item) => `- ${item}`)
            : ["- none"]),
          "",
        ])
      : ["- No finance learning capability candidate has been recorded yet.", ""]),
  ].join("\n");
}

export function renderFinanceArticleSourceRegistryArtifact(
  artifact: FinanceArticleSourceRegistryArtifact,
): string {
  return [
    "# Finance Article Source Registry",
    "",
    `- **Updated At**: ${artifact.updatedAt}`,
    "",
    "## Sources",
    ...(artifact.sources.length > 0
      ? artifact.sources.flatMap((source, index) => [
          `### Source ${index + 1}`,
          `- **Source Name**: ${source.sourceName}`,
          `- **Source Type**: ${source.sourceType}`,
          `- **Source Url Or Identifier**: ${source.sourceUrlOrIdentifier}`,
          `- **Requires Manual Input**: ${source.requiresManualInput ? "yes" : "no"}`,
          `- **Compliance Notes**: ${source.complianceNotes}`,
          `- **Rate Limit Notes**: ${source.rateLimitNotes}`,
          `- **Freshness Expectation**: ${source.freshnessExpectation}`,
          `- **Reliability Notes**: ${source.reliabilityNotes}`,
          `- **Extraction Target**: ${source.extractionTarget}`,
          `- **Allowed Action Authority**: ${source.allowedActionAuthority}`,
          `- **Is Publicly Accessible**: ${source.isPubliclyAccessible ? "yes" : "no"}`,
          "#### Allowed Collection Methods",
          ...(source.allowedCollectionMethods.length > 0
            ? source.allowedCollectionMethods.map((method) => `- ${method}`)
            : ["- none"]),
          "",
        ])
      : ["- No finance article source has been recorded yet.", ""]),
  ].join("\n");
}

export function parseFinanceLearningCapabilityCandidateArtifact(
  content: string,
): ParsedFinanceLearningCapabilityCandidateArtifact | undefined {
  const updatedAt = content.match(/- \*\*Updated At\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const frameworkContractPath = content
    .match(/- \*\*Framework Contract Path\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  if (!updatedAt || !frameworkContractPath) {
    return undefined;
  }
  const candidateBlocks = [
    ...content.matchAll(
      /### Capability Candidate \d+\n([\s\S]*?)(?=\n### Capability Candidate \d+\n|\n?$)/gu,
    ),
  ]
    .map((match) => match[1]?.trim())
    .filter(Boolean);
  const candidates = candidateBlocks
    .map((block) => {
      const candidateId = block.match(/- \*\*Candidate Id\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const sourceArticlePath = block
        .match(/- \*\*Source Article Path\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const title = block.match(/- \*\*Title\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const sourceType = normalizeFinanceLearningSourceType(
        block.match(/- \*\*Source Type\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      const collectionMethod = normalizeFinanceLearningCollectionMethod(
        block.match(/- \*\*Collection Method\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      const authorSourceName = block.match(/- \*\*Author Source Name\*\*: ([^\r\n]*)/)?.[1]?.trim();
      const publishDate = block.match(/- \*\*Publish Date\*\*: ([^\r\n]*)/)?.[1]?.trim();
      const extractionSummary = block
        .match(/- \*\*Extraction Summary\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const rawNotes = block.match(/- \*\*Raw Notes\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const capabilityName = block.match(/- \*\*Capability Name\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const capabilityType = normalizeFinanceLearningCapabilityType(
        block.match(/- \*\*Capability Type\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      const evidenceSummary = block.match(/- \*\*Evidence Summary\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const methodSummary = block.match(/- \*\*Method Summary\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const causalOrMechanisticClaim = block
        .match(/- \*\*Causal Or Mechanistic Claim\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const evidenceLevel = normalizeFinanceLearningEvidenceLevel(
        block.match(/- \*\*Evidence Level\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      const implementationRequirements = block
        .match(/- \*\*Implementation Requirements\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const riskAndFailureModes = block
        .match(/- \*\*Risk And Failure Modes\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const overfittingOrSpuriousRisk = block
        .match(/- \*\*Overfitting Or Spurious Risk\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const complianceOrCollectionNotes = block
        .match(/- \*\*Compliance Or Collection Notes\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const suggestedAttachmentPoint = block
        .match(/- \*\*Suggested Attachment Point\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const allowedActionAuthority = normalizeFinanceFrameworkAllowedActionAuthority(
        block.match(/- \*\*Allowed Action Authority\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      const relatedFinanceDomains = extractSectionList(block, "#### Related Finance Domains")
        .map((item) => normalizeFinanceFrameworkCoreDomain(item))
        .filter((item): item is FinanceFrameworkCoreDomain => Boolean(item));
      const capabilityTags = extractSectionList(block, "#### Capability Tags")
        .map((item) => normalizeFinanceLearningCapabilityTag(item))
        .filter((item): item is FinanceLearningCapabilityTag => Boolean(item));
      const evidenceCategories = extractSectionList(block, "#### Evidence Categories")
        .map((item) => normalizeFinanceEvidenceCategory(item))
        .filter((item): item is FinanceEvidenceCategory => Boolean(item));
      const requiredDataSources = extractSectionList(block, "#### Required Data Sources");
      if (
        !candidateId ||
        !sourceArticlePath ||
        !title ||
        !sourceType ||
        !collectionMethod ||
        !extractionSummary ||
        !rawNotes ||
        !capabilityName ||
        !capabilityType ||
        !evidenceSummary ||
        !methodSummary ||
        !causalOrMechanisticClaim ||
        !evidenceLevel ||
        !implementationRequirements ||
        !riskAndFailureModes ||
        !overfittingOrSpuriousRisk ||
        !complianceOrCollectionNotes ||
        !suggestedAttachmentPoint ||
        !allowedActionAuthority ||
        relatedFinanceDomains.length === 0 ||
        capabilityTags.length === 0 ||
        evidenceCategories.length === 0 ||
        requiredDataSources.length === 0
      ) {
        return undefined;
      }
      return {
        candidateId,
        sourceArticlePath,
        title,
        sourceType,
        collectionMethod,
        authorSourceName: authorSourceName || undefined,
        publishDate: publishDate || undefined,
        extractionSummary,
        rawNotes,
        capabilityName,
        capabilityType,
        relatedFinanceDomains,
        capabilityTags,
        evidenceCategories,
        evidenceSummary,
        methodSummary,
        requiredDataSources,
        causalOrMechanisticClaim,
        evidenceLevel,
        implementationRequirements,
        riskAndFailureModes,
        overfittingOrSpuriousRisk,
        complianceOrCollectionNotes,
        suggestedAttachmentPoint,
        allowedActionAuthority,
      };
    })
    .filter(
      (candidate): candidate is FinanceLearningCapabilityCandidateArtifact["candidates"][number] =>
        Boolean(candidate),
    );
  if (candidateBlocks.length > 0 && candidates.length !== candidateBlocks.length) {
    return undefined;
  }
  return {
    updatedAt,
    frameworkContractPath,
    candidates,
  };
}

export function parseFinanceArticleSourceRegistryArtifact(
  content: string,
): ParsedFinanceArticleSourceRegistryArtifact | undefined {
  const updatedAt = content.match(/- \*\*Updated At\*\*: ([^\r\n]+)/)?.[1]?.trim();
  if (!updatedAt) {
    return undefined;
  }
  const sourceBlocks = [
    ...content.matchAll(/### Source \d+\n([\s\S]*?)(?=\n### Source \d+\n|\n?$)/gu),
  ]
    .map((match) => match[1]?.trim())
    .filter(Boolean);
  const sources = sourceBlocks
    .map((block) => {
      const sourceName = block.match(/- \*\*Source Name\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const sourceType = normalizeFinanceArticleSourceType(
        block.match(/- \*\*Source Type\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      const sourceUrlOrIdentifier = block
        .match(/- \*\*Source Url Or Identifier\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const requiresManualInputRaw = block
        .match(/- \*\*Requires Manual Input\*\*: ([^\r\n]+)/)?.[1]
        ?.trim()
        .toLowerCase();
      const complianceNotes = block.match(/- \*\*Compliance Notes\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const rateLimitNotes = block.match(/- \*\*Rate Limit Notes\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const freshnessExpectation = block
        .match(/- \*\*Freshness Expectation\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const reliabilityNotes = block.match(/- \*\*Reliability Notes\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const extractionTarget = block.match(/- \*\*Extraction Target\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const allowedActionAuthority = normalizeFinanceFrameworkAllowedActionAuthority(
        block.match(/- \*\*Allowed Action Authority\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      const isPubliclyAccessibleRaw = block
        .match(/- \*\*Is Publicly Accessible\*\*: ([^\r\n]+)/)?.[1]
        ?.trim()
        .toLowerCase();
      const allowedCollectionMethods = [...block.matchAll(/^-\s+([a-z_]+)$/gmu)]
        .map((match) => normalizeFinanceArticleSourceCollectionMethod(match[1]?.trim()))
        .filter(
          (
            method,
          ): method is FinanceArticleSourceRegistryArtifact["sources"][number]["allowedCollectionMethods"][number] =>
            Boolean(method),
        );
      if (
        !sourceName ||
        !sourceType ||
        !sourceUrlOrIdentifier ||
        !complianceNotes ||
        !rateLimitNotes ||
        !freshnessExpectation ||
        !reliabilityNotes ||
        !extractionTarget ||
        !allowedActionAuthority ||
        !["yes", "no"].includes(requiresManualInputRaw ?? "") ||
        !["yes", "no"].includes(isPubliclyAccessibleRaw ?? "") ||
        allowedCollectionMethods.length === 0
      ) {
        return undefined;
      }
      return {
        sourceName,
        sourceType,
        sourceUrlOrIdentifier,
        allowedCollectionMethods,
        requiresManualInput: requiresManualInputRaw === "yes",
        complianceNotes,
        rateLimitNotes,
        freshnessExpectation,
        reliabilityNotes,
        extractionTarget,
        allowedActionAuthority,
        isPubliclyAccessible: isPubliclyAccessibleRaw === "yes",
      };
    })
    .filter((source): source is FinanceArticleSourceRegistryArtifact["sources"][number] =>
      Boolean(source),
    );
  if (sourceBlocks.length > 0 && sources.length !== sourceBlocks.length) {
    return undefined;
  }
  return {
    updatedAt,
    sources,
  };
}

export function renderFeishuFinanceDoctrinePromotionCandidateArtifact(
  artifact: FeishuFinanceDoctrinePromotionCandidateArtifact,
): string {
  return [
    "# Feishu Finance Doctrine Promotion Candidates",
    "",
    `- **Generated At**: ${artifact.generatedAt}`,
    `- **Consumer**: ${artifact.consumer}`,
    `- **Window Days**: ${artifact.windowDays}`,
    `- **Window Start Date**: ${artifact.windowStartDate}`,
    `- **Window End Date**: ${artifact.windowEndDate}`,
    `- **Total Calibration Notes**: ${artifact.totalCalibrationNotes}`,
    "",
    "## Candidates",
    ...(artifact.candidates.length > 0
      ? artifact.candidates.flatMap((candidate, index) => [
          `### Candidate ${index + 1}`,
          `- **Candidate Key**: ${candidate.candidateKey}`,
          `- **Signal**: ${candidate.signal}`,
          `- **Observed Value**: ${candidate.observedValue}`,
          `- **Occurrences**: ${candidate.occurrences}`,
          `- **Review State**: ${candidate.reviewState}`,
          ...(candidate.reviewNotes ? [`- **Review Notes**: ${candidate.reviewNotes}`] : []),
          `- **Candidate Text**: ${candidate.candidateText}`,
          `- **Not Enough For Promotion**: ${candidate.notEnoughForPromotion}`,
          "",
        ])
      : ["- No promotion candidate met the repeat threshold yet.", ""]),
  ].join("\n");
}

function normalizeFinanceDoctrinePromotionReviewState(
  value: string | undefined,
):
  | FeishuFinanceDoctrinePromotionCandidateArtifact["candidates"][number]["reviewState"]
  | undefined {
  if (!value) {
    return undefined;
  }
  switch (value) {
    case "pending":
      return "unreviewed";
    case "reviewed_defer":
      return "deferred";
    case "reviewed_reject":
      return "rejected";
    case "unreviewed":
    case "deferred":
    case "rejected":
    case "ready_for_manual_promotion":
      return value;
    default:
      return undefined;
  }
}

function normalizeFinanceDoctrinePromotionDecisionOutcome(
  value: string | undefined,
):
  | FeishuFinanceDoctrinePromotionDecisionArtifact["decisions"][number]["decisionOutcome"]
  | undefined {
  if (!value) {
    return undefined;
  }
  switch (value) {
    case "proposal_created":
    case "deferred_after_promotion_review":
    case "rejected_after_promotion_review":
      return value;
    default:
      return undefined;
  }
}

function normalizeFinanceDoctrinePromotionProposalStatus(
  value: string | undefined,
): FeishuFinanceDoctrinePromotionProposalArtifact["proposals"][number]["status"] | undefined {
  if (!value) {
    return undefined;
  }
  switch (value) {
    case "draft":
    case "accepted_for_manual_edit":
    case "rejected":
    case "superseded":
      return value;
    default:
      return undefined;
  }
}

function normalizeFinanceDoctrineTeacherFeedbackCritiqueType(
  value: string | undefined,
): FeishuFinanceDoctrineTeacherFeedbackArtifact["feedbacks"][number]["critiqueType"] | undefined {
  if (!value) {
    return undefined;
  }
  switch (value) {
    case "missing_causal_chain":
    case "overconfident_conviction":
    case "missing_bear_case":
    case "weak_no_action_justification":
    case "weak_instrument_choice":
    case "weak_risk_gate":
      return value;
    default:
      return undefined;
  }
}

function normalizeFinanceDoctrineTeacherReviewOutcome(
  value: string | undefined,
): FeishuFinanceDoctrineTeacherReviewArtifact["reviews"][number]["reviewOutcome"] | undefined {
  if (!value) {
    return undefined;
  }
  switch (value) {
    case "deferred":
    case "rejected":
    case "elevated_for_governance_review":
      return value;
    default:
      return undefined;
  }
}

function normalizeFinanceDoctrineTeacherElevationHandoffStatus(
  value: string | undefined,
): FeishuFinanceDoctrineTeacherElevationHandoffArtifact["handoffs"][number]["status"] | undefined {
  if (!value) {
    return undefined;
  }
  switch (value) {
    case "open":
    case "converted_to_candidate_input":
    case "rejected_after_handoff_review":
    case "superseded":
      return value;
    default:
      return undefined;
  }
}

function normalizeFinanceDoctrineTeacherCandidateInputReviewOutcome(
  value: string | undefined,
):
  | FeishuFinanceDoctrineTeacherCandidateInputReviewArtifact["reviews"][number]["reviewOutcome"]
  | undefined {
  if (!value) {
    return undefined;
  }
  switch (value) {
    case "consumed_into_candidate_flow":
    case "rejected_before_candidate_flow":
    case "superseded":
      return value;
    default:
      return undefined;
  }
}

function normalizeFinanceDoctrineTeacherCandidateInputReconciliationMode(
  value: string | undefined,
):
  | FeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact["reconciliations"][number]["reconciliationMode"]
  | undefined {
  if (!value) {
    return undefined;
  }
  switch (value) {
    case "link_existing_candidate":
    case "new_candidate_reference":
      return value;
    default:
      return undefined;
  }
}

function normalizeFinanceDoctrineTeacherCandidateInputReconciliationStatus(
  value: string | undefined,
):
  | FeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact["reconciliations"][number]["status"]
  | undefined {
  if (!value) {
    return undefined;
  }
  switch (value) {
    case "open":
    case "linked_to_existing_candidate":
    case "created_as_new_candidate_reference":
    case "rejected_before_reconciliation":
    case "superseded":
      return value;
    default:
      return undefined;
  }
}

function normalizeFinanceFrameworkCoreDomain(
  value: string | undefined,
): FinanceFrameworkCoreDomain | undefined {
  if (!value) {
    return undefined;
  }
  if ((FINANCE_FRAMEWORK_CORE_DOMAINS as readonly string[]).includes(value)) {
    return value as FinanceFrameworkCoreDomain;
  }
  return undefined;
}

function normalizeFinanceFrameworkAllowedActionAuthority(
  value: string | undefined,
): FinanceFrameworkAllowedActionAuthority | undefined {
  if (!value) {
    return undefined;
  }
  if ((FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES as readonly string[]).includes(value)) {
    return value as FinanceFrameworkAllowedActionAuthority;
  }
  return undefined;
}

function normalizeFinanceFrameworkConfidenceOrConviction(
  value: string | undefined,
): FinanceFrameworkConfidenceOrConviction | undefined {
  if (!value) {
    return undefined;
  }
  if ((FINANCE_FRAMEWORK_CONFIDENCE_OR_CONVICTION_LEVELS as readonly string[]).includes(value)) {
    return value as FinanceFrameworkConfidenceOrConviction;
  }
  return undefined;
}

function normalizeFinanceLearningCapabilityType(
  value: string | undefined,
): FinanceLearningCapabilityType | undefined {
  if (!value) {
    return undefined;
  }
  if ((FINANCE_LEARNING_CAPABILITY_TYPES as readonly string[]).includes(value)) {
    return value as FinanceLearningCapabilityType;
  }
  return undefined;
}

function normalizeFinanceLearningCapabilityTag(
  value: string | undefined,
): FinanceLearningCapabilityTag | undefined {
  if (!value) {
    return undefined;
  }
  if ((FINANCE_LEARNING_CAPABILITY_TAGS as readonly string[]).includes(value)) {
    return value as FinanceLearningCapabilityTag;
  }
  return undefined;
}

function normalizeFinanceLearningSourceType(
  value: string | undefined,
): FinanceLearningSourceType | undefined {
  if (!value) {
    return undefined;
  }
  if ((FINANCE_LEARNING_SOURCE_TYPES as readonly string[]).includes(value)) {
    return value as FinanceLearningSourceType;
  }
  return undefined;
}

function normalizeFinanceLearningCollectionMethod(
  value: string | undefined,
): FinanceLearningCollectionMethod | undefined {
  if (!value) {
    return undefined;
  }
  if ((FINANCE_LEARNING_COLLECTION_METHODS as readonly string[]).includes(value)) {
    return value as FinanceLearningCollectionMethod;
  }
  return undefined;
}

function normalizeFinanceLearningEvidenceLevel(
  value: string | undefined,
): FinanceLearningEvidenceLevel | undefined {
  if (!value) {
    return undefined;
  }
  if ((FINANCE_LEARNING_EVIDENCE_LEVELS as readonly string[]).includes(value)) {
    return value as FinanceLearningEvidenceLevel;
  }
  return undefined;
}

function normalizeFinanceArticleSourceType(
  value: string | undefined,
): FinanceArticleSourceType | undefined {
  if (!value) {
    return undefined;
  }
  if ((FINANCE_ARTICLE_SOURCE_TYPES as readonly string[]).includes(value)) {
    return value as FinanceArticleSourceType;
  }
  return undefined;
}

function normalizeFinanceArticleSourceCollectionMethod(
  value: string | undefined,
): FinanceArticleSourceCollectionMethod | undefined {
  if (!value) {
    return undefined;
  }
  if ((FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS as readonly string[]).includes(value)) {
    return value as FinanceArticleSourceCollectionMethod;
  }
  return undefined;
}

function normalizeFinanceEvidenceCategory(
  value: string | undefined,
): FinanceEvidenceCategory | undefined {
  if (!value) {
    return undefined;
  }
  if ((FINANCE_EVIDENCE_CATEGORIES as readonly string[]).includes(value)) {
    return value as FinanceEvidenceCategory;
  }
  return undefined;
}

function extractSectionList(block: string, heading: string): string[] {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = block.match(
    new RegExp(`${escapedHeading}\\n([\\s\\S]*?)(?=\\n#### |\\n- \\*\\*|$)`, "u"),
  );
  if (!match?.[1]) {
    return [];
  }
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => Boolean(line) && line !== "none");
}

function normalizeFinanceDoctrineEditHandoffStatus(
  value: string | undefined,
): FeishuFinanceDoctrineEditHandoffArtifact["handoffs"][number]["status"] | undefined {
  if (!value) {
    return undefined;
  }
  switch (value) {
    case "open":
    case "applied_manually":
    case "rejected_after_edit_review":
    case "superseded":
      return value;
    default:
      return undefined;
  }
}

export function parseFeishuFinanceDoctrinePromotionCandidateArtifact(
  content: string,
): ParsedFeishuFinanceDoctrinePromotionCandidateArtifact | undefined {
  const generatedAt = content.match(/- \*\*Generated At\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const consumer = content.match(/- \*\*Consumer\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const windowDaysRaw = content.match(/- \*\*Window Days\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const windowStartDate = content.match(/- \*\*Window Start Date\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const windowEndDate = content.match(/- \*\*Window End Date\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const totalCalibrationNotesRaw = content
    .match(/- \*\*Total Calibration Notes\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  const windowDays = Number(windowDaysRaw ?? "NaN");
  const totalCalibrationNotes = Number(totalCalibrationNotesRaw ?? "NaN");
  if (
    !generatedAt ||
    !consumer ||
    !windowStartDate ||
    !windowEndDate ||
    !Number.isFinite(windowDays) ||
    !Number.isFinite(totalCalibrationNotes)
  ) {
    return undefined;
  }
  const candidates = [
    ...content.matchAll(/### Candidate \d+\n([\s\S]*?)(?=\n### Candidate \d+\n|\n?$)/gu),
  ]
    .map((match) => match[1]?.trim())
    .filter(Boolean)
    .map((block) => {
      const candidateKey = block.match(/- \*\*Candidate Key\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const signal = block.match(/- \*\*Signal\*\*: ([^\r\n]+)/)?.[1]?.trim() as
        | FeishuFinanceDoctrinePromotionCandidateArtifact["candidates"][number]["signal"]
        | undefined;
      const observedValue = block.match(/- \*\*Observed Value\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const occurrencesRaw = block.match(/- \*\*Occurrences\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const reviewState = normalizeFinanceDoctrinePromotionReviewState(
        block.match(/- \*\*Review State\*\*: ([^\r\n]+)/)?.[1]?.trim() ?? "unreviewed",
      );
      const reviewNotes = block.match(/- \*\*Review Notes\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const candidateText = block.match(/- \*\*Candidate Text\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const notEnoughForPromotion = block
        .match(/- \*\*Not Enough For Promotion\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const occurrences = Number(occurrencesRaw ?? "NaN");
      if (
        !(candidateKey || (signal && observedValue)) ||
        !signal ||
        !observedValue ||
        !Number.isFinite(occurrences) ||
        !reviewState ||
        !candidateText ||
        !notEnoughForPromotion
      ) {
        return undefined;
      }
      return {
        candidateKey: candidateKey ?? `${signal}:${observedValue}`,
        signal,
        observedValue,
        occurrences,
        reviewState,
        reviewNotes,
        candidateText,
        notEnoughForPromotion,
      };
    })
    .filter(
      (
        candidate,
      ): candidate is FeishuFinanceDoctrinePromotionCandidateArtifact["candidates"][number] =>
        Boolean(candidate),
    );
  return {
    generatedAt,
    consumer,
    windowDays,
    windowStartDate,
    windowEndDate,
    totalCalibrationNotes,
    candidates,
  };
}

export function renderFeishuFinanceDoctrinePromotionReviewArtifact(
  artifact: FeishuFinanceDoctrinePromotionReviewArtifact,
): string {
  return [
    "# Feishu Finance Doctrine Promotion Review",
    "",
    `- **Reviewed At**: ${artifact.reviewedAt}`,
    `- **Consumer**: ${artifact.consumer}`,
    `- **Linked Candidate Artifact**: ${artifact.linkedCandidateArtifact}`,
    "",
    "## Reviews",
    ...(artifact.reviews.length > 0
      ? artifact.reviews.flatMap((review, index) => [
          `### Review ${index + 1}`,
          `- **Candidate Key**: ${review.candidateKey}`,
          `- **Review State**: ${review.reviewState}`,
          ...(review.reviewNotes ? [`- **Review Notes**: ${review.reviewNotes}`] : []),
          "",
        ])
      : ["- No review state has been recorded yet.", ""]),
  ].join("\n");
}

export function parseFeishuFinanceDoctrinePromotionReviewArtifact(
  content: string,
): ParsedFeishuFinanceDoctrinePromotionReviewArtifact | undefined {
  const reviewedAt = content.match(/- \*\*Reviewed At\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const consumer = content.match(/- \*\*Consumer\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const linkedCandidateArtifact = content
    .match(/- \*\*Linked Candidate Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  if (!reviewedAt || !consumer || !linkedCandidateArtifact) {
    return undefined;
  }
  const reviews = [...content.matchAll(/### Review \d+\n([\s\S]*?)(?=\n### Review \d+\n|\n?$)/gu)]
    .map((match) => match[1]?.trim())
    .filter(Boolean)
    .map((block) => {
      const candidateKey = block.match(/- \*\*Candidate Key\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const reviewState = normalizeFinanceDoctrinePromotionReviewState(
        block.match(/- \*\*Review State\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      const reviewNotes = block.match(/- \*\*Review Notes\*\*: ([^\r\n]+)/)?.[1]?.trim();
      if (!candidateKey || !reviewState) {
        return undefined;
      }
      return {
        candidateKey,
        reviewState,
        reviewNotes,
      };
    })
    .filter((review): review is FeishuFinanceDoctrinePromotionReviewArtifact["reviews"][number] =>
      Boolean(review),
    );
  return {
    reviewedAt,
    consumer,
    linkedCandidateArtifact,
    reviews,
  };
}

export function renderFeishuFinanceDoctrinePromotionDecisionArtifact(
  artifact: FeishuFinanceDoctrinePromotionDecisionArtifact,
): string {
  return [
    "# Feishu Finance Doctrine Promotion Decisions",
    "",
    `- **Decided At**: ${artifact.decidedAt}`,
    `- **Consumer**: ${artifact.consumer}`,
    `- **Linked Candidate Artifact**: ${artifact.linkedCandidateArtifact}`,
    `- **Linked Review Artifact**: ${artifact.linkedReviewArtifact}`,
    "",
    "## Decisions",
    ...(artifact.decisions.length > 0
      ? artifact.decisions.flatMap((decision, index) => [
          `### Decision ${index + 1}`,
          `- **Candidate Key**: ${decision.candidateKey}`,
          `- **Decision Outcome**: ${decision.decisionOutcome}`,
          `- **Review State At Decision**: ${decision.reviewStateAtDecision}`,
          ...(decision.decisionNotes ? [`- **Decision Notes**: ${decision.decisionNotes}`] : []),
          "",
        ])
      : ["- No promotion decision has been recorded yet.", ""]),
  ].join("\n");
}

export function parseFeishuFinanceDoctrinePromotionDecisionArtifact(
  content: string,
): ParsedFeishuFinanceDoctrinePromotionDecisionArtifact | undefined {
  const decidedAt = content.match(/- \*\*Decided At\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const consumer = content.match(/- \*\*Consumer\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const linkedCandidateArtifact = content
    .match(/- \*\*Linked Candidate Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  const linkedReviewArtifact = content
    .match(/- \*\*Linked Review Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  if (!decidedAt || !consumer || !linkedCandidateArtifact || !linkedReviewArtifact) {
    return undefined;
  }
  const decisions = [
    ...content.matchAll(/### Decision \d+\n([\s\S]*?)(?=\n### Decision \d+\n|\n?$)/gu),
  ]
    .map((match) => match[1]?.trim())
    .filter(Boolean)
    .map((block) => {
      const candidateKey = block.match(/- \*\*Candidate Key\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const decisionOutcome = normalizeFinanceDoctrinePromotionDecisionOutcome(
        block.match(/- \*\*Decision Outcome\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      const reviewStateAtDecision = normalizeFinanceDoctrinePromotionReviewState(
        block.match(/- \*\*Review State At Decision\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      const decisionNotes = block.match(/- \*\*Decision Notes\*\*: ([^\r\n]+)/)?.[1]?.trim();
      if (
        !candidateKey ||
        !decisionOutcome ||
        reviewStateAtDecision !== "ready_for_manual_promotion"
      ) {
        return undefined;
      }
      return {
        candidateKey,
        decisionOutcome,
        reviewStateAtDecision,
        decisionNotes,
      };
    })
    .filter(
      (decision): decision is FeishuFinanceDoctrinePromotionDecisionArtifact["decisions"][number] =>
        Boolean(decision),
    );
  return {
    decidedAt,
    consumer,
    linkedCandidateArtifact,
    linkedReviewArtifact,
    decisions,
  };
}

export function renderFeishuFinanceDoctrinePromotionProposalArtifact(
  artifact: FeishuFinanceDoctrinePromotionProposalArtifact,
): string {
  return [
    "# Feishu Finance Doctrine Promotion Proposals",
    "",
    `- **Drafted At**: ${artifact.draftedAt}`,
    `- **Consumer**: ${artifact.consumer}`,
    `- **Source Decision Artifact**: ${artifact.sourceDecisionArtifact}`,
    `- **Linked Candidate Artifact**: ${artifact.linkedCandidateArtifact}`,
    `- **Linked Review Artifact**: ${artifact.linkedReviewArtifact}`,
    "",
    "## Proposals",
    ...(artifact.proposals.length > 0
      ? artifact.proposals.flatMap((proposal, index) => [
          `### Proposal ${index + 1}`,
          `- **Proposal ID**: ${proposal.proposalId}`,
          `- **Candidate Key**: ${proposal.candidateKey}`,
          `- **Source Candidate Text**: ${proposal.sourceCandidateText}`,
          `- **Proposed Doctrine Change**: ${proposal.proposedDoctrineChange}`,
          `- **Rationale From Calibration**: ${proposal.rationaleFromCalibration}`,
          `- **Risk Or Counterargument**: ${proposal.riskOrCounterargument}`,
          `- **Operator Next Action**: ${proposal.operatorNextAction}`,
          `- **Status**: ${proposal.status}`,
          "",
        ])
      : ["- No promotion proposal draft has been recorded yet.", ""]),
  ].join("\n");
}

export function parseFeishuFinanceDoctrinePromotionProposalArtifact(
  content: string,
): ParsedFeishuFinanceDoctrinePromotionProposalArtifact | undefined {
  const draftedAt = content.match(/- \*\*Drafted At\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const consumer = content.match(/- \*\*Consumer\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const sourceDecisionArtifact = content
    .match(/- \*\*Source Decision Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  const linkedCandidateArtifact = content
    .match(/- \*\*Linked Candidate Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  const linkedReviewArtifact = content
    .match(/- \*\*Linked Review Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  if (
    !draftedAt ||
    !consumer ||
    !sourceDecisionArtifact ||
    !linkedCandidateArtifact ||
    !linkedReviewArtifact
  ) {
    return undefined;
  }
  const proposals = [
    ...content.matchAll(/### Proposal \d+\n([\s\S]*?)(?=\n### Proposal \d+\n|\n?$)/gu),
  ]
    .map((match) => match[1]?.trim())
    .filter(Boolean)
    .map((block) => {
      const proposalId = block.match(/- \*\*Proposal ID\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const candidateKey = block.match(/- \*\*Candidate Key\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const sourceCandidateText = block
        .match(/- \*\*Source Candidate Text\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const proposedDoctrineChange = block
        .match(/- \*\*Proposed Doctrine Change\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const rationaleFromCalibration = block
        .match(/- \*\*Rationale From Calibration\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const riskOrCounterargument = block
        .match(/- \*\*Risk Or Counterargument\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const operatorNextAction = block
        .match(/- \*\*Operator Next Action\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const status = normalizeFinanceDoctrinePromotionProposalStatus(
        block.match(/- \*\*Status\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      if (
        !proposalId ||
        !candidateKey ||
        !sourceCandidateText ||
        !proposedDoctrineChange ||
        !rationaleFromCalibration ||
        !riskOrCounterargument ||
        !operatorNextAction ||
        !status
      ) {
        return undefined;
      }
      return {
        proposalId,
        candidateKey,
        sourceCandidateText,
        proposedDoctrineChange,
        rationaleFromCalibration,
        riskOrCounterargument,
        operatorNextAction,
        status,
      };
    })
    .filter(
      (proposal): proposal is FeishuFinanceDoctrinePromotionProposalArtifact["proposals"][number] =>
        Boolean(proposal),
    );
  return {
    draftedAt,
    consumer,
    sourceDecisionArtifact,
    linkedCandidateArtifact,
    linkedReviewArtifact,
    proposals,
  };
}

export function renderFeishuFinanceDoctrineEditHandoffArtifact(
  artifact: FeishuFinanceDoctrineEditHandoffArtifact,
): string {
  return [
    "# Feishu Finance Doctrine Edit Handoffs",
    "",
    `- **Handed Off At**: ${artifact.handedOffAt}`,
    `- **Consumer**: ${artifact.consumer}`,
    `- **Source Proposal Artifact**: ${artifact.sourceProposalArtifact}`,
    ...(artifact.sourceDecisionArtifact
      ? [`- **Source Decision Artifact**: ${artifact.sourceDecisionArtifact}`]
      : []),
    ...(artifact.linkedCandidateArtifact
      ? [`- **Linked Candidate Artifact**: ${artifact.linkedCandidateArtifact}`]
      : []),
    ...(artifact.linkedReviewArtifact
      ? [`- **Linked Review Artifact**: ${artifact.linkedReviewArtifact}`]
      : []),
    "",
    "## Handoffs",
    ...(artifact.handoffs.length > 0
      ? artifact.handoffs.flatMap((handoff, index) => [
          `### Handoff ${index + 1}`,
          `- **Handoff ID**: ${handoff.handoffId}`,
          `- **Proposal ID**: ${handoff.proposalId}`,
          `- **Candidate Key**: ${handoff.candidateKey}`,
          `- **Proposed Doctrine Change**: ${handoff.proposedDoctrineChange}`,
          `- **Rationale From Calibration**: ${handoff.rationaleFromCalibration}`,
          `- **Risk Or Counterargument**: ${handoff.riskOrCounterargument}`,
          `- **Target Doctrine Or Card**: ${handoff.targetDoctrineOrCard}`,
          `- **Manual Edit Checklist**: ${handoff.manualEditChecklist}`,
          `- **Operator Decision Needed**: ${handoff.operatorDecisionNeeded}`,
          `- **Status**: ${handoff.status}`,
          "",
        ])
      : ["- No doctrine-edit handoff has been recorded yet.", ""]),
  ].join("\n");
}

export function parseFeishuFinanceDoctrineEditHandoffArtifact(
  content: string,
): ParsedFeishuFinanceDoctrineEditHandoffArtifact | undefined {
  const handedOffAt = content.match(/- \*\*Handed Off At\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const consumer = content.match(/- \*\*Consumer\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const sourceProposalArtifact = content
    .match(/- \*\*Source Proposal Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  if (!handedOffAt || !consumer || !sourceProposalArtifact) {
    return undefined;
  }
  const sourceDecisionArtifact = content
    .match(/- \*\*Source Decision Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  const linkedCandidateArtifact = content
    .match(/- \*\*Linked Candidate Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  const linkedReviewArtifact = content
    .match(/- \*\*Linked Review Artifact\*\*: ([^\r\n]+)/)?.[1]
    ?.trim();
  const handoffs = [
    ...content.matchAll(/### Handoff \d+\n([\s\S]*?)(?=\n### Handoff \d+\n|\n?$)/gu),
  ]
    .map((match) => match[1]?.trim())
    .filter(Boolean)
    .map((block) => {
      const handoffId = block.match(/- \*\*Handoff ID\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const proposalId = block.match(/- \*\*Proposal ID\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const candidateKey = block.match(/- \*\*Candidate Key\*\*: ([^\r\n]+)/)?.[1]?.trim();
      const proposedDoctrineChange = block
        .match(/- \*\*Proposed Doctrine Change\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const rationaleFromCalibration = block
        .match(/- \*\*Rationale From Calibration\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const riskOrCounterargument = block
        .match(/- \*\*Risk Or Counterargument\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const targetDoctrineOrCard = block
        .match(/- \*\*Target Doctrine Or Card\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const manualEditChecklist = block
        .match(/- \*\*Manual Edit Checklist\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const operatorDecisionNeeded = block
        .match(/- \*\*Operator Decision Needed\*\*: ([^\r\n]+)/)?.[1]
        ?.trim();
      const status = normalizeFinanceDoctrineEditHandoffStatus(
        block.match(/- \*\*Status\*\*: ([^\r\n]+)/)?.[1]?.trim(),
      );
      if (
        !handoffId ||
        !proposalId ||
        !candidateKey ||
        !proposedDoctrineChange ||
        !rationaleFromCalibration ||
        !riskOrCounterargument ||
        !targetDoctrineOrCard ||
        !manualEditChecklist ||
        !operatorDecisionNeeded ||
        !status
      ) {
        return undefined;
      }
      return {
        handoffId,
        proposalId,
        candidateKey,
        proposedDoctrineChange,
        rationaleFromCalibration,
        riskOrCounterargument,
        targetDoctrineOrCard,
        manualEditChecklist,
        operatorDecisionNeeded,
        status,
      };
    })
    .filter((handoff): handoff is FeishuFinanceDoctrineEditHandoffArtifact["handoffs"][number] =>
      Boolean(handoff),
    );
  return {
    handedOffAt,
    consumer,
    sourceProposalArtifact,
    sourceDecisionArtifact,
    linkedCandidateArtifact,
    linkedReviewArtifact,
    handoffs,
  };
}

export function renderFeishuSurfaceLanePanelArtifact(
  artifact: FeishuSurfaceLanePanelArtifact,
): string {
  return [
    "# Feishu Surface Lane Panel",
    "",
    `- **Active Lanes**: ${artifact.activeLanes}`,
    "",
    "## Lane Meter",
    ...artifact.laneMeterLines,
    "",
  ].join("\n");
}

export function parseFeishuSurfaceLanePanelArtifact(
  content: string,
): ParsedFeishuSurfaceLanePanelArtifact | undefined {
  const activeRaw = content.match(/- \*\*Active Lanes\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const active = activeRaw ? Number(activeRaw) : Number.NaN;
  const laneMeterLines = extractSectionBulletLines(content, "Lane Meter");
  if (!Number.isFinite(active) && laneMeterLines.length === 0) {
    return undefined;
  }
  return {
    activeLanes: Number.isFinite(active) ? active : undefined,
    laneMeterLines,
  };
}

export function renderFeishuSurfaceLaneHealthArtifact(
  artifact: FeishuSurfaceLaneHealthArtifact,
): string {
  return [
    "# Feishu Surface Lane Health",
    "",
    `- **Status**: ${artifact.status}`,
    `- **Active Lanes**: ${artifact.activeLanes}`,
    `- **Crowded Chats**: ${artifact.crowdedChats.length > 0 ? artifact.crowdedChats.join(", ") : "none"}`,
    `- **Busiest Lane**: ${artifact.busiestLane ?? "none"}`,
    "",
    "## Guidance",
    ...artifact.guidanceLines,
    "",
  ].join("\n");
}

export function parseFeishuSurfaceLaneHealthArtifact(
  content: string,
): ParsedFeishuSurfaceLaneHealthArtifact | undefined {
  const status = content.match(/- \*\*Status\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const activeRaw = content.match(/- \*\*Active Lanes\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const activeLanes = Number(activeRaw ?? "NaN");
  const crowdedRaw = content.match(/- \*\*Crowded Chats\*\*: ([^\r\n]+)/)?.[1]?.trim();
  const busiestLane = content.match(/- \*\*Busiest Lane\*\*: ([^\r\n]+)/)?.[1]?.trim();
  if (!status || !Number.isFinite(activeLanes)) {
    return undefined;
  }
  return {
    status,
    activeLanes,
    crowdedChats:
      crowdedRaw && crowdedRaw !== "none"
        ? crowdedRaw
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : [],
    busiestLane: busiestLane && busiestLane !== "none" ? busiestLane : undefined,
  };
}

export function renderKnowledgeValidationWeeklyArtifact(
  artifact: KnowledgeValidationWeeklyArtifact,
): string {
  return [
    `# Knowledge Validation Weekly: ${artifact.weekKey}`,
    "",
    `- **Window**: ${artifact.rangeLabel}`,
    `- **Session Key**: ${artifact.sessionKey}`,
    `- **Validation Notes**: ${artifact.validationNotes}`,
    `- **Benchmark Notes**: ${artifact.benchmarkNotes}`,
    `- **Daily Real-Task Notes**: ${artifact.dailyRealTaskNotes}`,
    "",
    "## Benchmark Coverage",
    ...artifact.benchmarkCoverageLines,
    "",
    "## Daily Real-Task Coverage",
    ...artifact.dailyRealTaskCoverageLines,
    "",
    "## Capability-Family Coverage",
    ...artifact.capabilityCoverageLines,
    "",
    "## Strongest Domains",
    ...artifact.strongestDomainLines,
    "",
    "## Weakest Domains",
    ...artifact.weakestDomainLines,
    "",
    "## Hallucination-Prone Domains",
    ...artifact.hallucinationProneLines,
    "",
    "## Correction Candidates",
    ...artifact.correctionCandidateLines,
    "",
    "## Repair-Ticket Candidates",
    ...artifact.repairTicketCandidateLines,
    "",
    "## Next Validation Focus",
    ...artifact.nextValidationFocusLines,
    "",
  ].join("\n");
}

export function parseKnowledgeValidationWeeklyArtifact(
  content: string,
): ParsedKnowledgeValidationWeeklyArtifact | undefined {
  const weekKey = content.match(/^# Knowledge Validation Weekly: ([^\r\n]+)/m)?.[1]?.trim();
  if (!weekKey) {
    return undefined;
  }
  return {
    weekKey,
    strongestDomain: extractFirstSectionBullet(
      content,
      "Strongest Domains",
      "No strongest-domain summary yet.",
    ),
    weakestDomain: extractFirstSectionBullet(
      content,
      "Weakest Domains",
      "No weakest-domain summary yet.",
    ),
    hallucinationDomain: extractFirstSectionBullet(
      content,
      "Hallucination-Prone Domains",
      "No hallucination-prone summary yet.",
    ),
  };
}

export function renderLearningReviewMemoryNote(artifact: LearningReviewMemoryNoteArtifact): string {
  return [
    `# Learning Review: ${artifact.dateStr} ${artifact.timeStr} UTC`,
    "",
    `- **Session Key**: ${artifact.sessionKey}`,
    `- **Session ID**: ${artifact.sessionId}`,
    `- **Topic**: ${artifact.topic}`,
    "",
    "## Problem",
    `- ${artifact.problem}`,
    "",
    "## Working Answer",
    `- ${artifact.workingAnswer}`,
    "",
    "## Review Note",
    `- mistake_pattern: ${artifact.mistakePattern}`,
    `- core_principle: ${artifact.corePrinciple}`,
    `- micro_drill: ${artifact.microDrill}`,
    `- transfer_hint: ${artifact.transferHint}`,
    "",
    "## Lobster Transfer",
    `- foundation_template: ${artifact.foundationTemplate}`,
    `- why_it_matters: ${artifact.whyItMatters}`,
    "",
    "## Session Trace",
    ...artifact.sessionTraceLines.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

export function renderLearningCouncilRuntimeArtifact(
  artifact: LearningCouncilRuntimeArtifact,
): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

export function renderMarketIntelligenceRuntimeArtifact(
  artifact: MarketIntelligenceRuntimeArtifact,
): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

export function renderMarketIntelligenceMemoryNote(
  artifact: MarketIntelligenceRuntimeArtifact,
): string {
  const comparedAgainst = artifact.comparedAgainst
    ? `${artifact.comparedAgainst.artifactPath} (${artifact.comparedAgainst.generatedAt})`
    : "none";
  const skillLabel = `${artifact.sourceContext.skillReceipt.skillName} / ${artifact.sourceContext.skillReceipt.status}`;
  return [
    `# Market Intelligence Packet: ${artifact.topicKey}`,
    "",
    `- **Generated At**: ${artifact.generatedAt}`,
    `- **Message ID**: ${artifact.messageId}`,
    `- **Material Change**: ${artifact.materialChangeFlag}`,
    `- **No Material Change**: ${artifact.noMaterialChange ? "yes" : "no"}`,
    `- **Confidence Band**: ${artifact.confidenceBand}`,
    `- **Skill Receipt**: ${skillLabel}`,
    `- **Compared Against**: ${comparedAgainst}`,
    `- **Fingerprint**: ${artifact.fingerprint}`,
    "",
    "## Survivor Theses",
    ...(artifact.survivorTheses.length > 0
      ? artifact.survivorTheses.map(
          (item) => `- ${item.label}: ${item.whySurvived} [${item.thesisId}]`,
        )
      : ["- no thesis survived strongly enough; keep this packet provisional."]),
    "",
    "## Evidence Gaps",
    ...(artifact.evidenceGaps.length > 0
      ? artifact.evidenceGaps.map((item) => `- ${item}`)
      : ["- no explicit evidence gap was extracted."]),
    "",
    "## Follow-Up Candidates",
    ...(artifact.followUpCandidates.length > 0
      ? artifact.followUpCandidates.map((item) => `- ${item}`)
      : ["- no follow-up candidate survived this pass."]),
    "",
    "## Distilled Residue",
    ...(artifact.distillation.retainedResidueLines.length > 0
      ? artifact.distillation.retainedResidueLines.map((item) => `- ${item}`)
      : ["- no residue line survived strongly enough yet."]),
    ...(artifact.doNotContinueReason
      ? ["", "## Do Not Continue", `- ${artifact.doNotContinueReason}`]
      : []),
    "",
  ].join("\n");
}

function parseStringArray(value: unknown, maxItems = 8): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function parseLearningCouncilRunPacket(value: unknown): LearningCouncilRunPacket | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const packet = value as {
    objective?: unknown;
    protectedAnchorsPresent?: unknown;
    protectedAnchorsMissing?: unknown;
    currentFocus?: unknown;
    topDecision?: unknown;
    recallOrder?: unknown;
    latestCarryoverSource?: unknown;
    localMemoryCardPaths?: unknown;
    keepLines?: unknown;
    discardLines?: unknown;
    lobsterImprovementLines?: unknown;
    currentBracketLines?: unknown;
    ruledOutLines?: unknown;
    highestInfoNextCheckLines?: unknown;
    replayTriggerLines?: unknown;
    nextEvalCueLines?: unknown;
    recoveryReadOrder?: unknown;
  };
  const objective =
    typeof packet.objective === "string" && packet.objective.trim().length > 0
      ? packet.objective.trim()
      : "";
  if (!objective) {
    return undefined;
  }
  return {
    objective,
    protectedAnchorsPresent: parseStringArray(packet.protectedAnchorsPresent),
    protectedAnchorsMissing: parseStringArray(packet.protectedAnchorsMissing),
    currentFocus:
      typeof packet.currentFocus === "string" && packet.currentFocus.trim().length > 0
        ? packet.currentFocus.trim()
        : undefined,
    topDecision:
      typeof packet.topDecision === "string" && packet.topDecision.trim().length > 0
        ? packet.topDecision.trim()
        : undefined,
    recallOrder:
      typeof packet.recallOrder === "string" && packet.recallOrder.trim().length > 0
        ? packet.recallOrder.trim()
        : undefined,
    latestCarryoverSource:
      typeof packet.latestCarryoverSource === "string" &&
      packet.latestCarryoverSource.trim().length > 0
        ? packet.latestCarryoverSource.trim()
        : undefined,
    localMemoryCardPaths: parseStringArray(packet.localMemoryCardPaths),
    keepLines: parseStringArray(packet.keepLines, 12),
    discardLines: parseStringArray(packet.discardLines, 12),
    lobsterImprovementLines: parseStringArray(packet.lobsterImprovementLines, 8),
    currentBracketLines: parseStringArray(packet.currentBracketLines, 8),
    ruledOutLines: parseStringArray(packet.ruledOutLines, 8),
    highestInfoNextCheckLines: parseStringArray(packet.highestInfoNextCheckLines, 8),
    replayTriggerLines: parseStringArray(packet.replayTriggerLines, 12),
    nextEvalCueLines: parseStringArray(packet.nextEvalCueLines, 12),
    recoveryReadOrder: parseStringArray(packet.recoveryReadOrder, 16),
  };
}

function parseMarketIntelligenceConfidenceBand(
  value: unknown,
): MarketIntelligenceConfidenceBand | undefined {
  switch (value) {
    case "low":
    case "medium":
    case "guarded_high":
      return value;
    default:
      return undefined;
  }
}

function parseMarketIntelligenceMaterialChangeFlag(
  value: unknown,
): MarketIntelligenceMaterialChangeFlag | undefined {
  switch (value) {
    case "material":
    case "no_material_change":
    case "unclear":
      return value;
    default:
      return undefined;
  }
}

function parseMarketHypothesisSet(value: unknown, maxItems = 4): MarketIntelligenceHypothesis[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const hypothesis = item as {
        id?: unknown;
        label?: unknown;
        stance?: unknown;
        thesis?: unknown;
        keyDrivers?: unknown;
      };
      const id = typeof hypothesis.id === "string" ? hypothesis.id.trim() : "";
      const label = typeof hypothesis.label === "string" ? hypothesis.label.trim() : "";
      const thesis = typeof hypothesis.thesis === "string" ? hypothesis.thesis.trim() : "";
      const stance =
        hypothesis.stance === "bullish" ||
        hypothesis.stance === "bearish" ||
        hypothesis.stance === "mixed"
          ? hypothesis.stance
          : undefined;
      if (!id || !label || !thesis || !stance) {
        return undefined;
      }
      return {
        id,
        label,
        thesis,
        stance,
        keyDrivers: parseStringArray(hypothesis.keyDrivers, 6),
      } satisfies MarketIntelligenceHypothesis;
    })
    .filter((item): item is MarketIntelligenceHypothesis => Boolean(item))
    .slice(0, maxItems);
}

function parseMarketChallengeFindings(
  value: unknown,
  maxItems = 6,
): MarketIntelligenceChallengeFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const finding = item as {
        thesisId?: unknown;
        finding?: unknown;
        severity?: unknown;
        evidenceNeeded?: unknown;
      };
      const thesisId = typeof finding.thesisId === "string" ? finding.thesisId.trim() : "";
      const findingText = typeof finding.finding === "string" ? finding.finding.trim() : "";
      const evidenceNeeded =
        typeof finding.evidenceNeeded === "string" ? finding.evidenceNeeded.trim() : "";
      const severity =
        finding.severity === "low" || finding.severity === "medium" || finding.severity === "high"
          ? finding.severity
          : undefined;
      if (!thesisId || !findingText || !evidenceNeeded || !severity) {
        return undefined;
      }
      return {
        thesisId,
        finding: findingText,
        severity,
        evidenceNeeded,
      } satisfies MarketIntelligenceChallengeFinding;
    })
    .filter((item): item is MarketIntelligenceChallengeFinding => Boolean(item))
    .slice(0, maxItems);
}

function parseMarketSurvivorTheses(
  value: unknown,
  maxItems = 4,
): MarketIntelligenceSurvivorThesis[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const thesis = item as {
        thesisId?: unknown;
        label?: unknown;
        whySurvived?: unknown;
      };
      const thesisId = typeof thesis.thesisId === "string" ? thesis.thesisId.trim() : "";
      const label = typeof thesis.label === "string" ? thesis.label.trim() : "";
      const whySurvived = typeof thesis.whySurvived === "string" ? thesis.whySurvived.trim() : "";
      if (!thesisId || !label || !whySurvived) {
        return undefined;
      }
      return { thesisId, label, whySurvived } satisfies MarketIntelligenceSurvivorThesis;
    })
    .filter((item): item is MarketIntelligenceSurvivorThesis => Boolean(item))
    .slice(0, maxItems);
}

function parseMarketSkillReceipt(value: unknown): MarketIntelligenceSkillReceipt | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const receipt = value as {
    skillName?: unknown;
    status?: unknown;
    reason?: unknown;
    installId?: unknown;
    message?: unknown;
    warnings?: unknown;
  };
  const skillName = typeof receipt.skillName === "string" ? receipt.skillName.trim() : "";
  const reason = typeof receipt.reason === "string" ? receipt.reason.trim() : "";
  const status =
    receipt.status === "not_needed" ||
    receipt.status === "activated_existing" ||
    receipt.status === "installed_and_used" ||
    receipt.status === "install_failed" ||
    receipt.status === "denied" ||
    receipt.status === "use_failed"
      ? receipt.status
      : undefined;
  if (!skillName || !reason || !status) {
    return undefined;
  }
  return {
    skillName,
    status,
    reason,
    installId: typeof receipt.installId === "string" ? receipt.installId.trim() : undefined,
    message: typeof receipt.message === "string" ? receipt.message.trim() : undefined,
    warnings: parseStringArray(receipt.warnings, 6),
  };
}

function parseBooleanLineValue(value: string): boolean {
  return value.trim().toLowerCase() === "yes";
}

function parseLearningCouncilAdoptionCueType(
  value: string,
): LearningCouncilAdoptionCueType | undefined {
  const trimmed = value.trim();
  switch (trimmed) {
    case "keep":
    case "discard":
    case "lobster_improvement":
    case "replay_trigger":
    case "next_eval":
    case "current_bracket":
    case "ruled_out":
    case "highest_info_next_check":
      return trimmed;
    default:
      return undefined;
  }
}

function parseLearningCouncilAdoptionState(
  value: string,
): LearningCouncilAdoptionState | undefined {
  const trimmed = value.trim();
  switch (trimmed) {
    case "adopted_now":
    case "candidate_for_reuse":
    case "ignored":
      return trimmed;
    default:
      return undefined;
  }
}

function extractLedgerLineValue(block: string, field: string): string {
  return (
    block.match(new RegExp(`^- ${escapeRegexFragment(field)}:\\s*(.+)$`, "mu"))?.[1]?.trim() || ""
  );
}

export function parseLearningCouncilMemoryNote(params: {
  filename: string;
  content: string;
}): ParsedLearningCouncilMemoryNote | undefined {
  const parsedName = parseLearningCouncilMemoryNoteFilename(params.filename);
  if (!parsedName) {
    return undefined;
  }
  const extract = (pattern: RegExp, fallback: string) =>
    params.content.match(pattern)?.[1]?.trim() || fallback;
  return {
    name: params.filename,
    date: parsedName.dateStr,
    noteSlug: parsedName.noteSlug,
    generatedAt: extract(/- \*\*Generated At\*\*: ([^\n]+)/, `${parsedName.dateStr}T00:00:00.000Z`),
    status: extract(/- \*\*Status\*\*: ([^\n]+)/, "unknown"),
    userMessage: extract(/- \*\*User Message\*\*: ([^\n]+)/, "unknown topic"),
    mutableFactWarnings: parseValidationNumber(
      extract(/- \*\*Mutable Fact Warnings\*\*: ([^\n]+)/, "0"),
      0,
    ),
    failedRolesSummary: extract(/- \*\*Failed Roles\*\*: ([^\n]+)/, "none"),
    finalReplySnapshot:
      params.content.match(/## Final Reply Snapshot\n([\s\S]*?)$/u)?.[1]?.trim() ?? "",
    keeperLines: extractSectionBulletLines(params.content, "Distilled Keep").length
      ? extractSectionBulletLines(params.content, "Distilled Keep")
      : extractSectionBulletLines(params.content, "Keep"),
    discardLines: extractSectionBulletLines(params.content, "Distilled Discard").length
      ? extractSectionBulletLines(params.content, "Distilled Discard")
      : extractSectionBulletLines(params.content, "Discard or downrank"),
    lobsterImprovementLines: extractSectionBulletLines(
      params.content,
      "Lobster Improvement Feedback",
    ),
    rehearsalTriggerLines: extractSectionBulletLines(params.content, "Distilled Rehearsal Triggers")
      .length
      ? extractSectionBulletLines(params.content, "Distilled Rehearsal Triggers")
      : extractSectionBulletLines(params.content, "Rehearsal triggers"),
    nextEvalCueLines: extractSectionBulletLines(params.content, "Distilled Next Eval").length
      ? extractSectionBulletLines(params.content, "Distilled Next Eval")
      : extractSectionBulletLines(params.content, "Next eval cue"),
  };
}

export function parseLearningCouncilAdoptionLedger(params: {
  filename: string;
  content: string;
}): ParsedLearningCouncilAdoptionLedger | undefined {
  const parsedName = parseLearningCouncilAdoptionLedgerFilename(params.filename);
  if (!parsedName) {
    return undefined;
  }
  const extract = (pattern: RegExp, fallback: string) =>
    params.content.match(pattern)?.[1]?.trim() || fallback;
  const entryBlocks = Array.from(
    params.content.matchAll(/### Entry \d+\n([\s\S]*?)(?=\n### Entry |\n## |$)/gu),
  );
  const entries = entryBlocks
    .map((match) => {
      const block = match[1] ?? "";
      const cueType = parseLearningCouncilAdoptionCueType(
        extractLedgerLineValue(block, "cue_type"),
      );
      const adoptedState = parseLearningCouncilAdoptionState(
        extractLedgerLineValue(block, "adopted_state"),
      );
      const source = extractLedgerLineValue(block, "source");
      const text = extractLedgerLineValue(block, "text");
      const linkedArtifactOrReceipt = extractLedgerLineValue(block, "linked_artifact_or_receipt");
      if (!cueType || !adoptedState || !source || !text || !linkedArtifactOrReceipt) {
        return undefined;
      }
      return {
        source,
        cueType,
        text,
        adoptedState,
        reusedLater: parseBooleanLineValue(extractLedgerLineValue(block, "reused_later")),
        downrankedOrFailed: parseBooleanLineValue(
          extractLedgerLineValue(block, "downranked_or_failed"),
        ),
        linkedArtifactOrReceipt,
        notes: extractLedgerLineValue(block, "notes") || "none",
      } satisfies LearningCouncilAdoptionLedgerEntry;
    })
    .filter((entry): entry is LearningCouncilAdoptionLedgerEntry => Boolean(entry));
  return {
    name: params.filename,
    date: parsedName.dateStr,
    noteSlug: parsedName.noteSlug,
    generatedAt: extract(/- \*\*Generated At\*\*: ([^\n]+)/, `${parsedName.dateStr}T00:00:00.000Z`),
    status: extract(/- \*\*Status\*\*: ([^\n]+)/, "unknown"),
    userMessage: extract(/- \*\*User Message\*\*: ([^\n]+)/, "unknown topic"),
    sourceArtifact: extract(/- \*\*Source Artifact\*\*: ([^\n]+)/, "unknown"),
    entries,
  };
}

export function parseLearningReviewMemoryNote(params: {
  filename: string;
  content: string;
}): ParsedLearningReviewMemoryNote | undefined {
  const parsedName = parseLearningReviewNoteFilename(params.filename);
  if (!parsedName) {
    return undefined;
  }
  const extract = (pattern: RegExp, fallback: string) =>
    params.content.match(pattern)?.[1]?.trim() || fallback;
  return {
    name: params.filename,
    date: parsedName.dateStr,
    noteSlug: parsedName.noteSlug,
    sessionKey: extract(/- \*\*Session Key\*\*: ([^\n]+)/, "unknown"),
    sessionId: extract(/- \*\*Session ID\*\*: ([^\n]+)/, "unknown"),
    topic: extract(/- \*\*Topic\*\*: ([^\n]+)/, "unknown"),
    problem: extract(/## Problem\n- ([^\n]+)/, "Study-heavy session"),
    workingAnswer: extract(/## Working Answer\n- ([^\n]+)/, "No assistant answer captured."),
    mistakePattern: extract(/^- mistake_pattern:\s*(.+)$/m, "No recurring mistake captured."),
    corePrinciple: extract(/^- core_principle:\s*(.+)$/m, "No core principle captured."),
    microDrill: extract(/^- micro_drill:\s*(.+)$/m, "No micro-drill captured."),
    transferHint: extract(/^- transfer_hint:\s*(.+)$/m, "No transfer hint captured."),
    foundationTemplate: extract(/^- foundation_template:\s*(.+)$/m, "execution-hygiene"),
    whyItMatters: extract(
      /^- why_it_matters:\s*(.+)$/m,
      "Compress this lesson into execution-hygiene rather than leaving it as a loose study note.",
    ),
  };
}

export function parseCorrectionNoteArtifact(
  content: string,
): ParsedCorrectionNoteArtifact | undefined {
  const headingMatch = content.match(
    /^# Correction Note: (\d{4}-\d{2}-\d{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2}) UTC/m,
  );
  if (!headingMatch) {
    return undefined;
  }
  const extract = (pattern: RegExp, fallback: string) =>
    content.match(pattern)?.[1]?.trim() || fallback;
  return {
    date: headingMatch[1],
    time: headingMatch[2],
    sessionKey: extract(/- \*\*Session Key\*\*: ([^\n]+)/, "unknown"),
    sessionId: extract(/- \*\*Session ID\*\*: ([^\n]+)/, "unknown"),
    issueKey: extract(/- \*\*Issue Key\*\*: ([^\n]+)/, "unknown"),
    memoryTier: extract(/- \*\*Memory Tier\*\*: ([^\n]+)/, "provisional"),
    priorClaimOrBehavior: extract(
      /## Prior Claim Or Behavior\n- ([^\n]+)/,
      "No assistant answer captured before correction.",
    ),
    foundationTemplate: extract(/## Foundation Template\n- ([^\n]+)/, "general"),
    whatWasWrong: extract(/## What Was Wrong\n- ([^\n]+)/, "No correction summary captured."),
    evidenceOrUserObservedFailure: extract(
      /## Evidence Or User-Observed Failure\n- ([^\n]+)/,
      "No operator-observed failure captured.",
    ),
    replacementRule: extract(
      /## Replacement Rule\n- ([^\n]+)/,
      "Do not silently preserve the old behavior.",
    ),
    confidenceDowngrade: extract(
      /## Confidence Downgrade\n- ([^\n]+)/,
      "old_rule_confidence: downgraded due to direct operator feedback",
    ),
    repeatedIssueSignal: extract(/## Follow-Up\n- repeated_issue_signal:\s*([^\n]+)/, "no"),
    sessionTraceLines: extractSectionBulletLines(content, "Session Trace"),
  };
}

export function parseLearningCouncilRuntimeArtifact(
  content: string,
): ParsedLearningCouncilRuntimeArtifact | undefined {
  let parsed: {
    generatedAt?: unknown;
    messageId?: unknown;
    userMessage?: unknown;
    status?: unknown;
    runPacket?: unknown;
    finalReply?: unknown;
  };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    return undefined;
  }

  const generatedAt =
    typeof parsed.generatedAt === "string" && parsed.generatedAt.trim().length > 0
      ? parsed.generatedAt.trim()
      : "";
  const generatedDateKey = extractIsoDateKey(generatedAt);
  const messageId =
    typeof parsed.messageId === "string" && parsed.messageId.trim().length > 0
      ? parsed.messageId.trim()
      : "";
  const userMessage =
    typeof parsed.userMessage === "string" && parsed.userMessage.trim().length > 0
      ? parsed.userMessage.trim()
      : "";
  const status =
    typeof parsed.status === "string" && parsed.status.trim().length > 0
      ? parsed.status.trim()
      : "";
  const runPacket = parseLearningCouncilRunPacket(parsed.runPacket);
  const finalReply =
    typeof parsed.finalReply === "string" && parsed.finalReply.trim().length > 0
      ? parsed.finalReply.trim()
      : "";

  if (!generatedAt || !generatedDateKey || !messageId || !userMessage || !status) {
    return undefined;
  }

  return {
    generatedAt,
    generatedDateKey,
    messageId,
    userMessage,
    status,
    runPacket,
    finalReply,
  };
}

export function parseMarketIntelligenceRuntimeArtifact(
  content: string,
): ParsedMarketIntelligenceRuntimeArtifact | undefined {
  let parsed: {
    generatedAt?: unknown;
    messageId?: unknown;
    userMessage?: unknown;
    topicKey?: unknown;
    fingerprint?: unknown;
    materialChangeFlag?: unknown;
    noMaterialChange?: unknown;
    confidenceBand?: unknown;
    sourceContext?: unknown;
    hypothesisSet?: unknown;
    evidenceGaps?: unknown;
    challengeFindings?: unknown;
    survivorTheses?: unknown;
    followUpCandidates?: unknown;
    doNotContinueReason?: unknown;
    comparedAgainst?: unknown;
    distillation?: unknown;
    finalReply?: unknown;
  };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    return undefined;
  }

  const generatedAt =
    typeof parsed.generatedAt === "string" && parsed.generatedAt.trim().length > 0
      ? parsed.generatedAt.trim()
      : "";
  const generatedDateKey = extractIsoDateKey(generatedAt);
  const messageId =
    typeof parsed.messageId === "string" && parsed.messageId.trim().length > 0
      ? parsed.messageId.trim()
      : "";
  const userMessage =
    typeof parsed.userMessage === "string" && parsed.userMessage.trim().length > 0
      ? parsed.userMessage.trim()
      : "";
  const topicKey =
    typeof parsed.topicKey === "string" && parsed.topicKey.trim().length > 0
      ? parsed.topicKey.trim()
      : "";
  const fingerprint =
    typeof parsed.fingerprint === "string" && parsed.fingerprint.trim().length > 0
      ? parsed.fingerprint.trim()
      : "";
  const materialChangeFlag = parseMarketIntelligenceMaterialChangeFlag(parsed.materialChangeFlag);
  const confidenceBand = parseMarketIntelligenceConfidenceBand(parsed.confidenceBand);
  const noMaterialChange = parsed.noMaterialChange === true;
  const sourceContext =
    parsed.sourceContext && typeof parsed.sourceContext === "object"
      ? (parsed.sourceContext as {
          sourceRefs?: unknown;
          sourceDigests?: unknown;
          skillReceipt?: unknown;
        })
      : undefined;
  const skillReceipt = parseMarketSkillReceipt(sourceContext?.skillReceipt);
  const distillation =
    parsed.distillation && typeof parsed.distillation === "object"
      ? (parsed.distillation as {
          retainedResidueLines?: unknown;
          memoryNotePath?: unknown;
        })
      : undefined;
  const finalReply =
    typeof parsed.finalReply === "string" && parsed.finalReply.trim().length > 0
      ? parsed.finalReply.trim()
      : "";

  if (
    !generatedAt ||
    !generatedDateKey ||
    !messageId ||
    !userMessage ||
    !topicKey ||
    !fingerprint ||
    !materialChangeFlag ||
    !confidenceBand ||
    !skillReceipt
  ) {
    return undefined;
  }

  const comparedAgainst =
    parsed.comparedAgainst && typeof parsed.comparedAgainst === "object"
      ? (parsed.comparedAgainst as { artifactPath?: unknown })
      : undefined;

  return {
    generatedAt,
    generatedDateKey,
    messageId,
    userMessage,
    topicKey,
    fingerprint,
    materialChangeFlag,
    noMaterialChange,
    confidenceBand,
    sourceRefs: parseStringArray(sourceContext?.sourceRefs, 6),
    sourceDigests: parseStringArray(sourceContext?.sourceDigests, 6),
    skillReceipt,
    hypothesisSet: parseMarketHypothesisSet(parsed.hypothesisSet),
    evidenceGaps: parseStringArray(parsed.evidenceGaps, 8),
    challengeFindings: parseMarketChallengeFindings(parsed.challengeFindings),
    survivorTheses: parseMarketSurvivorTheses(parsed.survivorTheses),
    followUpCandidates: parseStringArray(parsed.followUpCandidates, 8),
    doNotContinueReason:
      typeof parsed.doNotContinueReason === "string" && parsed.doNotContinueReason.trim().length > 0
        ? parsed.doNotContinueReason.trim()
        : undefined,
    comparedAgainstArtifactPath:
      typeof comparedAgainst?.artifactPath === "string" &&
      comparedAgainst.artifactPath.trim().length > 0
        ? comparedAgainst.artifactPath.trim()
        : undefined,
    retainedResidueLines: parseStringArray(distillation?.retainedResidueLines, 8),
    memoryNotePath:
      typeof distillation?.memoryNotePath === "string" &&
      distillation.memoryNotePath.trim().length > 0
        ? distillation.memoryNotePath.trim()
        : "",
    finalReply,
  };
}

export function buildFundamentalReviewChainJsonPath(
  stageName: FundamentalReviewChainStage,
  manifestId: string,
): string {
  return buildFundamentalArtifactJsonPath(stageName, manifestId);
}

export function buildFundamentalReviewChainNoteFilename(params: {
  dateStr: string;
  stageName: FundamentalReviewChainStage;
  manifestId: string;
}): string {
  return buildFundamentalArtifactNoteFilename(params);
}

export function buildFundamentalArtifactJsonPath(
  stageName: FundamentalArtifactStage,
  manifestId: string,
): string {
  const spec = FUNDAMENTAL_ARTIFACT_STAGE_SPECS.find((entry) => entry.stageName === stageName);
  if (!spec) {
    throw new Error(`Unknown fundamental artifact stage: ${stageName}`);
  }
  return `${spec.jsonDir}/${manifestId}.json`;
}

export function buildFundamentalArtifactNoteFilename(params: {
  dateStr: string;
  stageName: FundamentalArtifactStage;
  manifestId: string;
}): string {
  return `${params.dateStr}-${params.stageName}-${params.manifestId}.md`;
}
