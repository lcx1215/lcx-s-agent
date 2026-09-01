import { createHash } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  EXECUTOR_SCHEMA_VERSION,
  SHADOW_CASE,
  SHADOW_PATTERNS,
  type ShadowCapabilities,
  type ShadowExecutorRequest,
  type ShadowExecutorResponse,
  type ShadowFaultInjection,
  type ShadowEvent,
  type ShadowSideEffect,
  type ShadowToolEvent,
} from "../../scripts/operator/lcx-multi-agent-pattern-shadow.ts";
import {
  LCX_ONTOLOGY_AGENT_ROLES,
  LCX_ONTOLOGY_CONTEXT_SCOPES,
  LCX_ONTOLOGY_OWNERSHIP_MODES,
  LCX_ONTOLOGY_WORKSPACE_SCOPES,
} from "../../src/shared/lcx-ontology.ts";

/**
 * A deterministic, no-network executor for validating the isolated shadow
 * executor seam.
 * It is deliberately a test fixture, not a provider adapter or runtime owner.
 */
const FIXTURE_ID = "lcx_multi_agent_shadow_protocol_fixture_v1";
const FIXTURE_ANSWER =
  "风险结论：NVDA 亏 20% 本身不是补仓理由。默认风险门：补仓资格=未通过，直到你把 thesis、仓位占比和强制风险补齐。\n\n" +
  "三档决策树：A. 红灯：有杠杆/期权、仓位对账户太重，或者说不清买入 thesis，目标先变成账户风险控制。B. 黄灯：thesis 没坏，但估值被重估或市场流动性在压缩，先做研究复核，等财报/指引/估值证据更新后再谈新增风险。C. 绿灯：thesis 仍成立、单票仓位仍在你的风险预算内、没有杠杆/期权强制风险，且最新数据支持原逻辑，才有资格讨论新的风险预算。失效条件：财报/指引破坏原 thesis、仓位超过风险预算，或杠杆/期权带来强制风险。\n\n" +
  "你下一条直接发：组合占比、成本区间、买入 thesis、持有期限、最大可承受回撤、是否有杠杆/期权，以及最近财报/指引/估值数据时间戳。";

const FAULT_KINDS = ["interrupt_after_checkpoint", "timeout_child", "permission_probe"] as const;
type FixtureFaultKind = (typeof FAULT_KINDS)[number];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isKnown<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function supportedCapabilities(): ShadowCapabilities {
  return {
    eventReceipt: "supported",
    toolEventReceipt: "supported",
    sideEffectReceipt: "supported",
    faultInjection: "supported",
    resume: "supported",
  };
}

function unknownCapabilities(): ShadowCapabilities {
  return {
    eventReceipt: "unknown",
    toolEventReceipt: "unknown",
    sideEffectReceipt: "unknown",
    faultInjection: "unknown",
    resume: "unknown",
  };
}

function blockedResponse(code: string, message: string): ShadowExecutorResponse {
  return {
    schemaVersion: EXECUTOR_SCHEMA_VERSION,
    status: "blocked",
    capabilities: unknownCapabilities(),
    error: { code, message },
  };
}

function parseFault(value: unknown): ShadowFaultInjection | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value);
  if (!record || !isKnown(FAULT_KINDS, record.kind)) {
    return undefined;
  }
  return {
    kind: record.kind,
    afterEventId: typeof record.afterEventId === "string" ? record.afterEventId : undefined,
  };
}

function parseRequest(
  value: unknown,
): { ok: true; request: ShadowExecutorRequest } | { ok: false; response: ShadowExecutorResponse } {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== EXECUTOR_SCHEMA_VERSION) {
    return {
      ok: false,
      response: blockedResponse(
        "fixture_schema_incompatible",
        `expected ${EXECUTOR_SCHEMA_VERSION}`,
      ),
    };
  }
  if (
    typeof record.runId !== "string" ||
    record.runId.length === 0 ||
    record.caseId !== SHADOW_CASE.id ||
    !isKnown(SHADOW_PATTERNS, record.pattern) ||
    !isKnown(LCX_ONTOLOGY_AGENT_ROLES, record.role) ||
    !Array.isArray(record.taskPath) ||
    !record.taskPath.every((item) => typeof item === "string") ||
    !(record.parentTaskId === null || typeof record.parentTaskId === "string") ||
    !isKnown(LCX_ONTOLOGY_CONTEXT_SCOPES, record.contextScope) ||
    !isKnown(LCX_ONTOLOGY_WORKSPACE_SCOPES, record.workspaceScope) ||
    !isKnown(LCX_ONTOLOGY_OWNERSHIP_MODES, record.ownershipMode) ||
    !Array.isArray(record.allowedTools) ||
    !record.allowedTools.every((item) => typeof item === "string") ||
    !record.allowedTools.includes("read_case") ||
    !record.allowedTools.includes("write_workspace_artifact") ||
    typeof record.workspaceDir !== "string" ||
    record.workspaceDir.length === 0 ||
    (record.resumeFromEventId !== undefined && typeof record.resumeFromEventId !== "string")
  ) {
    return {
      ok: false,
      response: blockedResponse(
        "fixture_request_invalid",
        "fixture requires the current case, topology, role, scope, allowlist, and workspace contract",
      ),
    };
  }
  const faultInjection = parseFault(record.faultInjection);
  if (record.faultInjection !== undefined && !faultInjection) {
    return {
      ok: false,
      response: blockedResponse(
        "fixture_fault_unsupported",
        "fixture only supports the declared interrupt, timeout, and permission probes",
      ),
    };
  }
  return {
    ok: true,
    request: {
      schemaVersion: EXECUTOR_SCHEMA_VERSION,
      runId: record.runId,
      caseId: SHADOW_CASE.id,
      pattern: record.pattern,
      role: record.role,
      taskPath: record.taskPath,
      parentTaskId: record.parentTaskId,
      contextScope: record.contextScope,
      workspaceScope: record.workspaceScope,
      ownershipMode: record.ownershipMode,
      allowedTools: record.allowedTools,
      workspaceDir: record.workspaceDir,
      ...(typeof record.resumeFromEventId === "string"
        ? { resumeFromEventId: record.resumeFromEventId }
        : {}),
      ...(faultInjection ? { faultInjection } : {}),
    },
  };
}

