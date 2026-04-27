import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { optionalStringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const LOCAL_MEMORY_TYPES = [
  "lesson",
  "rule",
  "correction",
  "holding",
  "workflow",
  "pattern",
  "preference",
  "fact",
  "risk_gate",
] as const;

const LOCAL_MEMORY_STATUSES = ["active", "provisional", "downranked", "superseded"] as const;

const LOCAL_MEMORY_CONFIDENCE = ["low", "medium", "high"] as const;

const LOCAL_MEMORY_DIR = path.join("memory", "local-memory");

const LocalMemoryRecordSchema = Type.Object({
  subject: Type.String(),
  memoryType: optionalStringEnum(LOCAL_MEMORY_TYPES),
  summary: Type.String(),
  activationRule: Type.Optional(Type.String()),
  firstStep: Type.Optional(Type.String()),
  stopRule: Type.Optional(Type.String()),
  whyItMatters: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.String()),
  sourceArtifact: Type.Optional(Type.String()),
  confidence: optionalStringEnum(LOCAL_MEMORY_CONFIDENCE),
  status: optionalStringEnum(LOCAL_MEMORY_STATUSES),
  validFrom: Type.Optional(Type.String()),
  validTo: Type.Optional(Type.String()),
  updateReason: Type.Optional(Type.String()),
});

type LocalMemoryCard = {
  subject: string;
  memoryType: string;
  status: string;
  confidence: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  validFrom?: string;
  validTo?: string;
  sourceArtifact?: string;
  summary: string;
  activationRule?: string;
  firstStep?: string;
  stopRule?: string;
  whyItMatters?: string;
  evidence?: string;
  updateReason?: string;
  priorSnapshotsRaw: string;
  revisionTrailRaw: string;
};

function slugifyLocalMemorySubject(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/g, "")
    .replace(/-+$/g, "");
  return normalized || "memory-card";
}

function normalizeBlock(value?: string): string | undefined {
  const trimmed = value?.trim().replace(/\r\n/g, "\n");
  return trimmed ? trimmed : undefined;
}

function buildLocalMemoryCardRelPath(subject: string, memoryType: string): string {
  return `${LOCAL_MEMORY_DIR}/${memoryType}-${slugifyLocalMemorySubject(subject)}.md`;
}

function extractSection(content: string, heading: string): string | undefined {
  const normalized = content.replace(/\r\n/g, "\n");
  const marker = `## ${heading}\n`;
  const start = normalized.indexOf(marker);
  if (start < 0) {
    return undefined;
  }
  const from = start + marker.length;
  const rest = normalized.slice(from);
  const nextHeading = rest.indexOf("\n## ");
  const block = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  return normalizeBlock(block);
}

function parseMetadataBlock(content: string): Record<string, string> | null {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("# Local Memory Card")) {
    return null;
  }
  const headingIndex = normalized.indexOf("\n## ");
  const headerBlock = headingIndex >= 0 ? normalized.slice(0, headingIndex) : normalized;
  const lines = headerBlock.split("\n").slice(1);
  const metadata = new Map<string, string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = /^- ([a-z_]+):\s*(.*)$/u.exec(trimmed);
    if (!match) {
      return null;
    }
    const [, key, rawValue] = match;
    if (!key) {
      return null;
    }
    metadata.set(key, rawValue.trim());
  }
  return Object.fromEntries(metadata);
}

