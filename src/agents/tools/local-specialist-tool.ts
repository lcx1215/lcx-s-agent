import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  createLocalTextModelAdapter,
  resolveLocalTextModelRuntimeConfig,
} from "../local-text-model-adapter.js";
import { createResidentLocalTextAdapter, localTextWorker } from "../local-text-worker.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import { jsonResult, readStringParam, ToolInputError, type AnyAgentTool } from "./common.js";
import {
  LOCAL_SPECIALIST_POLICY,
  LOCAL_SPECIALIST_PROFILES,
  buildLocalSpecialistPrompt,
  validateLocalSpecialistOutput,
} from "./local-specialist-contract.js";
export {
  LOCAL_SPECIALIST_POLICY,
  LOCAL_SPECIALIST_PROFILES,
  buildLocalSpecialistPrompt,
  validateLocalSpecialistOutput,
} from "./local-specialist-contract.js";

function createLocalSpecialistItemTool(options?: {
  workspaceDir?: string;
  modelRoot?: string;
  pythonPath?: string;
  adapterFactory?: typeof createLocalTextModelAdapter;
}): AnyAgentTool {
  const workspace = resolveWorkspaceRoot(options?.workspaceDir);
  const modelRoot =
    options?.modelRoot ?? path.join(os.homedir(), ".openclaw", "models", "local-specialists");
  let calls = 0;
  let disabled = false;
  return {
    name: "local_specialist",
    label: "Local Text Specialist",
    description:
      "Agent-supervised offline preprocessing only: preliminary labels or source-complete verbatim extraction. Never use labels to discard evidence. Free-form summaries are unqualified and return the original text without inference. At most 32 calls per batch, 15 seconds each, no retries or fallback model. Failure returns the original source to the supervising agent. Suggestions require review; no planning, risk judgment, final approval, tools, network, training or trading authority.",
    parameters: Type.Object({
      task: Type.Union([
        Type.Literal("classify"),
        Type.Literal("extract"),
        Type.Literal("summarize"),
      ]),
      text: Type.String({ minLength: 1, maxLength: 4000 }),
      labels: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 60 }), { minItems: 2, maxItems: 12 }),
      ),
    }),
    execute: async (_callId, args, signal) => {
      signal?.throwIfAborted();
      const params = args as Record<string, unknown>;
      if (Object.keys(params).some((key) => !["task", "text", "labels"].includes(key))) {
        throw new ToolInputError("local specialist accepts only task, text and labels");
      }
      const task = readStringParam(params, "task", { required: true });
      if (task !== "classify" && task !== "extract" && task !== "summarize") {
        throw new ToolInputError("unknown local specialist task");
      }
      const text = readStringParam(params, "text", { required: true });
      const labels = Array.isArray(params.labels) ? params.labels : [];
      if (
        text.length > 4000 ||
        !labels.every(
          (item): item is string =>
            typeof item === "string" && item.length > 0 && item.length <= 60,
        ) ||
        labels.length > 12 ||
        (params.labels !== undefined && !Array.isArray(params.labels)) ||
        new Set(labels).size !== labels.length ||
        (task === "classify" && labels.length < 2)
      ) {
        throw new ToolInputError("bounded text and valid classification labels are required");
      }
      const id = randomUUID();
      const started = Date.now();
      let contractPassed = false;
      let value: Record<string, unknown> | undefined;
      let observation: ReturnType<
        NonNullable<ReturnType<typeof createLocalTextModelAdapter>["observe"]>
      >;
      let reason: string | undefined;
      let status: "completed_requires_review" | "fallback_to_agent" | "cancelled" =
        "fallback_to_agent";
      if (task === "summarize") {
        reason = "summary_not_qualified";
      } else if (disabled) {
        reason = "local_helper_disabled_after_failure";
      } else if (calls >= LOCAL_SPECIALIST_POLICY.maxCallsPerBatch) {
        reason = "local_call_budget_exhausted";
      } else {
        calls++;
        try {
          const modelPath = path.join(modelRoot, LOCAL_SPECIALIST_PROFILES[task].model);
          await fs.access(path.join(modelPath, "config.json"));
          const runtime = resolveLocalTextModelRuntimeConfig({
            adapterPath: "",
            baseModel: true,
            modelId: modelPath,
            pythonPath: options?.pythonPath,
            allowNetwork: false,
            maxTokens: LOCAL_SPECIALIST_POLICY.maxTokens,
            timeoutMs: LOCAL_SPECIALIST_POLICY.timeoutMs,
          });
          const adapter = (options?.adapterFactory ?? createResidentLocalTextAdapter)(runtime, {
            idPrefix: "local-specialist",
            capabilities: [task],
            buildPrompt: () => buildLocalSpecialistPrompt(task, text, labels),
          });
          const request = {
            callId: id,
            correlationId: id,
            taskId: task,
            role: "data_cleaning" as const,
            attempt: 1,
            provider: adapter.provider,
            modelId: adapter.modelId,
            payload: {},
          };
          const result = await adapter.invoke(request, signal ?? new AbortController().signal);
          observation = adapter.observe?.(request);
          if (signal?.aborted) {
            status = "cancelled";
            reason = "caller_cancelled";
          } else {
            value =
              result && typeof result === "object" && !Array.isArray(result)
                ? (result as Record<string, unknown>)
                : undefined;
            contractPassed =
              value !== undefined && validateLocalSpecialistOutput(task, value, text, labels);
            if (contractPassed) {
              status = "completed_requires_review";
            } else {
              reason = "output_invalid_or_source_coverage_incomplete";
              disabled = true;
            }
          }
        } catch {
          status = signal?.aborted ? "cancelled" : "fallback_to_agent";
          reason = signal?.aborted ? "caller_cancelled" : "local_inference_unavailable";
          disabled = true;
        }
      }
      const receipt = {
        boundary: "local_text_preprocessing_only",
        policyRevision: LOCAL_SPECIALIST_POLICY.revision,
        task,
        model: LOCAL_SPECIALIST_PROFILES[task].model,
        status,
        reason,
        elapsedMs: Date.now() - started,
        callsUsed: calls,
        rawContractPassed: contractPassed && !observation?.outputNormalization,
        observation,
        result: contractPassed ? value : undefined,
        source: { text, sha256: createHash("sha256").update(text).digest("hex") },
        nextAction:
          status === "completed_requires_review"
            ? "agent_review_against_source"
            : "agent_process_original_source",
        finalAuthority: false,
        reviewRequired: true,
        modelWeightAbsorbed: false,
        apiCalls: 0,
      };
      const receiptPath = path.join(workspace, "state", "local-specialist-runs", `${id}.json`);
      await fs.mkdir(path.dirname(receiptPath), { recursive: true });
      await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      if (status === "cancelled") {
        signal?.throwIfAborted();
      }
      return jsonResult({ ...receipt, receiptPath });
    },
  };
}

