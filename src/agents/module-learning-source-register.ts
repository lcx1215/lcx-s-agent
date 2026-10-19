import type { LcxOntologyLearningTargetId } from "../shared/lcx-ontology.js";

// Versioned intake obligations. These are mappings and acceptance tasks, never learning receipts.
export type ModuleLearningSource = {
  id: string;
  sourceUrls: string[];
  registeredOn: string;
  targetModule: LcxOntologyLearningTargetId;
  capabilityScope: "finance" | "shared_infrastructure";
  readingScope: string;
  implementationStatus: "partial" | "existing_only" | "analysis_only";
  implementationCommits: string[];
  implementationPaths: string[];
  applicationTask: string;
  remainingWork: string[];
};

export const MODULE_LEARNING_SOURCE_REGISTER: readonly ModuleLearningSource[] = [
  {
    id: "autoscientist-quant",
    sourceUrls: [
      "https://mp.weixin.qq.com/s/psmcPelSTDmJHriksN3uSw",
      "https://arxiv.org/abs/2608.28632",
    ],
    registeredOn: "2026-09-27",
    targetModule: "factor_research",
    capabilityScope: "finance",
    readingScope:
      "Supplied article text and research mapping; embedded figures and formula coverage are incomplete.",
    implementationStatus: "partial",
    implementationCommits: ["efcf06bb63"],
    implementationPaths: [
      "scripts/operator/local-brain-distill-train-slice.ts",
      "scripts/operator/local-brain-distill-eval.ts",
      "scripts/operator/minimax-brain-training-guard.ts",
    ],
    applicationTask:
      "On an independent candidate, demonstrate slice identity rejection after byte changes and preserve the candidate, parent, budget and holdout receipts across research stages.",
    remainingWork: [
      "Cross-stage candidate and parent-adapter lineage",
      "Reconciled vector budget",
      "Experiment-specific inaccessible final holdout",
      "Isolated evaluator before generated-code execution",
    ],
  },
  {
    id: "optiver-continuous-decisions",
    sourceUrls: [
      "https://www.optiver.com/insights/technology-blog/where-ai-trading-models-work-and-where-they-still-fall-short/",
    ],
    registeredOn: "2026-09-27",
    targetModule: "technical_timing",
    capabilityScope: "finance",
    readingScope:
      "Article text and supplied translation; model labels in inaccessible figures were not verified.",
    implementationStatus: "partial",
    implementationCommits: ["4a9c33d5c6"],
    implementationPaths: [
      "src/agents/finance-intraday-monitor.ts",
      "src/agents/finance-intraday-paper.ts",
      "docs/experiments/research/optiver-trading-decision-loop.md",
    ],
    applicationTask:
      "Record a Paper decision trajectory through restart, fill or rejection and the next closed bar; demonstrate actual early-close calendar use and uncertainty blocking.",
    remainingWork: [
      "Calibrated belief and fair-value updates",
      "Cost-complete expected value and position sizing",
      "Opponent response and own market impact evaluation",
    ],
  },
  {
    id: "zen-backtest-to-broker",
    sourceUrls: ["https://zentradings.com/blog/one-weight-vector-from-backtest-to-broker"],
    registeredOn: "2026-09-27",
    targetModule: "portfolio_risk_gates",
    capabilityScope: "finance",
    readingScope:
      "Public article analyzed in the source-reading task; existing target-weight code is not article-specific validation.",
    implementationStatus: "existing_only",
    implementationCommits: [],
    implementationPaths: [
      "src/agents/finance-daily-strategy.ts",
      "src/agents/finance-daily-cycle.ts",
      "src/agents/finance-portfolio-composition.ts",
    ],
    applicationTask:
      "Freeze one strategy version, inputs and target weights; reconcile replay and Paper order conversion including rounding, partial fills, rejection, fees and calendar differences.",
    remainingWork: ["Article-specific strategy contract parity evidence"],
  },
  {
    id: "zen-supply-chain-shock",
    sourceUrls: ["https://zentradings.com/blog/how-our-machines-read-a-supply-chain-shock"],
    registeredOn: "2026-09-27",
    targetModule: "event_driven",
    capabilityScope: "finance",
    readingScope:
      "Public article analyzed; claimed vendor coverage is not independently established.",
    implementationStatus: "partial",
    implementationCommits: ["c0fce1861d"],
    implementationPaths: [
      "src/agents/finance-research-provenance.ts",
      "src/agents/finance-research-thesis-learning.ts",
      "src/agents/finance-thesis-decision-context.ts",
    ],
    applicationTask:
      "Apply the provenance contract to a new sourced supply-chain event; retain contradictory evidence, distinguish reported relationships from impact inference, and expose unavailable magnitude inputs.",
    remainingWork: ["Sourced multi-hop shock propagation and independent validation"],
  },
  {
    id: "dram-etf-due-diligence",
    sourceUrls: ["https://yvette666.substack.com/p/inside-the-ai-memory-trade-a-look"],
    registeredOn: "2026-09-27",
    targetModule: "portfolio_risk_gates",
    capabilityScope: "finance",
    readingScope:
      "Public article analyzed; its cost estimates are not verified instrument parameters.",
    implementationStatus: "partial",
    implementationCommits: ["c0fce1861d"],
    implementationPaths: [
      "src/agents/finance-strategy-method-catalog.ts",
      "src/agents/finance-research-provenance.ts",
    ],
    applicationTask:
      "Apply holdings look-through to a new sourced ETF case, separately accounting for swaps, financing, FX, liquidity, counterparties and exit costs; missing costs must remain unknown.",
    remainingWork: ["Instrument-specific look-through and swap/exit cost stress evidence"],
  },
  {
    id: "skill-eval-methodology",
    sourceUrls: ["https://www.53ai.com/news/tishicijiqiao/2026052990654.html"],
    registeredOn: "2026-09-27",
    targetModule: "skill_pattern_distillation",
    capabilityScope: "shared_infrastructure",
    readingScope:
      "Public excerpt only; the page required login for the remaining 70 percent. Acceptance applies only to the visible methods.",
    implementationStatus: "analysis_only",
    implementationCommits: [],
    implementationPaths: ["src/agents/quality-harness-contract.ts"],
    applicationTask:
      "Compare old and new skill versions on frozen positive, negative and adjacent tasks; report trigger precision, output correctness, cost and repeat variance independently of an LLM judge.",
    remainingWork: ["Version-bound comparative skill evaluation with failure examples"],
  },
];

