import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import { resolveStateDir } from "../config/paths.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";

export const MODEL_REQUEST_TRAJECTORY_SCHEMA = "lcx_model_request_metadata_v1";

export type ModelRequestSource = "agent_session" | "finance_engine" | "central_brain";
export type ModelRequestStage =
  | "attempt_started"
  | "response_received"
  | "request_error"
  | "request_aborted";
export type ModelRequestErrorKind =
  | "transport"
  | "stream_setup"
  | "stream_response"
  | "stream_result";

export type ModelRequestRecord = Readonly<{
  schema: typeof MODEL_REQUEST_TRAJECTORY_SCHEMA;
  requestId: string;
  ts: string;
  stage: ModelRequestStage;
  source: ModelRequestSource;
  provider: string;
  modelId: string;
  modelApi?: string;
  inputBytes?: number;
  messageCount?: number;
  durationMs?: number;
  httpStatus?: number;
  errorKind?: ModelRequestErrorKind;
}>;

export type ModelRequestTrajectoryWriter = Pick<QueuedFileWriter, "write">;

type ModelRequestTrajectoryConfig = {
  enabled: boolean;
  filePath: string;
};

export type ModelRequestTrajectoryDependencies = {
  env?: NodeJS.ProcessEnv;
  writer?: ModelRequestTrajectoryWriter;
  now?: () => number;
};

export type ModelRequestStartInput = {
  source: ModelRequestSource;
  provider: string;
  modelId: string;
  modelApi?: string;
  inputBytes?: number;
  messageCount?: number;
};

export type ModelRequestTicket = Readonly<{
  requestId: string;
  startedAtMs: number;
  source: ModelRequestSource;
  provider: string;
  modelId: string;
  modelApi?: string;
}>;

export type ModelRequestUpdate =
  | { stage: "response_received"; httpStatus?: number }
  | { stage: "request_error"; errorKind: ModelRequestErrorKind }
  | { stage: "request_aborted" };

const writers = new Map<string, QueuedFileWriter>();

function resolveConfig(env: NodeJS.ProcessEnv): ModelRequestTrajectoryConfig {
  const enabled = parseBooleanValue(env.LCX_MODEL_TRAJECTORY) ?? env.NODE_ENV !== "test";
  const override = env.LCX_MODEL_TRAJECTORY_FILE?.trim();
  return {
    enabled,
    filePath: override
      ? resolveUserPath(override)
      : path.join(resolveStateDir(env), "logs", "lcx-model-request-metadata.jsonl"),
  };
}

export function modelRequestTrajectoryPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveConfig(env).filePath;
}

/** Returns a byte count only. Serialized input text is never included in a record. */
export function measureModelRequestInputBytes(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : Buffer.byteLength(serialized, "utf8");
  } catch {
    return undefined;
  }
}

function writeRecord(
  record: ModelRequestRecord,
  dependencies: ModelRequestTrajectoryDependencies,
): boolean {
  try {
    const env = dependencies.env ?? process.env;
    const config = resolveConfig(env);
    if (!config.enabled) {
      return false;
    }
    const writer = dependencies.writer ?? getQueuedFileWriter(writers, config.filePath);
    writer.write(`${JSON.stringify(record)}\n`);
    return true;
  } catch {
    // Observability must never block or change the model request.
    return false;
  }
}

export function recordModelRequestStart(
  input: ModelRequestStartInput,
  dependencies: ModelRequestTrajectoryDependencies = {},
): ModelRequestTicket | null {
  const startedAtMs = (dependencies.now ?? Date.now)();
  const ticket: ModelRequestTicket = {
    requestId: randomUUID(),
    startedAtMs,
    source: input.source,
    provider: input.provider,
    modelId: input.modelId,
    ...(input.modelApi ? { modelApi: input.modelApi } : {}),
  };
  const record: ModelRequestRecord = {
    schema: MODEL_REQUEST_TRAJECTORY_SCHEMA,
    requestId: ticket.requestId,
    ts: new Date(startedAtMs).toISOString(),
    stage: "attempt_started",
    source: input.source,
    provider: input.provider,
    modelId: input.modelId,
    ...(input.modelApi ? { modelApi: input.modelApi } : {}),
    ...(Number.isSafeInteger(input.inputBytes) && input.inputBytes! >= 0
      ? { inputBytes: input.inputBytes }
      : {}),
    ...(Number.isSafeInteger(input.messageCount) && input.messageCount! >= 0
      ? { messageCount: input.messageCount }
      : {}),
  };
  return writeRecord(record, dependencies) ? ticket : null;
}

