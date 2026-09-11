import { expect, it } from "vitest";
import {
  FINANCE_ENTITY_CANARY,
  evaluateFinanceEntitySpecialist,
} from "./finance-model-specialist.js";
import type { LogicalAgentModelAdapter, ModelCallRequest } from "./logical-agent-model-router.js";
it("does not qualify repaired output or promote a perfect canary to general capability", async () => {
  let last: ModelCallRequest;
  const adapter: LogicalAgentModelAdapter = {
    id: "test",
    provider: "test",
    modelId: "test",
    mode: "adapter",
    capabilities: [],
    requiredTools: [],
    requiredSideEffects: [],
    invoke: async (request) => {
      last = request;
      const payload = request.payload as { items: { id: string; expected?: string }[] };
      expect(payload.items.every((item) => item.expected === undefined)).toBe(true);
      return {
        items: payload.items.map((item) => ({
          id: item.id,
          label: FINANCE_ENTITY_CANARY.find((test) => test.id === item.id)!.expected,
        })),
      };
    },
    observe: () => ({
      ...last,
      transportRequestId: "test-record",
      kind: "model_inference",
      outputNormalization: "json_extraction",
    }),
  };
  const repaired = await evaluateFinanceEntitySpecialist(adapter);
  expect(repaired.correct).toBe(24);
  expect(repaired.rawContract).toBe(0);
  expect(repaired.status).toBe("candidate_rejected");
  const raw = await evaluateFinanceEntitySpecialist({
    ...adapter,
    observe: () => ({ ...last, transportRequestId: "test-record", kind: "model_inference" }),
  });
  expect(raw.status).toBe("canary_pass_requires_heldout_and_runtime_qualification");
  expect(raw.generalModelPromotion).toBe(false);
});