function parseLocalMemoryCard(content: string): LocalMemoryCard | null {
  const metadata = parseMetadataBlock(content);
  if (!metadata) {
    return null;
  }
  const subject = metadata.subject?.trim();
  const memoryType = metadata.memory_type?.trim();
  const status = metadata.status?.trim();
  const confidence = metadata.confidence?.trim();
  const createdAt = metadata.created_at?.trim();
  const updatedAt = metadata.updated_at?.trim();
  const revisionRaw = metadata.revision?.trim();
  const revision = revisionRaw ? Number.parseInt(revisionRaw, 10) : Number.NaN;
  const summary = extractSection(content, "Current Summary");
  const priorSnapshotsRaw = extractSection(content, "Prior Snapshots");
  const revisionTrailRaw = extractSection(content, "Revision Trail");
  if (
    !subject ||
    !memoryType ||
    !status ||
    !confidence ||
    !createdAt ||
    !updatedAt ||
    !Number.isFinite(revision) ||
    revision < 1 ||
    !summary ||
    !revisionTrailRaw
  ) {
    return null;
  }
  return {
    subject,
    memoryType,
    status,
    confidence,
    createdAt,
    updatedAt,
    revision,
    validFrom: normalizeBlock(metadata.valid_from),
    validTo: normalizeBlock(metadata.valid_to),
    sourceArtifact: normalizeBlock(metadata.source_artifact),
    summary,
    activationRule: extractSection(content, "Use This Card When"),
    firstStep: extractSection(content, "First Narrowing Step"),
    stopRule: extractSection(content, "Stop Rule"),
    whyItMatters: extractSection(content, "Why It Matters"),
    evidence: extractSection(content, "Evidence"),
    updateReason: extractSection(content, "Update Reason"),
    priorSnapshotsRaw:
      priorSnapshotsRaw && priorSnapshotsRaw !== "No prior snapshots yet." ? priorSnapshotsRaw : "",
    revisionTrailRaw,
  };
}

function renderOptionalSection(title: string, content?: string): string {
  return [`## ${title}`, content?.trim() || "Not recorded yet.", ""].join("\n");
}

function buildPriorSnapshot(card: LocalMemoryCard): string {
  const lines = [`### Revision ${card.revision} · ${card.updatedAt}`];
  lines.push(`- status: ${card.status}`);
  lines.push(`- confidence: ${card.confidence}`);
  if (card.sourceArtifact) {
    lines.push(`- source_artifact: ${card.sourceArtifact}`);
  }
  if (card.activationRule) {
    lines.push(`- use_when: ${card.activationRule}`);
  }
  lines.push("", "Summary:", card.summary.trim());
  if (card.firstStep) {
    lines.push("", "First narrowing step:", card.firstStep.trim());
  }
  if (card.stopRule) {
    lines.push("", "Stop rule:", card.stopRule.trim());
  }
  if (card.whyItMatters) {
    lines.push("", "Why it matters:", card.whyItMatters.trim());
  }
  if (card.evidence) {
    lines.push("", "Evidence:", card.evidence.trim());
  }
  return lines.join("\n").trim();
}

function renderLocalMemoryCard(params: {
  subject: string;
  memoryType: string;
  status: string;
  confidence: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  validFrom?: string;
  validTo?: string;
  sourceArtifact?: string;
  summary: string;
  activationRule?: string;
  firstStep?: string;
  stopRule?: string;
  whyItMatters?: string;
  evidence?: string;
  updateReason: string;
  priorSnapshotsRaw: string;
  revisionTrailRaw: string;
}): string {
  const metadataLines = [
    "# Local Memory Card",
    "",
    `- subject: ${params.subject}`,
    `- memory_type: ${params.memoryType}`,
    `- status: ${params.status}`,
    `- confidence: ${params.confidence}`,
    `- created_at: ${params.createdAt}`,
    `- updated_at: ${params.updatedAt}`,
    `- revision: ${params.revision}`,
    `- valid_from: ${params.validFrom ?? ""}`,
    `- valid_to: ${params.validTo ?? ""}`,
    `- source_artifact: ${params.sourceArtifact ?? ""}`,
    "- promotion_status: local_durable_memory_only",
    "- protected_summary_anchor: no",
    "",
    "## Current Summary",
    params.summary.trim(),
    "",
    renderOptionalSection("Use This Card When", params.activationRule),
    renderOptionalSection("First Narrowing Step", params.firstStep),
    renderOptionalSection("Stop Rule", params.stopRule),
    renderOptionalSection("Why It Matters", params.whyItMatters),
    renderOptionalSection("Evidence", params.evidence),
    "## Update Reason",
    params.updateReason.trim(),
    "",
    "## Prior Snapshots",
    params.priorSnapshotsRaw.trim() || "No prior snapshots yet.",
    "",
    "## Revision Trail",
    params.revisionTrailRaw.trim(),
    "",
  ];
  return metadataLines.join("\n");
}

