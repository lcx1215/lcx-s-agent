import crypto from "node:crypto";

export const CODING_HARNESS_TRAJECTORY_SCHEMA_VERSION = 1 as const;

export type CodingHarnessTrajectoryEventKind =
  | "run/requested"
  | "run/accepted"
  | "run/waited"
  | "run/history-observed"
  | "workspace/observed"
  | "verification/observed"
  | "run/resumed"
  | "run/forked"
  | "run/completed"
  | "run/failed"
  | "run/timed-out";

export type CodingHarnessTrajectoryEvent = {
  schemaVersion: typeof CODING_HARNESS_TRAJECTORY_SCHEMA_VERSION;
  runId: string;
  sequence: number;
  kind: CodingHarnessTrajectoryEventKind;
  at: string;
  data: Record<string, unknown>;
};

const CODING_HARNESS_TRAJECTORY_EVENT_KINDS = new Set<CodingHarnessTrajectoryEventKind>([
  "run/requested",
  "run/accepted",
  "run/waited",
  "run/history-observed",
  "workspace/observed",
  "verification/observed",
  "run/resumed",
  "run/forked",
  "run/completed",
  "run/failed",
  "run/timed-out",
]);

export type CodingHarnessTrajectoryProjection = {
  runId: string;
  status:
    | "created"
    | "accepted"
    | "running"
    | "completed"
    | "completed-unverified"
    | "failed"
    | "timed-out";
  executorAccepted: boolean;
  historyObserved: boolean;
  changedPaths: string[];
  verification: "not-requested" | "passed" | "failed" | "blocked";
  eventCount: number;
};

