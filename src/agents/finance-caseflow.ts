import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { FinanceResearchRunReceipt } from "./finance-research-runner.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const CaseId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u);
const Evidence = z.object({
  id: z.string(),
  source: z.string(),
  timestamp: z.string(),
  text: z.string(),
});
const Claim = z.object({
  id: z.string(),
  text: z.string(),
  evidenceIds: z.array(z.string()),
  kind: z.literal("inference_candidate"),
  sourceStatus: z.string(),
  referenceStatus: z.enum(["linked", "needs_review"]),
});
const CaseRun = z.object({
  schemaVersion: z.literal("lcx_caseflow_v1"),
  case: z.object({
    id: CaseId,
    revision: Hash,
    question: z.string().min(1),
    asOf: z.string(),
    definition: z.record(z.string(), z.unknown()),
  }),
  run: z.object({
    id: z.string().uuid(),
    recordedAt: z.string().datetime(),
    execution: z.record(z.string(), z.unknown()),
    executionFingerprint: Hash,
    evidenceFingerprint: Hash,
    snapshotFingerprint: Hash,
    evidence: z.array(Evidence),
    snapshot: z.record(z.string(), z.unknown()),
  }),
  packet: z.object({
    status: z.enum(["planned", "candidate", "needs_review", "blocked"]),
    adopted: z.boolean(),
    analysis: z.string().optional(),
    claims: z.array(Claim),
    gaps: z.array(z.string()),
    executionAuthority: z.literal("none"),
    semanticSupport: z.literal("not_independently_verified"),
    followups: z.array(
      z.object({
        months: z.number(),
        dueAt: z.string().datetime(),
        status: z.literal("not_scheduled"),
      }),
    ),
  }),
});
export type FinanceCaseRun = z.infer<typeof CaseRun>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("caseflow requires JSON values");
  }
  return encoded;
}
export function caseflowFingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function jsonRecord(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(JSON.parse(JSON.stringify(value)));
}
function followupDate(asOf: string, months: number): string {
  const date = new Date(asOf);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("invalid case observation date");
  }
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString();
}

/** Construct one self-contained run; raw evidence never comes from model output. */
export function buildFinanceCaseRun(params: {
  caseId: string;
  receipt: FinanceResearchRunReceipt;
  execution: Record<string, unknown>;
  budget: { maxApiCalls: number };
}): FinanceCaseRun {
  const { receipt } = params;
  CaseId.parse(params.caseId);
  z.number().int().positive().parse(params.budget.maxApiCalls);
  const definition = jsonRecord({
    question: receipt.plan.ask,
    asOf: receipt.plan.asOf,
    horizonMonths: receipt.plan.horizonMonths,
    decisionMode: receipt.plan.decisionMode,
    targets: receipt.plan.targets,
    budget: params.budget,
  });
  const snapshot = jsonRecord(receipt);
  const execution = jsonRecord(params.execution);
  const evidence = (receipt.batch?.committeeEvidence ?? []).map((item) => ({ ...item }));
  const ids = new Set(evidence.map((item) => item.id));
  if (ids.size !== evidence.length) {
    throw new Error("duplicate case evidence id");
  }
  const claims = (receipt.quarterlyOutput.candidateClaims ?? []).map((claim) => ({
    id: claim.id,
    text: claim.text,
    evidenceIds: [...claim.evidenceIds],
    kind: "inference_candidate" as const,
    sourceStatus: claim.status,
    referenceStatus:
      claim.evidenceIds.length > 0 && claim.evidenceIds.every((id) => ids.has(id))
        ? ("linked" as const)
        : ("needs_review" as const),
  }));
  const invalidReferences = claims.some((claim) => claim.referenceStatus === "needs_review");
  return CaseRun.parse({
    schemaVersion: "lcx_caseflow_v1",
    case: {
      id: params.caseId,
      revision: caseflowFingerprint(definition),
      question: receipt.plan.ask,
      asOf: receipt.plan.asOf,
      definition,
    },
    run: {
      id: randomUUID(),
      recordedAt: new Date().toISOString(),
      execution,
      executionFingerprint: caseflowFingerprint(execution),
      evidenceFingerprint: caseflowFingerprint(evidence),
      snapshotFingerprint: caseflowFingerprint(snapshot),
      evidence,
      snapshot,
    },
    packet: {
      status: invalidReferences ? "needs_review" : receipt.status,
      adopted:
        receipt.status === "candidate" &&
        receipt.gates.length > 0 &&
        receipt.gates.every((gate) => gate.passed) &&
        receipt.quarterlyOutput.adopted &&
        !invalidReferences,
      analysis: receipt.quarterlyOutput.candidateAnalysis,
      claims,
      gaps: [
        ...receipt.missingEvidence,
        ...receipt.gates.filter((gate) => !gate.passed).map((gate) => `${gate.id}:${gate.reason}`),
        ...(invalidReferences ? ["unresolved_claim_references"] : []),
      ],
      executionAuthority: "none",
      semanticSupport: "not_independently_verified",
      followups: [3, 6].map((months) => ({
        months,
        dueAt: followupDate(receipt.plan.asOf, months),
        status: "not_scheduled",
      })),
    },
  });
}

