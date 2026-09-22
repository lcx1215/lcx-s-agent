import { createHash } from "node:crypto";
import { runFinanceAlpacaOrder, type FinanceAlpacaRunRequest } from "./finance-alpaca-run.js";
import { parseResearchConclusion } from "./finance-conclusion-intake.js";
import {
  evaluateConclusionToMandate,
  type FinanceConclusionRiskContext,
} from "./finance-conclusion-to-mandate.js";
import { recoverConfirmedFinanceExecutions } from "./finance-execution-recovery.js";
import type { FinanceRegime } from "./finance-mandate.js";
import { appendFinanceExecutionReceipt } from "./finance-position-ledger.js";
import { extractFinanceConclusionJson } from "./finance-research-conclusion-prompt.js";
import {
  isReadyFinanceValueAssessment,
  type FinanceValueAssessment,
} from "./finance-value-assessment.js";
import {
  calculateReturnsFromLevels,
  calculateRollingVolatility,
  calculateMaxDrawdown,
} from "./tools/quant-math-tool.js";

export type FinanceResearchEvidence = Readonly<{
  sourceId: string;
  description: string;
  detail: string;
  sourceUrlOrArtifact: string;
  /** Native source time when known; collection time never substitutes for a price observation. */
  sourceTimestamp?: string;
  /** Multiple statements from one issuer/report are not independent corroboration. */
  independenceKey?: string;
  computation?: Readonly<{
    calculationId: string;
    module: string;
    inputSourceIds: readonly string[];
    inputHash?: string;
  }>;
}>;
export type FinanceResearchDailyBars = Readonly<{
  sourceId: string;
  sourceUrlOrArtifact: string;
  rows: readonly Readonly<{ date: string; close: number }>[];
  periodsPerYear: number;
}>;

/** Reuse the existing quantitative functions on qualified native daily bars, not price guesses. */
export function buildFinanceResearchMathEvidence(
  input: FinanceResearchDailyBars,
): readonly FinanceResearchEvidence[] {
  if (
    input.rows.length < 21 ||
    !input.sourceId.trim() ||
    !input.sourceUrlOrArtifact.trim() ||
    !Number.isFinite(input.periodsPerYear) ||
    input.periodsPerYear <= 0 ||
    input.rows.some(
      (row, index) =>
        !/^\d{4}-\d{2}-\d{2}$/u.test(row.date) ||
        !Number.isFinite(Date.parse(row.date)) ||
        !Number.isFinite(row.close) ||
        row.close <= 0 ||
        (index > 0 && row.date <= input.rows[index - 1].date),
    )
  ) {
    return [];
  }
  const levels = input.rows.map((row) => row.close);
  const returns = calculateReturnsFromLevels(levels);
  const volatility = calculateRollingVolatility({
    series: returns.returns,
    window: 20,
    periodsPerYear: input.periodsPerYear,
  });
  const drawdown = calculateMaxDrawdown(levels, "levels");
  const raw = JSON.stringify(input.rows);
  const inputHash = hash(
    JSON.stringify({ rows: input.rows, window: 20, periodsPerYear: input.periodsPerYear }),
  );
  const sourceTimestamp = input.rows.at(-1)!.date;
  const results = [
    {
      module: "calculateReturnsFromLevels",
      result: returns,
      summary: { observations: returns.observations, latestReturn: returns.returns.at(-1) },
    },
    {
      module: "calculateRollingVolatility",
      result: volatility,
      summary: {
        window: 20,
        periodsPerYear: input.periodsPerYear,
        latest: volatility.values.at(-1),
      },
    },
    { module: "calculateMaxDrawdown", result: drawdown, summary: drawdown },
  ];
  return [
    {
      sourceId: input.sourceId,
      sourceUrlOrArtifact: input.sourceUrlOrArtifact,
      sourceTimestamp,
      description: "native historical daily closes, not an execution quote",
      detail: raw,
    },
    ...results.map(({ module, result, summary }) => {
      const calculationId = hash(JSON.stringify({ inputHash, module, result }));
      return {
        sourceId: `${input.sourceId}:${module}`,
        sourceUrlOrArtifact: `calculation:quant_math:${calculationId}`,
        sourceTimestamp,
        description: `computed historical price statistic via quant_math.${module}; not account risk state`,
        detail: JSON.stringify({ ...summary, calculationId, inputHash }),
        computation: {
          calculationId,
          module: `quant_math.${module}`,
          inputHash,
          inputSourceIds: [input.sourceId],
        },
      };
    }),
  ];
}

