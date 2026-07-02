// Track B: turn the finance answer path from "audit-only" into "compose -> audit".
//
// Today `scripts/dev/lcx-commercial-answer-pipeline.ts` only AUDITS a
// `candidateAnswer` that is passed in — nothing in the repo actually composes
// one from a model + real data. The runtime reply path calls a model, but the
// dev answer pipeline has no compose step, so its scenario suite hard-codes
// answers.
//
// This module adds a testable composer that:
//   1. takes the live finance data-gateway snapshot as grounding context
//      (from finance-live-market-source.ts), and
//   2. calls the SAME real model interface the agent already uses
//      (Kimi / DeepSeek / MiniMax via the gateway `agent` method), injected so
//      it is testable offline, then
//   3. returns a candidate answer to be handed to the existing audit gate.
//
// It deliberately does NOT send Lark messages, mutate provider config, write
// protected memory, or claim user-visible-observed. It only produces a
// candidate answer object plus the grounding it used, so the existing audit
// (buildPipelineResult) stays the terminal authority.

import type { FinanceDataGatewaySnapshot } from "./finance-data-gateway.js";

/**
 * Minimal shape of the real gateway model call the agent already uses
 * (`callGateway({ method: "agent", params: { model, message, ... } })`).
 * Injecting it keeps this module offline-testable and avoids a hard import of
 * the feishu extension into the agents layer.
 */
export type FinanceModelCaller = (request: {
  model: string;
  userMessage: string;
  systemContext: string;
}) => Promise<{ text: string }>;

export type FinanceComposeRequest = {
  ask: string;
  /** The gateway snapshot from collectLiveFinanceGatewayInput -> buildFinanceDataGatewaySnapshot. */
  snapshot?: FinanceDataGatewaySnapshot;
  /** Model id to use, e.g. "moonshot/kimi-k2.5". Caller resolves the family. */
  model: string;
  callModel: FinanceModelCaller;
};

export type FinanceComposeResult = {
  candidateAnswer: string;
  /** The grounding context handed to the model, kept for receipts/audit. */
  groundingContext: string;
  /** Honest data posture derived from the snapshot, not from the model. */
  dataPosture: "grounded_ready" | "grounded_needs_review" | "data_blocked" | "no_snapshot";
  modelUsed: string;
};

const RESEARCH_ONLY_SYSTEM_PREAMBLE = [
  "You are LCX Agent composing a research-only finance answer.",
  "Hard rules: no buy/sell/add/reduce instructions, no position sizing, no options bet instructions.",
  "Cite every current number with its source and timestamp, or mark it unverified.",
  "If required data is missing or blocked, say exactly what is missing and what can be checked next;",
  "still give a useful research-grade decision packet (evidence status, thesis/counter-thesis,",
  "catalyst/invalidation, portfolio impact, next safe work).",
].join(" ");

/**
 * Render the live gateway snapshot into a compact, honest grounding block. This
 * is what separates a grounded answer from a hallucinated one: the model only
 * sees numbers that already carry source + timestamp + quality status, and it
 * is told plainly when the data is blocked/needs-review.
 */
export function buildGroundingContext(snapshot?: FinanceDataGatewaySnapshot): string {
  if (!snapshot) {
    return "No finance data-gateway snapshot is available. Do not invent current prices or numbers.";
  }
  const lines: string[] = [
    `Finance data gateway snapshot for ${snapshot.instrument} (${snapshot.assetClass}), asOf ${snapshot.asOf}.`,
    `Data quality: ${snapshot.qualityStatus}. Research-only; ${snapshot.boundary}.`,
  ];
  if (snapshot.normalizedFields.length > 0) {
    lines.push("Fields (each usable only with its source and timestamp):");
    for (const field of snapshot.normalizedFields) {
      const unit = field.currency ?? field.unit ?? "";
      lines.push(
        `- ${field.name} = ${field.value} ${unit} [${field.providerName}, ${field.providerRole}, ${field.sourceTimestamp}]`,
      );
    }
  }
  if (snapshot.conflicts.length > 0) {
    lines.push(
      `Conflicts present on: ${snapshot.conflicts
        .map((conflict) => conflict.fieldName)
        .join(", ")}. Do not resolve by preference; treat as needs-review.`,
    );
  }
  if (snapshot.missingEvidence.length > 0) {
    lines.push(`Missing evidence: ${snapshot.missingEvidence.join(", ")}.`);
  }
  if (snapshot.freshnessWarnings.length > 0) {
    lines.push(`Freshness warnings: ${snapshot.freshnessWarnings.join("; ")}.`);
  }
  if (snapshot.qualityStatus === "blocked") {
    lines.push(
      "Because quality is blocked, do NOT present the numbers as verified; explain what is missing and the next safe check.",
    );
  }
  return lines.join("\n");
}

function derivePosture(snapshot?: FinanceDataGatewaySnapshot): FinanceComposeResult["dataPosture"] {
  if (!snapshot) {
    return "no_snapshot";
  }
  switch (snapshot.qualityStatus) {
    case "ready":
      return "grounded_ready";
    case "needs_review":
      return "grounded_needs_review";
    default:
      return "data_blocked";
  }
}

/**
 * Compose a candidate finance answer using the real model interface, grounded
 * on the live gateway snapshot. The returned candidate is NOT final — the
 * caller must still run it through the existing audit gate
 * (buildPipelineResult) which stays the terminal authority.
 */
export async function composeFinanceAnswer(
  request: FinanceComposeRequest,
): Promise<FinanceComposeResult> {
  const ask = request.ask.trim();
  if (!ask) {
    throw new Error("ask required");
  }
  const groundingContext = buildGroundingContext(request.snapshot);
  const systemContext = `${RESEARCH_ONLY_SYSTEM_PREAMBLE}\n\n${groundingContext}`;

  const modelResult = await request.callModel({
    model: request.model,
    userMessage: ask,
    systemContext,
  });
  const candidateAnswer = modelResult.text.trim();
  if (!candidateAnswer) {
    // Fail closed: an empty model result must not become a fake adopted answer.
    throw new Error("model returned an empty candidate answer");
  }

  return {
    candidateAnswer,
    groundingContext,
    dataPosture: derivePosture(request.snapshot),
    modelUsed: request.model,
  };
}
