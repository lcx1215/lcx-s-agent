import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import {
  buildKnowledgeValidationWeeklyArtifactFilename,
  isKnowledgeValidationNoteFilename,
  parseKnowledgeValidationNote,
  renderKnowledgeValidationWeeklyArtifact,
  type ParsedKnowledgeValidationNote,
} from "../lobster-brain-registry.js";
import { countTop, formatIsoWeek, isWithinTrailingUtcDays, writeMemoryNotes } from "../weekly-memory.js";

const log = createSubsystemLogger("hooks/knowledge-validation-weekly");

async function loadValidationNotes(memoryDir: string, now: Date): Promise<ParsedKnowledgeValidationNote[]> {
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    const parsed = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isKnowledgeValidationNoteFilename(entry.name))
        .map(async (entry) => {
          const content = await fs.readFile(path.join(memoryDir, entry.name), "utf-8");
          return parseKnowledgeValidationNote({ filename: entry.name, content });
        }),
    );
    return parsed
      .filter((entry): entry is ParsedKnowledgeValidationNote => Boolean(entry))
      .filter((entry) => isWithinTrailingUtcDays(entry.date, now, 7))
      .toSorted((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function topDomainLines(
  notes: ParsedKnowledgeValidationNote[],
  pick: "strongest" | "weakest",
): string[] {
  const grouped = new Map<string, ParsedKnowledgeValidationNote[]>();
  for (const note of notes) {
    const list = grouped.get(note.domain) ?? [];
    list.push(note);
    grouped.set(note.domain, list);
  }
  const ranked = [...grouped.entries()]
    .map(([domain, domainNotes]) => ({
      domain,
      factual: average(domainNotes.map((note) => note.factualQuality)),
      reasoning: average(domainNotes.map((note) => note.reasoningQuality)),
      count: domainNotes.length,
    }))
    .toSorted((a, b) =>
      pick === "strongest"
        ? b.factual + b.reasoning - (a.factual + a.reasoning) || b.count - a.count
        : a.factual + a.reasoning - (b.factual + b.reasoning) || b.count - a.count,
    )
    .slice(0, 3);
  if (ranked.length === 0) {
    return [`- No ${pick} domain evidence was captured this week.`];
  }
  return ranked.map(
    (entry) =>
      `- ${entry.domain}: factual ${entry.factual.toFixed(1)}/5, reasoning ${entry.reasoning.toFixed(1)}/5 (${entry.count} note${entry.count === 1 ? "" : "s"})`,
  );
}

function hallucinationProneLines(notes: ParsedKnowledgeValidationNote[]): string[] {
  const risky = notes.filter(
    (note) =>
      note.hallucinationRisk === "high" ||
      (note.hallucinationRisk === "medium" && note.confidenceMode === "high_confidence"),
  );
  if (risky.length === 0) {
    return ["- No hallucination-prone domain stood out this week."];
  }
  return countTop(
    risky.map((note) => note.domain),
    5,
  ).map(
    (entry) =>
      `- ${entry.value}: ${entry.count} risky validation note${entry.count === 1 ? "" : "s"}`,
  );
}

function candidateLines(
  notes: ParsedKnowledgeValidationNote[],
  field: "correctionCandidate" | "repairTicketCandidate",
): string[] {
  const candidates = notes
    .map((note) => note[field])
    .filter((value) => value && value.toLowerCase() !== "none");
  if (candidates.length === 0) {
    return [
      `- No ${field === "correctionCandidate" ? "correction" : "repair-ticket"} candidate was captured this week.`,
    ];
  }
  return countTop(candidates, 5).map((entry) => `- ${entry.value} (${entry.count})`);
}

function buildWeeklyValidationArtifact(params: {
  weekKey: string;
  rangeLabel: string;
  sessionKey: string;
  notes: ParsedKnowledgeValidationNote[];
}): string {
  const benchmarkNotes = params.notes.filter((note) => note.validationType === "benchmark");
  const dailyTaskNotes = params.notes.filter((note) => note.validationType === "daily_real_task");
  const benchmarkFamilies = countTop(
    benchmarkNotes.map((note) => note.benchmarkFamily).filter((value) => value !== "none"),
    5,
  );
  const taskFamilies = countTop(
    dailyTaskNotes.map((note) => note.taskFamily).filter((value) => value !== "none"),
    5,
  );
  const capabilityFamilies = countTop(params.notes.map((note) => note.capabilityFamily), 5);
  const nextValidationFocusLines = [
    benchmarkNotes.length === 0
      ? "- Add at least one benchmark-style note next week before claiming domain improvement."
      : "- Keep benchmark validation running so reasoning quality does not outrun factual quality.",
    dailyTaskNotes.length === 0
      ? "- Add at least one daily real-task validation note from actual buy/sell/add/reduce or macro/risk questions."
      : "- Use daily task notes to test whether benchmark gains actually improve real answers.",
  ];

  return renderKnowledgeValidationWeeklyArtifact({
    weekKey: params.weekKey,
    rangeLabel: params.rangeLabel,
    sessionKey: params.sessionKey,
    validationNotes: params.notes.length,
    benchmarkNotes: benchmarkNotes.length,
    dailyRealTaskNotes: dailyTaskNotes.length,
    benchmarkCoverageLines:
      benchmarkFamilies.length > 0
        ? benchmarkFamilies.map(
            (entry) => `- ${entry.value}: ${entry.count} note${entry.count === 1 ? "" : "s"}`,
          )
        : ["- No benchmark-style validation note was captured this week."],
    dailyRealTaskCoverageLines:
      taskFamilies.length > 0
        ? taskFamilies.map(
            (entry) => `- ${entry.value}: ${entry.count} note${entry.count === 1 ? "" : "s"}`,
          )
        : ["- No daily real-task validation note was captured this week."],
    capabilityCoverageLines:
      capabilityFamilies.length > 0
        ? capabilityFamilies.map(
            (entry) => `- ${entry.value}: ${entry.count} note${entry.count === 1 ? "" : "s"}`,
          )
        : ["- No capability-family validation note was captured this week."],
    strongestDomainLines: topDomainLines(params.notes, "strongest"),
    weakestDomainLines: topDomainLines(params.notes, "weakest"),
    hallucinationProneLines: hallucinationProneLines(params.notes),
    correctionCandidateLines: candidateLines(params.notes, "correctionCandidate"),
    repairTicketCandidateLines: candidateLines(params.notes, "repairTicketCandidate"),
    nextValidationFocusLines,
  });
}

const handler: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { memoryDir, displaySessionKey } = await resolveMemorySessionContext({ event });
    const now = new Date(event.timestamp);
    const { weekKey, rangeLabel } = formatIsoWeek(now);
    const notes = await loadValidationNotes(memoryDir, now);
    if (notes.length === 0) {
      return;
    }

    await writeMemoryNotes(memoryDir, [
      {
        filename: buildKnowledgeValidationWeeklyArtifactFilename(weekKey),
        content: buildWeeklyValidationArtifact({
          weekKey,
          rangeLabel,
          sessionKey: displaySessionKey,
          notes,
        }),
      },
    ]);
  } catch (error) {
    log.error("Failed to save knowledge validation weekly report", { error: String(error) });
  }
};

export default handler;
