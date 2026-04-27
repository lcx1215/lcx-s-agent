import fs from "node:fs";
import path from "node:path";
import { resolveWorkspaceRoot } from "../../agents/workspace-dir.js";
import {
  buildCapabilitySurfaceReport,
  buildLobsterProtocolSurface,
} from "../../commands/capabilities.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  buildWatchtowerArtifactDir,
  parseCurrentResearchLineArtifact,
  parseLobsterWorkfaceArtifact,
  parseWatchtowerAnomalyRecord,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { resolveActiveFallbackState } from "../fallback-state.js";
import { resolveSelectedAndActiveModel } from "../model-runtime.js";
import { buildHelpMessage, formatLobsterProtocolLine } from "../status.js";
import {
  resolveProtocolInfoQuestionKind,
  resolveSpecificCapabilityCheck,
} from "./commands-protocol-families.js";

type ProtocolInfoSessionState = Pick<
  SessionEntry,
  | "modelProvider"
  | "model"
  | "fallbackNoticeSelectedModel"
  | "fallbackNoticeActiveModel"
  | "fallbackNoticeReason"
>;

type LearningEvidence = {
  source: "lobster-workface" | "current-research-line" | "none";
  date?: string;
  retain?: string;
  discard?: string;
  improveLobster?: string;
  replay?: string;
  nextEval?: string;
  summary?: string;
  cueFields?: string[];
};

type LearningTimeboxEvidence = {
  source: "timebox" | "none";
  sessionId?: string;
  status?: "running" | "completed" | "failed" | "interrupted" | "overdue";
  deadlineAt?: string;
  lastHeartbeatAt?: string;
  iterationsCompleted?: number;
  iterationsFailed?: number;
};

type WriteFailureEvidence = {
  source: "anomaly" | "none";
  lastSeenAt?: string;
  sourceSystem?: string;
  problem?: string;
  occurrenceCount?: number;
};

type SearchHealthEvidence = {
  source: "anomaly" | "none";
  lastSeenAt?: string;
  sourceSystem?: string;
  problem?: string;
  occurrenceCount?: number;
};

type LearningWorkflowRiskEvidence = {
  source: "anomaly" | "none";
  lastSeenAt?: string;
  sourceSystem?: string;
  category?: string;
  problem?: string;
  occurrenceCount?: number;
};

function isWriteFailureRelevantToLearningArtifact(params: {
  learning: LearningEvidence;
  writeFailure: WriteFailureEvidence;
}): boolean {
  if (params.writeFailure.source !== "anomaly") {
    return false;
  }
  if (params.learning.source !== "lobster-workface" || !params.learning.date) {
    return true;
  }
  const failureDay = params.writeFailure.lastSeenAt?.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(failureDay ?? "")) {
    return true;
  }
  return failureDay >= params.learning.date;
}

function normalizeLearningTimeboxStatus(state: {
  status?: "running" | "completed" | "failed" | "interrupted";
  deadlineAt?: string;
}): "running" | "completed" | "failed" | "interrupted" | "overdue" {
  if (state.status === "running" && state.deadlineAt) {
    const deadlineMs = new Date(state.deadlineAt).getTime();
    if (Number.isFinite(deadlineMs) && deadlineMs <= Date.now()) {
      return "overdue";
    }
  }
  return state.status ?? "running";
}

function classifyErrorType(learning: LearningEvidence): {
  label: string;
  evidence: string | null;
} {
  const text = [learning.discard, learning.improveLobster, learning.replay, learning.summary]
    .filter(Boolean)
    .join(" | ")
    .toLowerCase();
  if (
    text.includes("precision") ||
    text.includes("overclaim") ||
    text.includes("过度承诺") ||
    text.includes("capability") ||
    text.includes("provider marketing")
  ) {
    return {
      label: "overclaiming_or_false_precision",
      evidence: learning.discard ?? learning.improveLobster ?? null,
    };
  }
  if (
    text.includes("evidence") ||
    text.includes("falsify") ||
    text.includes("proof") ||
    text.includes("没证据")
  ) {
    return {
      label: "weak_evidence_or_no_falsification",
      evidence: learning.replay ?? learning.discard ?? null,
    };
  }
  if (
    text.includes("lane") ||
    text.includes("scope") ||
    text.includes("routing") ||
    text.includes("session")
  ) {
    return {
      label: "routing_or_scope_drift",
      evidence: learning.improveLobster ?? learning.discard ?? null,
    };
  }
  return {
    label: "uncategorized_but_recorded",
    evidence: learning.discard ?? learning.improveLobster ?? learning.summary ?? null,
  };
}

function readLatestWorkfaceLearningEvidence(cfg?: OpenClawConfig): LearningEvidence {
  const workspaceDir = resolveWorkspaceRoot(cfg?.agents?.defaults?.workspace);
  const memoryDir = path.join(workspaceDir, "memory");
  try {
    const latest = fs
      .readdirSync(memoryDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}-lobster-workface\.md$/u.test(name))
      .toSorted((a, b) => b.localeCompare(a))[0];
    if (latest) {
      const content = fs.readFileSync(path.join(memoryDir, latest), "utf-8");
      const parsed = parseLobsterWorkfaceArtifact(content);
      if (parsed) {
        const cueFields = [
          parsed.learningKeep ? "retain" : undefined,
          parsed.learningDiscard ? "discard" : undefined,
          parsed.learningReplay ? "replay" : undefined,
          parsed.learningNextEval ? "next eval" : undefined,
        ].filter((field): field is string => Boolean(field));
        return {
          source: "lobster-workface",
          date: parsed.dateKey,
          retain: parsed.learningKeep || undefined,
          discard: parsed.learningDiscard || undefined,
          improveLobster: parsed.learningImproveLobster || undefined,
          replay: parsed.learningReplay || undefined,
          nextEval: parsed.learningNextEval || undefined,
          cueFields,
        };
      }
    }
  } catch {}

  try {
    const content = fs.readFileSync(path.join(memoryDir, "current-research-line.md"), "utf-8");
    const parsed = parseCurrentResearchLineArtifact(content);
    if (parsed) {
      return {
        source: "current-research-line",
        summary: parsed.currentSessionSummary || parsed.currentFocus,
      };
    }
  } catch {}

  return { source: "none" };
}