function verify(value: unknown): FinanceCaseRun {
  const result = CaseRun.parse(value);
  if (
    caseflowFingerprint(result.case.definition) !== result.case.revision ||
    caseflowFingerprint(result.run.execution) !== result.run.executionFingerprint ||
    caseflowFingerprint(result.run.evidence) !== result.run.evidenceFingerprint ||
    caseflowFingerprint(result.run.snapshot) !== result.run.snapshotFingerprint
  ) {
    throw new Error("caseflow fingerprint mismatch");
  }
  return result;
}

/** Atomic publication via a same-directory hard link: no overwrite and no partial reader. */
export async function saveFinanceCaseRun(directory: string, value: FinanceCaseRun) {
  const run = verify(value);
  const encoded = canonical(run);
  const ref = caseflowFingerprint(run);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, `${ref}.json`);
  const temporary = path.join(directory, `.caseflow-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(encoded + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if ((await fs.readFile(destination, "utf8")).trim() !== encoded) {
        throw new Error("caseflow existing artifact mismatch", { cause: error });
      }
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }

  return {
    ref,
    path: destination,
    caseId: run.case.id,
    caseRevision: run.case.revision,
    runId: run.run.id,
  };
}

/** Reading frozen output never calls a source or model. This is not model replay. */
export async function readFinanceCaseRun(directory: string, ref: string): Promise<FinanceCaseRun> {
  Hash.parse(ref);
  const value: unknown = JSON.parse(await fs.readFile(path.join(directory, `${ref}.json`), "utf8"));
  if (caseflowFingerprint(value) !== ref) {
    throw new Error("caseflow artifact integrity mismatch");
  }
  return verify(value);
}

export function compareFinanceCaseRuns(before: FinanceCaseRun, after: FinanceCaseRun) {
  verify(before);
  verify(after);
  if (before.case.id !== after.case.id) {
    throw new Error("cannot compare different research cases");
  }
  const oldClaims = new Map(before.packet.claims.map((claim) => [claim.id, claim]));
  const newClaims = new Map(after.packet.claims.map((claim) => [claim.id, claim]));
  return {
    caseId: before.case.id,
    beforeRun: before.run.id,
    afterRun: after.run.id,
    definitionChanged: before.case.revision !== after.case.revision,
    executionChanged: before.run.executionFingerprint !== after.run.executionFingerprint,
    evidenceComparison: "exact_snapshot_including_transport_metadata",
    evidenceChanged: before.run.evidenceFingerprint !== after.run.evidenceFingerprint,
    status: { before: before.packet.status, after: after.packet.status },
    addedClaims: [...newClaims.keys()].filter((id) => !oldClaims.has(id)),
    removedClaims: [...oldClaims.keys()].filter((id) => !newClaims.has(id)),
    changedClaims: [...newClaims.keys()].filter(
      (id) => oldClaims.has(id) && canonical(oldClaims.get(id)) !== canonical(newClaims.get(id)),
    ),
    gaps: { before: before.packet.gaps, after: after.packet.gaps },
  };
}
