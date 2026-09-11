import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_VISION_MODEL,
  collapseRepeatedVisionText,
  isLocalVisionModelRef,
  LOCAL_VISION_MODEL_PROFILES,
  LOW_MEMORY_LOCAL_VISION_MODEL,
  LOCAL_VISION_MODEL_REF,
  resolveLocalVisionModelId,
  resolveLocalVisionRuntimeConfig,
} from "./local-vision-vlm.js";

describe("local vision VLM runtime", () => {
  it("keeps the MLX model and process contract deterministic", () => {
    expect(resolveLocalVisionRuntimeConfig({})).toEqual({
      enabled: false,
      pythonPath: expect.stringContaining(".openclaw/local-brain-trainer/.venv/bin/python"),
      model: DEFAULT_LOCAL_VISION_MODEL,
      timeoutMs: 180_000,
      maxTokens: 512,
    });
  });

  it("keeps a quality default and an explicit low-memory fallback profile", () => {
    expect(DEFAULT_LOCAL_VISION_MODEL).toBe("mlx-community/Qwen3-VL-4B-Instruct-4bit");
    expect(LOW_MEMORY_LOCAL_VISION_MODEL).toBe("mlx-community/Qwen3-VL-2B-Instruct-3bit");
    expect(LOCAL_VISION_MODEL_PROFILES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: DEFAULT_LOCAL_VISION_MODEL, role: "quality_default" }),
        expect.objectContaining({ id: LOW_MEMORY_LOCAL_VISION_MODEL, role: "low_memory_fallback" }),
      ]),
    );
  });

  it("accepts explicit local model refs without treating them as remote providers", () => {
    expect(isLocalVisionModelRef(LOCAL_VISION_MODEL_REF)).toBe(true);
    expect(isLocalVisionModelRef("mlx-vlm/Qwen3-VL-2B-Instruct-3bit")).toBe(true);
    expect(isLocalVisionModelRef("openai/gpt-5-mini")).toBe(false);
  });

  it("resolves the default model from environment without exposing credentials", () => {
    expect(resolveLocalVisionModelId("local", { LCX_LOCAL_VISION_MODEL: "local/model" })).toBe(
      "local/model",
    );
    expect(resolveLocalVisionModelId(undefined, {})).toBe(DEFAULT_LOCAL_VISION_MODEL);
  });

  it("rejects invalid numeric runtime overrides", () => {
    expect(
      resolveLocalVisionRuntimeConfig({
        LCX_LOCAL_VISION_ENABLED: "yes",
        LCX_LOCAL_VISION_TIMEOUT_MS: "0",
        LCX_LOCAL_VISION_MAX_TOKENS: "not-a-number",
      }),
    ).toMatchObject({ enabled: true, timeoutMs: 180_000, maxTokens: 512 });
  });

  it("collapses consecutive VLM repetition without changing distinct observations", () => {
    expect(collapseRepeatedVisionText("trend up. trend up. support 100.")).toBe(
      "trend up. support 100.",
    );
    expect(collapseRepeatedVisionText("- 1. 1.1\n- 2. 1.1\n- 3. 1.1")).toBe("- 1. 1.1");
    expect(
      collapseRepeatedVisionText(
        "The chart shows a thermostat. The system is used to adjust room temperature and the data is presented graphically. The system is used to control room temperature and the data is presented graphically.",
      ),
    ).toBe(
      "The chart shows a thermostat. The system is used to adjust room temperature and the data is presented graphically.",
    );
    expect(
      collapseRepeatedVisionText("The current return is 10%. The current return is 20%."),
    ).toBe("The current return is 10%. The current return is 20%.");
  });
});
