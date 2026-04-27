import type { OpenClawConfig } from "../../config/config.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "../auth-profiles.js";
import { resolveBuiltInDefaultModelRef } from "../defaults.js";
import { resolveEnvApiKey } from "../model-auth.js";
import { resolveConfiguredModelRef } from "../model-selection.js";

export function resolveDefaultModelRef(cfg?: OpenClawConfig): { provider: string; model: string } {
  const builtInDefault = resolveBuiltInDefaultModelRef();
  if (cfg) {
    const resolved = resolveConfiguredModelRef({
      cfg,
      defaultProvider: builtInDefault.provider,
      defaultModel: builtInDefault.model,
    });
    return { provider: resolved.provider, model: resolved.model };
  }
  return builtInDefault;
}

export function hasAuthForProvider(params: { provider: string; agentDir: string }): boolean {
  if (resolveEnvApiKey(params.provider)?.apiKey) {
    return true;
  }
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  return listProfilesForProvider(store, params.provider).length > 0;
}
