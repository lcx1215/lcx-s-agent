import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveBuiltInDefaultModelReason, resolveBuiltInDefaultModelRef } from "./defaults.js";

describe("resolveBuiltInDefaultModelRef", () => {
  it("falls back to Anthropic when MiniMax credentials are absent", async () => {
    await withEnvAsync(
      {
        MINIMAX_API_KEY: undefined,
        MINIMAX_OAUTH_TOKEN: undefined,
        OPENCLAW_MINIMAX_DEFAULT_MODEL: undefined,
      },
      async () => {
        expect(resolveBuiltInDefaultModelRef()).toEqual({
          provider: "anthropic",
          model: "claude-opus-4-6",
        });
        expect(resolveBuiltInDefaultModelReason()).toBe("anthropic_fallback");
      },
    );
  });

  it("prefers MiniMax API when the API key exists", async () => {
    await withEnvAsync(
      {
        MINIMAX_API_KEY: "sk-minimax-test",
        MINIMAX_OAUTH_TOKEN: undefined,
        OPENCLAW_MINIMAX_DEFAULT_MODEL: "MiniMax-M2.7",
      },
      async () => {
        expect(resolveBuiltInDefaultModelRef()).toEqual({
          provider: "minimax",
          model: "MiniMax-M2.7",
        });
        expect(resolveBuiltInDefaultModelReason()).toBe("minimax_api_key");
      },
    );
  });

  it("falls back to MiniMax portal when only OAuth is available", async () => {
    await withEnvAsync(
      {
        MINIMAX_API_KEY: undefined,
        MINIMAX_OAUTH_TOKEN: "minimax-oauth-token",
        OPENCLAW_MINIMAX_DEFAULT_MODEL: undefined,
      },
      async () => {
        expect(resolveBuiltInDefaultModelRef()).toEqual({
          provider: "minimax-portal",
          model: "MiniMax-M2.7",
        });
        expect(resolveBuiltInDefaultModelReason()).toBe("minimax_oauth_token");
      },
    );
  });
});
