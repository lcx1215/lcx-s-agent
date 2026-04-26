import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  shouldEscalateOperationalIssueToCodex,
  writeAndMaybeDispatchCodexEscalation,
} from "../../../infra/codex-escalation.js";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { recordOperationalAnomaly } from "../../../infra/operational-anomalies.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import {
  compactText,
  loadSessionTurns,
  resolveMemorySessionContext,
  type SessionTurn,
} from "../artifact-memory.js";
import {
  buildCorrectionNoteFilename,
  buildCorrectionLoopRepairTicketRelativePath,
  isLearningCouncilAdoptionLedgerFilename,
  parseLearningCouncilAdoptionLedger,
  parseCorrectionNoteFilename,
  parseCorrectionNoteArtifact,
  renderLearningCouncilAdoptionLedger,
  renderCorrectionNoteArtifact,
  renderRepairTicketArtifact,
} from "../lobster-brain-registry.js";
import { isCorrectionLoopInput } from "./detection.js";

const log = createSubsystemLogger("hooks/correction-loop");

const REPEATED_ISSUE_PATTERN =
  /(重复|反复|再次|又出现|连续|same issue|again|repeated|recurring|repeat)/i;
const LEADING_REPEAT_NOISE_PATTERN =
  /^(重复出现[,，:：]\s*|反复出现[,，:：]\s*|再次[,，:：]\s*|again[,，:：]\s*|repeatedly[,，:：]\s*)/i;

export type CorrectionIssue = {
  rawText: string;
  normalizedText: string;
  issueKey: string;
  repeated: boolean;
};

type FoundationTemplateArea =
  | "portfolio-sizing-discipline"
  | "risk-transmission"
  | "outcome-review"
  | "behavior-error-correction"
  | "execution-hygiene"
  | "business-quality"
  | "catalyst-map"
  | "general";

function sanitizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeIssueText(value: string): string {
  return sanitizeInline(value.replace(LEADING_REPEAT_NOISE_PATTERN, ""));
}

function inferCorrectionCategory(text: string): string {
  const normalized = text.toLowerCase();
  if (
    normalized.includes("hallucination") ||
    normalized.includes("幻觉") ||
    normalized.includes("编造")
  ) {
    return "hallucination_risk";
  }
  if (
    normalized.includes("role drift") ||
    normalized.includes("角色漂移") ||
    normalized.includes("support bot")
  ) {
    return "role_drift";
  }
  if (
    normalized.includes("provider") ||
    normalized.includes("freshness") ||
    normalized.includes("搜索") ||
    normalized.includes("实时")
  ) {
    return "provider_or_freshness";
  }
  if (
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("保存") ||
    normalized.includes("落盘")
  ) {
    return "write_edit_failure";
  }
  if (normalized.includes("learning") || normalized.includes("学习")) {
    return "learning_quality_drift";
  }
  return "correction_loop_repeat";
}