export function recordModelRequestUpdate(
  ticket: ModelRequestTicket | null,
  update: ModelRequestUpdate,
  dependencies: ModelRequestTrajectoryDependencies = {},
): void {
  if (!ticket) {
    return;
  }
  const now = (dependencies.now ?? Date.now)();
  const record: ModelRequestRecord = {
    schema: MODEL_REQUEST_TRAJECTORY_SCHEMA,
    requestId: ticket.requestId,
    ts: new Date(now).toISOString(),
    stage: update.stage,
    source: ticket.source,
    provider: ticket.provider,
    modelId: ticket.modelId,
    ...(ticket.modelApi ? { modelApi: ticket.modelApi } : {}),
    durationMs: Math.max(0, Math.round(now - ticket.startedAtMs)),
    ...(update.stage === "response_received" &&
    Number.isSafeInteger(update.httpStatus) &&
    update.httpStatus! >= 100 &&
    update.httpStatus! <= 599
      ? { httpStatus: update.httpStatus }
      : {}),
    ...(update.stage === "request_error" ? { errorKind: update.errorKind } : {}),
  };
  writeRecord(record, dependencies);
}

/** Wraps the actual provider seam; only request dimensions and outcome metadata are recorded. */
export function wrapStreamFnForTrajectory(
  baseFn: StreamFn,
  source: ModelRequestSource = "agent_session",
  dependencies: ModelRequestTrajectoryDependencies = {},
): StreamFn {
  return (model, context, options) => {
    const modelContext = context as {
      system?: unknown;
      systemPrompt?: unknown;
      messages?: AgentMessage[];
      tools?: unknown;
    };
    const messages = Array.isArray(modelContext.messages) ? modelContext.messages : [];
    const ticket = recordModelRequestStart(
      {
        source,
        provider: model.provider,
        modelId: model.id,
        modelApi: model.api,
        messageCount: messages.length,
        inputBytes: measureModelRequestInputBytes({
          system: modelContext.system ?? modelContext.systemPrompt,
          messages,
          tools: modelContext.tools,
        }),
      },
      dependencies,
    );
    const wrapResult = (stream: Awaited<ReturnType<StreamFn>>) => {
      const result = stream.result.bind(stream);
      let outcomeRecorded = false;
      stream.result = () =>
        result().then(
          (message) => {
            if (!outcomeRecorded) {
              outcomeRecorded = true;
              if (message.stopReason === "aborted") {
                recordModelRequestUpdate(ticket, { stage: "request_aborted" }, dependencies);
              } else if (message.stopReason === "error") {
                recordModelRequestUpdate(
                  ticket,
                  { stage: "request_error", errorKind: "stream_response" },
                  dependencies,
                );
              } else {
                recordModelRequestUpdate(ticket, { stage: "response_received" }, dependencies);
              }
            }
            return message;
          },
          (error: unknown) => {
            if (!outcomeRecorded) {
              outcomeRecorded = true;
              recordModelRequestUpdate(
                ticket,
                { stage: "request_error", errorKind: "stream_result" },
                dependencies,
              );
            }
            throw error;
          },
        );
      return stream;
    };

    try {
      const response = baseFn(model, context, options);
      if (response instanceof Promise) {
        return response.then(wrapResult, (error: unknown) => {
          recordModelRequestUpdate(
            ticket,
            { stage: "request_error", errorKind: "stream_setup" },
            dependencies,
          );
          throw error;
        });
      }
      return wrapResult(response);
    } catch (error) {
      recordModelRequestUpdate(
        ticket,
        { stage: "request_error", errorKind: "stream_setup" },
        dependencies,
      );
      throw error;
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SOURCES: readonly ModelRequestSource[] = ["agent_session", "finance_engine", "central_brain"];
const STAGES: ReadonlySet<ModelRequestStage> = new Set([
  "attempt_started",
  "response_received",
  "request_error",
  "request_aborted",
]);

function parseRecord(value: unknown): ModelRequestRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value.schema !== MODEL_REQUEST_TRAJECTORY_SCHEMA ||
    typeof value.requestId !== "string" ||
    typeof value.ts !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.modelId !== "string" ||
    !SOURCES.includes(value.source as ModelRequestSource) ||
    !STAGES.has(value.stage as ModelRequestStage)
  ) {
    return undefined;
  }
  const stage = value.stage as ModelRequestStage;
  return {
    schema: MODEL_REQUEST_TRAJECTORY_SCHEMA,
    requestId: value.requestId,
    ts: value.ts,
    stage,
    source: value.source as ModelRequestSource,
    provider: value.provider,
    modelId: value.modelId,
    ...(typeof value.modelApi === "string" ? { modelApi: value.modelApi } : {}),
    ...(Number.isSafeInteger(value.inputBytes) && Number(value.inputBytes) >= 0
      ? { inputBytes: Number(value.inputBytes) }
      : {}),
    ...(Number.isSafeInteger(value.messageCount) && Number(value.messageCount) >= 0
      ? { messageCount: Number(value.messageCount) }
      : {}),
    ...(Number.isFinite(value.durationMs) && Number(value.durationMs) >= 0
      ? { durationMs: Number(value.durationMs) }
      : {}),
    ...(Number.isSafeInteger(value.httpStatus) &&
    Number(value.httpStatus) >= 100 &&
    Number(value.httpStatus) <= 599
      ? { httpStatus: Number(value.httpStatus) }
      : {}),
    ...(stage === "request_error" &&
    (value.errorKind === "transport" ||
      value.errorKind === "stream_setup" ||
      value.errorKind === "stream_response" ||
      value.errorKind === "stream_result")
      ? { errorKind: value.errorKind }
      : {}),
  };
}

export async function readModelRequestTrajectory(
  params: {
    filePath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ModelRequestRecord[]> {
  const env = params.env ?? process.env;
  const filePath = params.filePath ?? modelRequestTrajectoryPath(env);
  const records: ModelRequestRecord[] = [];
  await forEachModelRequestTrajectoryRecord(filePath, (record) => records.push(record));
  return records;
}

type MutableModelRequestTrajectorySummary = {
  events: number;
  attempts: number;
  responses: number;
  errors: number;
  aborted: number;
  bySource: Record<
    ModelRequestSource,
    { attempts: number; responses: number; errors: number; aborted: number }
  >;
};

function emptyModelRequestTrajectorySummary(): MutableModelRequestTrajectorySummary {
  return {
    events: 0,
    attempts: 0,
    responses: 0,
    errors: 0,
    aborted: 0,
    bySource: Object.fromEntries(
      SOURCES.map((source) => [source, { attempts: 0, responses: 0, errors: 0, aborted: 0 }]),
    ) as MutableModelRequestTrajectorySummary["bySource"],
  };
}

function addRecordToTrajectorySummary(
  summary: MutableModelRequestTrajectorySummary,
  record: ModelRequestRecord,
): void {
  const count = summary.bySource[record.source];
  summary.events += 1;
  if (record.stage === "attempt_started") {
    summary.attempts += 1;
    count.attempts += 1;
  } else if (record.stage === "response_received") {
    summary.responses += 1;
    count.responses += 1;
  } else if (record.stage === "request_error") {
    summary.errors += 1;
    count.errors += 1;
  } else {
    summary.aborted += 1;
    count.aborted += 1;
  }
}

async function forEachModelRequestTrajectoryRecord(
  filePath: string,
  visit: (record: ModelRequestRecord) => void,
): Promise<void> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = parseRecord(JSON.parse(line) as unknown);
        if (record) {
          visit(record);
        }
      } catch {
        // Ignore incomplete or malformed lines without exposing their content.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  } finally {
    lines.close();
    input.destroy();
  }
}

/** Summarizes the append-only trajectory with memory independent of the total file size. */
export async function summarizeModelRequestTrajectoryFile(
  params: {
    filePath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ReturnType<typeof emptyModelRequestTrajectorySummary>> {
  const env = params.env ?? process.env;
  const filePath = params.filePath ?? modelRequestTrajectoryPath(env);
  const summary = emptyModelRequestTrajectorySummary();
  await forEachModelRequestTrajectoryRecord(filePath, (record) =>
    addRecordToTrajectorySummary(summary, record),
  );
  return summary;
}

export function summarizeModelRequestTrajectory(records: readonly ModelRequestRecord[]) {
  const summary = emptyModelRequestTrajectorySummary();
  for (const record of records) {
    addRecordToTrajectorySummary(summary, record);
  }
  return summary;
}
