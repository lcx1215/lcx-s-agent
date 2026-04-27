import { resolveMinimaxDefaultTextModelId } from "./minimax-model-catalog.js";

// Defaults for agent metadata when upstream does not supply them.
// Anthropic remains the neutral built-in fallback when no better runtime
// signal exists, but MiniMax should win whenever the runtime is already
// configured with MiniMax credentials.
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-opus-4-6";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;

function hasConfiguredSecret(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function resolveBuiltInDefaultModelReason(
  env: NodeJS.ProcessEnv = process.env,
): "minimax_api_key" | "minimax_oauth_token" | "anthropic_fallback" {
  if (hasConfiguredSecret(env.MINIMAX_API_KEY)) {
    return "minimax_api_key";
  }
  if (hasConfiguredSecret(env.MINIMAX_OAUTH_TOKEN)) {
    return "minimax_oauth_token";
  }
  return "anthropic_fallback";
}

/**
 * Resolve the built-in runtime default model when config does not specify one.
 * Explicit config still wins everywhere; this only changes the empty-config
 * fallback so MiniMax-heavy environments stop silently defaulting to Anthropic.
 */
export function resolveBuiltInDefaultModelRef(env: NodeJS.ProcessEnv = process.env): {
  provider: string;
  model: string;
} {
  const reason = resolveBuiltInDefaultModelReason(env);
  if (reason !== "anthropic_fallback") {
    return {
      provider: reason === "minimax_api_key" ? "minimax" : "minimax-portal",
      model: resolveMinimaxDefaultTextModelId(),
    };
  }
  return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
}