const REDACTED = "[redacted]";
const SENSITIVE_KEY = /(token|secret|password|authorization|cookie|private[_-]?key|api[_-]?key)/i;
const MAX_STRING_LENGTH = 2_000;
const MAX_ARRAY_ITEMS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`
      : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => sanitizeValue(entry));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(data) as Record<string, unknown>;
}

function assertValidEvent(
  event: CodingHarnessTrajectoryEvent,
  expectedRunId: string,
  index: number,
) {
  if (event.schemaVersion !== CODING_HARNESS_TRAJECTORY_SCHEMA_VERSION) {
    throw new Error(`Unsupported coding trajectory schema: ${String(event.schemaVersion)}`);
  }
  if (event.runId !== expectedRunId) {
    throw new Error(`Coding trajectory run id mismatch at sequence ${event.sequence}`);
  }
  if (event.sequence !== index + 1) {
    throw new Error(`Coding trajectory sequence gap at ${event.sequence}`);
  }
  if (
    !CODING_HARNESS_TRAJECTORY_EVENT_KINDS.has(event.kind) ||
    !event.at ||
    !isRecord(event.data)
  ) {
    throw new Error(`Malformed coding trajectory event at sequence ${event.sequence}`);
  }
  if (Number.isNaN(Date.parse(event.at))) {
    throw new Error(`Invalid coding trajectory timestamp at sequence ${event.sequence}`);
  }
}

function cloneEvent(event: CodingHarnessTrajectoryEvent): CodingHarnessTrajectoryEvent {
  return {
    ...event,
    data: sanitizeData(event.data),
  };
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function summarizeTrajectoryText(value: string): { sha256: string; length: number } {
  return { sha256: hashText(value), length: value.length };
}

export class AppendOnlyCodingTrajectory {
  private readonly eventLog: CodingHarnessTrajectoryEvent[];

  constructor(
    public readonly runId: string,
    events: readonly CodingHarnessTrajectoryEvent[] = [],
  ) {
    if (!runId.trim()) {
      throw new Error("Coding trajectory run id is required");
    }
    this.eventLog = events.map(cloneEvent);
    this.validate();
  }

  get events(): readonly CodingHarnessTrajectoryEvent[] {
    return this.eventLog.map(cloneEvent);
  }

  append(
    kind: CodingHarnessTrajectoryEventKind,
    data: Record<string, unknown> = {},
    at = new Date().toISOString(),
  ): CodingHarnessTrajectoryEvent {
    const event: CodingHarnessTrajectoryEvent = {
      schemaVersion: CODING_HARNESS_TRAJECTORY_SCHEMA_VERSION,
      runId: this.runId,
      sequence: this.eventLog.length + 1,
      kind,
      at,
      data: sanitizeData(data),
    };
    assertValidEvent(event, this.runId, this.eventLog.length);
    this.eventLog.push(event);
    return cloneEvent(event);
  }

  validate(): void {
    this.eventLog.forEach((event, index) => assertValidEvent(event, this.runId, index));
  }

  replay(): CodingHarnessTrajectoryProjection {
    this.validate();
    let status: CodingHarnessTrajectoryProjection["status"] = "created";
    let executorAccepted = false;
    let historyObserved = false;
    let changedPaths: string[] = [];
    let verification: CodingHarnessTrajectoryProjection["verification"] = "not-requested";

    for (const event of this.eventLog) {
      switch (event.kind) {
        case "run/accepted":
          executorAccepted = true;
          status = "accepted";
          break;
        case "run/waited":
          status = event.data.status === "ok" ? "running" : status;
          break;
        case "run/history-observed":
          historyObserved = event.data.observed === true;
          break;
        case "workspace/observed":
          changedPaths = Array.isArray(event.data.changedPaths)
            ? event.data.changedPaths.filter((path): path is string => typeof path === "string")
            : changedPaths;
          break;
        case "verification/observed":
          if (event.data.status === "passed") {
            verification = "passed";
          } else if (event.data.status === "failed") {
            verification = "failed";
          } else if (event.data.status === "blocked") {
            verification = "blocked";
          }
          break;
        case "run/completed":
          status = event.data.verified === true ? "completed" : "completed-unverified";
          break;
        case "run/failed":
          status = "failed";
          break;
        case "run/timed-out":
          status = "timed-out";
          break;
        case "run/requested":
        case "run/resumed":
        case "run/forked":
          break;
      }
    }

    return {
      runId: this.runId,
      status,
      executorAccepted,
      historyObserved,
      changedPaths,
      verification,
      eventCount: this.eventLog.length,
    };
  }

  resume(at = new Date().toISOString()): AppendOnlyCodingTrajectory {
    const resumed = new AppendOnlyCodingTrajectory(this.runId, this.eventLog);
    resumed.append("run/resumed", { fromSequence: this.eventLog.length }, at);
    return resumed;
  }

  fork(
    forkRunId: string,
    atSequence = this.eventLog.length,
    at = new Date().toISOString(),
  ): AppendOnlyCodingTrajectory {
    if (!Number.isInteger(atSequence) || atSequence < 1 || atSequence > this.eventLog.length) {
      throw new Error(`Invalid coding trajectory fork sequence: ${atSequence}`);
    }
    const forkedEvents = this.eventLog.slice(0, atSequence).map((event) => ({
      ...event,
      runId: forkRunId,
      data: sanitizeData(event.data),
    }));
    const forked = new AppendOnlyCodingTrajectory(forkRunId, forkedEvents);
    forked.append(
      "run/forked",
      {
        sourceRunId: this.runId,
        sourceSequence: atSequence,
      },
      at,
    );
    return forked;
  }

  toJSONL(): string {
    this.validate();
    return this.eventLog.map((event) => JSON.stringify(event)).join("\n");
  }

  static fromJSONL(runId: string, value: string): AppendOnlyCodingTrajectory {
    const lines = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const events = lines.map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`Invalid coding trajectory JSON at line ${index + 1}`);
      }
      if (!isRecord(parsed)) {
        throw new Error(`Malformed coding trajectory JSON at line ${index + 1}`);
      }
      return parsed as unknown as CodingHarnessTrajectoryEvent;
    });
    return new AppendOnlyCodingTrajectory(runId, events);
  }
}