function buildCarryoverCueStatusLine(learning: LearningEvidence): string | undefined {
  if (learning.source !== "lobster-workface") {
    return undefined;
  }
  const cueFields = learning.cueFields ?? [];
  if (cueFields.length === 4) {
    return `Carryover cue: complete (${cueFields.join(" / ")}).`;
  }
  if (cueFields.length > 0) {
    return `Carryover cue: partial (${cueFields.join(" / ")}). Do not treat this as full internalization proof yet.`;
  }
  return "Carryover cue: not yet recorded. Do not treat this as durable internalization proof yet.";
}

function readLatestLearningTimeboxEvidence(cfg?: OpenClawConfig): LearningTimeboxEvidence {
  const workspaceDir = resolveWorkspaceRoot(cfg?.agents?.defaults?.workspace);
  const timeboxDir = path.join(workspaceDir, "memory", "feishu-learning-timeboxes");
  try {
    const latest = fs
      .readdirSync(timeboxDir)
      .filter((name) => name.endsWith(".json") && !name.endsWith(".receipts.jsonl"))
      .map((name) => {
        const state = JSON.parse(fs.readFileSync(path.join(timeboxDir, name), "utf-8")) as {
          sessionId?: string;
          status?: "running" | "completed" | "failed" | "interrupted";
          startedAt?: string;
          deadlineAt?: string;
          lastHeartbeatAt?: string;
          iterationsCompleted?: number;
          iterationsFailed?: number;
        };
        return {
          sessionId: state.sessionId ?? name.replace(/\.json$/u, ""),
          startedAt: state.startedAt ?? "",
          status: normalizeLearningTimeboxStatus(state),
          deadlineAt: state.deadlineAt,
          lastHeartbeatAt: state.lastHeartbeatAt,
          iterationsCompleted: state.iterationsCompleted ?? 0,
          iterationsFailed: state.iterationsFailed ?? 0,
        };
      })
      .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (latest?.sessionId) {
      return {
        source: "timebox",
        sessionId: latest.sessionId,
        status: latest.status,
        deadlineAt: latest.deadlineAt,
        lastHeartbeatAt: latest.lastHeartbeatAt,
        iterationsCompleted: latest.iterationsCompleted,
        iterationsFailed: latest.iterationsFailed,
      };
    }
  } catch {}
  return { source: "none" };
}

