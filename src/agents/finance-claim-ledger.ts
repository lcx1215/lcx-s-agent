/**
 * A ledger of claims the system refused to act on, so they can be judged later.
 *
 * The problem this solves: a gate that refuses a trade settles the question for
 * that moment but never answers it. If the model keeps insisting that a certain
 * kind of trade is right, there is no way to find out whether the gate is wisely
 * cautious or wrongly timid, because the refused idea leaves no trace.
 *
 * So a refused claim is written down instead of discarded - what was claimed, how
 * strongly, why, and what refused it - and then resolved once the horizon has
 * passed against what the price actually did.
 *
 * Two rules keep this from becoming a back door:
 *
 * - recording a claim does not act on it. This ledger cannot place anything; it
 *   only observes.
 * - the result is evidence about the gate, not permission. A claim that turns
 *   out to have been right is a reason to review a threshold, not a reason to
 *   bypass it in the moment.
 *
 * It also protects against the opposite error: if most refused claims turn out
 * to have been wrong, that is the strongest possible evidence that the gate is
 * doing its job, and that insistence was misplaced.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

export const DEFAULT_CLAIM_HORIZON_DAYS = 30;

const CLAIMS_REL = "state/finance/claims.jsonl";

export type Claim = Readonly<{
  claimId: string;
  instrument: string;
  direction: "buy" | "sell";
  conviction: number;
  rationale: string;
  refusedBy: string;
  claimedAt: string;
  referencePrice: number;
  horizonDays: number;
  /** Filled in when resolved. */
  outcome?: 0 | 1;
  movePct?: number;
  resolvedAt?: string;
}>;

async function claimsFile(workspaceDir?: string): Promise<string> {
  const root = resolveWorkspaceRoot(workspaceDir);
  return path.isAbsolute(CLAIMS_REL) ? CLAIMS_REL : path.join(root, CLAIMS_REL);
}

export async function readClaims(workspaceDir?: string): Promise<Claim[]> {
  try {
    const raw = await fs.readFile(await claimsFile(workspaceDir), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const row = JSON.parse(line) as Claim;
          return typeof row?.instrument === "string" ? [row] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export async function recordClaim(params: {
  instrument: string;
  direction: "buy" | "sell";
  conviction: number;
  rationale: string;
  refusedBy: string;
  referencePrice: number;
  horizonDays?: number;
  workspaceDir?: string;
}): Promise<{ ok: true; claim: Claim } | { ok: false; refusals: readonly string[] }> {
  const refusals: string[] = [];
  const instrument = params.instrument.trim().toUpperCase();
  if (instrument.length === 0) {
    refusals.push("instrument is required");
  }
  if (!Number.isFinite(params.conviction) || params.conviction < 0 || params.conviction > 1) {
    refusals.push("conviction must be between 0 and 1");
  }
  if (!Number.isFinite(params.referencePrice) || params.referencePrice <= 0) {
    refusals.push("referencePrice must be a positive number, and must have been observed");
  }
  if (params.rationale.trim().length < 8) {
    refusals.push(
      "rationale is required and must be checkable later; a bare assertion cannot be judged in hindsight",
    );
  }
  if (params.direction !== "buy" && params.direction !== "sell") {
    refusals.push("direction must be buy or sell");
  }
  if (refusals.length > 0) {
    return { ok: false, refusals };
  }

  const claimedAt = new Date().toISOString();
  const claim: Claim = {
    claimId: "claim-" + Date.now().toString(36) + "-" + instrument.toLowerCase(),
    instrument,
    direction: params.direction,
    conviction: params.conviction,
    rationale: params.rationale.trim(),
    refusedBy: params.refusedBy.trim() || "unspecified",
    claimedAt,
    referencePrice: params.referencePrice,
    horizonDays: params.horizonDays ?? DEFAULT_CLAIM_HORIZON_DAYS,
  };

  const file = await claimsFile(params.workspaceDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(claim) + "\n");
  return { ok: true, claim };
}

export async function resolveClaims(params: {
  priceLookup: (instrument: string) => Promise<number | null>;
  workspaceDir?: string;
  nowMs?: number;
}): Promise<{ resolved: number; skipped: number }> {
  const all = await readClaims(params.workspaceDir);
  const nowMs = params.nowMs ?? Date.now();
  let resolved = 0;
  let skipped = 0;

  const out: Claim[] = [];
  for (const claim of all) {
    if (claim.outcome !== undefined) {
      out.push(claim);
      continue;
    }
    const dueMs = Date.parse(claim.claimedAt) + claim.horizonDays * 86_400_000;
    if (nowMs < dueMs) {
      skipped += 1;
      out.push(claim);
      continue;
    }
    const price = await params.priceLookup(claim.instrument);
    if (price === null || !Number.isFinite(price) || price <= 0) {
      // Unreadable is not "no move" - it stays pending rather than being scored.
      skipped += 1;
      out.push(claim);
      continue;
    }
    const movePct = ((price - claim.referencePrice) / claim.referencePrice) * 100;
    const movedUp = price > claim.referencePrice;
    const outcome: 0 | 1 = claim.direction === "buy" ? (movedUp ? 1 : 0) : movedUp ? 0 : 1;
    resolved += 1;
    out.push({
      ...claim,
      outcome,
      movePct: Number(movePct.toFixed(4)),
      resolvedAt: new Date(nowMs).toISOString(),
    });
  }

  const file = await claimsFile(params.workspaceDir);
  await fs.writeFile(
    file,
    out.map((c) => JSON.stringify(c)).join("\n") + (out.length > 0 ? "\n" : ""),
  );
  return { resolved, skipped };
}

export async function claimSummary(workspaceDir?: string): Promise<{
  total: number;
  resolved: number;
  pending: number;
  wouldHaveWon: number;
  wouldHaveLost: number;
  hitRate: number | null;
  meanClaimed: number | null;
}> {
  const all = await readClaims(workspaceDir);
  const resolvedClaims = all.filter((c) => c.outcome !== undefined);
  const wins = resolvedClaims.filter((c) => c.outcome === 1).length;
  return {
    total: all.length,
    resolved: resolvedClaims.length,
    pending: all.length - resolvedClaims.length,
    wouldHaveWon: wins,
    wouldHaveLost: resolvedClaims.length - wins,
    hitRate: resolvedClaims.length === 0 ? null : wins / resolvedClaims.length,
    meanClaimed:
      resolvedClaims.length === 0
        ? null
        : resolvedClaims.reduce((sum, c) => sum + c.conviction, 0) / resolvedClaims.length,
  };
}
