import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import {
  type AuthProfileCredential,
  type AuthProfileEligibilityReasonCode,
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveAuthProfileDisplayLabel,
  resolveAuthProfileEligibility,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import {
  getCustomProviderApiKey,
  resolveApiKeyForProvider,
  resolveEnvApiKey,
} from "../../agents/model-auth.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import {
  findNormalizedProviderValue,
  normalizeProviderId,
  parseModelRef,
} from "../../agents/model-selection.js";
import { ensureOpenClawModelsJson } from "../../agents/models-config.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelApi, ModelProviderConfig } from "../../config/types.models.js";
import { coerceSecretRef, normalizeSecretInputString } from "../../config/types.secrets.js";
import { type SecretRefResolveCache, resolveSecretRefString } from "../../secrets/resolve.js";
import { fetchWithTimeout } from "../../utils/fetch-timeout.js";
import { redactSecrets } from "../status-all/format.js";
import { DEFAULT_PROVIDER, formatMs } from "./shared.js";

export type AuthProbeStatus =
  | "ok"
  | "auth"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "format"
  | "unknown"
  | "no_model";

export type AuthProbeReasonCode =
  | "excluded_by_auth_order"
  | "missing_credential"
  | "expired"
  | "invalid_expires"
  | "unresolved_ref"
  | "ineligible_profile"
  | "no_model";

export type AuthProbeResult = {
  provider: string;
  model?: string;
  profileId?: string;
  label: string;
  source: "profile" | "env" | "models.json";
  mode?: string;
  probeKind?: "raw_provider";
  timeoutScope?: "raw_http_request";
  requestedTimeoutMs?: number;
  timedOut?: boolean;
  httpStatus?: number;
  status: AuthProbeStatus;
  reasonCode?: AuthProbeReasonCode;
  error?: string;
  latencyMs?: number;
};

type AuthProbeTarget = {
  provider: string;
  model?: { provider: string; model: string } | null;
  profileId?: string;
  label: string;
  source: "profile" | "env" | "models.json";
  mode?: string;
};

export type AuthProbeSummary = {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  totalTargets: number;
  options: {
    provider?: string;
    profileIds?: string[];
    timeoutMs: number;
    concurrency: number;
    maxTokens: number;
    probeStrategy: "raw_provider_preferred";
    timeoutScope: "per_target_total";
  };
  results: AuthProbeResult[];
};

export type AuthProbeOptions = {
  provider?: string;
  profileIds?: string[];
  timeoutMs: number;
  concurrency: number;
  maxTokens: number;
};

export function mapFailoverReasonToProbeStatus(reason?: string | null): AuthProbeStatus {
  if (!reason) {
    return "unknown";
  }
  if (reason === "auth" || reason === "auth_permanent") {
    // Keep probe output backward-compatible: permanent auth failures still
    // surface in the auth bucket instead of showing as unknown.
    return "auth";
  }
  if (reason === "rate_limit") {
    return "rate_limit";
  }
  if (reason === "billing") {
    return "billing";
  }
  if (reason === "timeout") {
    return "timeout";
  }
  if (reason === "format") {
    return "format";
  }
  return "unknown";
}

function buildCandidateMap(modelCandidates: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const raw of modelCandidates) {
    const parsed = parseModelRef(String(raw ?? ""), DEFAULT_PROVIDER);
    if (!parsed) {
      continue;
    }
    const list = map.get(parsed.provider) ?? [];
    if (!list.includes(parsed.model)) {
      list.push(parsed.model);
    }
    map.set(parsed.provider, list);
  }
  return map;
}

function selectProbeModel(params: {
  provider: string;
  candidates: Map<string, string[]>;
  catalog: Array<{ provider: string; id: string }>;
}): { provider: string; model: string } | null {
  const { provider, candidates, catalog } = params;
  const direct = candidates.get(provider);
  if (direct && direct.length > 0) {
    return { provider, model: direct[0] };
  }
  const fromCatalog = catalog.find((entry) => entry.provider === provider);
  if (fromCatalog) {
    return { provider: fromCatalog.provider, model: fromCatalog.id };
  }
  return null;
}

function mapEligibilityReasonToProbeReasonCode(
  reasonCode: AuthProfileEligibilityReasonCode,
): AuthProbeReasonCode {
  if (reasonCode === "missing_credential") {
    return "missing_credential";
  }
  if (reasonCode === "expired") {
    return "expired";
  }
  if (reasonCode === "invalid_expires") {
    return "invalid_expires";
  }
  if (reasonCode === "unresolved_ref") {
    return "unresolved_ref";
  }
  return "ineligible_profile";
}