/** Agent-owned batches renew their budget; the resident inference service does not expire. */
export function createLocalSpecialistTool(
  options?: Parameters<typeof createLocalSpecialistItemTool>[0],
): AnyAgentTool {
  let active = false;
  return {
    name: "local_specialist",
    label: "Local Data Worker",
    description:
      "Agent-supervised local data batches. Supply text or records (not both). clean uses deterministic whitespace normalization and duplicate marking; classify supplies preliminary labels; extract requires source-complete quotes. Never discard records based on labels. Summarize is unqualified and returns source. Up to 32 records, 32000 total characters, 60 seconds per batch; MLX inference up to 15 seconds per item, no retries. Batches renew after completion. All model suggestions require agent review; no planning, risk judgment, execution or final-review authority.",
    parameters: Type.Object(
      {
        task: Type.Union([
          Type.Literal("clean"),
          Type.Literal("classify"),
          Type.Literal("extract"),
          Type.Literal("summarize"),
        ]),
        text: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
        records: Type.Optional(
          Type.Array(
            Type.Object(
              {
                id: Type.String({ minLength: 1, maxLength: 128 }),
                text: Type.String({ minLength: 1, maxLength: 4000 }),
              },
              { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 32 },
          ),
        ),
        labels: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 60 }), { minItems: 2, maxItems: 12 }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (callId, args, signal) => {
      signal?.throwIfAborted();
      const params = args as Record<string, unknown>;
      if (Object.keys(params).some((key) => !["task", "text", "records", "labels"].includes(key))) {
        throw new ToolInputError("local specialist accepts only task, text and labels or records");
      }
      const task = readStringParam(params, "task", { required: true });
      if (!["clean", "classify", "extract", "summarize"].includes(task)) {
        throw new ToolInputError("unknown local specialist task");
      }
      if ((params.text !== undefined) === (params.records !== undefined)) {
        throw new ToolInputError("provide text or records, not both");
      }
      const records = params.records ?? [{ id: "single", text: params.text }];
      if (
        !Array.isArray(records) ||
        records.length === 0 ||
        records.length > 32 ||
        records.some(
          (record: unknown) =>
            !record ||
            typeof record !== "object" ||
            !("id" in record) ||
            !("text" in record) ||
            Object.keys(record).some((key) => !["id", "text"].includes(key)) ||
            typeof record.id !== "string" ||
            !record.id.trim() ||
            record.id.length > 128 ||
            typeof record.text !== "string" ||
            !record.text.trim() ||
            record.text.length > 4000,
        )
      ) {
        throw new ToolInputError("bounded text and records required");
      }
      const items = records as Array<{ id: string; text: string }>;
      if (
        new Set(items.map((item) => item.id)).size !== items.length ||
        items.reduce((sum, item) => sum + item.text.length, 0) > 32_000
      ) {
        throw new ToolInputError("unique record IDs and bounded batch text required");
      }
      const labels = params.labels ?? [];
      if (
        !Array.isArray(labels) ||
        labels.some(
          (label: unknown) => typeof label !== "string" || !label.trim() || label.length > 60,
        ) ||
        labels.length > 12 ||
        new Set(labels).size !== labels.length ||
        (task === "classify" && labels.length < 2)
      ) {
        throw new ToolInputError("valid classification labels required");
      }
      if (active) {
        return jsonResult({
          status: "fallback_to_agent",
          reason: "local_batch_busy",
          records: items,
          finalAuthority: false,
        });
      }
      active = true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LOCAL_SPECIALIST_POLICY.batchTimeoutMs);
      const batchSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const tool = createLocalSpecialistItemTool(options);
      const results: Array<{ id: string; details: unknown }> = [];
      const seen = new Map<string, string>();
      try {
        for (const [index, item] of items.entries()) {
          signal?.throwIfAborted();
          if (task === "clean") {
            const normalized = item.text.replace(/\s+/gu, " ").trim();
            const duplicateOf = seen.get(normalized);
            if (!duplicateOf) {
              seen.set(normalized, item.id);
            }
            results.push({
              id: item.id,
              details: {
                status: "completed_deterministic",
                source: { text: item.text },
                result: { text: normalized, ...(duplicateOf ? { duplicateOf } : {}) },
                apiCalls: 0,
                modelCalls: 0,
                finalAuthority: false,
              },
            });
          } else if (controller.signal.aborted) {
            results.push({
              id: item.id,
              details: {
                status: "fallback_to_agent",
                reason: "batch_timeout",
                source: { text: item.text },
                finalAuthority: false,
              },
            });
          } else {
            try {
              const result = await tool.execute(
                `${callId}:${index}`,
                { task, text: item.text, labels },
                batchSignal,
              );
              results.push({ id: item.id, details: result.details });
            } catch (error) {
              signal?.throwIfAborted();
              if (!controller.signal.aborted) {
                throw error;
              }
              results.push({
                id: item.id,
                details: {
                  status: "fallback_to_agent",
                  reason: "batch_timeout",
                  source: { text: item.text },
                  finalAuthority: false,
                },
              });
            }
          }
        }
        if (params.records === undefined) {
          return jsonResult(results[0].details);
        }
        const fallbackCount = results.filter(
          ({ details }) =>
            details &&
            typeof details === "object" &&
            "status" in details &&
            details.status === "fallback_to_agent",
        ).length;
        const receipt = {
          status: fallbackCount ? "batch_partial" : "batch_completed",
          fallbackCount,
          policyRevision: LOCAL_SPECIALIST_POLICY.revision,
          task,
          results,
          inputCount: items.length,
          outputCount: results.length,
          sourceRecordsRetained: true,
          finalAuthority: false,
          reviewRequired: task !== "clean",
        };
        const receiptPath = path.join(
          resolveWorkspaceRoot(options?.workspaceDir),
          "state",
          "local-specialist-runs",
          `${randomUUID()}.json`,
        );
        await fs.mkdir(path.dirname(receiptPath), { recursive: true });
        await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        return jsonResult({ ...receipt, receiptPath });
      } finally {
        clearTimeout(timer);
        active = false;
      }
    },
  };
}

/** Both resident entries use this owner; missing optional weights degrade startup. */
export async function startLocalSpecialistService(): Promise<{ stop: () => Promise<void> }> {
  const modelId = path.join(
    os.homedir(),
    ".openclaw",
    "models",
    "local-specialists",
    LOCAL_SPECIALIST_PROFILES.classify.model,
  );
  await fs.access(path.join(modelId, "config.json"));
  const runtime = resolveLocalTextModelRuntimeConfig({
    adapterPath: "",
    baseModel: true,
    modelId,
    allowNetwork: false,
    maxTokens: LOCAL_SPECIALIST_POLICY.maxTokens,
    timeoutMs: LOCAL_SPECIALIST_POLICY.timeoutMs,
  });
  await fs.access(runtime.pythonPath);
  const worker = localTextWorker(runtime);
  worker.start();
  return { stop: () => worker.stop() };
}