function taskIdFor(request: ShadowExecutorRequest): string {
  return `${request.runId}:${request.role}`;
}

function dependencyIds(request: ShadowExecutorRequest): string[] {
  if (request.pattern !== "manager") {
    return [];
  }
  const order = ["risk_gate", "evaluator", "advisor"];
  const index = order.indexOf(request.role);
  return index > 0 ? [`${request.runId}:${order[index - 1]}`] : [];
}

function makeEvent(params: {
  request: ShadowExecutorRequest;
  kind: ShadowEvent["kind"];
  communicationKind: ShadowEvent["communicationKind"];
  state: ShadowEvent["state"];
  atMs: number;
  durationMs?: number;
}): ShadowEvent {
  const taskId = taskIdFor(params.request);
  const final = params.request.pattern === "handoff" && params.request.role === "specialist";
  const outputContract = final ? "final_answer" : "role_report";
  return {
    eventId: `${taskId}:${params.kind}:${params.atMs}`,
    taskId,
    parentTaskId: params.request.parentTaskId,
    role: params.request.role,
    state: params.state,
    kind: params.kind,
    communicationKind: params.communicationKind,
    atMs: params.atMs,
    durationMs: params.durationMs,
    dependsOnTaskIds: dependencyIds(params.request),
    outputContract,
    artifactHash: hash(`${FIXTURE_ID}|${taskId}|${params.kind}|${params.atMs}`),
  };
}

function makeToolEvents(
  request: ShadowExecutorRequest,
  fault?: FixtureFaultKind,
): ShadowToolEvent[] {
  const taskId = taskIdFor(request);
  const events: ShadowToolEvent[] = [
    {
      eventId: `${taskId}:tool:read_case`,
      taskId,
      toolName: "read_case",
      status: "completed",
      allowed: true,
    },
  ];
  if (fault === "permission_probe") {
    events.push({
      eventId: `${taskId}:tool:permission-probe`,
      taskId,
      toolName: "external_channel.send",
      status: "blocked",
      allowed: false,
    });
  }
  return events;
}

function makeSideEffects(fault?: FixtureFaultKind): ShadowSideEffect[] {
  return fault === "permission_probe"
    ? [{ kind: "external_channel_send", target: "blocked", status: "blocked" }]
    : [];
}

function makeResponse(request: ShadowExecutorRequest): ShadowExecutorResponse {
  const fault = request.faultInjection?.kind;
  const taskId = taskIdFor(request);
  const started = makeEvent({
    request,
    kind: "task_started",
    communicationKind: "parent_message",
    state: "running",
    atMs: 0,
  });
  const checkpoint = makeEvent({
    request,
    kind: "checkpoint",
    communicationKind: "report",
    state: "waiting",
    atMs: 8,
  });
  const completed = makeEvent({
    request,
    kind: "task_completed",
    communicationKind:
      request.pattern === "handoff" && request.role === "specialist" ? "final_answer" : "report",
    state: "completed",
    atMs: 16,
    durationMs: 16,
  });
  const common = {
    schemaVersion: EXECUTOR_SCHEMA_VERSION,
    toolEvents: makeToolEvents(request, fault),
    sideEffects: makeSideEffects(fault),
    capabilities: supportedCapabilities(),
    report: { fixtureId: FIXTURE_ID, role: request.role, pattern: request.pattern },
  } satisfies Pick<
    ShadowExecutorResponse,
    "schemaVersion" | "toolEvents" | "sideEffects" | "capabilities" | "report"
  >;
  if (fault === "timeout_child") {
    return {
      ...common,
      status: "timed_out",
      events: [started],
      error: { code: "fixture_timeout", message: "deterministic fixture timeout probe" },
    };
  }
  if (fault === "permission_probe") {
    return {
      ...common,
      status: "blocked",
      events: [started, checkpoint],
      error: { code: "fixture_permission_probe", message: "forbidden tool remained blocked" },
    };
  }
  if (request.faultInjection?.kind === "interrupt_after_checkpoint" && !request.resumeFromEventId) {
    return {
      ...common,
      status: "interrupted",
      events: [started, checkpoint],
      resumeToken: checkpoint.eventId,
      error: { code: "fixture_interruption", message: "deterministic checkpoint interruption" },
    };
  }
  return {
    ...common,
    status: request.resumeFromEventId ? "resumed" : "completed",
    answer: FIXTURE_ANSWER,
    events: [completed],
    ...(request.resumeFromEventId ? { resumeToken: `${taskId}:resume-used` } : {}),
  };
}

export function buildFixtureResponse(value: unknown): ShadowExecutorResponse {
  const parsed = parseRequest(value);
  return parsed.ok ? makeResponse(parsed.request) : parsed.response;
}

function main(): void {
  let input: unknown;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    process.stdout.write(
      `${JSON.stringify(blockedResponse("fixture_input_invalid", "stdin must contain one JSON request"))}\n`,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(buildFixtureResponse(input))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
