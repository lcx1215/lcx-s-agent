import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  assertValidLcxOntologyEdges,
  LCX_CASEFLOW_CONTRACT,
  LCX_ONTOLOGY_FINANCE_EXECUTION_AUTHORITIES,
  type LcxOntologyEdge,
} from "../shared/lcx-ontology.js";
import { FinanceForecast, type FinanceForecastContract } from "./finance-forecast-calibration.js";
import type { FinanceResearchRunReceipt } from "./finance-research-runner.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const CaseId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u);
const LEGACY_CASEFLOW_SCHEMA_VERSION = "lcx_caseflow_v1" as const;
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
const OntologyEdges = z.unknown().transform((value) => {
  assertValidLcxOntologyEdges(value, "caseflow ontology edges");
  return [...value];
});
const CaseRun = z.object({
  schemaVersion: z.union([
    z.literal(LCX_CASEFLOW_CONTRACT.schemaVersion),
    z.literal(LEGACY_CASEFLOW_SCHEMA_VERSION),
  ]),
  ontologyEdges: OntologyEdges.optional(),
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
    forecasts: z.array(FinanceForecast).optional(),
    status: z.enum(["planned", "candidate", "needs_review", "blocked"]),
    adopted: z.boolean(),
    analysis: z.string().optional(),
    supportingAnalysis: z.record(z.string(), z.unknown()).optional(),
    claims: z.array(Claim),
    gaps: z.array(z.string()),
    executionAuthority: z.enum([...LCX_ONTOLOGY_FINANCE_EXECUTION_AUTHORITIES]),
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
type ParsedFinanceCaseRun = z.infer<typeof CaseRun>;
export type FinanceCaseRun = Omit<ParsedFinanceCaseRun, "schemaVersion" | "ontologyEdges"> & {
  schemaVersion: typeof LCX_CASEFLOW_CONTRACT.schemaVersion;
  ontologyEdges: LcxOntologyEdge[];
};

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

function legacyTargetsFromDefinition(
  definition: Record<string, unknown>,
): readonly { id: string }[] {
  if (!Array.isArray(definition.targets)) {
    return [];
  }
  return definition.targets.flatMap((target) => {
    if (
      target !== null &&
      typeof target === "object" &&
      !Array.isArray(target) &&
      typeof (target as Record<string, unknown>).id === "string"
    ) {
      return [{ id: (target as Record<string, string>).id }];
    }
    return [];
  });
}

function buildFinanceCaseOntologyEdges(params: {
  caseId: string;
  runId: string;
  targets: readonly { id: string }[];
  evidence: readonly { id: string }[];
  claims: readonly { id: string; evidenceIds: readonly string[] }[];
}): LcxOntologyEdge[] {
  const taskId = `research_case:${params.caseId}`;
  const intentId = `intent:${params.caseId}`;
  const receiptId = `research_run:${params.runId}`;
  const artifactId = `decision_packet:${params.runId}`;
  const edges: LcxOntologyEdge[] = [];
  const seen = new Set<string>();
  const add = (edge: LcxOntologyEdge) => {
    const key = JSON.stringify(edge);
    if (!seen.has(key)) {
      seen.add(key);
      edges.push(edge);
    }
  };

  add({
    relation: "asks_for",
    subject: { type: "intent", id: intentId },
    object: { type: "task", id: taskId },
  });
  for (const target of params.targets) {
    add({
      relation: "targets",
      subject: { type: "task", id: taskId },
      object: { type: "domain_entity", id: `target:${target.id}` },
    });
  }
  add({
    relation: "produces",
    subject: { type: "task", id: taskId },
    object: { type: "receipt", id: receiptId },
  });
  add({
    relation: "produces",
    subject: { type: "task", id: taskId },
    object: { type: "artifact", id: artifactId },
  });
  add({
    relation: "owned_by",
    subject: { type: "artifact", id: artifactId },
    object: { type: "module", id: "src/agents/finance-caseflow.ts" },
  });
  add({
    relation: "validated_by",
    subject: { type: "artifact", id: artifactId },
    object: { type: "receipt", id: receiptId },
  });
  for (const item of params.evidence) {
    const evidenceId = `evidence:${item.id}`;
    add({
      relation: "requires",
      subject: { type: "task", id: taskId },
      object: { type: "evidence", id: evidenceId },
    });
    add({
      relation: "derived_from",
      subject: { type: "artifact", id: artifactId },
      object: { type: "evidence", id: evidenceId },
    });
  }
  const evidenceIds = new Set(params.evidence.map((item) => item.id));
  for (const claim of params.claims) {
    for (const evidenceId of claim.evidenceIds) {
      if (evidenceIds.has(evidenceId)) {
        add({
          relation: "supports",
          subject: { type: "evidence", id: `evidence:${evidenceId}` },
          object: { type: "claim", id: `claim:${claim.id}` },
        });
      }
    }
  }
  return edges;
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
  forecasts?: FinanceForecastContract[];
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
    ...(params.forecasts ? { forecasts: z.array(FinanceForecast).parse(params.forecasts) } : {}),
  });
  if (
    params.forecasts &&
    new Set(params.forecasts.map((f) => f.id)).size !== params.forecasts.length
  ) {
    throw new Error("duplicate forecast id");
  }
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
  const runId = randomUUID();
  const ontologyEdges = buildFinanceCaseOntologyEdges({
    caseId: params.caseId,
    runId,
    targets: receipt.plan.targets,
    evidence,
    claims,
  });
  return verify({
    schemaVersion: LCX_CASEFLOW_CONTRACT.schemaVersion,
    ontologyEdges,
    case: {
      id: params.caseId,
      revision: caseflowFingerprint(definition),
      question: receipt.plan.ask,
      asOf: receipt.plan.asOf,
      definition,
    },
    run: {
      id: runId,
      recordedAt: new Date().toISOString(),
      execution,
      executionFingerprint: caseflowFingerprint(execution),
      evidenceFingerprint: caseflowFingerprint(evidence),
      snapshotFingerprint: caseflowFingerprint(snapshot),
      evidence,
      snapshot,
    },
    packet: {
      ...(params.forecasts ? { forecasts: params.forecasts } : {}),
      status: invalidReferences ? "needs_review" : receipt.status,
      adopted:
        receipt.status === "candidate" &&
        receipt.gates.length > 0 &&
        receipt.gates.every((gate) => gate.passed) &&
        receipt.quarterlyOutput.adopted &&
        !invalidReferences,
      analysis: receipt.quarterlyOutput.candidateAnalysis,
      supportingAnalysis: receipt.quality?.finalArtifact?.supportingAnalysis,
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
  const parsed = CaseRun.parse(value);
  if (
    parsed.schemaVersion === LCX_CASEFLOW_CONTRACT.schemaVersion &&
    parsed.ontologyEdges === undefined
  ) {
    throw new Error("caseflow v2 artifact is missing ontology edges");
  }
  const result = {
    ...parsed,
    schemaVersion: LCX_CASEFLOW_CONTRACT.schemaVersion,
    ontologyEdges:
      parsed.ontologyEdges ??
      buildFinanceCaseOntologyEdges({
        caseId: parsed.case.id,
        runId: parsed.run.id,
        targets: legacyTargetsFromDefinition(parsed.case.definition),
        evidence: parsed.run.evidence,
        claims: parsed.packet.claims,
      }),
  } satisfies FinanceCaseRun;
  if (
    caseflowFingerprint(result.case.definition) !== result.case.revision ||
    caseflowFingerprint(result.run.execution) !== result.run.executionFingerprint ||
    caseflowFingerprint(result.run.evidence) !== result.run.evidenceFingerprint ||
    caseflowFingerprint(result.run.snapshot) !== result.run.snapshotFingerprint
  ) {
    throw new Error("caseflow fingerprint mismatch");
  }
  assertValidLcxOntologyEdges(result.ontologyEdges, "caseflow ontology edges");
  if (
    result.packet.forecasts &&
    caseflowFingerprint(result.packet.forecasts) !==
      caseflowFingerprint(result.case.definition.forecasts)
  ) {
    throw new Error("forecast definition mismatch");
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

/**
 * The stable part of a gap: the failure family, with the per-symbol and per-source detail
 * stripped.
 *
 * A blocked case can carry hundreds of gaps that are all one failure repeated per instrument
 * (`BTCUSDT:stale_or_invalid_collection_provenance:[...]`). The count alone would say how many
 * observations failed but not *which* failure it is, and "blocked by 426 gaps" is not actionable
 * while "blocked by stale_or_invalid_collection_provenance" is.
 *
 * Both shapes the caseflow writes are `<subject>:<failure>[:<detail>]`, where the failure is the
 * second segment: `<symbol>:<missing-evidence-kind>:[...]` for an uncollected observation and
 * `<gate-id>:<reason>` for a failed gate. So the second segment is the family in both, and a gap
 * with no separator is already its own family.
 */
export function caseflowGapKind(gap: string): string {
  const parts = gap.split(":");
  return parts.length >= 2 ? (parts[1] ?? gap) : gap;
}

/** Derived inventory only: content-addressed artifacts remain the source of truth. */
export type FinanceCaseInventoryEntry = {
  ref: string;
  caseId: string;
  question: string;
  revision: string;
  runId: string;
  recordedAt: string;
  asOf: string;
  status: FinanceCaseRun["packet"]["status"];
  adopted: boolean;
  claimCount: number;
  /**
   * Why the case is not further along, collapsed to one entry per failure family. Empty means the
   * case recorded no gap, not that it is unblocked — read `status` for that.
   */
  gapKinds: readonly string[];
  gapCount: number;
  followups: FinanceCaseRun["packet"]["followups"];
};
export async function listFinanceCases(directory: string): Promise<FinanceCaseInventoryEntry[]> {
  let filenames: string[];
  try {
    filenames = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const runs = await Promise.all(
    filenames
      .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
      .map(async (name) => {
        const ref = name.slice(0, -5);
        const run = await readFinanceCaseRun(directory, ref);
        return {
          ref,
          caseId: run.case.id,
          question: run.case.question,
          revision: run.case.revision,
          runId: run.run.id,
          recordedAt: run.run.recordedAt,
          asOf: run.case.asOf,
          status: run.packet.status,
          adopted: run.packet.adopted,
          claimCount: run.packet.claims.length,
          gapKinds: [...new Set(run.packet.gaps.map(caseflowGapKind))].toSorted(),
          gapCount: run.packet.gaps.length,
          followups: run.packet.followups,
        };
      }),
  );
  return runs.toSorted(
    (a, b) =>
      a.caseId.localeCompare(b.caseId) ||
      b.recordedAt.localeCompare(a.recordedAt) ||
      a.ref.localeCompare(b.ref),
  );
}