function inferFoundationTemplateArea(text: string): FoundationTemplateArea {
  const normalized = text.toLowerCase();
  if (
    normalized.includes("仓位") ||
    normalized.includes("加仓") ||
    normalized.includes("减仓") ||
    normalized.includes("重仓") ||
    normalized.includes("position") ||
    normalized.includes("sizing") ||
    normalized.includes("size") ||
    normalized.includes("concentration") ||
    normalized.includes("集中")
  ) {
    return "portfolio-sizing-discipline";
  }
  if (
    normalized.includes("confirmation bias") ||
    normalized.includes("fomo") ||
    normalized.includes("urgency") ||
    normalized.includes("追涨") ||
    normalized.includes("冲动") ||
    normalized.includes("情绪") ||
    normalized.includes("确认偏误") ||
    normalized.includes("叙事上头")
  ) {
    return "behavior-error-correction";
  }
  if (
    normalized.includes("利率") ||
    normalized.includes("美元") ||
    normalized.includes("信用利差") ||
    normalized.includes("波动率") ||
    normalized.includes("vix") ||
    normalized.includes("dollar") ||
    normalized.includes("credit") ||
    normalized.includes("rate") ||
    normalized.includes("cross-asset") ||
    normalized.includes("传导") ||
    normalized.includes("risk appetite")
  ) {
    return "risk-transmission";
  }
  if (
    normalized.includes("护城河") ||
    normalized.includes("定价权") ||
    normalized.includes("资本配置") ||
    normalized.includes("management") ||
    normalized.includes("pricing power") ||
    normalized.includes("capital allocation") ||
    normalized.includes("business quality") ||
    normalized.includes("moat") ||
    normalized.includes("industry structure")
  ) {
    return "business-quality";
  }
  if (
    normalized.includes("catalyst") ||
    normalized.includes("earnings") ||
    normalized.includes("财报日") ||
    normalized.includes("催化") ||
    normalized.includes("事件驱动") ||
    normalized.includes("event-driven") ||
    normalized.includes("review date")
  ) {
    return "catalyst-map";
  }
  if (
    normalized.includes("等待") ||
    normalized.includes("流动性") ||
    normalized.includes("事件风险") ||
    normalized.includes("分批") ||
    normalized.includes("wait") ||
    normalized.includes("liquidity") ||
    normalized.includes("event risk") ||
    normalized.includes("execution") ||
    normalized.includes("timing discipline")
  ) {
    return "execution-hygiene";
  }
  if (
    normalized.includes("复盘") ||
    normalized.includes("recommendation") ||
    normalized.includes("lesson") ||
    normalized.includes("review") ||
    normalized.includes("结果") ||
    normalized.includes("outcome") ||
    normalized.includes("evidence") ||
    normalized.includes("锚点") ||
    normalized.includes("freshness")
  ) {
    return "outcome-review";
  }
  return "general";
}

export function extractLatestCorrectionIssue(turns: SessionTurn[]): CorrectionIssue | null {
  const latestUserCorrection = turns
    .toReversed()
    .find((turn) => turn.role === "user" && isCorrectionLoopInput(turn.text));
  if (!latestUserCorrection) {
    return null;
  }

  const rawText = latestUserCorrection.text.trim();
  const normalizedText = normalizeIssueText(
    rawText.replace(/^(反馈：|复盘：|纠正：)/iu, "").trim(),
  );
  if (!normalizedText) {
    return null;
  }

  const issueKey = crypto
    .createHash("sha256")
    .update(normalizedText.toLowerCase())
    .digest("hex")
    .slice(0, 12);

  return {
    rawText,
    normalizedText,
    issueKey,
    repeated: REPEATED_ISSUE_PATTERN.test(rawText),
  };
}

