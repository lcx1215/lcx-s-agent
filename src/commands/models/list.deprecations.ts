import { modelKey } from "./shared.js";

const DEPRECATED_MODEL_REPLACEMENTS = new Map<string, string>([
  [
    modelKey("custom-api-deepseek-com", "deepseek-chat"),
    modelKey("custom-api-deepseek-com", "deepseek-v4-flash"),
  ],
  [
    modelKey("custom-api-deepseek-com", "deepseek-reasoner"),
    modelKey("custom-api-deepseek-com", "deepseek-v4-pro"),
  ],
]);

export function appendModelDeprecationTags(params: { key: string; tags: string[] }): string[] {
  const replacement = DEPRECATED_MODEL_REPLACEMENTS.get(params.key);
  if (!replacement) {
    return params.tags;
  }
  return [...params.tags, "deprecated", `replaced-by:${replacement}`];
}
