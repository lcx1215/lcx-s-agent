import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai/dist/utils/event-stream.js";
import { describe, expect, it, vi } from "vitest";
import {
  modelRequestTrajectoryPath,
  readModelRequestTrajectory,
  recordModelRequestStart,
  recordModelRequestUpdate,
  summarizeModelRequestTrajectory,
  wrapStreamFnForTrajectory,
} from "./model-request-trajectory.js";

const testEnv = { NODE_ENV: "test", LCX_MODEL_TRAJECTORY: "true" };

describe("model request metadata trajectory", () => {
  it("stores only allowlisted metadata and never prompt or credential text", async () => {
    const lines: string[] = [];
    const writer = { write: (line: string) => lines.push(line) };
    const baseFn = vi.fn(() => new AssistantMessageEventStream()) as unknown as StreamFn;
    const wrapped = wrapStreamFnForTrajectory(baseFn, "agent_session", {
      env: testEnv,
      writer,
      now: () => 1_000,
    });
    const model = {
      provider: "provider-x",
      id: "model-y",
      api: "openai-completions",
    } as Parameters<StreamFn>[0];
    const context = {
      system: "PRIVATE_SYSTEM_PROMPT_SENTINEL",
      messages: [{ role: "user", content: "PRIVATE_USER_PROMPT_SENTINEL" }],
      tools: [{ name: "review" }],
    } as unknown as Parameters<StreamFn>[1];

    await wrapped(model, context, {} as Parameters<StreamFn>[2]);

    expect(baseFn).toHaveBeenCalledOnce();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("PRIVATE_");
    const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(record).toMatchObject({
      source: "agent_session",
      provider: "provider-x",
      modelId: "model-y",
      modelApi: "openai-completions",
      stage: "attempt_started",
      messageCount: 1,
    });
    for (const unsafeField of ["prompt", "messages", "system", "content", "apiKey"]) {
      expect(record).not.toHaveProperty(unsafeField);
    }
    expect(record.inputBytes).toEqual(expect.any(Number));
  });

  it("records a safe transport-stage marker and preserves the original error", () => {
    const lines: string[] = [];
    const failure = new Error("PRIVATE_PROVIDER_ERROR_SENTINEL");
    const baseFn = (() => {
      throw failure;
    }) as unknown as StreamFn;
    const wrapped = wrapStreamFnForTrajectory(baseFn, "agent_session", {
      env: testEnv,
      writer: { write: (line) => lines.push(line) },
      now: (() => {
        let current = 1_000;
        return () => (current += 25);
      })(),
    });
    const model = { provider: "provider-x", id: "model-y", api: "test" } as Parameters<StreamFn>[0];

    expect(() =>
      wrapped(model, {} as Parameters<StreamFn>[1], {} as Parameters<StreamFn>[2]),
    ).toThrow(failure);
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("PRIVATE_PROVIDER_ERROR_SENTINEL");
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
      stage: "request_error",
      errorKind: "stream_setup",
      durationMs: 25,
    });
  });

  it("can be disabled and resolves overrides without exposing file contents", () => {
    expect(
      recordModelRequestStart(
        { source: "finance_engine", provider: "p", modelId: "m" },
        { env: { NODE_ENV: "test", LCX_MODEL_TRAJECTORY: "false" } },
      ),
    ).toBeNull();
    expect(
      modelRequestTrajectoryPath({
        NODE_ENV: "test",
        LCX_MODEL_TRAJECTORY_FILE: "/tmp/lcx-model-requests.jsonl",
      }),
    ).toBe(path.resolve("/tmp/lcx-model-requests.jsonl"));
  });

  it("whitelists records read from disk and summarizes only counts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "lcx-model-trajectory-"));
    const filePath = path.join(directory, "requests.jsonl");
    try {
      await writeFile(
        filePath,
        `${JSON.stringify({
          schema: "lcx_model_request_metadata_v1",
          requestId: "request-1",
          ts: "2026-09-24T00:00:00.000Z",
          stage: "attempt_started",
          source: "central_brain",
          provider: "provider-x",
          modelId: "model-y",
          prompt: "PRIVATE_OLD_PROMPT_SENTINEL",
        })}\n${JSON.stringify({ schema: "legacy", prompt: "PRIVATE_OLD_PROMPT_SENTINEL" })}\n`,
        "utf8",
      );

      const records = await readModelRequestTrajectory({ filePath, env: testEnv });

      expect(records).toHaveLength(1);
      expect(records[0]).not.toHaveProperty("prompt");
      expect(JSON.stringify(records)).not.toContain("PRIVATE_OLD_PROMPT_SENTINEL");
      expect(summarizeModelRequestTrajectory(records)).toMatchObject({
        events: 1,
        attempts: 1,
        responses: 0,
        errors: 0,
        aborted: 0,
        bySource: { central_brain: { attempts: 1, responses: 0, errors: 0, aborted: 0 } },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes start and response events without retaining arbitrary update fields", () => {
    const lines: string[] = [];
    const dependencies = {
      env: testEnv,
      writer: { write: (line: string) => lines.push(line) },
      now: () => 1_000,
    };
    const ticket = recordModelRequestStart(
      {
        source: "finance_engine",
        provider: "provider-x",
        modelId: "model-y",
        inputBytes: 42,
        messageCount: 1,
      },
      dependencies,
    );
    const updateWithUnexpectedField = {
      stage: "response_received" as const,
      httpStatus: 200,
      prompt: "PRIVATE",
    };
    recordModelRequestUpdate(ticket, updateWithUnexpectedField, {
      ...dependencies,
      now: () => 1_125,
    });

    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("PRIVATE");
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
      stage: "response_received",
      httpStatus: 200,
      durationMs: 125,
    });
  });

  it("records streamed completion and failure without copying response text", async () => {
    const lines: string[] = [];
    const dependencies = {
      env: testEnv,
      writer: { write: (line: string) => lines.push(line) },
      now: (() => {
        let current = 1_000;
        return () => (current += 25);
      })(),
    };
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "PRIVATE_RESPONSE_SENTINEL" }],
      api: "openai-completions",
      provider: "provider-x",
      model: "model-y",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      stopReason: "stop",
      timestamp: 1_000,
    } as const;
    const stream = new AssistantMessageEventStream();
    const wrapped = wrapStreamFnForTrajectory(
      (() => stream) as unknown as StreamFn,
      "agent_session",
      dependencies,
    );
    const model = { provider: "provider-x", id: "model-y", api: "test" } as Parameters<StreamFn>[0];
    const result = wrapped(model, {} as Parameters<StreamFn>[1], {} as Parameters<StreamFn>[2]);
    if (result instanceof Promise) {
      throw new Error("synchronous stream wrapper returned a promise");
    }
    const finalResult = result.result();
    stream.push({ type: "done", reason: "stop", message: message as never });

    await expect(finalResult).resolves.toMatchObject({ stopReason: "stop" });
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("PRIVATE_RESPONSE_SENTINEL");
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
      stage: "response_received",
      durationMs: 25,
    });
  });

  it("separates aborted streams and async stream-setup failures from responses", async () => {
    const lines: string[] = [];
    const dependencies = {
      env: testEnv,
      writer: { write: (line: string) => lines.push(line) },
      now: () => 1_000,
    };
    const errorMessage = {
      role: "assistant",
      content: [{ type: "text", text: "PRIVATE_STREAM_ERROR_SENTINEL" }],
      api: "openai-completions",
      provider: "provider-x",
      model: "model-y",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "aborted",
      timestamp: 1_000,
    } as const;
    const stream = new AssistantMessageEventStream();
    const wrapped = wrapStreamFnForTrajectory(
      (() => stream) as unknown as StreamFn,
      "agent_session",
      dependencies,
    );
    const model = { provider: "provider-x", id: "model-y", api: "test" } as Parameters<StreamFn>[0];
    const result = wrapped(model, {} as Parameters<StreamFn>[1], {} as Parameters<StreamFn>[2]);
    if (result instanceof Promise) {
      throw new Error("synchronous stream wrapper returned a promise");
    }
    const finalResult = result.result();
    stream.push({ type: "error", reason: "aborted", error: errorMessage as never });
    await finalResult;

    const failure = new Error("PRIVATE_SETUP_ERROR_SENTINEL");
    const asyncFailure = wrapStreamFnForTrajectory(
      (async () => {
        throw failure;
      }) as unknown as StreamFn,
      "agent_session",
      dependencies,
    );
    await expect(
      asyncFailure(model, {} as Parameters<StreamFn>[1], {} as Parameters<StreamFn>[2]),
    ).rejects.toBe(failure);

    expect(lines).toHaveLength(4);
    expect(lines.join("\n")).not.toContain("PRIVATE_STREAM_ERROR_SENTINEL");
    expect(lines.join("\n")).not.toContain("PRIVATE_SETUP_ERROR_SENTINEL");
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ stage: "request_aborted" });
    expect(JSON.parse(lines[3] ?? "{}")).toMatchObject({
      stage: "request_error",
      errorKind: "stream_setup",
    });
  });
});
