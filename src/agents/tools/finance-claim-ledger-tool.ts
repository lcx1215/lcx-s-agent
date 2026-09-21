import { Type } from "@sinclair/typebox";
import {
  DEFAULT_CLAIM_HORIZON_DAYS,
  claimSummary,
  readClaims,
  recordClaim,
} from "../finance-claim-ledger.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

/**
 * Record a claim the system would not act on, and later find out whether
 * refusing it was right.
 *
 * Only contested claims are worth recording. When the model and the gate agree
 * there is nothing to learn, and writing every passing thought down would cost
 * more than it returns. The informative set is exactly the disagreement: cases
 * where the model wanted to act and the system declined.
 *
 * Recording does not act. This ledger cannot place anything - it observes, so
 * that in a month the question "was that refusal correct" has an answer instead
 * of an opinion.
 *
 * It also cuts the other way, which is the more likely outcome and the more
 * useful one: if most recorded claims turn out to have been wrong, that is
 * direct evidence the gate was right and the confidence behind it was misplaced.
 */

export const FINANCE_CLAIM_LEDGER_SCHEMA_VERSION = "lcx_finance_claim_ledger_v1" as const;

const FinanceClaimLedgerSchema = Type.Object({
  action: Type.Union([Type.Literal("record"), Type.Literal("list"), Type.Literal("summary")], {
    description: "record a refused claim, list them, or summarise how they turned out.",
  }),
  instrument: Type.Optional(Type.String({ description: "Symbol. Required for record." })),
  direction: Type.Optional(
    Type.Union([Type.Literal("buy"), Type.Literal("sell")], {
      description: "What was claimed. Required for record.",
    }),
  ),
  conviction: Type.Optional(
    Type.Number({ description: "Claimed conviction, 0..1. Required for record." }),
  ),
  rationale: Type.Optional(
    Type.String({
      description:
        "Why, in terms that can be checked later. Required for record; a bare assertion cannot be judged in hindsight.",
    }),
  ),
  refusedBy: Type.Optional(
    Type.String({ description: "What refused it - the refusal reason. Required for record." }),
  ),
  referencePrice: Type.Optional(
    Type.Number({ description: "Observed price at the time of the claim. Required for record." }),
  ),
  horizonDays: Type.Optional(
    Type.Number({ description: `Days until judgement (default ${DEFAULT_CLAIM_HORIZON_DAYS}).` }),
  ),
  workspaceDir: Type.Optional(Type.String({ description: "Workspace root." })),
});

export function createFinanceClaimLedgerTool(): AnyAgentTool {
  return {
    name: "finance_claim_ledger",
    label: "Finance claim ledger",
    description:
      "Record a trade claim the system refused, then later see whether refusing it was right. Observation only - it cannot place anything. Record only contested claims: agreement teaches nothing, disagreement is where the evidence is.",
    parameters: FinanceClaimLedgerSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action") ?? "summary";
      const workspaceDir = readStringParam(params, "workspaceDir");

      if (action === "summary") {
        const summary = await claimSummary(workspaceDir);
        return jsonResult({
          ok: true,
          schemaVersion: FINANCE_CLAIM_LEDGER_SCHEMA_VERSION,
          ...summary,
          note:
            summary.resolved === 0
              ? "No claims have come due yet, so there is no evidence either way about whether refusals are right."
              : undefined,
        });
      }

      if (action === "list") {
        const claims = await readClaims(workspaceDir);
        return jsonResult({
          ok: true,
          schemaVersion: FINANCE_CLAIM_LEDGER_SCHEMA_VERSION,
          count: claims.length,
          claims,
        });
      }

      const result = await recordClaim({
        instrument: readStringParam(params, "instrument") ?? "",
        direction: (readStringParam(params, "direction") ?? "") as "buy" | "sell",
        conviction: typeof params.conviction === "number" ? params.conviction : Number.NaN,
        rationale: readStringParam(params, "rationale") ?? "",
        refusedBy: readStringParam(params, "refusedBy") ?? "",
        referencePrice:
          typeof params.referencePrice === "number" ? params.referencePrice : Number.NaN,
        ...(typeof params.horizonDays === "number" ? { horizonDays: params.horizonDays } : {}),
        ...(workspaceDir ? { workspaceDir } : {}),
      });

      return jsonResult({
        ok: result.ok,
        schemaVersion: FINANCE_CLAIM_LEDGER_SCHEMA_VERSION,
        ...(result.ok
          ? {
              claim: result.claim,
              note: "Recorded for later judgement. This did not place an order, and it does not authorise one.",
            }
          : { refusals: [...result.refusals] }),
      });
    },
  };
}