type ReviewRow = {
  sourceUrlOrPath?: unknown;
  targetModule?: unknown;
  receiptPath?: unknown;
  status?: unknown;
  weak?: unknown;
  terminalNonAbsorbedDecision?: unknown;
  exactMissingProof?: unknown;
};

function sourceIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const url = new URL(value);
    // Strip fragments only: query parameters may identify a different source.
    url.hash = "";
    url.pathname = url.pathname.replace(/\/$/u, "");
    return url.href;
  } catch {
    return value;
  }
}

export function buildModuleLearningSourceCoverage(
  rows: readonly ReviewRow[],
  targetModule?: string,
  dateKey = "all",
) {
  const sources = MODULE_LEARNING_SOURCE_REGISTER.filter(
    (source) =>
      (!targetModule || source.targetModule === targetModule) &&
      (dateKey === "all" || source.registeredOn <= dateKey),
  ).map((source) => {
    const identities = new Set(source.sourceUrls.map(sourceIdentity));
    const matched = rows.filter(
      (row) =>
        row.targetModule === source.targetModule &&
        identities.has(sourceIdentity(row.sourceUrlOrPath)),
    );
    // Every current receipt for this source/target must be resolved; an old success
    // cannot hide a new failing application. File references remain claims, not proof.
    const unresolved = matched.filter(
      (row) =>
        row.weak !== false ||
        !Array.isArray(row.exactMissingProof) ||
        row.exactMissingProof.length > 0 ||
        (row.status !== "eval_absorbed" && row.terminalNonAbsorbedDecision !== true),
    );
    const missingProof =
      matched.length === 0
        ? ["source_bound_module_receipt"]
        : [
            ...new Set(
              unresolved.flatMap((row) => [
                "source_receipt_evidence_incomplete",
                ...(Array.isArray(row.exactMissingProof)
                  ? row.exactMissingProof.filter(
                      (value): value is string => typeof value === "string",
                    )
                  : []),
              ]),
            ),
          ];
    return {
      ...source,
      receiptPaths: matched.map((row) => row.receiptPath),
      receiptClaimsResolved: matched.length > 0 && unresolved.length === 0,
      missingProof,
      nextProofOwner:
        matched.length === 0
          ? "module_learning_pipeline_plan"
          : unresolved.length > 0
            ? "module_learning_pipeline_apply_validation"
            : "none",
    };
  });
  return {
    scope: "registered_sources_within_review_scope",
    registryVersion: 1,
    registeredSources: sources.length,
    sourcesWithoutReceipts: sources.filter((source) => source.receiptPaths.length === 0).length,
    unresolvedSources: sources.filter((source) => !source.receiptClaimsResolved).length,
    codeMappingIsNotApplicationEvidence: true,
    receiptClaimsAreNotIndependentVerification: true,
    sources,
  };
}
