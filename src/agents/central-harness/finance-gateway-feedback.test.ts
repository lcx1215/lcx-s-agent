import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { probeOriginalGatewayFeedback } from "../../../test/fixtures/lcx-waterflow-gateway-feedback-probe.js";
import { CENTRAL_STEP_OUTCOME_BUDGET_BYTES, nextCycleContinuation } from "./harness-loop.js";
import { createCentralToolRegistry } from "./tool-registry.js";

describe("original financial gateway feedback in the central tool loop", () => {
  it.each(["conflict", "missing_source", "unchanged"] as const)(
    "carries the specific %s into exact recall and a subsequent judgment",
    async (fault) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-feedback-"));
      try {
        const result = await probeOriginalGatewayFeedback(root, fault);
        expect(result.inputKeys).toEqual(
          expect.arrayContaining(["asOfMode", "crossSourceSkewMaxMinutes"]),
        );
        expect(result.catalog).toContain("asOfMode");
        expect(result.catalog).toContain("crossSourceSkewMaxMinutes");
        const first = result.receipts[0].steps[0];
        expect(first.status).toBe("ran_ok");
        expect(first.outcome).toMatchObject({
          qualityStatus: fault === "missing_source" ? "blocked" : "needs_review",
          nextTool: "finance_data_gateway_snapshot",
          nextReviewTarget: "data_provenance_quality_review_input",
          retryOnlyAfter: "new_or_corrected_source_observations",
        });
        expect(Buffer.byteLength(JSON.stringify(first.outcome))).toBeLessThanOrEqual(
          CENTRAL_STEP_OUTCOME_BUDGET_BYTES,
        );
        expect(first.outcomeDroppedKeys).toContain("normalizedFields");
        expect(result.callableNextTools.every((item) => item.registered)).toBe(true);
        const recall = result.receipts[1].steps[0];
        expect(recall.outcome).toMatchObject({
          available: true,
          artifactId: result.artifactId,
          field: result.readField,
        });
        expect(recall.outcome?.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(result.perceptions[1].backlog).toEqual(expect.any(Array));
        expect(result.receipts.at(-1)?.steps).toHaveLength(0);
        if (fault === "conflict") {
          expect(first.outcome?.conflictingFields).toEqual(["last_price"]);
          expect(result.selected).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ value: 100 }),
              expect.objectContaining({ value: 110 }),
            ]),
          );
          const revalidated = result.receipts[2].steps[0];
          expect(revalidated.args).toEqual(result.correctedInput);
          expect(revalidated.outcome?.qualityStatus).toBe("ready");
          expect(revalidated.outcome).not.toHaveProperty("nextTool");
          expect(result.finalNote).toContain(
            "upstream truth and broker authority remain unverified",
          );
        } else if (fault === "missing_source") {
          expect(first.outcome?.missingEvidence).toContain("cross_check_market_data_provider");
          expect(result.selected).toContain("cross_check_market_data_provider");
          expect(result.finalNote).toContain("Unresolved: cross_check_market_data_provider");
        } else {
          expect(result.receipts[2].steps[0].outcome?.qualityStatus).toBe("needs_review");
          expect(result.finalNote).toContain("still conflict");
          expect(nextCycleContinuation(result.receipts[2], 2, 5, result.receipts[0])).toEqual({
            run: false,
            because: "unchanged_result",
          });
        }
        const registry = createCentralToolRegistry({ workspaceDir: root });
        expect(
          registry
            .get("finance_data_gateway_snapshot")!
            .approve({ ...result.input, writeReceipt: true }).ok,
        ).toBe(false);
        expect(registry.has("data_provenance_quality_review_input")).toBe(false);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
