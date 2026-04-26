import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentId, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildWatchtowerAnomalyRecordRelativePath,
  buildWatchtowerAnomalyRepairTicketRelativePath,
  renderRepairTicketArtifact,
} from "../hooks/bundled/lobster-brain-registry.js";
import { writeFileWithinRoot } from "./fs-safe.js";

export type OperationalAnomalySeverity = "low" | "medium" | "high";

export type OperationalAnomalyRecord = {
  version: 1;
  generatedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  severity: OperationalAnomalySeverity;
  category: string;
  source: string;
  problem: string;
  impact: string;
  foundationTemplate?: string;
  suggestedScope: string;
  evidence: string[];
  fingerprint: string;
};

type ExistingOperationalAnomalyRecord = OperationalAnomalyRecord;

function sanitizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizeList(values: string[]): string[] {
  return values.map((entry) => sanitizeInline(entry)).filter(Boolean);
}

function buildFingerprint(params: {
  category: string;
  source: string;
  problem: string;
  fingerprint?: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      sanitizeInline(
        params.fingerprint ?? `${params.category}::${params.source}::${params.problem}`,
      ).toLowerCase(),
    )
    .digest("hex")
    .slice(0, 16);
}

function renderRepairTicket(params: { record: OperationalAnomalyRecord; nowIso: string }): string {
  return renderRepairTicketArtifact({
    titleValue: params.record.category,
    category: params.record.category,
    issueKey: params.record.fingerprint,
    foundationTemplate: params.record.foundationTemplate ?? "general",
    occurrences: params.record.occurrenceCount,
    lastSeen: params.record.lastSeenAt,
    problem: params.record.problem,
    evidenceLines: params.record.evidence,
    impactLine: params.record.impact,
    suggestedScopeLine: params.record.suggestedScope,
    extraMetadataLines: [
      `- **Severity**: ${params.record.severity}`,
      `- **Source**: ${params.record.source}`,
      `- **Fingerprint**: ${params.record.fingerprint}`,
    ],
    generatedAt: params.nowIso,
  });
}

function resolveOperationalWorkspaceDir(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
}): string | undefined {
  const explicit = params.workspaceDir?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  if (!params.cfg) {
    return undefined;
  }
  const agentId = resolveDefaultAgentId(params.cfg);
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
  return workspaceDir ? path.resolve(workspaceDir) : undefined;
}

async function readExistingRecord(params: {
  workspaceDir: string;
  recordPath: string;
}): Promise<ExistingOperationalAnomalyRecord | undefined> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(params.workspaceDir, params.recordPath), "utf-8"),
    ) as ExistingOperationalAnomalyRecord;
  } catch {
    return undefined;
  }
}

export async function recordOperationalAnomaly(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  category: string;
  severity: OperationalAnomalySeverity;
  source: string;
  problem: string;
  evidence: string[];
  impact: string;
  foundationTemplate?: string;
  suggestedScope?: string;
  fingerprint?: string;
  nowIso?: string;
  repairTicketThreshold?: number | false;
}): Promise<{
  recordPath?: string;
  ticketPath?: string;
  record?: OperationalAnomalyRecord;
}> {
  const workspaceDir = resolveOperationalWorkspaceDir(params);
  if (!workspaceDir) {
    return {};
  }

  await fs.mkdir(workspaceDir, { recursive: true });

  const nowIso = params.nowIso ?? new Date().toISOString();
  const problem = sanitizeInline(params.problem);
  const impact = sanitizeInline(params.impact);
  const evidence = sanitizeList(params.evidence);
  const suggestedScope = sanitizeInline(
    params.suggestedScope ??
      "smallest-safe-patch only; do not broaden providers, memory architecture, or doctrine without explicit approval",
  );
  const fingerprint = buildFingerprint({
    category: params.category,
    source: params.source,
    problem,
    fingerprint: params.fingerprint,
  });
  const recordPath = buildWatchtowerAnomalyRecordRelativePath({
    category: params.category,
    fingerprint,
  });
  const ticketPath = buildWatchtowerAnomalyRepairTicketRelativePath({
    category: params.category,
    fingerprint,
  });
  const existing = await readExistingRecord({
    workspaceDir,
    recordPath,
  });
  const record: OperationalAnomalyRecord = {
    version: 1,
    generatedAt: nowIso,
    firstSeenAt: existing?.firstSeenAt ?? nowIso,
    lastSeenAt: nowIso,
    occurrenceCount: (existing?.occurrenceCount ?? 0) + 1,
    severity: params.severity,
    category: params.category,
    source: params.source,
    problem,
    impact,
    foundationTemplate: params.foundationTemplate?.trim() || undefined,
    suggestedScope,
    evidence,
    fingerprint,
  };

  await writeFileWithinRoot({
    rootDir: workspaceDir,
    relativePath: recordPath,
    data: `${JSON.stringify(record, null, 2)}\n`,
    encoding: "utf-8",
    mkdir: true,
  });

  const repairTicketThreshold = params.repairTicketThreshold ?? 2;
  if (repairTicketThreshold === false) {
    return { recordPath, record };
  }
  if (record.occurrenceCount >= repairTicketThreshold) {
    await writeFileWithinRoot({
      rootDir: workspaceDir,
      relativePath: ticketPath,
      data: renderRepairTicket({ record, nowIso }),
      encoding: "utf-8",
      mkdir: true,
    });
    return { recordPath, ticketPath, record };
  }

  return { recordPath, record };
}
