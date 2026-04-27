import fs from "node:fs/promises";
import path from "node:path";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import {
  buildMemoryHygieneArtifactRelativePath,
  buildWatchtowerArtifactDir,
  isLobsterWorkfaceFilename,
  isCorrectionNoteFilename,
  isKnowledgeValidationNoteFilename,
  isLearningCouncilMemoryNoteFilename,
  parseLobsterWorkfaceFilename,
  parseCodexEscalationArtifact,
  parseCorrectionNoteArtifact,
  parseCorrectionNoteFilename,
  parseKnowledgeValidationNote,
  parseLearningCouncilMemoryNote,
  parseWatchtowerAnomalyRecord,
} from "../lobster-brain-registry.js";
import {
  addUtcDateKeyDays,
  formatIsoWeek,
  isWithinTrailingUtcDays,
  toUtcDateKey,
} from "../weekly-memory.js";

const log = createSubsystemLogger("hooks/memory-hygiene-weekly");

type StorageReason =
  | "provisional_replacement"
  | "bounded_learning_note"
  | "failed_validation"
  | "hallucination_prone"
  | "expired_operating_artifact";

type StorageRecord = {
  relativePath: string;
  source: "correction" | "learning" | "validation" | "operating_artifact";
  reason: StorageReason;
  createdAt: string;
  expiresAt?: string;
  reviveCondition?: string;
  summary: string;
};

type AntiPatternRecord = {
  label: string;
  count: number;
  evidence: string[];
};

type CodexEscalationRecord = {
  relativePath: string;
  category: string;
  source: string;
  severity: string;
  foundationTemplate: string;
  generatedAt: string;
  problem: string;
};

function sanitizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderLedger(title: string, records: StorageRecord[]): string {
  return [
    `# ${title}`,
    "",
    ...(records.length > 0
      ? records.flatMap((record) => [
          `## ${record.relativePath}`,
          `- source: ${record.source}`,
          `- reason: ${record.reason}`,
          `- created_at: ${record.createdAt}`,
          `- expires_at: ${record.expiresAt ?? "none"}`,
          `- revive_condition: ${record.reviveCondition ?? "none"}`,
          `- summary: ${record.summary}`,
          "",
        ])
      : ["- no records", ""]),
  ].join("\n");
}

function renderAntiPatterns(weekKey: string, records: AntiPatternRecord[]): string {
  return [
    `# Anti-Patterns: ${weekKey}`,
    "",
    ...(records.length > 0
      ? records.flatMap((record) => [
          `## ${record.label}`,
          `- count: ${record.count}`,
          ...record.evidence.map((item) => `- evidence: ${item}`),
          "",
        ])
      : ["- no repeated anti-patterns crossed threshold this week.", ""]),
  ].join("\n");
}

function renderWeeklyReport(params: {
  weekKey: string;
  rangeLabel: string;
  sessionKey: string;
  provisional: StorageRecord[];
  rejected: StorageRecord[];
  antiPatterns: AntiPatternRecord[];
  codexEscalations: CodexEscalationRecord[];
  trashCandidates: StorageRecord[];
  prunedPaths: string[];
}): string {
  return [
    `# Memory Hygiene Weekly: ${params.weekKey}`,
    "",
    `- **Window**: ${params.rangeLabel}`,
    `- **Session Key**: ${params.sessionKey}`,
    `- **Provisional Records**: ${params.provisional.length}`,
    `- **Rejected Records**: ${params.rejected.length}`,
    `- **Anti-Patterns**: ${params.antiPatterns.length}`,
    `- **Codex Escalations**: ${params.codexEscalations.length}`,
    `- **Trash Candidates**: ${params.trashCandidates.length}`,
    `- **Pruned Paths**: ${params.prunedPaths.length}`,
    "",
    "## Verified Boundary",
    "- verified memory stays small, explicit, and separate; provisional and rejected material must not enter primary answers by default.",
    "",
    "## Provisional Queue",
    ...(params.provisional.length > 0
      ? params.provisional.map(
          (record) =>
            `- ${record.relativePath} (${record.reason}) - expires ${record.expiresAt ?? "none"}`,
        )
      : ["- no provisional queue entries this week."]),
    "",
    "## Rejected / Quarantine Queue",
    ...(params.rejected.length > 0
      ? params.rejected.map(
          (record) =>
            `- ${record.relativePath} (${record.reason}) - revive only if ${record.reviveCondition ?? "explicit operator review"}`,
        )
      : ["- no rejected validation records this week."]),
    "",
    "## Anti-Patterns To Keep",
    ...(params.antiPatterns.length > 0
      ? params.antiPatterns.map((record) => `- ${record.label}: ${record.count} recent signals`)
      : ["- no repeated anti-pattern crossed the extraction threshold this week."]),
    "",
    "## Codex Escalation Queue",
    ...(params.codexEscalations.length > 0
      ? params.codexEscalations.map(
          (record) =>
            `- ${record.severity} / ${record.category}: ${record.problem} (source ${record.source}, foundation ${record.foundationTemplate})`,
        )
      : ["- no Codex escalation packet entered memory hygiene this week."]),
    "",
    "## Trash / TTL",
    ...(params.trashCandidates.length > 0
      ? params.trashCandidates.map(
          (record) => `- ${record.relativePath} -> expires ${record.expiresAt ?? "none"}`,
        )
      : ["- no trash candidates were identified this week."]),
    "",
    "## Prune Actions",
    ...(params.prunedPaths.length > 0
      ? params.prunedPaths.map((relativePath) => `- pruned ${relativePath}`)
      : ["- no eligible expired artifact was pruned this week."]),
    "",
    "## Guardrails",
    "- provisional or rejected material is kept for audit and review, not for silent reuse in current-research-line or control-room answers.",
    "- pruning is intentionally narrow: only regenerable operating artifacts with explicit TTL are removed automatically.",
    "",
  ].join("\n");
}