function formatMissingCredentialProbeError(reasonCode: AuthProbeReasonCode): string {
  const legacyLine = "Auth profile credentials are missing or expired.";
  if (reasonCode === "expired") {
    return `${legacyLine}\n↳ Auth reason [expired]: token credentials are expired.`;
  }
  if (reasonCode === "invalid_expires") {
    return `${legacyLine}\n↳ Auth reason [invalid_expires]: token expires must be a positive Unix ms timestamp.`;
  }
  if (reasonCode === "missing_credential") {
    return `${legacyLine}\n↳ Auth reason [missing_credential]: no inline credential or SecretRef is configured.`;
  }
  if (reasonCode === "unresolved_ref") {
    return `${legacyLine}\n↳ Auth reason [unresolved_ref]: configured SecretRef could not be resolved.`;
  }
  return `${legacyLine}\n↳ Auth reason [ineligible_profile]: profile is incompatible with provider config.`;
}

function resolveProbeSecretRef(profile: AuthProfileCredential, cfg: OpenClawConfig) {
  const defaults = cfg.secrets?.defaults;
  if (profile.type === "api_key") {
    if (normalizeSecretInputString(profile.key) !== undefined) {
      return null;
    }
    return coerceSecretRef(profile.keyRef, defaults);
  }
  if (profile.type === "token") {
    if (normalizeSecretInputString(profile.token) !== undefined) {
      return null;
    }
    return coerceSecretRef(profile.tokenRef, defaults);
  }
  return null;
}

function formatUnresolvedRefProbeError(refLabel: string): string {
  const legacyLine = "Auth profile credentials are missing or expired.";
  return `${legacyLine}\n↳ Auth reason [unresolved_ref]: could not resolve SecretRef "${refLabel}".`;
}

function mapHttpStatusToProbeStatus(status: number): AuthProbeStatus {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 402) {
    return "billing";
  }
  if (status === 408 || status === 504) {
    return "timeout";
  }
  if (status === 429) {
    return "rate_limit";
  }
  if (status >= 400 && status < 500) {
    return "format";
  }
  return "unknown";
}

function isAbortLikeError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
      err.name === "TimeoutError" ||
      err.message.toLowerCase().includes("aborted"))
  );
}

type RawProviderProbeConfig = {
  api: Extract<ModelApi, "openai-completions" | "anthropic-messages">;
  baseUrl: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
};

async function loadProviderConfigs(params: {
  cfg: OpenClawConfig;
  agentDir: string;
}): Promise<Record<string, ModelProviderConfig>> {
  const merged: Record<string, ModelProviderConfig> = {
    ...params.cfg.models?.providers,
  };
  try {
    await ensureOpenClawModelsJson(params.cfg, params.agentDir);
    const raw = await fs.readFile(path.join(params.agentDir, "models.json"), "utf8");
    const parsed = JSON.parse(raw) as { providers?: Record<string, ModelProviderConfig> };
    for (const [provider, config] of Object.entries(parsed.providers ?? {})) {
      merged[provider] = config;
    }
  } catch {
    // A missing generated models.json should not break auth-status output; it only
    // disables the raw provider probe fallback for that target.
  }
  return merged;
}

async function resolveRawProviderProbeConfig(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  provider: string;
  modelId: string;
}): Promise<RawProviderProbeConfig | null> {
  const providers = await loadProviderConfigs({ cfg: params.cfg, agentDir: params.agentDir });
  const providerConfig =
    findNormalizedProviderValue(providers, params.provider) ??
    providers[normalizeProviderId(params.provider)] ??
    providers[params.provider];
  if (!providerConfig?.baseUrl) {
    return null;
  }
  const modelConfig = providerConfig.models?.find((entry) => entry.id === params.modelId);
  const api = modelConfig?.api ?? providerConfig.api;
  if (api !== "openai-completions" && api !== "anthropic-messages") {
    return null;
  }
  return {
    api,
    baseUrl: providerConfig.baseUrl,
    authHeader: providerConfig.authHeader,
    headers: {
      ...providerConfig.headers,
      ...modelConfig?.headers,
    },
  };
}

