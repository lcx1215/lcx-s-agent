import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  createFinanceExecutionSafetyContext,
  type FinanceExecutionSafetyContextFactory,
} from "./finance-execution-safety.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Synthetic funded account, held shares and fresh observations. No provider evidence is implied. */
export function syntheticSafetyContextForAsset(
  assetType: "spot_equity" | "spot_crypto",
): FinanceExecutionSafetyContextFactory {
  return (binding) => {
    const stateDir = mkdtempSync(join(tmpdir(), "finance-synthetic-safety-"));
    directories.push(stateDir);
    const accountId = stateDir.split("/").at(-1)!;
    const observedAt = new Date(Date.now()).toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    return createFinanceExecutionSafetyContext({
      ...binding,
      stateDir,
      accountId,
      policy: {
        planId: "synthetic-authorized-plan",
        revision: "1",
        riskModel: "fully_funded_unhedged_spot",
        authorizedSide: binding.intent.side,
        authorizedQuantity: binding.intent.quantity,
        expiresAt,
        maxPortfolioDrawdownFraction: 0.1,
        maxGrossExposure: 2_000_000,
        maxAccountAgeMs: 60_000,
        maxQuoteAgeMs: 60_000,
        maxInstrumentEvidenceAgeMs: 60_000,
      },
      readFacts: async () => ({
        accountId,
        adapterId: binding.adapterId,
        venue: binding.venue,
        instrument: binding.intent.instrument,
        instrumentEvidence: {
          source: "fixture://spot-instrument",
          observedAt,
          assetType,
          fullyPaid: true,
          marginEnabled: false,
          hedged: false,
        },
        snapshotId: "synthetic-account-observation",
        source: "fixture://synthetic-account",
        observedAt,
        expiresAt,
        positionQuantity: binding.intent.side === "sell" ? binding.intent.quantity : 0,
        openOrderIds: [],
        unresolvedOrderIds: [],
        account: {
          status: "ACTIVE",
          tradingBlocked: false,
          equity: 1_000_000,
          peakEquity: 1_000_000,
          availableCash: 1_000_000,
          currency: "USD",
          grossExposure:
            binding.intent.side === "sell"
              ? binding.intent.quantity * binding.intent.referencePrice
              : 0,
        },
        quote: {
          source: "fixture://synthetic-quote",
          price: binding.intent.referencePrice,
          observedAt: binding.intent.referencePriceAt,
          expiresAt,
          currency: "USD",
        },
      }),
    });
  };
}

export const syntheticSafetyContext = syntheticSafetyContextForAsset("spot_equity");
