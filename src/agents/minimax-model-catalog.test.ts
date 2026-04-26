import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  MINIMAX_BUILTIN_DEFAULT_TEXT_MODEL_ID,
  resolveMinimaxDefaultTextModelId,
  resolveMinimaxTextModelCatalog,
} from "./minimax-model-catalog.js";

describe("minimax-model-catalog", () => {
  it("uses the built-in default when no override is set", async () => {
    await withEnvAsync({ OPENCLAW_MINIMAX_DEFAULT_MODEL: undefined }, async () => {
      expect(resolveMinimaxDefaultTextModelId()).toBe(MINIMAX_BUILTIN_DEFAULT_TEXT_MODEL_ID);
    });
  });

  it("prepends an override model when the default is not in the built-in catalog", async () => {
    await withEnvAsync({ OPENCLAW_MINIMAX_DEFAULT_MODEL: "MiniMax-M2.7" }, async () => {
      expect(resolveMinimaxDefaultTextModelId()).toBe("MiniMax-M2.7");
      expect(resolveMinimaxTextModelCatalog()[0]).toMatchObject({
        id: "MiniMax-M2.7",
        name: "MiniMax M2.7",
        reasoning: true,
      });
    });
  });
});