export type FinanceResearchExecutionControl = Readonly<{
  mode?: "shadow" | "alpaca_paper";
  /** Canonical controller-owned finance database root, never from model JSON. */
  stateDirectory?: string;
  recovery?: Readonly<{ safetyStateDir: string; accountId: string; venue: string }>;
  riskContext?: FinanceConclusionRiskContext;
  /** Controller-only input. Never populated from model JSON or CLI flags. */
  execution?: Omit<
    FinanceAlpacaRunRequest,
    "conclusion" | "strategyClass" | "minConviction" | "mode"
  >;
}>;
export type FinanceResearchBridgeInput = Readonly<{
  instrument: string;
  assetClass: "us_equity" | "crypto";
  modelText: string;
  researchBasis?: "business_value" | "market_structure";
  valueAssessment?: FinanceValueAssessment;
  evidence: readonly FinanceResearchEvidence[];
  market: { referencePrice: number; referencePriceAt: string };
  equity: number;
  runAuthorizationId: string;
  regime?: FinanceRegime;
}>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function parseObservation(raw: unknown): ReturnType<typeof parseResearchConclusion> {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("direction" in raw) ||
    (raw.direction !== "hold" && raw.direction !== "avoid")
  ) {
    return parseResearchConclusion(raw);
  }
  if (
    !("instrument" in raw) ||
    typeof raw.instrument !== "string" ||
    !("assetClass" in raw) ||
    typeof raw.assetClass !== "string" ||
    !("thesis" in raw) ||
    typeof raw.thesis !== "string" ||
    !raw.thesis.trim() ||
    !("conviction" in raw) ||
    typeof raw.conviction !== "number" ||
    !Number.isFinite(raw.conviction) ||
    raw.conviction < 0 ||
    raw.conviction > 1 ||
    !("evidence" in raw) ||
    !Array.isArray(raw.evidence)
  ) {
    return { ok: false, refusals: ["non-trade research observation is incomplete"] };
  }
  const evidence = raw.evidence.flatMap((ref: unknown) =>
    typeof ref === "object" &&
    ref !== null &&
    "sourceId" in ref &&
    typeof ref.sourceId === "string" &&
    ref.sourceId.trim()
      ? [{ sourceId: ref.sourceId }]
      : [],
  );
  if (evidence.length !== raw.evidence.length || evidence.length < 1) {
    return { ok: false, refusals: ["non-trade research requires source evidence"] };
  }
  return {
    ok: true,
    notes: [],
    conclusion: {
      conclusionId: "non-trade-observation",
      instrument: raw.instrument,
      assetClass: raw.assetClass,
      direction: raw.direction,
      conviction: raw.conviction,
      thesis: raw.thesis,
      evidence,
    },
  };
}

export async function recoverFinanceResearchHistory(control: FinanceResearchExecutionControl) {
  if (!control.stateDirectory || !control.recovery || control.recovery.venue !== "alpaca:paper") {
    return { ok: false as const, reason: "controller account recovery binding required" };
  }
  const recovery = await recoverConfirmedFinanceExecutions({
    ...control.recovery,
    ledgerDir: control.stateDirectory,
    signal: control.execution?.signal,
  });
  return {
    ok:
      recovery.pendingReconciliation.length === 0 &&
      recovery.legacyUnsupported.length === 0 &&
      recovery.failures.length === 0,
    recovery,
  };
}

