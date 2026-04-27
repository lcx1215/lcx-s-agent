import { resolveBuiltInDefaultModelRef } from "../../agents/defaults.js";
import {
  buildModelAliasIndex,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
import type { ConfiguredEntry } from "./list.types.js";
import { modelKey } from "./shared.js";

export function resolveConfiguredEntries(cfg: OpenClawConfig) {
  const builtInDefault = resolveBuiltInDefaultModelRef();
  const resolvedDefault = resolveConfiguredModelRef({
    cfg,
    defaultProvider: builtInDefault.provider,
    defaultModel: builtInDefault.model,
  });
  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: builtInDefault.provider,
  });
  const order: string[] = [];
  const tagsByKey = new Map<string, Set<string>>();
  const aliasesByKey = new Map<string, string[]>();

  for (const [key, aliases] of aliasIndex.byKey.entries()) {
    aliasesByKey.set(key, aliases);
  }

  const addEntry = (ref: { provider: string; model: string }, tag: string) => {
    const key = modelKey(ref.provider, ref.model);
    if (!tagsByKey.has(key)) {
      tagsByKey.set(key, new Set());
      order.push(key);
    }
    tagsByKey.get(key)?.add(tag);
  };

  addEntry(resolvedDefault, "default");

  const modelFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
  const imageFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel);
  const imagePrimary = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel) ?? "";

  modelFallbacks.forEach((raw, idx) => {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider: builtInDefault.provider,
      aliasIndex,
    });
    if (!resolved) {
      return;
    }
    addEntry(resolved.ref, `fallback#${idx + 1}`);
  });

  if (imagePrimary) {
    const resolved = resolveModelRefFromString({
      raw: imagePrimary,
      defaultProvider: builtInDefault.provider,
      aliasIndex,
    });
    if (resolved) {
      addEntry(resolved.ref, "image");
    }
  }

  imageFallbacks.forEach((raw, idx) => {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider: builtInDefault.provider,
      aliasIndex,
    });
    if (!resolved) {
      return;
    }
    addEntry(resolved.ref, `img-fallback#${idx + 1}`);
  });

  for (const key of Object.keys(cfg.agents?.defaults?.models ?? {})) {
    const parsed = parseModelRef(String(key ?? ""), builtInDefault.provider);
    if (!parsed) {
      continue;
    }
    addEntry(parsed, "configured");
  }

  const entries: ConfiguredEntry[] = order.map((key) => {
    const slash = key.indexOf("/");
    const provider = slash === -1 ? key : key.slice(0, slash);
    const model = slash === -1 ? "" : key.slice(slash + 1);
    return {
      key,
      ref: { provider, model },
      tags: tagsByKey.get(key) ?? new Set(),
      aliases: aliasesByKey.get(key) ?? [],
    } satisfies ConfiguredEntry;
  });

  return { entries };
}