function readLatestWriteFailureEvidence(cfg?: OpenClawConfig): WriteFailureEvidence {
  const workspaceDir = resolveWorkspaceRoot(cfg?.agents?.defaults?.workspace);
  const anomaliesDir = path.join(workspaceDir, buildWatchtowerArtifactDir("anomalies"));
  try {
    const latest = fs
      .readdirSync(anomaliesDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const parsed = parseWatchtowerAnomalyRecord(
          fs.readFileSync(path.join(anomaliesDir, name), "utf-8"),
        );
        return parsed;
      })
      .filter(
        (entry): entry is NonNullable<typeof entry> =>
          Boolean(entry) &&
          entry.category === "write_edit_failure" &&
          (entry.source === "feishu.surface_memory" ||
            entry.source === "feishu.work_receipts" ||
            entry.source.startsWith("feishu.")),
      )
      .toSorted((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
    if (latest) {
      return {
        source: "anomaly",
        lastSeenAt: latest.lastSeenAt,
        sourceSystem: latest.source,
        problem: latest.problem,
        occurrenceCount: latest.occurrenceCount,
      };
    }
  } catch {}
  return { source: "none" };
}

function readLatestSearchHealthEvidence(cfg?: OpenClawConfig): SearchHealthEvidence {
  const workspaceDir = resolveWorkspaceRoot(cfg?.agents?.defaults?.workspace);
  const anomaliesDir = path.join(workspaceDir, buildWatchtowerArtifactDir("anomalies"));
  try {
    const latest = fs
      .readdirSync(anomaliesDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const parsed = parseWatchtowerAnomalyRecord(
          fs.readFileSync(path.join(anomaliesDir, name), "utf-8"),
        );
        return parsed;
      })
      .filter(
        (entry): entry is NonNullable<typeof entry> =>
          Boolean(entry) &&
          entry.category === "provider_degradation" &&
          (entry.source.startsWith("feishu.") || entry.source.startsWith("provider.")),
      )
      .toSorted((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
    if (latest) {
      return {
        source: "anomaly",
        lastSeenAt: latest.lastSeenAt,
        sourceSystem: latest.source,
        problem: latest.problem,
        occurrenceCount: latest.occurrenceCount,
      };
    }
  } catch {}
  return { source: "none" };
}

function readLatestLearningWorkflowRiskEvidence(
  cfg?: OpenClawConfig,
): LearningWorkflowRiskEvidence {
  const workspaceDir = resolveWorkspaceRoot(cfg?.agents?.defaults?.workspace);
  const anomaliesDir = path.join(workspaceDir, buildWatchtowerArtifactDir("anomalies"));
  try {
    const latest = fs
      .readdirSync(anomaliesDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const parsed = parseWatchtowerAnomalyRecord(
          fs.readFileSync(path.join(anomaliesDir, name), "utf-8"),
        );
        return parsed;
      })
      .filter(
        (entry): entry is NonNullable<typeof entry> =>
          Boolean(entry) &&
          entry.source === "feishu.learning_command" &&
          (entry.category === "write_edit_failure" ||
            entry.category === "learning_quality_drift" ||
            entry.category === "provider_degradation"),
      )
      .toSorted((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
    if (latest) {
      return {
        source: "anomaly",
        lastSeenAt: latest.lastSeenAt,
        sourceSystem: latest.source,
        category: latest.category,
        problem: latest.problem,
        occurrenceCount: latest.occurrenceCount,
      };
    }
  } catch {}
  return { source: "none" };
}

export function buildProtocolInfoReply(params: {
  text: string;
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  sessionEntry?: ProtocolInfoSessionState;
  feishuReplyFlowEvidence?: string;
}) {
  const kind = resolveProtocolInfoQuestionKind(params.text);
  if (!kind) {
    return null;
  }
  const protocol = buildLobsterProtocolSurface(params.cfg ?? {});
  const capabilityReport = buildCapabilitySurfaceReport(params.cfg ?? {});
  const lobsterLine = formatLobsterProtocolLine(params.cfg);
  const selectedProvider = params.provider?.trim();
  const selectedModel = params.model?.trim();
  const modelRefs =
    selectedProvider && selectedModel
      ? resolveSelectedAndActiveModel({
          selectedProvider,
          selectedModel,
          sessionEntry: params.sessionEntry,
        })
      : null;
  const fallbackState = modelRefs
    ? resolveActiveFallbackState({
        selectedModelRef: modelRefs.selected.label,
        activeModelRef: modelRefs.active.label,
        state: params.sessionEntry,
      })
    : null;
  const missingAnchors = protocol.protectedAnchors
    .filter((anchor) => !anchor.present)
    .map((anchor) => anchor.path);

  if (kind === "help") {
    return { text: buildHelpMessage(params.cfg) };
  }
  if (kind === "snapshot") {
    const selectedCapabilityModel = modelRefs
      ? capabilityReport.models.find(
          (entry) =>
            entry.provider === modelRefs.selected.provider &&
            entry.model === modelRefs.selected.model,
        )
      : null;
    const activeCapabilityModel = modelRefs
      ? capabilityReport.models.find(
          (entry) =>
            entry.provider === modelRefs.active.provider && entry.model === modelRefs.active.model,
        )
      : null;
    const providerToolState = activeCapabilityModel?.toolsConnected.length
      ? `connected (${activeCapabilityModel.toolsConnected.join(", ")})`
      : "not connected";
    return {
      text: [
        "📍 Operator snapshot",
        `Mode: ${protocol.defaultMode} · ${protocol.executionSubstrate.kind}`,
        `Model: ${modelRefs ? modelRefs.active.label : (protocol.executionSubstrate.defaultModel ?? "unknown")}`,
        modelRefs?.activeDiffers
          ? `Selected: ${modelRefs.selected.label}`
          : "Selected: same as active",
        `Capability mode: ${selectedCapabilityModel?.mode ?? activeCapabilityModel?.mode ?? "unknown"}`,
        `Provider tools: ${providerToolState}`,
        fallbackState?.active
          ? `Fallback: ${fallbackState.reason?.trim() || "active model differs"}`
          : "Fallback: none",
        missingAnchors.length > 0
          ? `Missing anchors: ${missingAnchors.join(", ")}`
          : "Missing anchors: none",
        lobsterLine,
        "Use /status for the full runtime snapshot.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (kind === "status_readback") {
    const learning = readLatestWorkfaceLearningEvidence(params.cfg);
    const timebox = readLatestLearningTimeboxEvidence(params.cfg);
    const writeFailure = readLatestWriteFailureEvidence(params.cfg);
    const workflowRisk = readLatestLearningWorkflowRiskEvidence(params.cfg);
    const lines = [
      "🧭 Status readback",
      "Classification: this is a status-readback request, not a request for optimistic progress prose.",
      "Evidence order: repo state -> scoped diff or commit receipt -> targeted test or lint receipt -> migration/build/restart receipt -> live probe receipt -> visible Lark/Feishu reply-flow evidence.",
      "Dev-fixed: only supported by current local implementation plus scoped verification receipts.",
      "Live-fixed: unproven unless migration, build, restart, live probe, and visible Lark/Feishu reply evidence are all present.",
    ];
    if (learning.source === "lobster-workface") {
      lines.push(`Latest durable learning artifact: present (${learning.date ?? "unknown date"})`);
      lines.push(buildCarryoverCueStatusLine(learning) ?? "Carryover cue: unavailable");
    } else if (learning.source === "current-research-line") {
      lines.push("Latest durable learning artifact: current-research-line only");
      if (learning.summary) {
        lines.push(`Current carried summary: ${learning.summary}`);
      }
    } else {
      lines.push("Latest durable learning artifact: none recent");
    }
    if (timebox.source === "timebox") {
      lines.push(
        `Latest learning session receipt: ${timebox.status ?? "unknown"}${timebox.sessionId ? ` (${timebox.sessionId})` : ""}`,
      );
    } else {
      lines.push("Latest learning session receipt: none found");
    }
    if (writeFailure.source === "anomaly") {
      lines.push(
        `Latest write anomaly: ${writeFailure.sourceSystem ?? "feishu"}${writeFailure.lastSeenAt ? ` @ ${writeFailure.lastSeenAt}` : ""}`,
      );
      if (writeFailure.problem) {
        lines.push(`Write anomaly problem: ${writeFailure.problem}`);
      }
    } else {
      lines.push("Latest write anomaly: none found");
    }
    if (workflowRisk.source === "anomaly") {
      lines.push(
        `Latest workflow risk: ${workflowRisk.sourceSystem ?? "feishu"}${workflowRisk.lastSeenAt ? ` @ ${workflowRisk.lastSeenAt}` : ""}`,
      );
      if (workflowRisk.problem) {
        lines.push(`Workflow risk problem: ${workflowRisk.problem}`);
      }
    }
    if (params.feishuReplyFlowEvidence?.trim()) {
      lines.push("Visible Lark/Feishu reply-flow evidence: present");
      lines.push(params.feishuReplyFlowEvidence.trim());
    } else {
      lines.push("Visible Lark/Feishu reply-flow evidence: missing from this status reply.");
    }
    lines.push(
      "Next check: name the first missing evidence layer instead of collapsing dev-fixed, live-fixed, started, running, completed, blocked, and unproven into one success label.",
    );
    lines.push(lobsterLine);
    return { text: lines.filter(Boolean).join("\n") };
  }
  if (kind === "lobster") {
    const pluginState = protocol.lobsterWorkflowRuntime.enabledByPolicy ? "on" : "optional";
    return {
      text: [
        "🦞 Lobster",
        `Plugin: ${pluginState}`,
        lobsterLine,
        "Use /context detail for the full protocol block.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (kind === "search_health") {
    const activeCapabilityModel = modelRefs
      ? capabilityReport.models.find(
          (entry) =>
            entry.provider === modelRefs.active.provider && entry.model === modelRefs.active.model,
        )
      : null;
    const searchHealth = readLatestSearchHealthEvidence(params.cfg);
    const providerWebSearch = capabilityReport.providerCapabilities.find(
      (entry) => entry.provider === modelRefs?.active.provider && entry.capability === "web-search",
    );
    const providerOpenAIWebSearch = capabilityReport.providerCapabilities.find(
      (entry) => entry.provider === modelRefs?.active.provider && entry.capability === "web_search",
    );
    const openclawWebSearch = capabilityReport.openclawCapabilities.find(
      (entry) => entry.tool === "web_search",
    );
    const providerSearchState =
      providerWebSearch?.states.includes("connected") ||
      providerOpenAIWebSearch?.states.includes("connected")
        ? "connected"
        : providerWebSearch || providerOpenAIWebSearch
          ? "not connected"
          : "unknown for the active provider";
    return {
      text: [
        "🔎 Search and provider health",
        `Active model: ${modelRefs ? modelRefs.active.label : (protocol.executionSubstrate.defaultModel ?? "unknown")}`,
        `Provider-native search: ${providerSearchState}`,
        `OpenClaw web_search: ${openclawWebSearch?.states.includes("connected") ? "connected" : "not connected"}`,
        `Capability mode: ${activeCapabilityModel?.mode ?? "unknown"}`,
        searchHealth.source === "anomaly"
          ? `Recent degradation record: ${searchHealth.sourceSystem ?? "provider"}${searchHealth.lastSeenAt ? ` @ ${searchHealth.lastSeenAt}` : ""}`
          : "Recent degradation record: none found",
        searchHealth.source === "anomaly" && searchHealth.problem
          ? `Recent degradation problem: ${searchHealth.problem}`
          : undefined,
        "Current truth here is runtime/config surface only, not a fresh live probe.",
        "This distinguishes current configured/connected state from stale past failures.",
        lobsterLine,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (kind === "model") {
    return {
      text: [
        "🧠 Default model",
        protocol.executionSubstrate.defaultModel ?? "unknown",
        lobsterLine,
        "Use /status for the full runtime snapshot.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (kind === "learning") {
    const learning = readLatestWorkfaceLearningEvidence(params.cfg);
    if (learning.source === "lobster-workface") {
      return {
        text: [
          "📚 Learning status",
          `Evidence: lobster-workface${learning.date ? ` ${learning.date}` : ""}`,
          buildCarryoverCueStatusLine(learning),
          learning.retain ? `Retained: ${learning.retain}` : undefined,
          learning.discard ? `Discarded: ${learning.discard}` : undefined,
          learning.replay ? `Replay: ${learning.replay}` : undefined,
          learning.nextEval ? `Next eval: ${learning.nextEval}` : undefined,
          learning.cueFields?.length === 4
            ? "This is the latest explicit learning evidence, not a self-claim."
            : "This is a bounded learning receipt, but not yet full proof of complete internalization.",
          lobsterLine,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    if (learning.source === "current-research-line") {
      return {
        text: [
          "📚 Learning status",
          "Evidence: current-research-line only",
          learning.summary ? `Current carried summary: ${learning.summary}` : undefined,
          "I cannot prove a fresh durable lesson was learned today without a newer learning artifact.",
          lobsterLine,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    return {
      text: [
        "📚 Learning status",
        "Evidence: none recent",
        "I cannot honestly claim that today's learning was internalized because no current learning artifact was found.",
        lobsterLine,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (kind === "learning_receipt") {
    const learning = readLatestWorkfaceLearningEvidence(params.cfg);
    const timebox = readLatestLearningTimeboxEvidence(params.cfg);
    const workflowRisk = readLatestLearningWorkflowRiskEvidence(params.cfg);
    const lines = ["🧾 Learning task receipt"];
    if (timebox.source === "timebox") {
      lines.push(`Latest session receipt: ${timebox.sessionId}`);
      lines.push(`Workflow status: ${timebox.status}`);
      lines.push(
        `Progress: completed ${timebox.iterationsCompleted ?? 0} · failed ${timebox.iterationsFailed ?? 0}`,
      );
      lines.push(
        timebox.status === "running"
          ? `Execution receipt: active session${timebox.deadlineAt ? ` until ${timebox.deadlineAt}` : ""}`
          : `Execution receipt: latest session is ${timebox.status}`,
      );
      if (timebox.lastHeartbeatAt) {
        lines.push(`Last heartbeat: ${timebox.lastHeartbeatAt}`);
      }
    } else {
      lines.push("Latest session receipt: none found");
      lines.push("Execution receipt: no current learning-session receipt was found");
    }
    if (workflowRisk.source === "anomaly") {
      lines.push(
        `Recent workflow risk: ${workflowRisk.category ?? "unknown"}${workflowRisk.lastSeenAt ? ` @ ${workflowRisk.lastSeenAt}` : ""}`,
      );
      if (workflowRisk.problem) {
        lines.push(`Recent workflow problem: ${workflowRisk.problem}`);
      }
    } else {
      lines.push("Recent workflow risk: none found");
    }

    if (learning.source === "lobster-workface") {
      lines.push(`Durable artifact: lobster-workface${learning.date ? ` ${learning.date}` : ""}`);
      lines.push(buildCarryoverCueStatusLine(learning) ?? "Carryover cue: unavailable");
      lines.push(
        learning.cueFields?.length === 4
          ? `Internalization evidence: full carryover cue recorded${learning.retain ? ` (${learning.retain})` : ""}`
          : learning.cueFields?.length
            ? `Internalization evidence: durable workface exists, but the carryover cue is still partial${learning.retain ? ` (${learning.retain})` : ""}`
            : "Internalization evidence: durable workface exists, but no carryover cue is recorded yet",
      );
      if (learning.replay || learning.nextEval) {
        lines.push(
          `Behavior change evidence: ${[learning.replay, learning.nextEval]
            .filter(Boolean)
            .join(" · ")}`,
        );
      } else {
        lines.push("Behavior change evidence: no replay or next-eval cue is recorded yet");
      }
      lines.push(
        timebox.source === "timebox"
          ? learning.cueFields?.length === 4
            ? "Execution vs explanation: I can prove both a workflow receipt and a durable learning artifact."
            : "Execution vs explanation: I can prove a workflow receipt and a durable artifact, but not yet a fully mature carryover cue."
          : learning.cueFields?.length === 4
            ? "Execution vs explanation: I can prove a durable learning artifact, but not a currently running learning session."
            : "Execution vs explanation: I can prove a durable artifact exists, but not yet a fully mature carryover cue or a currently running learning session.",
      );
    } else if (learning.source === "current-research-line") {
      lines.push("Durable artifact: current-research-line only");
      if (learning.summary) {
        lines.push(`Carried summary: ${learning.summary}`);
      }
      lines.push(
        "Internalization evidence: only carried summary, not a fresh durable learning artifact",
      );
      lines.push(
        timebox.source === "timebox"
          ? "Execution vs explanation: I can prove a learning-session receipt exists, but I cannot yet prove durable internalization beyond summary carryover."
          : "Execution vs explanation: I cannot prove this progressed beyond explanation because only summary carryover is present.",
      );
    } else {
      lines.push("Durable artifact: none recent");
      lines.push("Internalization evidence: none recent");
      lines.push(
        timebox.source === "timebox"
          ? "Execution vs explanation: I can prove a learning-session receipt exists, but I cannot yet prove a durable lesson was written down."
          : "Execution vs explanation: I cannot honestly prove this progressed beyond explanation because no current receipt or durable learning artifact was found.",
      );
    }
    lines.push("This answer is bounded to recorded receipts and durable artifacts, not guesswork.");
    lines.push(lobsterLine);
    return { text: lines.filter(Boolean).join("\n") };
  }
  if (kind === "learning_application") {
    const learning = readLatestWorkfaceLearningEvidence(params.cfg);
    if (learning.source === "lobster-workface") {
      return {
        text: [
          "🧪 Learning and application",
          "Acquisition: I can review new papers, extract bounded useful claims, and compare them against current doctrine and existing anchors.",
          "Internalization: I only count it as learned when the result is recorded as a reusable lesson, replay cue, or next-eval item.",
          "Finance pipeline gate: for finance-learning runs, the stricter visible gate is learningInternalizationStatus=application_ready.",
          "Application: I should apply it through explicit summaries, correction notes, and later decisions, not by claiming instant permanent mastery.",
          buildCarryoverCueStatusLine(learning),
          learning.retain ? `Latest retained lesson: ${learning.retain}` : undefined,
          learning.replay ? `Replay trigger: ${learning.replay}` : undefined,
          learning.nextEval ? `Next eval: ${learning.nextEval}` : undefined,
          learning.cueFields?.length === 4
            ? undefined
            : "This is not yet full proof of complete internalization; the latest carryover cue is still incomplete.",
          "If you give a real paper-reading task, that should go to the main agent path, not this info surface.",
          lobsterLine,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    if (learning.source === "current-research-line") {
      return {
        text: [
          "🧪 Learning and application",
          "Acquisition: I can review new papers, extract bounded useful claims, and compare them against current doctrine and existing anchors.",
          "Internalization: I only count it as learned when the result is recorded as a reusable lesson, replay cue, or next-eval item.",
          "Finance pipeline gate: for finance-learning runs, the stricter visible gate is learningInternalizationStatus=application_ready.",
          "Application: I should apply it through explicit summaries, correction notes, and later decisions, not by claiming instant permanent mastery.",
          learning.summary ? `Current carried summary: ${learning.summary}` : undefined,
          "I cannot prove a fresh paper insight was learned and applied without a newer learning artifact.",
          lobsterLine,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    return {
      text: [
        "🧪 Learning and application",
        "Acquisition: I can review new papers, extract bounded useful claims, and compare them against current doctrine and existing anchors.",
        "Internalization: I only count it as learned when the result is recorded as a reusable lesson, replay cue, or next-eval item.",
        "Finance pipeline gate: for finance-learning runs, the stricter visible gate is learningInternalizationStatus=application_ready.",
        "Application: I should apply it through explicit summaries, correction notes, and later decisions, not by claiming instant permanent mastery.",
        "I cannot honestly claim a fresh paper insight was learned and applied because no current learning artifact was found.",
        lobsterLine,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (kind === "promise_risk") {
    const learning = readLatestWorkfaceLearningEvidence(params.cfg);
    const timebox = readLatestLearningTimeboxEvidence(params.cfg);
    const workflowRisk = readLatestLearningWorkflowRiskEvidence(params.cfg);
    const lines = ["⚠️ Promise and execution risk"];
    if (timebox.source === "timebox") {
      lines.push(`Latest workflow receipt: ${timebox.sessionId} (${timebox.status})`);
      lines.push(
        timebox.status === "running"
          ? "Persistent background learning claim: supported by a live session receipt."
          : "Persistent background learning claim: only supported as a past session receipt, not as an active running claim.",
      );
    } else {
      lines.push("Latest workflow receipt: none found");
      lines.push(
        "Persistent background learning claim: not supported. Without a session receipt, this must be treated as at most a single audited pass or an unproven claim.",
      );
    }
    if (workflowRisk.source === "anomaly") {
      lines.push(
        `Recent workflow risk: ${workflowRisk.category ?? "unknown"}${workflowRisk.lastSeenAt ? ` @ ${workflowRisk.lastSeenAt}` : ""}`,
      );
      if (workflowRisk.problem) {
        lines.push(`Recent workflow problem: ${workflowRisk.problem}`);
      }
    } else {
      lines.push("Recent workflow risk: none found");
    }
    if (learning.source === "lobster-workface") {
      lines.push(`Durable artifact: lobster-workface${learning.date ? ` ${learning.date}` : ""}`);
      lines.push(buildCarryoverCueStatusLine(learning) ?? "Carryover cue: unavailable");
    } else if (learning.source === "current-research-line") {
      lines.push("Durable artifact: current-research-line only");
    } else {
      lines.push("Durable artifact: none recent");
    }
    lines.push(
      timebox.source === "timebox"
        ? "Overclaim check: describe the workflow according to the receipt status only; do not upgrade it to more than the recorded session proves."
        : "Overclaim check: if this was described as a started or still-running background workflow, that would be overclaiming.",
    );
    lines.push(
      "This answer is about execution honesty: started, running, downgraded, or unproven are different states and should not be blended.",
    );
    lines.push(lobsterLine);
    return { text: lines.filter(Boolean).join("\n") };
  }
  if (kind === "persistence_state") {
    const learning = readLatestWorkfaceLearningEvidence(params.cfg);
    const writeFailure = readLatestWriteFailureEvidence(params.cfg);
    const writeFailureRelevant = isWriteFailureRelevantToLearningArtifact({
      learning,
      writeFailure,
    });
    const lines = ["💾 Persistence state"];
    if (learning.source === "lobster-workface") {
      lines.push(`Durable artifact: lobster-workface${learning.date ? ` ${learning.date}` : ""}`);
      lines.push(buildCarryoverCueStatusLine(learning) ?? "Carryover cue: unavailable");
      if (writeFailureRelevant) {
        lines.push(
          `Latest explicit write failure: ${writeFailure.sourceSystem ?? "feishu"}${writeFailure.lastSeenAt ? ` @ ${writeFailure.lastSeenAt}` : ""}`,
        );
        if (writeFailure.problem) {
          lines.push(`Failure problem: ${writeFailure.problem}`);
        }
      }
      lines.push(
        writeFailureRelevant
          ? "Long-term storage claim: mixed. A durable artifact exists, but a recent explicit write failure means the latest write outcome must not be treated as fully clean."
          : learning.cueFields?.length === 4
            ? "Long-term storage claim: supported for the recorded learning artifact."
            : "Long-term storage claim: only partially supported; the artifact exists, but the carryover cue is incomplete.",
      );
    } else if (learning.source === "current-research-line") {
      lines.push("Durable artifact: current-research-line only");
      if (learning.summary) {
        lines.push(`Carried summary: ${learning.summary}`);
      }
      if (writeFailure.source === "anomaly") {
        lines.push(
          `Latest explicit write failure: ${writeFailure.sourceSystem ?? "feishu"}${writeFailure.lastSeenAt ? ` @ ${writeFailure.lastSeenAt}` : ""}`,
        );
      }
      lines.push(
        "Long-term storage claim: not yet supported for a fresh learning artifact. This currently looks like session-level understanding or top-line carryover, not a full durable learning write.",
      );
    } else {
      lines.push("Durable artifact: none recent");
      if (writeFailure.source === "anomaly") {
        lines.push(
          `Latest explicit write failure: ${writeFailure.sourceSystem ?? "feishu"}${writeFailure.lastSeenAt ? ` @ ${writeFailure.lastSeenAt}` : ""}`,
        );
      }
      lines.push(
        "Long-term storage claim: not supported. If this was described as already written into long-term memory, that would be inaccurate.",
      );
    }
    lines.push(
      "This answer distinguishes current-session understanding from durable storage; they are not the same state.",
    );
    lines.push(lobsterLine);
    return { text: lines.filter(Boolean).join("\n") };
  }
  if (kind === "write_outcome") {
    const learning = readLatestWorkfaceLearningEvidence(params.cfg);
    const timebox = readLatestLearningTimeboxEvidence(params.cfg);
    const writeFailure = readLatestWriteFailureEvidence(params.cfg);
    const writeFailureRelevant = isWriteFailureRelevantToLearningArtifact({
      learning,
      writeFailure,
    });
    const lines = ["🧱 Write outcome"];
    if (learning.source === "lobster-workface") {
      lines.push(`Durable write: present (${learning.date ?? "unknown date"})`);
      lines.push(buildCarryoverCueStatusLine(learning) ?? "Carryover cue: unavailable");
      lines.push("Current-session understanding: yes");
      if (writeFailureRelevant) {
        lines.push(
          `Latest explicit write failure: ${writeFailure.sourceSystem ?? "feishu"}${writeFailure.lastSeenAt ? ` @ ${writeFailure.lastSeenAt}` : ""}`,
        );
        if (writeFailure.problem) {
          lines.push(`Failure problem: ${writeFailure.problem}`);
        }
      }
      lines.push(
        writeFailureRelevant
          ? "Outcome: durable artifact evidence exists, but a recent explicit write failure is also recorded. Treat the write lane as mixed until a fresh clean artifact lands after the failure."
          : "Outcome: durable artifact write succeeded for the recorded learning result.",
      );
    } else if (learning.source === "current-research-line") {
      lines.push("Durable write: no fresh learning artifact");
      lines.push("Current-session understanding: yes");
      if (writeFailure.source === "anomaly") {
        lines.push(
          `Latest explicit write failure: ${writeFailure.sourceSystem ?? "feishu"}${writeFailure.lastSeenAt ? ` @ ${writeFailure.lastSeenAt}` : ""}`,
        );
        if (writeFailure.problem) {
          lines.push(`Failure problem: ${writeFailure.problem}`);
        }
      }
      lines.push(
        "Outcome: the system appears to understand the result in the current session or top-line carryover, but a fresh durable learning write is not proven yet.",
      );
    } else {
      lines.push(
        writeFailure.source === "anomaly"
          ? "Durable write: explicit failure recorded"
          : "Durable write: none recent",
      );
      lines.push(
        timebox.source === "timebox"
          ? "Current-session understanding: maybe, because a workflow receipt exists, but no durable artifact was found."
          : "Current-session understanding: unproven",
      );
      if (writeFailure.source === "anomaly") {
        lines.push(
          `Latest explicit write failure: ${writeFailure.sourceSystem ?? "feishu"}${writeFailure.lastSeenAt ? ` @ ${writeFailure.lastSeenAt}` : ""}`,
        );
        if (writeFailure.problem) {
          lines.push(`Failure problem: ${writeFailure.problem}`);
        }
      }
      lines.push(
        writeFailure.source === "anomaly"
          ? "Outcome: a durable write failure was explicitly recorded. At best the result is session-local or pending until a fresh artifact lands."
          : "Outcome: if this was described as already written durably, that would be inaccurate. At best it is session-local or pending.",
      );
    }
    lines.push(
      "This answer separates write success from current-session understanding; they are related but not identical.",
    );
    lines.push(lobsterLine);
    return { text: lines.filter(Boolean).join("\n") };
  }
  if (kind === "improvement") {
    const learning = readLatestWorkfaceLearningEvidence(params.cfg);
    if (learning.source === "lobster-workface") {
      return {
        text: [
          "🪞 Improvement loop",
          "Training: no model-weight distillation is claimed here.",
          "Method: explicit correction notes, replay cues, next-eval checks, and protected summaries.",
          learning.discard ? `Latest wrong pattern: ${learning.discard}` : undefined,
          learning.improveLobster ? `Improve target: ${learning.improveLobster}` : undefined,
          learning.replay ? `Replay trigger: ${learning.replay}` : undefined,
          learning.nextEval ? `Next eval: ${learning.nextEval}` : undefined,
          "This answer is based on recorded learning evidence, not a self-congratulatory claim.",
          lobsterLine,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    if (learning.source === "current-research-line") {
      return {
        text: [
          "🪞 Improvement loop",
          "Training: no model-weight distillation is claimed here.",
          "Method: explicit correction notes, replay cues, next-eval checks, and protected summaries.",
          learning.summary ? `Current carried summary: ${learning.summary}` : undefined,
          "I cannot prove a fresh conversation mistake was internalized without a newer correction or learning artifact.",
          lobsterLine,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    return {
      text: [
        "🪞 Improvement loop",
        "Training: no model-weight distillation is claimed here.",
        "Method: explicit correction notes, replay cues, next-eval checks, and protected summaries.",
        "I cannot honestly claim that a recent bad answer was learned from because no current correction artifact was found.",
        lobsterLine,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (kind === "error_type") {
    const learning = readLatestWorkfaceLearningEvidence(params.cfg);
    if (learning.source === "lobster-workface") {
      const classification = classifyErrorType(learning);
      return {
        text: [
          "🧯 Error type",
          `Class: ${classification.label}`,
          classification.evidence ? `Evidence: ${classification.evidence}` : undefined,
          learning.replay ? `Replay trigger: ${learning.replay}` : undefined,
          "This classification is inferred from recorded correction evidence, not from freeform self-judgment.",
          lobsterLine,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    if (learning.source === "current-research-line") {
      return {
        text: [
          "🧯 Error type",
          learning.summary ? `Current carried summary: ${learning.summary}` : undefined,
          "I cannot classify a fresh answer failure without a newer correction or learning artifact.",
          lobsterLine,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    return {
      text: [
        "🧯 Error type",
        "I cannot honestly classify the latest answer failure because no current correction artifact was found.",
        lobsterLine,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (kind === "specific_capability") {
    const check = resolveSpecificCapabilityCheck(params.text);
    const activeProvider = modelRefs?.active.provider?.trim();
    const providerCapability =
      check && activeProvider
        ? capabilityReport.providerCapabilities.find(
            (entry) =>
              entry.provider === activeProvider && entry.capability === check.providerCapability,
          )
        : null;
    const providerConnected = Boolean(providerCapability?.states.includes("connected"));
    const providerMissing = Boolean(providerCapability?.states.includes("adapter_missing"));
    const genericTool = check?.genericTool ?? null;
    const genericConnected = genericTool
      ? capabilityReport.openclawCapabilities.some(
          (entry) => entry.tool === genericTool && entry.states.includes("connected"),
        )
      : false;
    return {
      text: [
        `🔎 Capability check: ${check?.label ?? "unknown"}`,
        `Active model: ${modelRefs ? modelRefs.active.label : (protocol.executionSubstrate.defaultModel ?? "unknown")}`,
        providerConnected
          ? `Provider-native ${check?.label ?? "capability"}: connected`
          : providerMissing
            ? `Provider-native ${check?.label ?? "capability"}: not connected`
            : `Provider-native ${check?.label ?? "capability"}: unknown`,
        genericTool
          ? `OpenClaw ${genericTool}: ${genericConnected ? "connected" : "not connected"}`
          : "OpenClaw generic tool: none",
        "This answer is runtime truth, not provider marketing.",
        lobsterLine,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (kind === "agent_architecture") {
    return {
      text: [
        "🧠 Agent architecture",
        "Short answer: not pure API chat. This is a main control-room agent with routed working surfaces, learning-council lanes, tools, memory/artifact receipts, and optional subagent/session-spawn capability.",
        "Current structure: control_room routes ordinary Lark/Feishu language into specialist surfaces such as learning_command, technical_daily, fundamental_research, knowledge_maintenance, ops_audit, and watchtower.",
        "Learning path: learning_command can run a three-lane council with stable Kimi / MiniMax / DeepSeek role labels; those labels are structural receipts, not a claim that every reply always used three live providers.",
        "Subagents: OpenClaw also exposes sessions_spawn / subagents capability for real spawned work, but ordinary answers do not automatically become a persistent multi-agent swarm.",
        "Boundary: this answer is runtime/protocol truth, not marketing. Live Lark proof still requires build, restart, probe, and visible reply evidence.",
        lobsterLine,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (kind === "learning_capability_state") {
    return {
      text: [
        "🧪 Learning capability state",
        "Dev truth: learning_command routing, the finance learning pipeline concept, capability candidate attachment / inspect paths, and finance-learning maintenance language families are wired in the repo surface.",
        "Backend paths to look for: finance_learning_pipeline_orchestrator, finance_learning_capability_inspect, finance_learning_capability_attach, finance_article_extract_capability_input, and learning_command council routing.",
        "What this means: the system can classify Lark language into the learning surface and has internal tool paths for bounded finance-learning artifacts; it should preserve existing candidates and receipts instead of restarting from blank learning.",
        "Current acceptance gate: a finance-learning run is not treated as internalized just because it became retrievable. The pipeline distinguishes application_ready, retrievable_but_not_application_ready, and not_retrievable through retrievalFirstLearning.learningInternalizationStatus.",
        "What it does not prove: this is not live-fixed by itself. It does not prove the current deployed Lark bot rebuilt, restarted, routed a real message, or visibly invoked the pipeline in production.",
        "Required live proof: build, restart, probe, one real Lark phrase for this family, visible reply naming target surface=learning_command plus the intended finance-learning tool path and learningInternalizationStatus, and no fake claim that a background learning swarm started.",
        lobsterLine,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (kind === "capabilities") {
    const activeProvider = modelRefs?.active.provider?.trim();
    const activeProviderTools = activeProvider
      ? capabilityReport.providerCapabilities
          .filter(
            (entry) => entry.provider === activeProvider && entry.states.includes("connected"),
          )
          .map((entry) => entry.capability)
      : [];
    const genericTools = capabilityReport.openclawCapabilities
      .filter((entry) => entry.states.includes("connected"))
      .map((entry) => entry.tool);
    return {
      text: [
        "🧰 Connected capabilities",
        `Active model: ${modelRefs ? modelRefs.active.label : (protocol.executionSubstrate.defaultModel ?? "unknown")}`,
        `Provider-native tools: ${activeProviderTools.length > 0 ? activeProviderTools.join(", ") : "none connected"}`,
        `OpenClaw tools: ${genericTools.length > 0 ? genericTools.join(", ") : "none connected"}`,
        lobsterLine,
        "Use /context detail or openclaw capabilities for the full capability surface.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (kind === "limitations") {
    const activeProvider = modelRefs?.active.provider?.trim();
    const missingProviderTools = activeProvider
      ? capabilityReport.providerCapabilities
          .filter(
            (entry) =>
              entry.provider === activeProvider && entry.states.includes("adapter_missing"),
          )
          .map((entry) => entry.capability)
      : [];
    return {
      text: [
        "⛔ Capability limits",
        `Active model: ${modelRefs ? modelRefs.active.label : (protocol.executionSubstrate.defaultModel ?? "unknown")}`,
        `Provider-native tools not connected: ${missingProviderTools.length > 0 ? missingProviderTools.join(", ") : "none"}`,
        "Connected capability answers here are runtime truth, not provider marketing.",
        lobsterLine,
        "Use openclaw capabilities for the full capability surface.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (kind === "runtime_model") {
    if (modelRefs) {
      return {
        text: [
          "🎛️ Runtime model",
          `Selected: ${modelRefs.selected.label}`,
          modelRefs.activeDiffers
            ? `Active: ${modelRefs.active.label}`
            : "Active: same as selected",
          lobsterLine,
          "Use /status for the full runtime snapshot.",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    return {
      text: [
        "🎛️ Runtime model",
        "Selected: unknown",
        "Active: unknown",
        lobsterLine,
        "Use /status for the full runtime snapshot.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (kind === "fallback_reason") {
    if (modelRefs) {
      const reason = fallbackState.reason?.trim();
      return {
        text: [
          "↪️ Model fallback",
          `Selected: ${modelRefs.selected.label}`,
          `Active: ${modelRefs.active.label}`,
          modelRefs.activeDiffers
            ? reason
              ? `Reason: ${reason}`
              : "Reason: active model differs, but no persisted fallback reason is available."
            : "Reason: active model matches selected.",
          lobsterLine,
          "Use /status for the full runtime snapshot.",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    return {
      text: [
        "↪️ Model fallback",
        "Reason: unknown",
        lobsterLine,
        "Use /status for the full runtime snapshot.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (kind === "anchors") {
    return {
      text: [
        "🪝 Protected anchors",
        missingAnchors.length > 0 ? `Missing: ${missingAnchors.join(", ")}` : "Missing: none",
        lobsterLine,
        "Use /context detail for the full protocol block.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  return {
    text: [
      "🧵 DM scope",
      "DM sessions default to main and are not isolated unless routing overrides dmScope.",
      lobsterLine,
      "Use /context detail for the full protocol block.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