function appendEndpointPath(baseUrl: string, endpointPath: "chat/completions" | "messages") {
  return new URL(endpointPath, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href;
}

function normalizeAnthropicMessagesBaseUrl(baseUrl: string) {
  return /\/v1\/?$/iu.test(baseUrl.trim())
    ? baseUrl.trim()
    : baseUrl.trim().replace(/\/?$/u, "/v1");
}

async function runRawProviderProbe(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  target: AuthProbeTarget;
  model: { provider: string; model: string };
  timeoutMs: number;
}): Promise<AuthProbeResult | null> {
  const rawConfig = await resolveRawProviderProbeConfig({
    cfg: params.cfg,
    agentDir: params.agentDir,
    provider: params.target.provider,
    modelId: params.model.model,
  });
  if (!rawConfig) {
    return null;
  }

  const start = Date.now();
  const baseResult = {
    provider: params.target.provider,
    model: `${params.model.provider}/${params.model.model}`,
    profileId: params.target.profileId,
    label: params.target.label,
    source: params.target.source,
    mode: params.target.mode,
    probeKind: "raw_provider" as const,
    timeoutScope: "raw_http_request" as const,
    requestedTimeoutMs: params.timeoutMs,
  };

  try {
    const auth = await resolveApiKeyForProvider({
      provider: params.target.provider,
      cfg: params.cfg,
      profileId: params.target.profileId,
      agentDir: params.agentDir,
    });
    if (!auth.apiKey) {
      return {
        ...baseResult,
        timedOut: false,
        status: "auth",
        error: "No API key available for raw provider probe.",
        latencyMs: Date.now() - start,
      };
    }

    const endpoint =
      rawConfig.api === "anthropic-messages"
        ? appendEndpointPath(normalizeAnthropicMessagesBaseUrl(rawConfig.baseUrl), "messages")
        : appendEndpointPath(rawConfig.baseUrl, "chat/completions");
    const authHeaders: Record<string, string> =
      rawConfig.api === "anthropic-messages"
        ? rawConfig.authHeader
          ? { Authorization: `Bearer ${auth.apiKey}` }
          : { "x-api-key": auth.apiKey, "anthropic-version": "2023-06-01" }
        : { Authorization: `Bearer ${auth.apiKey}` };
    const body =
      rawConfig.api === "anthropic-messages"
        ? {
            model: params.model.model,
            max_tokens: 1,
            messages: [{ role: "user", content: "OK" }],
            stream: false,
          }
        : {
            model: params.model.model,
            messages: [{ role: "user", content: "OK" }],
            max_tokens: 1,
            stream: false,
          };
    const response = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
          ...rawConfig.headers,
        },
        body: JSON.stringify(body),
      },
      params.timeoutMs,
    );
    return {
      ...baseResult,
      timedOut: false,
      status: response.ok ? "ok" : mapHttpStatusToProbeStatus(response.status),
      httpStatus: response.status,
      error: response.ok ? undefined : `Raw provider probe returned HTTP ${response.status}.`,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      ...baseResult,
      timedOut: isAbortLikeError(err),
      status: isAbortLikeError(err) ? "timeout" : "unknown",
      error: redactSecrets(err instanceof Error ? err.message : String(err)),
      latencyMs: Date.now() - start,
    };
  }
}

async function maybeResolveUnresolvedRefIssue(params: {
  cfg: OpenClawConfig;
  profile?: AuthProfileCredential;
  cache: SecretRefResolveCache;
}): Promise<{ reasonCode: "unresolved_ref"; error: string } | null> {
  if (!params.profile) {
    return null;
  }
  const ref = resolveProbeSecretRef(params.profile, params.cfg);
  if (!ref) {
    return null;
  }
  try {
    await resolveSecretRefString(ref, {
      config: params.cfg,
      env: process.env,
      cache: params.cache,
    });
    return null;
  } catch {
    return {
      reasonCode: "unresolved_ref",
      error: formatUnresolvedRefProbeError(`${ref.source}:${ref.provider}:${ref.id}`),
    };
  }
}