async function loadProvisionalRecords(memoryDir: string, now: Date): Promise<StorageRecord[]> {
  const entries = await fs.readdir(memoryDir, { withFileTypes: true }).catch(() => []);
  const records = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          (isCorrectionNoteFilename(entry.name) || isLearningCouncilMemoryNoteFilename(entry.name)),
      )
      .map(async (entry): Promise<StorageRecord | undefined> => {
        const correctionMatch = parseCorrectionNoteFilename(entry.name);
        const content = await fs
          .readFile(path.join(memoryDir, entry.name), "utf-8")
          .catch(() => "");
        const learningNote = correctionMatch
          ? undefined
          : parseLearningCouncilMemoryNote({ filename: entry.name, content });
        const date = correctionMatch?.dateStr ?? learningNote?.date;
        if (!date || !isWithinTrailingUtcDays(date, now, 7)) {
          return undefined;
        }
        if (correctionMatch) {
          const summary =
            parseCorrectionNoteArtifact(content)?.whatWasWrong ??
            "correction note stayed provisional";
          return {
            relativePath: `memory/${entry.name}`,
            source: "correction",
            reason: "provisional_replacement",
            createdAt: date,
            expiresAt: addUtcDateKeyDays(date, 30),
            reviveCondition: "promote only after repeated use or stronger evidence",
            summary,
          } satisfies StorageRecord;
        }
        const summary = learningNote?.status || "bounded learning-council note";
        return {
          relativePath: `memory/${entry.name}`,
          source: "learning",
          reason: "bounded_learning_note",
          createdAt: date,
          expiresAt: addUtcDateKeyDays(date, 21),
          reviveCondition: "promote only if re-verified or reused successfully",
          summary,
        } satisfies StorageRecord;
      }),
  );
  return records.filter((record): record is StorageRecord => Boolean(record));
}

async function loadRejectedRecords(memoryDir: string, now: Date): Promise<StorageRecord[]> {
  const entries = await fs.readdir(memoryDir, { withFileTypes: true }).catch(() => []);
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && isKnowledgeValidationNoteFilename(entry.name))
      .map(async (entry): Promise<StorageRecord | undefined> => {
        const content = await fs
          .readFile(path.join(memoryDir, entry.name), "utf-8")
          .catch(() => "");
        const parsed = parseKnowledgeValidationNote({ filename: entry.name, content });
        if (!parsed || !isWithinTrailingUtcDays(parsed.date, now, 7)) {
          return undefined;
        }
        const verdict = parsed.verdict.trim().toLowerCase();
        const hallucinationRisk = parsed.hallucinationRisk.trim().toLowerCase();
        if (verdict !== "fail" && hallucinationRisk !== "high") {
          return undefined;
        }
        const reason: StorageReason =
          verdict === "fail" ? "failed_validation" : "hallucination_prone";
        const summary =
          parsed.domain || "validation note failed or remained too hallucination-prone";
        return {
          relativePath: `memory/${entry.name}`,
          source: "validation",
          reason,
          createdAt: parsed.date,
          expiresAt: addUtcDateKeyDays(parsed.date, 45),
          reviveCondition: "only after a fresh validation pass changes the verdict",
          summary,
        } satisfies StorageRecord;
      }),
  );
  return records.filter((record): record is StorageRecord => Boolean(record));
}

