import { FINANCE_FUNDAMENTAL_EXPECTATION_GUIDANCE } from "./finance-expectation-gap.js";
import { buildFinanceStrategyMethodKit } from "./finance-strategy-method-kit.js";

/**
 * The wire between the model and the rules: asking for a conclusion in a shape
 * the machine can check, and getting it back out of the model's answer.
 *
 * Why this exists as code rather than as a paragraph in a prompt: the intake
 * layer already refuses a conclusion with fewer than two distinct sources, no
 * thesis, or a conviction outside 0..1. A model that is never told those
 * requirements will produce prose, and someone will end up hand-transcribing it
 * into JSON, which is where invented numbers get in.
 *
 * The prompt therefore states the requirements, lists only the sources that
 * actually exist, and preserves unknown inputs as unknown. Conditional ideas and
 * waiting both need reasons; neither a hypothesis nor a parsed conclusion proves
 * an executed order.
 */

export const FINANCE_CONCLUSION_JSON_SHAPE = `{
  "conclusionId": "short-unique-id",
  "instrument": "TICKER",
  "direction": "buy" | "sell" | "hold",
  "conviction": <number between 0 and 1>,
  "thesis": "one or two sentences of reasoning",
  "expectationGap": { "origin": "model_hypothesis", "edgeKind": "fundamentals" | "valuation" | "interpretation" | "timing" | "flow" | "risk_rebalance" | "unknown", "marketExpectation": "baseline hypothesis or null", "variantView": "different driver or null", "catalyst": "event and horizon or null", "invalidation": "falsification or null", "costRiskAssessment": "cost and downside implications or null" },
  "assetClass": "us_equity" | "crypto" | "...",
  "evidence": [{ "sourceId": "<one of the listed sources>", "ref": "<optional locator>" }],
  "invalidationPrice": <number, optional>,
  "invalidationCondition": "<what would prove this wrong, optional>",
  "horizonDays": <number, optional>,
  "targetPrice": <number, optional>
}`;

export type AvailableSource = Readonly<{
  sourceId: string;
  description: string;
}>;

export function buildFinanceConclusionPrompt(params: {
  instrument: string;
  assetClass: string;
  availableSources: readonly AvailableSource[];
  question?: string;
  horizonDays?: number;
  valueAssessmentId?: string;
}): string {
  const sourceList = params.availableSources
    .map((source) => `- ${source.sourceId}: ${source.description}`)
    .join("\n");

  const methodKit = buildFinanceStrategyMethodKit(
    [
      params.question ?? "",
      `Instrument: ${params.instrument}`,
      `Asset class: ${params.assetClass}`,
      ...(params.horizonDays === undefined ? [] : [`Horizon: ${params.horizonDays} days`]),
    ].join("\n"),
  );
  const lines = [
    "You are producing a machine-checked research conclusion, not an essay.",
    "",
    `Instrument: ${params.instrument}`,
    `Asset class: ${params.assetClass}`,
    ...(params.horizonDays !== undefined
      ? [`Intended holding period: ${params.horizonDays} days`]
      : []),
    ...(params.question ? [`Question: ${params.question}`] : []),
    "",
    "Sources you may cite (cite only these; do not invent others):",
    sourceList,
    "",
    methodKit.prompt,
    FINANCE_FUNDAMENTAL_EXPECTATION_GUIDANCE,
    "For an investment candidate include expectationGap with each text field at most 180 characters, or null when unknown. It is a source-bound research hypothesis, never measured consensus or execution authority.",
    "Foreground methods come from deterministic task matching and are not an exclusive catalog selection. When the request explicitly asks to design or evaluate a matched method, address its contract or state why it is inapplicable or blocked by missing evidence; do not force a method into a purely factual task. You may combine relevant methods from the full catalog when the supplied evidence supports them.",
    "Explain the chosen mechanism, supporting evidence and failure conditions in the existing thesis and invalidation fields. Method evidence requirements do not authorize invented sources, unsupported numbers or order execution. Do not add fields to the JSON schema below.",
    "",
    "Reply with a single JSON object in this shape and nothing else:",
    params.valueAssessmentId
      ? FINANCE_CONCLUSION_JSON_SHAPE.replace(
          "{\n",
          `{\n  "valueAssessmentId": "${params.valueAssessmentId}",\n`,
        )
      : FINANCE_CONCLUSION_JSON_SHAPE,
    "",
    "Rules the checker enforces, so satisfy them or the conclusion is refused:",
    `- cite at least two DISTINCT sourceId values from the list above;`,
    "  listing the same source twice counts as one.",
    `- conviction must be a number between 0 and 1 that you can defend;`,
    "  do not write 0.9 because the tone of the question is optimistic.",
    "- thesis is required and must state the reason, not restate the direction.",
    '- if the evidence does not support a direction, answer "hold".',
    "  State the opportunity cost of waiting; uncertainty alone does not require hold when a bounded, evidence-linked conditional thesis is available.",
    "- use invalidationPrice when a price would prove you wrong, or",
    "  invalidationCondition when a fact would.",
    "",
    "Do not wrap the JSON in prose. Preserve uncertainty without inventing facts or forcing a direction.",
  ];
  return lines.join("\n");
}

/**
 * Pull the JSON object out of a model's reply.
 *
 * Handles a fenced code block and a bare object, and returns null rather than
 * throwing when there is nothing usable, so the caller can report "no
 * conclusion" instead of crashing mid-run.
 */
export function extractFinanceConclusionJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const parsed = tryParseFirstObject(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function tryParseFirstObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }
  // Walk forward to the matching close so nested braces are kept intact.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const slice = text.slice(start, index + 1);
        try {
          return JSON.parse(slice) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