export async function buildProbeTargets(params: {
  cfg: OpenClawConfig;
  providers: string[];
  modelCandidates: string[];
  options: AuthProbeOptions;
}): Promise<{ targets: AuthProbeTarget[]; results: AuthProbeResult[] }> {
  const { cfg, providers, modelCandidates, options } = params;
  const store = ensureAuthProfileStore();
  const providerFilter = options.provider?.trim();
  const providerFilterKey = providerFilter ? normalizeProviderId(providerFilter) : null;
  const profileFilter = new Set((options.profileIds ?? []).map((id) => id.trim()).filter(Boolean));
  const refResolveCache: SecretRefResolveCache = {};
  const catalog = await loadModelCatalog({ config: cfg });
  const candidates = buildCandidateMap(modelCandidates);
  const targets: AuthProbeTarget[] = [];
  const results: AuthProbeResult[] = [];

  for (const provider of providers) {
    const providerKey = normalizeProviderId(provider);
    if (providerFilterKey && providerKey !== providerFilterKey) {
      continue;
    }

    const model = selectProbeModel({
      provider: providerKey,
      candidates,
      catalog,
    });

    const profileIds = listProfilesForProvider(store, providerKey);
    const explicitOrder = (() => {
      return (
        findNormalizedProviderValue(store.order, providerKey) ??
        findNormalizedProviderValue(cfg?.auth?.order, providerKey)
      );
    })();
    const allowedProfiles =
      explicitOrder && explicitOrder.length > 0
        ? new Set(resolveAuthProfileOrder({ cfg, store, provider: providerKey }))
        : null;
    const filteredProfiles = profileFilter.size
      ? profileIds.filter((id) => profileFilter.has(id))
      : profileIds;

    if (filteredProfiles.length > 0) {
      for (const profileId of filteredProfiles) {
        const profile = store.profiles[profileId];
        const mode = profile?.type;
        const label = resolveAuthProfileDisplayLabel({ cfg, store, profileId });
        if (explicitOrder && !explicitOrder.includes(profileId)) {
          results.push({
            provider: providerKey,
            profileId,
            model: model ? `${model.provider}/${model.model}` : undefined,
            label,
            source: "profile",
            mode,
            status: "unknown",
            reasonCode: "excluded_by_auth_order",
            error: "Excluded by auth.order for this provider.",
          });
          continue;
        }
        if (allowedProfiles && !allowedProfiles.has(profileId)) {
          const eligibility = resolveAuthProfileEligibility({
            cfg,
            store,
            provider: providerKey,
            profileId,
          });
          const reasonCode = mapEligibilityReasonToProbeReasonCode(eligibility.reasonCode);
          results.push({
            provider: providerKey,
            model: model ? `${model.provider}/${model.model}` : undefined,
            profileId,
            label,
            source: "profile",
            mode,
            status: "unknown",
            reasonCode,
            error: formatMissingCredentialProbeError(reasonCode),
          });
          continue;
        }
        const unresolvedRefIssue = await maybeResolveUnresolvedRefIssue({
          cfg,
          profile,
          cache: refResolveCache,
        });
        if (unresolvedRefIssue) {
          results.push({
            provider: providerKey,
            model: model ? `${model.provider}/${model.model}` : undefined,
            profileId,
            label,
            source: "profile",
            mode,
            status: "unknown",
            reasonCode: unresolvedRefIssue.reasonCode,
            error: unresolvedRefIssue.error,
          });
          continue;
        }
        if (!model) {
          results.push({
            provider: providerKey,
            model: undefined,
            profileId,
            label,
            source: "profile",
            mode,
            status: "no_model",
            reasonCode: "no_model",
            error: "No model available for probe",
          });
          continue;
        }
        targets.push({
          provider: providerKey,
          model,
          profileId,
          label,
          source: "profile",
          mode,
        });
      }
      continue;
    }

    if (profileFilter.size > 0) {
      continue;
    }

    const envKey = resolveEnvApiKey(providerKey);
    const customKey = getCustomProviderApiKey(cfg, providerKey);
    if (!envKey && !customKey) {
      continue;
    }

    const label = envKey ? "env" : "models.json";
    const source = envKey ? "env" : "models.json";
    const mode = envKey?.source.includes("OAUTH_TOKEN") ? "oauth" : "api_key";

    if (!model) {
      results.push({
        provider: providerKey,
        model: undefined,
        label,
        source,
        mode,
        status: "no_model",
        reasonCode: "no_model",
        error: "No model available for probe",
      });
      continue;
    }

    targets.push({
      provider: providerKey,
      model,
      label,
      source,
      mode,
    });
  }

  return { targets, results };
}