export function createLocalMemoryRecordTool(options?: { workspaceDir?: string }): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Local Memory Record",
    name: "local_memory_record",
    description:
      "Create or update a bounded local durable-memory card under memory/local-memory for reusable lessons, rules, corrections, holdings, workflow patterns, or preferences. Reusing the same subject and memoryType revises the same card while preserving prior snapshots. This local archive is supplemental durable memory, not a replacement for protected summaries.",
    parameters: LocalMemoryRecordSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const subject = readStringParam(params, "subject", { required: true });
      const summary = readStringParam(params, "summary", { required: true });
      const memoryType = readStringParam(params, "memoryType")?.trim() || "lesson";
      const status = readStringParam(params, "status")?.trim() || "active";
      const confidence = readStringParam(params, "confidence")?.trim() || "medium";
      const activationRule = normalizeBlock(readStringParam(params, "activationRule"));
      const firstStep = normalizeBlock(readStringParam(params, "firstStep"));
      const stopRule = normalizeBlock(readStringParam(params, "stopRule"));
      const whyItMatters = normalizeBlock(readStringParam(params, "whyItMatters"));
      const evidence = normalizeBlock(readStringParam(params, "evidence"));
      const sourceArtifact = normalizeBlock(readStringParam(params, "sourceArtifact"));
      const validFrom = normalizeBlock(readStringParam(params, "validFrom"));
      const validTo = normalizeBlock(readStringParam(params, "validTo"));
      const relPath = buildLocalMemoryCardRelPath(subject, memoryType);
      const absPath = path.join(workspaceDir, relPath);
      const updateReason =
        normalizeBlock(readStringParam(params, "updateReason")) || "initial local memory capture";

      let existing: LocalMemoryCard | null = null;
      let created = false;
      try {
        const existingContent = await fs.readFile(absPath, "utf8");
        existing = parseLocalMemoryCard(existingContent);
        if (!existing) {
          return jsonResult({
            ok: false,
            created: false,
            updated: false,
            path: relPath,
            reason: "existing_card_malformed",
            action:
              "Repair or archive the malformed local memory card before retrying local_memory_record.",
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        created = true;
      }

      const now = new Date().toISOString();
      const revision = existing ? existing.revision + 1 : 1;
      const createdAt = existing?.createdAt ?? now;
      const priorSnapshotsRaw = existing
        ? [buildPriorSnapshot(existing), existing.priorSnapshotsRaw].filter(Boolean).join("\n\n")
        : "";
      const revisionTrailLine = `- ${now} · revision ${revision} · ${existing ? "updated" : "created"} · ${updateReason}`;
      const revisionTrailRaw = existing
        ? [revisionTrailLine, existing.revisionTrailRaw].filter(Boolean).join("\n")
        : revisionTrailLine;

      const rendered = renderLocalMemoryCard({
        subject,
        memoryType,
        status: existing && !readStringParam(params, "status") ? existing.status : status,
        confidence:
          existing && !readStringParam(params, "confidence") ? existing.confidence : confidence,
        createdAt,
        updatedAt: now,
        revision,
        validFrom: validFrom ?? existing?.validFrom,
        validTo: validTo ?? existing?.validTo,
        sourceArtifact: sourceArtifact ?? existing?.sourceArtifact,
        summary,
        activationRule: activationRule ?? existing?.activationRule,
        firstStep: firstStep ?? existing?.firstStep,
        stopRule: stopRule ?? existing?.stopRule,
        whyItMatters: whyItMatters ?? existing?.whyItMatters,
        evidence: evidence ?? existing?.evidence,
        updateReason:
          normalizeBlock(readStringParam(params, "updateReason")) ||
          (existing
            ? "refined local memory card with fresher evidence"
            : "initial local memory capture"),
        priorSnapshotsRaw,
        revisionTrailRaw,
      });

      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, rendered, "utf8");

      return jsonResult({
        ok: true,
        created,
        updated: !created,
        path: relPath,
        subject,
        memoryType,
        revision,
        action:
          "Use memory_search or memory_get later to recall this local memory card; protected summaries remain the first anchor for current-state truth.",
      });
    },
  };
}