/** Existing research/mandate and venue seams, joined only by controller-owned authority. */
export async function runFinanceResearchExecutionBridge(
  input: FinanceResearchBridgeInput,
  control: FinanceResearchExecutionControl = {},
) {
  const evidenceReceipt = input.evidence.map((item) => ({
    sourceId: item.sourceId,
    sourceUrlOrArtifact: item.sourceUrlOrArtifact,
    sourceTimestamp: item.sourceTimestamp,
    independenceKey: item.independenceKey,
    detailHash: hash(item.detail),
    computation: item.computation,
  }));
  const receipt = {
    modelOutputHash: hash(input.modelText),
    evidence: evidenceReceipt,
    researchBasis: input.researchBasis,
    valueAssessment: input.valueAssessment,
  };
  const extracted = extractFinanceConclusionJson(input.modelText);
  const intake = parseObservation(extracted);
  if (!intake.ok) {
    return { status: "refused" as const, receipt, refusals: intake.refusals };
  }
  const conclusion = intake.conclusion;
  if (conclusion.instrument !== input.instrument || conclusion.assetClass !== input.assetClass) {
    return {
      status: "refused" as const,
      receipt,
      refusals: ["model conclusion changed the authorized instrument or asset class"],
    };
  }
  const available = new Map(input.evidence.map((item) => [item.sourceId, item]));
  if (
    available.size !== input.evidence.length ||
    conclusion.evidence.some((ref) => {
      const item = available.get(ref.sourceId);
      return !item || !item.detail.trim() || !item.sourceUrlOrArtifact.trim();
    })
  ) {
    return {
      status: "refused" as const,
      receipt,
      refusals: [
        "model citations must resolve to actual collected evidence with source provenance",
      ],
    };
  }
  const rawEvidence =
    typeof extracted === "object" &&
    extracted !== null &&
    "evidence" in extracted &&
    Array.isArray(extracted.evidence)
      ? extracted.evidence
      : [];
  const invalidCalculation = rawEvidence.some((ref: unknown) => {
    if (typeof ref !== "object" || ref === null || !("calculationId" in ref)) {
      return false;
    }
    const sourceId = "sourceId" in ref && typeof ref.sourceId === "string" ? ref.sourceId : "";
    const calculation = available.get(sourceId)?.computation;
    return (
      !calculation ||
      ref.calculationId !== calculation.calculationId ||
      !calculation.module.trim() ||
      calculation.inputSourceIds.length === 0 ||
      calculation.inputSourceIds.some((id) => id === sourceId || !available.has(id))
    );
  });
  if (invalidCalculation) {
    return {
      status: "refused" as const,
      receipt,
      refusals: [
        "claimed calculation must match a collected calculation receipt and its input evidence",
      ],
    };
  }

  // Derived calculations retain their parents: two IDs over the same bars are one source.
  const roots = (id: string, visiting: ReadonlySet<string> = new Set()): readonly string[] => {
    if (visiting.has(id)) {
      throw new Error("cyclic evidence lineage");
    }
    const item = available.get(id);
    if (!item) {
      throw new Error("missing evidence parent");
    }
    const parents = item.computation?.inputSourceIds;
    if (!parents) {
      return [item.independenceKey ?? item.sourceUrlOrArtifact];
    }
    if (parents.length === 0) {
      throw new Error("calculation has no input evidence");
    }
    const next = new Set([...visiting, id]);
    return parents.flatMap((parent) => roots(parent, next));
  };
  try {
    const independentSources = new Set(conclusion.evidence.flatMap((ref) => roots(ref.sourceId)));
    if (
      independentSources.size < 2 &&
      conclusion.direction !== "hold" &&
      conclusion.direction !== "avoid"
    ) {
      return {
        status: "refused" as const,
        receipt,
        refusals: [
          "fewer than two independent evidence roots; derived calculations do not create new market corroboration",
        ],
      };
    }
  } catch (error) {
    return {
      status: "refused" as const,
      receipt,
      refusals: [error instanceof Error ? error.message : "invalid evidence lineage"],
    };
  }
  if (conclusion.direction === "hold" || conclusion.direction === "avoid") {
    return { status: "shadow" as const, disposition: "no_trade" as const, receipt, conclusion };
  }

  if (
    input.researchBasis === "business_value" &&
    (!isReadyFinanceValueAssessment(input.valueAssessment) ||
      input.valueAssessment.instrument !== input.instrument ||
      input.valueAssessment.referencePrice !== input.market.referencePrice)
  ) {
    return {
      status: "refused" as const,
      receipt,
      refusals: [
        "business-value trade requires sourced operating facts, computed scenarios and passing opposing review",
      ],
    };
  }

  if (
    input.researchBasis === "business_value" &&
    (!extracted ||
      typeof extracted !== "object" ||
      !("valueAssessmentId" in extracted) ||
      extracted.valueAssessmentId !== input.valueAssessment?.receiptId ||
      !conclusion.evidence.some((ref) =>
        input.valueAssessment?.facts?.sourceIds.includes(ref.sourceId),
      ))
  ) {
    return {
      status: "refused" as const,
      receipt,
      refusals: [
        "value conclusion must consume the current valuation receipt and cite operating evidence",
      ],
    };
  }

  const execute = control.mode === "alpaca_paper";
  if (
    execute &&
    (!control.execution?.createSafetyContext || !control.stateDirectory || !control.recovery)
  ) {
    return {
      status: "blocked" as const,
      receipt,
      refusals: [
        "trusted execution controller unavailable; model JSON and CLI labels cannot authorize placement",
      ],
    };
  }
  if (execute) {
    const recovery = await recoverFinanceResearchHistory(control);
    if (!recovery.ok) {
      return {
        status: "blocked" as const,
        receipt,
        recovery,
        refusals: [
          "stored execution claims require reconciliation or receipt recovery before another dispatch",
        ],
      };
    }
  }
  const execution = execute ? control.execution : undefined;
  const decision = evaluateConclusionToMandate({
    raw: extracted,
    referencePrice: execution?.market.referencePrice ?? input.market.referencePrice,
    referencePriceAt: execution?.market.referencePriceAt ?? input.market.referencePriceAt,
    equity: execution?.equity ?? input.equity,
    runAuthorizationId: execution?.runAuthorizationId ?? input.runAuthorizationId,
    riskContext: control.riskContext,
    ...(input.regime === undefined ? {} : { regime: input.regime }),
  });
  if (!decision.ok || !decision.passed) {
    return {
      status: "refused" as const,
      receipt,
      decision,
      refusals: decision.ok ? decision.mandate.reasons : decision.refusals,
    };
  }
  if (!execution) {
    return { status: "shadow" as const, receipt, decision };
  }
  try {
    const placement = await runFinanceAlpacaOrder({
      ...execution,
      conclusion: decision.conclusion,
      ...(decision.strategyClass === "unknown" ? {} : { strategyClass: decision.strategyClass }),
      mode: "paper",
    });
    if (placement.ok) {
      try {
        const persisted = await appendFinanceExecutionReceipt(
          control.stateDirectory!,
          placement.receipt,
        );
        return { status: "placed" as const, receipt, decision, placement, persistence: persisted };
      } catch (error) {
        return {
          status: "executed_persistence_pending" as const,
          receipt,
          decision,
          placement,
          recovery: {
            stateDirectory: control.stateDirectory,
            receiptId: placement.receipt.receiptId,
            action: "append existing receipt only; do not redispatch",
          },
          persistenceError: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return {
      status: placement.ok ? ("placed" as const) : ("refused" as const),
      receipt,
      decision,
      placement,
    };
  } catch (error) {
    return {
      status: "unknown" as const,
      receipt,
      decision,
      refusals: [error instanceof Error ? error.message : String(error)],
    };
  }
}