export async function probeTarget(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  target: AuthProbeTarget;
  timeoutMs: number;
}): Promise<AuthProbeResult> {
  const { cfg, agentDir, target, timeoutMs } = params;
  if (!target.model) {
    return {
      provider: target.provider,
      model: undefined,
      profileId: target.profileId,
      label: target.label,
      source: target.source,
      mode: target.mode,
      status: "no_model",
      reasonCode: "no_model",
      error: "No model available for probe",
    };
  }
  const probeModel = target.model;

  const start = Date.now();
  const rawResult = await runRawProviderProbe({
    cfg,
    agentDir,
    target,
    model: probeModel,
    timeoutMs,
  });
  if (rawResult) {
    return rawResult;
  }

  return {
    provider: target.provider,
    model: `${probeModel.provider}/${probeModel.model}`,
    profileId: target.profileId,
    label: target.label,
    source: target.source,
    mode: target.mode,
    probeKind: "raw_provider",
    timeoutScope: "raw_http_request",
    requestedTimeoutMs: timeoutMs,
    timedOut: false,
    status: "unknown",
    error:
      "Raw provider probe is not available for this provider/api; embedded-agent probe is intentionally not used by models status.",
    latencyMs: Date.now() - start,
  };
}

async function runTargetsWithConcurrency(params: {
  cfg: OpenClawConfig;
  targets: AuthProbeTarget[];
  timeoutMs: number;
  maxTokens: number;
  concurrency: number;
  onProgress?: (update: { completed: number; total: number; label?: string }) => void;
}): Promise<AuthProbeResult[]> {
  const { cfg, targets, timeoutMs, onProgress } = params;
  const concurrency = Math.max(1, Math.min(targets.length || 1, params.concurrency));

  const agentDir = resolveOpenClawAgentDir();

  let completed = 0;
  const results: Array<AuthProbeResult | undefined> = Array.from({ length: targets.length });
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= targets.length) {
        return;
      }
      const target = targets[index];
      onProgress?.({
        completed,
        total: targets.length,
        label: `Probing ${target.provider}${target.profileId ? ` (${target.label})` : ""}`,
      });
      const result = await probeTarget({
        cfg,
        agentDir,
        target,
        timeoutMs,
      });
      results[index] = result;
      completed += 1;
      onProgress?.({ completed, total: targets.length });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return results.filter((entry): entry is AuthProbeResult => Boolean(entry));
}

export async function runAuthProbes(params: {
  cfg: OpenClawConfig;
  providers: string[];
  modelCandidates: string[];
  options: AuthProbeOptions;
  onProgress?: (update: { completed: number; total: number; label?: string }) => void;
}): Promise<AuthProbeSummary> {
  const startedAt = Date.now();
  const plan = await buildProbeTargets({
    cfg: params.cfg,
    providers: params.providers,
    modelCandidates: params.modelCandidates,
    options: params.options,
  });

  const totalTargets = plan.targets.length;
  params.onProgress?.({ completed: 0, total: totalTargets });

  const results = totalTargets
    ? await runTargetsWithConcurrency({
        cfg: params.cfg,
        targets: plan.targets,
        timeoutMs: params.options.timeoutMs,
        maxTokens: params.options.maxTokens,
        concurrency: params.options.concurrency,
        onProgress: params.onProgress,
      })
    : [];

  const finishedAt = Date.now();

  return {
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    totalTargets,
    options: {
      ...params.options,
      probeStrategy: "raw_provider_preferred",
      timeoutScope: "per_target_total",
    },
    results: [...plan.results, ...results],
  };
}

export function formatProbeLatency(latencyMs?: number | null) {
  if (!latencyMs && latencyMs !== 0) {
    return "-";
  }
  return formatMs(latencyMs);
}

export function groupProbeResults(results: AuthProbeResult[]): Map<string, AuthProbeResult[]> {
  const map = new Map<string, AuthProbeResult[]>();
  for (const result of results) {
    const list = map.get(result.provider) ?? [];
    list.push(result);
    map.set(result.provider, list);
  }
  return map;
}

export function sortProbeResults(results: AuthProbeResult[]): AuthProbeResult[] {
  return results.slice().toSorted((a, b) => {
    const provider = a.provider.localeCompare(b.provider);
    if (provider !== 0) {
      return provider;
    }
    const aLabel = a.label || a.profileId || "";
    const bLabel = b.label || b.profileId || "";
    return aLabel.localeCompare(bLabel);
  });
}

export function describeProbeSummary(summary: AuthProbeSummary): string {
  if (summary.totalTargets === 0) {
    return "No probe targets.";
  }
  return `Probed ${summary.totalTargets} auth target${summary.totalTargets === 1 ? "" : "s"} in ${formatMs(summary.durationMs)} (raw provider preferred)`;
}