function inferAntiPatternLabel(value: string): string | undefined {
  const normalized = value.toLowerCase();
  if (
    normalized.includes("freshness") ||
    normalized.includes("实时") ||
    normalized.includes("stale")
  ) {
    return "stale-anchor overreach";
  }
  if (normalized.includes("hallucination") || normalized.includes("编造")) {
    return "high-confidence low-evidence reply";
  }
  if (normalized.includes("role drift") || normalized.includes("角色漂移")) {
    return "workflow role drift";
  }
  if (normalized.includes("learning council") || normalized.includes("学习委员会")) {
    return "fake council or weak council discipline";
  }
  if (normalized.includes("wait") || normalized.includes("冲动") || normalized.includes("fomo")) {
    return "poor wait discipline";
  }
  return undefined;
}

async function loadAntiPatterns(
  memoryDir: string,
  workspaceDir: string,
  now: Date,
): Promise<AntiPatternRecord[]> {
  const correctionEntries = await fs.readdir(memoryDir, { withFileTypes: true }).catch(() => []);
  const anomalyDir = path.join(workspaceDir, buildWatchtowerArtifactDir("anomalies"));
  const anomalyEntries = await fs.readdir(anomalyDir, { withFileTypes: true }).catch(() => []);
  const packetDir = path.join(workspaceDir, buildWatchtowerArtifactDir("codexEscalations"));
  const packetEntries = await fs.readdir(packetDir, { withFileTypes: true }).catch(() => []);
  const evidence: string[] = [];

  for (const entry of correctionEntries) {
    if (!entry.isFile() || !isCorrectionNoteFilename(entry.name)) {
      continue;
    }
    const parsed = parseCorrectionNoteFilename(entry.name);
    if (!parsed?.dateStr || !isWithinTrailingUtcDays(parsed.dateStr, now, 7)) {
      continue;
    }
    const content = await fs.readFile(path.join(memoryDir, entry.name), "utf-8").catch(() => "");
    const item = parseCorrectionNoteArtifact(content)?.whatWasWrong;
    if (item) {
      evidence.push(item);
    }
  }

  for (const entry of anomalyEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const content = parseWatchtowerAnomalyRecord(
      await fs.readFile(path.join(anomalyDir, entry.name), "utf-8").catch(() => "{}"),
    );
    const date = content?.lastSeenDateKey;
    if (!date || !isWithinTrailingUtcDays(date, now, 7)) {
      continue;
    }
    evidence.push(`${content.category} ${content.problem}`.trim());
  }

  for (const entry of packetEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const content = parseCodexEscalationArtifact(
      await fs.readFile(path.join(packetDir, entry.name), "utf-8").catch(() => ""),
    );
    const date = content?.generatedDateKey;
    if (!date || !isWithinTrailingUtcDays(date, now, 7)) {
      continue;
    }
    evidence.push(`${content.category} ${content.problem}`.trim());
  }

  const grouped = new Map<string, string[]>();
  for (const item of evidence) {
    const label = inferAntiPatternLabel(item);
    if (!label) {
      continue;
    }
    const list = grouped.get(label) ?? [];
    list.push(sanitizeInline(item));
    grouped.set(label, list);
  }

  return [...grouped.entries()]
    .map(([label, items]) => ({
      label,
      count: items.length,
      evidence: [...new Set(items)].slice(0, 3),
    }))
    .filter((record) => record.count >= 2)
    .toSorted((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

async function loadCodexEscalations(
  workspaceDir: string,
  now: Date,
): Promise<CodexEscalationRecord[]> {
  const packetDir = path.join(workspaceDir, buildWatchtowerArtifactDir("codexEscalations"));
  try {
    const entries = await fs.readdir(packetDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map(async (entry) => {
          const content = parseCodexEscalationArtifact(
            await fs.readFile(path.join(packetDir, entry.name), "utf-8"),
          );
          if (!content || !isWithinTrailingUtcDays(content.generatedDateKey, now, 7)) {
            return undefined;
          }
          return {
            relativePath: `${buildWatchtowerArtifactDir("codexEscalations")}/${entry.name}`,
            category: content.category,
            source: content.source,
            severity: content.severity,
            foundationTemplate: content.foundationTemplate,
            generatedAt: content.generatedAt,
            problem: content.problem,
          } satisfies CodexEscalationRecord;
        }),
    );
    return parsed
      .filter((record): record is CodexEscalationRecord => Boolean(record))
      .toSorted(
        (a, b) =>
          b.generatedAt.localeCompare(a.generatedAt) || a.category.localeCompare(b.category),
      );
  } catch {
    return [];
  }
}

async function buildTrashCandidates(memoryDir: string, now: Date): Promise<StorageRecord[]> {
  const entries = await fs.readdir(memoryDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && isLobsterWorkfaceFilename(entry.name))
    .map((entry) => {
      const date = parseLobsterWorkfaceFilename(entry.name)?.dateKey ?? toUtcDateKey(now);
      return {
        relativePath: `memory/${entry.name}`,
        source: "operating_artifact",
        reason: "expired_operating_artifact",
        createdAt: date,
        expiresAt: addUtcDateKeyDays(date, 21),
        reviveCondition: "restore only for operator-debugging or audit reconstruction",
        summary: "daily workface is regenerable and should not accumulate forever",
      } satisfies StorageRecord;
    })
    .filter((record) => {
      const expires = new Date(`${record.expiresAt}T00:00:00.000Z`);
      return expires <= now;
    });
}

async function pruneTrashCandidates(
  workspaceDir: string,
  records: StorageRecord[],
): Promise<string[]> {
  const pruned: string[] = [];
  for (const record of records) {
    if (
      !record.relativePath.startsWith("memory/") ||
      !record.relativePath.endsWith("-lobster-workface.md")
    ) {
      continue;
    }
    const absolutePath = path.join(workspaceDir, record.relativePath);
    await fs.rm(absolutePath, { force: true }).catch(() => undefined);
    pruned.push(record.relativePath);
  }
  return pruned;
}

const saveMemoryHygieneWeekly: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir, displaySessionKey } = await resolveMemorySessionContext({
      event,
    });
    const now = new Date(event.timestamp);
    const { weekKey, rangeLabel } = formatIsoWeek(now);
    const [provisional, rejected, antiPatterns, codexEscalations, trashCandidates] =
      await Promise.all([
        loadProvisionalRecords(memoryDir, now),
        loadRejectedRecords(memoryDir, now),
        loadAntiPatterns(memoryDir, workspaceDir, now),
        loadCodexEscalations(workspaceDir, now),
        buildTrashCandidates(memoryDir, now),
      ]);
    const prunedPaths = await pruneTrashCandidates(workspaceDir, trashCandidates);

    if (
      provisional.length === 0 &&
      rejected.length === 0 &&
      antiPatterns.length === 0 &&
      codexEscalations.length === 0 &&
      trashCandidates.length === 0 &&
      prunedPaths.length === 0
    ) {
      return;
    }

    await Promise.all([
      writeFileWithinRoot({
        rootDir: workspaceDir,
        relativePath: buildMemoryHygieneArtifactRelativePath(weekKey, "memory-hygiene-weekly"),
        data: renderWeeklyReport({
          weekKey,
          rangeLabel,
          sessionKey: displaySessionKey,
          provisional,
          rejected,
          antiPatterns,
          codexEscalations,
          trashCandidates,
          prunedPaths,
        }),
        encoding: "utf-8",
        mkdir: true,
      }),
      writeFileWithinRoot({
        rootDir: workspaceDir,
        relativePath: buildMemoryHygieneArtifactRelativePath(weekKey, "provisional-ledger"),
        data: renderLedger(`Provisional Ledger: ${weekKey}`, provisional),
        encoding: "utf-8",
        mkdir: true,
      }),
      writeFileWithinRoot({
        rootDir: workspaceDir,
        relativePath: buildMemoryHygieneArtifactRelativePath(weekKey, "rejected-ledger"),
        data: renderLedger(`Rejected Ledger: ${weekKey}`, rejected),
        encoding: "utf-8",
        mkdir: true,
      }),
      writeFileWithinRoot({
        rootDir: workspaceDir,
        relativePath: buildMemoryHygieneArtifactRelativePath(weekKey, "anti-patterns"),
        data: renderAntiPatterns(weekKey, antiPatterns),
        encoding: "utf-8",
        mkdir: true,
      }),
      writeFileWithinRoot({
        rootDir: workspaceDir,
        relativePath: buildMemoryHygieneArtifactRelativePath(weekKey, "trash-candidates"),
        data: `${JSON.stringify({ version: 1, weekKey, trashCandidates, prunedPaths }, null, 2)}\n`,
        encoding: "utf-8",
        mkdir: true,
      }),
    ]);

    log.info("Memory hygiene weekly saved", {
      weekKey,
      provisionalCount: provisional.length,
      rejectedCount: rejected.length,
      antiPatternCount: antiPatterns.length,
      codexEscalationCount: codexEscalations.length,
      trashCount: trashCandidates.length,
      prunedCount: prunedPaths.length,
    });
  } catch (err) {
    if (err instanceof Error) {
      log.error("Failed to save memory hygiene weekly", {
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
      });
      return;
    }
    log.error("Failed to save memory hygiene weekly", { error: String(err) });
  }
};

export default saveMemoryHygieneWeekly;
