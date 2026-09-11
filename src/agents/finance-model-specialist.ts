import { createHash, randomUUID } from "node:crypto";
import type {
  LogicalAgentModelAdapter,
  ModelCallObservation,
} from "./logical-agent-model-router.js";

export const FINANCE_ENTITY_SPECIALIST_CONTRACT = "finance_entity_relevance_v1";
export type FinanceEntityCase = Readonly<{
  id: string;
  instrument: string;
  headline: string;
  expected: "relevant" | "irrelevant" | "uncertain";
}>;
/** Synthetic canary; success permits further evaluation, never general model promotion. */
export const FINANCE_ENTITY_CANARY: readonly FinanceEntityCase[] = [
  ["AAPL", "Apple reports quarterly iPhone revenue", "relevant"],
  ["AAPL", "Apple pie wins village baking competition", "irrelevant"],
  ["AAPL", "Supplier reports orders without naming customers", "uncertain"],
  ["NVDA", "Nvidia announces new data center GPU", "relevant"],
  ["NVDA", "Local football club appoints coach", "irrelevant"],
  ["NVDA", "Unnamed chip designer may face restrictions", "uncertain"],
  ["MSFT", "Microsoft Azure revenue grows", "relevant"],
  ["MSFT", "Apple launches a new phone", "irrelevant"],
  ["MSFT", "A software company is under investigation, identity withheld", "uncertain"],
  ["META", "Meta Platforms reports advertising revenue", "relevant"],
  ["META", "Meta analysis of bee populations published", "irrelevant"],
  ["META", "Unnamed social network plans layoffs", "uncertain"],
  ["TSLA", "Tesla cuts vehicle prices", "relevant"],
  ["TSLA", "Nikola Tesla museum opens exhibition", "irrelevant"],
  ["TSLA", "An undisclosed electric vehicle maker seeks funding", "uncertain"],
  ["AMZN", "Amazon AWS announces cloud expansion", "relevant"],
  ["AMZN", "Amazon rainforest bird species discovered", "irrelevant"],
  ["AMZN", "A major online retailer faces a lawsuit, company unnamed", "uncertain"],
  ["BTCUSDT", "Bitcoin network hash rate increases", "relevant"],
  ["BTCUSDT", "Ethereum upgrades its network", "irrelevant"],
  ["BTCUSDT", "An unnamed cryptocurrency was sold by a fund", "uncertain"],
  ["GLD", "SPDR Gold Shares reports fund holdings", "relevant"],
  ["GLD", "Gold medal awarded at swimming championship", "irrelevant"],
  ["GLD", "An unnamed gold ETF changes fees", "uncertain"],
].map(([instrument, headline, expected], index) => ({
  id: `entity-${index + 1}`,
  instrument: instrument,
  headline: headline,
  expected: expected as FinanceEntityCase["expected"],
}));

export function buildFinanceEntitySpecialistPrompt(payload: unknown): string {
  return `Classify each headline for the specified financial instrument. relevant means explicitly about its issuer, asset or exact fund. irrelevant means clearly another entity or nonfinancial homonym. uncertain means plausible but unnamed entity, cannot attribute. Use only the supplied headline, no external facts. Return ONLY JSON {"items":[{"id":"input id","label":"relevant|irrelevant|uncertain"}]}. No commentary. Input: ${JSON.stringify(payload)}`;
}

export async function evaluateFinanceEntitySpecialist(
  adapter: LogicalAgentModelAdapter,
  options: { cases?: readonly FinanceEntityCase[]; timeoutMs?: number } = {},
) {
  const cases = options.cases ?? FINANCE_ENTITY_CANARY;
  const results: { id: string; correct: boolean; rawContract: boolean; observed: boolean }[] = [];
  const observations: ModelCallObservation[] = [];
  for (let offset = 0; offset < cases.length; offset += 8) {
    const batch = cases.slice(offset, offset + 8);
    const identity = {
      callId: randomUUID(),
      correlationId: FINANCE_ENTITY_SPECIALIST_CONTRACT,
      taskId: `batch-${offset / 8}`,
      role: "news_classification" as const,
      attempt: 1,
      provider: adapter.provider,
      modelId: adapter.modelId,
    };
    let value: unknown;
    try {
      value = await adapter.invoke(
        { ...identity, payload: { items: batch.map(({ expected: _expected, ...item }) => item) } },
        AbortSignal.timeout(options.timeoutMs ?? 90_000),
      );
    } catch {
      value = undefined;
    }
    const observation = adapter.observe?.(identity);
    const observed =
      !!observation &&
      observation.callId === identity.callId &&
      observation.provider === adapter.provider &&
      observation.modelId === adapter.modelId &&
      !!observation.transportRequestId &&
      adapter.mode === "adapter" &&
      (observation.kind === "model_inference" || observation.kind === "provider_call");
    if (observation) {
      observations.push(observation);
    }
    const items =
      typeof value === "object" && value !== null && "items" in value && Array.isArray(value.items)
        ? (value.items as { id?: unknown; label?: unknown }[])
        : [];
    const contract =
      items.length === batch.length &&
      new Set(items.map((item) => item?.id)).size === batch.length &&
      items.every(
        (item) =>
          batch.some((test) => test.id === item?.id) &&
          ["relevant", "irrelevant", "uncertain"].includes(String(item?.label)),
      );
    for (const test of batch) {
      results.push({
        id: test.id,
        correct: contract && items.find((item) => item.id === test.id)?.label === test.expected,
        rawContract: contract && !observation?.outputNormalization,
        observed,
      });
    }
  }
  const correct = results.filter((item) => item.correct).length;
  const rawContract = results.filter((item) => item.rawContract).length;
  const observed = results.every((item) => item.observed);
  return {
    contract: FINANCE_ENTITY_SPECIALIST_CONTRACT,
    provider: adapter.provider,
    modelId: adapter.modelId,
    datasetSha256: createHash("sha256").update(JSON.stringify(cases)).digest("hex"),
    total: cases.length,
    correct,
    rawContract,
    observed,
    status:
      cases.length >= 24 &&
      correct / cases.length >= 0.95 &&
      rawContract === cases.length &&
      observed
        ? "canary_pass_requires_heldout_and_runtime_qualification"
        : "candidate_rejected",
    generalModelPromotion: false,
    candidateRole: "news_classification",
    results,
    normalizationCount: observations.filter((item) => item.outputNormalization).length,
  };
}
