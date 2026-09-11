import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { FinanceWorkflowSlotModels } from "../agents/finance-model-workflow.js";
import { runLocalVisionVlm, LOW_MEMORY_LOCAL_VISION_MODEL } from "../agents/local-vision-vlm.js";
import { jsonResult, readStringParam, ToolInputError } from "../agents/tools/common.js";
import { createFinanceResearchRunTool } from "../agents/tools/finance-research-run-tool.js";
import { createLocalSpecialistTool } from "../agents/tools/local-specialist-tool.js";
import type { OpenClawPluginApi } from "./types.js";

export const LOCAL_MODEL_DUTIES = [
  {
    model: "Qwen3.5-2B-4bit",
    status: "active_preprocessing",
    duties: ["short_summary", "verbatim_extraction", "preliminary_classification"],
    finalAuthority: false,
  },
  {
    model: "Qwen3-VL-2B-Instruct-3bit",
    status: "active_vision",
    duties: ["image_reading", "chart_description"],
    finalAuthority: false,
  },
  {
    model: "Qwen3-VL-4B-Instruct-4bit",
    status: "manual_reserve",
    duties: ["vision_comparison_when_memory_allows"],
    finalAuthority: false,
  },
  {
    model: "Qwen3-0.6B",
    status: "training_experiment",
    duties: ["existing_isolated_lora_training", "contract_regression"],
    finalAuthority: false,
  },
  {
    model: "Qwen3.5-0.8B-4bit",
    status: "candidate_not_routed",
    duties: ["low_memory_comparison"],
    finalAuthority: false,
  },
  {
    model: "llama3.2:1b",
    status: "manual_reserve",
    duties: ["english_baseline_comparison"],
    finalAuthority: false,
  },
] as const;

function readSlots(config: Record<string, unknown> | undefined): FinanceWorkflowSlotModels {
  const value = config?.slotModels;
  if (!value || typeof value !== "object") {
    throw new Error("lcx-model-fleet requires explicit slotModels");
  }
  const slots = value as Record<string, unknown>;
  for (const key of ["fast", "reasoning", "review"]) {
    if (typeof slots[key] !== "string" || !slots[key].includes("/")) {
      throw new Error(`lcx-model-fleet requires a provider/model for ${key}`);
    }
  }
  if (slots.reasoning === slots.review) {
    throw new Error("lcx-model-fleet requires a distinct review model");
  }
  return {
    fast: String(slots.fast),
    reasoning: String(slots.reasoning),
    review: String(slots.review),
  };
}

async function installedVisionPath(): Promise<string> {
  const cache = path.join(
    os.homedir(),
    ".cache",
    "huggingface",
    "hub",
    `models--${LOW_MEMORY_LOCAL_VISION_MODEL.replaceAll("/", "--")}`,
  );
  const revision = (await fs.readFile(path.join(cache, "refs", "main"), "utf8")).trim();
  if (!/^[a-f0-9]{40}$/u.test(revision)) {
    throw new Error("invalid local vision snapshot revision");
  }
  return fs.realpath(path.join(cache, "snapshots", revision));
}

export default {
  id: "lcx-model-fleet",
  name: "LCX Model Fleet",
  description:
    "Persistent model duties and bounded local/model-workflow tools on the existing host.",
  register(api: OpenClawPluginApi) {
    const slotModels = readSlots(api.pluginConfig);
    const workspaceDir =
      api.config.agents?.defaults?.workspace ?? path.join(os.homedir(), ".openclaw", "workspace");
    const roster = () => ({
      boundary: "model_runtime_assignment_not_learning_proof",
      pid: process.pid,
      cloud: slotModels,
      local: LOCAL_MODEL_DUTIES,
      maxConcurrentLocalInference: 1,
      localWeightsResidentWhenIdle: false,
      reviewRequired: true,
      modelWeightAbsorbed: false,
    });
    api.registerTool((context) =>
      createLocalSpecialistTool({ workspaceDir: context.workspaceDir ?? workspaceDir }),
    );
    api.registerTool((context) =>
      createFinanceResearchRunTool({
        workspaceDir: context.workspaceDir ?? workspaceDir,
        config: context.config ?? api.config,
        slotModels,
      }),
    );
    api.registerTool({
      name: "lcx_model_roster",
      label: "Model Duties",
      description: "Inspect current model duties and execution boundaries without invoking models.",
      parameters: Type.Object({}),
      execute: async () => jsonResult(roster()),
    });
    api.registerTool({
      name: "local_vision",
      label: "Local Vision",
      description:
        "Read a supplied image using the installed low-memory vision model. Returns unverified observations for review; never makes trading decisions. Shares the local inference slot with text tools.",
      parameters: Type.Object({
        imageBase64: Type.String({ maxLength: 4_000_000 }),
        mimeType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg")]),
        prompt: Type.String({ minLength: 1, maxLength: 2000 }),
      }),
      execute: async (_id, args, signal) => {
        signal?.throwIfAborted();
        const params = args as Record<string, unknown>;
        const imageBase64 = readStringParam(params, "imageBase64", { required: true });
        const prompt = readStringParam(params, "prompt", { required: true });
        if (
          imageBase64.length > 4_000_000 ||
          prompt.length > 2000 ||
          !["image/png", "image/jpeg"].includes(String(params.mimeType))
        ) {
          throw new ToolInputError("bounded image and prompt required");
        }
        const result = await runLocalVisionVlm({
          modelId: await installedVisionPath(),
          images: [{ base64: imageBase64, mimeType: String(params.mimeType) }],
          prompt,
          maxTokens: 256,
          timeoutMs: 90_000,
          signal,
        });
        return jsonResult({ ...result, reviewRequired: true, apiCalls: 0 });
      },
    });
    api.on("before_prompt_build", async () => ({
      prependContext:
        "LCX model duties: use local_specialist for short supplied-text summaries, verbatim extraction and preliminary labels; do not discard sources based on labels. Use local_vision for supplied images. Use finance_research_run for finance workflow planning; live=true only when the user has authorized source/model calls. lcx_model_roster lists current assignments. Reserve and training models are not final decision authorities. Never claim model learning from tool execution.",
    }));
    api.registerService({
      id: "lcx-model-fleet",
      start: async () => {
        const checks = await Promise.allSettled([
          fs.access(
            path.join(
              os.homedir(),
              ".openclaw",
              "models",
              "local-specialists",
              "Qwen3.5-2B-4bit",
              "config.json",
            ),
          ),
          installedVisionPath(),
        ]);
        const target = path.join(workspaceDir, "state", "model-fleet-runtime.json");
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(
          target,
          JSON.stringify(
            {
              ...roster(),
              startedAt: new Date().toISOString(),
              installedLocalChecks: checks.map((check) => check.status),
              status: checks.every((check) => check.status === "fulfilled") ? "ready" : "degraded",
            },
            null,
            2,
          ) + "\n",
          { mode: 0o600 },
        );
        api.logger.info("lcx-model-fleet: persistent model duties and local tools loaded");
      },
    });
  },
};