async function countPriorCorrectionNotes(params: {
  memoryDir: string;
  currentFilename: string;
  issueKey: string;
}): Promise<number> {
  try {
    const files = await fs.readdir(params.memoryDir);
    let count = 0;
    for (const file of files) {
      const parsed = parseCorrectionNoteFilename(file);
      if (file === params.currentFilename || !parsed) {
        continue;
      }
      const content = await fs.readFile(path.join(params.memoryDir, file), "utf-8").catch(() => "");
      if (parseCorrectionNoteArtifact(content)?.issueKey === params.issueKey) {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

function buildCorrectionNote(params: {
  dateStr: string;
  timeStr: string;
  sessionKey: string;
  sessionId?: string;
  issue: CorrectionIssue;
  latestAssistant: string;
  turns: SessionTurn[];
}): string {
  const foundationTemplate = inferFoundationTemplateArea(params.issue.normalizedText);
  return renderCorrectionNoteArtifact({
    dateStr: params.dateStr,
    timeStr: params.timeStr,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId ?? "unknown",
    issueKey: params.issue.issueKey,
    memoryTier: "provisional",
    priorClaimOrBehavior: compactText(
      params.latestAssistant || "No assistant answer captured before correction.",
    ),
    foundationTemplate,
    whatWasWrong: compactText(params.issue.normalizedText),
    evidenceOrUserObservedFailure: `source: operator correction (${compactText(params.issue.rawText)})`,
    replacementRule:
      "Do not silently preserve the old behavior. Treat this correction as the current provisional replacement until fresher evidence upgrades or downgrades it.",
    confidenceDowngrade: "old_rule_confidence: downgraded due to direct operator feedback",
    repeatedIssueSignal: params.issue.repeated ? "yes" : "no",
    sessionTraceLines: params.turns
      .slice(-8)
      .map((turn) => `${turn.role}: ${compactText(turn.text, 160)}`),
  });
}

function buildRepairTicket(params: {
  dateStr: string;
  timeStr: string;
  sessionKey: string;
  sessionId?: string;
  issue: CorrectionIssue;
  occurrences: number;
}): string {
  const category = inferCorrectionCategory(params.issue.normalizedText);
  const foundationTemplate = inferFoundationTemplateArea(params.issue.normalizedText);
  return renderRepairTicketArtifact({
    titleValue: params.issue.issueKey,
    category,
    issueKey: params.issue.issueKey,
    foundationTemplate,
    occurrences: params.occurrences,
    lastSeen: `${params.dateStr} ${params.timeStr} UTC`,
    problem: compactText(params.issue.normalizedText),
    evidenceLines: [`repeated operator correction detected (${params.occurrences} occurrences)`],
    impactLine:
      "user-facing trust or operating reliability is at risk if this issue keeps recurring",
    suggestedScopeLine:
      "smallest-safe-patch only; do not broaden providers, memory architecture, or doctrine without explicit approval",
    extraMetadataLines: [
      `- **Session Key**: ${params.sessionKey}`,
      `- **Session ID**: ${params.sessionId ?? "unknown"}`,
    ],
  });
}

async function markFailedAdoptionLedgerEntries(params: {
  memoryDir: string;
  dateStr: string;
  latestAssistant: string;
}): Promise<void> {
  const normalizedAssistant = sanitizeInline(params.latestAssistant);
  if (!normalizedAssistant) {
    return;
  }
  const files = await fs.readdir(params.memoryDir, { withFileTypes: true }).catch(() => []);
  for (const file of files) {
    if (!file.isFile() || !isLearningCouncilAdoptionLedgerFilename(file.name)) {
      continue;
    }
    const fullPath = path.join(params.memoryDir, file.name);
    const content = await fs.readFile(fullPath, "utf-8").catch(() => "");
    const parsedLedger = parseLearningCouncilAdoptionLedger({
      filename: file.name,
      content,
    });
    if (!parsedLedger || parsedLedger.date !== params.dateStr) {
      continue;
    }
    let changed = false;
    const nextEntries = parsedLedger.entries.map((entry) => {
      if (!entry.reusedLater || entry.downrankedOrFailed) {
        return entry;
      }
      if (sanitizeInline(entry.text) !== normalizedAssistant) {
        return entry;
      }
      changed = true;
      return {
        ...entry,
        downrankedOrFailed: true,
      };
    });
    if (!changed) {
      continue;
    }
    await writeFileWithinRoot({
      rootDir: params.memoryDir,
      relativePath: file.name,
      data: renderLearningCouncilAdoptionLedger({
        stem: parsedLedger.noteSlug,
        generatedAt: parsedLedger.generatedAt,
        status: parsedLedger.status,
        userMessage: parsedLedger.userMessage,
        sourceArtifact: parsedLedger.sourceArtifact,
        entries: nextEntries,
      }),
      encoding: "utf-8",
      mkdir: true,
    });
  }
}

const saveCorrectionLoopArtifacts: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { cfg, workspaceDir, memoryDir, sessionId, sessionFile, displaySessionKey } =
      await resolveMemorySessionContext({ event });
    if (!sessionFile) {
      return;
    }

    const hookConfig = resolveHookConfig(cfg, "correction-loop");
    const messageCount =
      typeof hookConfig?.messages === "number" && hookConfig.messages > 0
        ? hookConfig.messages
        : 18;
    const turns = await loadSessionTurns(sessionFile, messageCount);
    const issue = extractLatestCorrectionIssue(turns);
    if (!issue) {
      return;
    }

    const latestAssistant =
      turns
        .toReversed()
        .find((turn) => turn.role === "assistant")
        ?.text.trim() ?? "";

    const now = new Date(event.timestamp);
    const dateStr = now.toISOString().split("T")[0];
    const timeStr = now.toISOString().split("T")[1].split(".")[0];
    const timeSlug = now.toISOString().split("T")[1].replaceAll(":", "").replace(".", "-");
    const correctionFilename = buildCorrectionNoteFilename({
      dateStr,
      issueKey: issue.issueKey,
      timeSlug,
    });

    await writeFileWithinRoot({
      rootDir: memoryDir,
      relativePath: correctionFilename,
      data: buildCorrectionNote({
        dateStr,
        timeStr,
        sessionKey: event.sessionKey,
        sessionId,
        issue,
        latestAssistant,
        turns,
      }),
      encoding: "utf-8",
      mkdir: true,
    });
    await markFailedAdoptionLedgerEntries({
      memoryDir,
      dateStr,
      latestAssistant,
    });

    const priorCorrectionCount = await countPriorCorrectionNotes({
      memoryDir,
      currentFilename: correctionFilename,
      issueKey: issue.issueKey,
    });
    const totalOccurrences = priorCorrectionCount + 1;

    if (issue.repeated || priorCorrectionCount >= 1) {
      const category = inferCorrectionCategory(issue.normalizedText);
      const foundationTemplate = inferFoundationTemplateArea(issue.normalizedText);
      const repairTicketPath = buildCorrectionLoopRepairTicketRelativePath(issue.issueKey);
      const anomalyResult = await recordOperationalAnomaly({
        workspaceDir,
        category,
        severity: "medium",
        source: "correction-loop",
        problem: issue.normalizedText,
        foundationTemplate,
        evidence: [
          `issue_key=${issue.issueKey}`,
          `session_key=${displaySessionKey}`,
          `occurrences=${totalOccurrences}`,
          "source=operator_correction",
        ],
        impact: "a repeated user-observed failure is degrading trust or operating reliability",
        repairTicketThreshold: Number.MAX_SAFE_INTEGER,
      });
      await writeFileWithinRoot({
        rootDir: workspaceDir,
        relativePath: repairTicketPath,
        data: buildRepairTicket({
          dateStr,
          timeStr,
          sessionKey: displaySessionKey,
          sessionId,
          issue,
          occurrences: totalOccurrences,
        }),
        encoding: "utf-8",
        mkdir: true,
      });
      if (shouldEscalateOperationalIssueToCodex(category)) {
        await writeAndMaybeDispatchCodexEscalation({
          workspaceDir,
          category,
          issueKey: issue.issueKey,
          source: "correction-loop",
          severity: "medium",
          foundationTemplate,
          occurrences: totalOccurrences,
          lastSeen: `${dateStr} ${timeStr} UTC`,
          repairTicketPath,
          anomalyRecordPath: anomalyResult.recordPath,
          problem: compactText(issue.normalizedText),
          evidenceLines: [
            `repeated operator correction detected (${totalOccurrences} occurrences)`,
            `session_key=${displaySessionKey}`,
          ],
          impactLine:
            "user-facing trust or operating reliability is at risk if this issue keeps recurring",
          suggestedScopeLine:
            "smallest-safe-patch only; do not broaden providers, memory architecture, or doctrine without explicit approval",
          generatedAt: now.toISOString(),
        });
      }
      log.info("Correction loop escalated repeated issue into repair ticket", {
        issueKey: issue.issueKey,
        occurrences: totalOccurrences,
      });
      return;
    }

    log.info("Correction note saved", {
      issueKey: issue.issueKey,
      filename: correctionFilename,
    });
  } catch (err) {
    if (err instanceof Error) {
      log.error("Failed to save correction loop artifacts", {
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
      });
      return;
    }
    log.error("Failed to save correction loop artifacts", { error: String(err) });
  }
};

export default saveCorrectionLoopArtifacts;
