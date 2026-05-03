import fs from "node:fs";
import { isKnownCoreToolId } from "../agents/tool-catalog.js";
import { createGitHubProjectCapabilityIntakeTool } from "../agents/tools/github-project-capability-intake-tool.js";
import { resolveWorkspaceRoot } from "../agents/workspace-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import {
  languageBrainLoopSmokeCommand,
  type LanguageBrainLoopSmokeCommandOptions,
} from "./capabilities/language-brain-loop-smoke.js";
import { resolveConfiguredEntries } from "./models/list.configured.js";
import { loadModelsConfig } from "./models/load-config.js";

export type CapabilityState =
  | "unavailable"
  | "advertised"
  | "model_only"
  | "adapter_missing"
  | "adapter_implemented"
  | "configured"
  | "connected"
  | "live_verified"
  | "disabled"
  | "rejected";

export type CapabilitiesCommandOptions = {
  json?: boolean;
};

export type GitHubCapabilityIntakeCommandOptions = {
  repoName: string;
  repoUrl?: string;
  selectedFeature: string;
  projectSummary: string;
  evidenceSnippets?: string[];
  tags?: string[];
  requestedAdoptionMode?: string;
  writeReceipt?: boolean;
  json?: boolean;
};

export type { LanguageBrainLoopSmokeCommandOptions };
export { languageBrainLoopSmokeCommand };

export type ConfiguredModelCapabilitySurface = {
  provider: string;
  model: string;
  providerApi: string | null;
  defaultAgent: boolean;
  mode: "model_only" | "tool_backed" | "unavailable";
  tags: string[];
  aliases: string[];
  states: CapabilityState[];
  toolsConnected: string[];
};

export type ProviderNativeCapabilitySurface = {
  provider: string;
  capability: string;
  states: CapabilityState[];
  note?: string;
};

export type OpenClawToolCapabilitySurface = {
  tool: string;
  states: CapabilityState[];
  note?: string;
};

export type KnownCapabilityDescriptor = {
  label: string;
  providerCapability: string;
  aliases: string[];
  genericTool: string | null;
};

export type LobsterProtocolAnchorSurface = {
  path: string;
  present: boolean;
  states: CapabilityState[];
};

export type LobsterProtocolSurface = {
  defaultMode: "control_room_main_lane";
  executionSubstrate: {
    kind: "openclaw_embedded_agent";
    defaultModel: string | null;
    states: CapabilityState[];
  };
  lobsterOperatingLayer: {
    kind: "bundled_operating_layer";
    states: CapabilityState[];
    note: string;
  };
  lobsterWorkflowRuntime: {
    kind: "optional_plugin";
    enabledByPolicy: boolean;
    states: CapabilityState[];
    note: string;
  };
  sessionBoundaries: {
    dmScopeDefault: "main";
    states: CapabilityState[];
    note: string;
  };
  protectedAnchors: LobsterProtocolAnchorSurface[];
};

export type CapabilitySurfaceReport = {
  generatedAt: string;
  models: ConfiguredModelCapabilitySurface[];
  providerCapabilities: ProviderNativeCapabilitySurface[];
  openclawCapabilities: OpenClawToolCapabilitySurface[];
  lobsterProtocol: LobsterProtocolSurface;
  notes: string[];
};

export type LobsterProtocolSummaryLabels = {
  pluginEnabled?: string;
  pluginDisabled?: string;
};

type ProviderCapabilityDeclaration = {
  capability: string;
  note?: string;
  states: CapabilityState[];
};

const MOONSHOT_DECLARATIONS: ProviderCapabilityDeclaration[] = [
  {
    capability: "web-search",
    note: "provider-native official tool",
    states: ["advertised", "adapter_missing"],
  },
  {
    capability: "fetch",
    note: "provider-native official tool",
    states: ["advertised", "adapter_missing"],
  },
  {
    capability: "memory",
    note: "provider-native official tool",
    states: ["advertised", "adapter_missing"],
  },
  {
    capability: "excel",
    note: "provider-native official tool",
    states: ["advertised", "adapter_missing"],
  },
  {
    capability: "date",
    note: "provider-native official tool",
    states: ["advertised", "adapter_missing"],
  },
  {
    capability: "quickjs",
    note: "provider-native official tool",
    states: ["advertised", "adapter_missing"],
  },
  {
    capability: "code_runner",
    note: "provider-native official tool",
    states: ["advertised", "adapter_missing"],
  },
  {
    capability: "rethink",
    note: "provider-native official tool",
    states: ["advertised", "adapter_missing"],
  },
];

const OPENAI_DECLARATIONS: ProviderCapabilityDeclaration[] = [
  {
    capability: "web_search",
    note: "Responses built-in tool",
    states: ["advertised", "adapter_missing"],
  },
  {
    capability: "file_search",
    note: "Responses built-in tool",
    states: ["advertised", "adapter_missing"],
  },
  {
    capability: "code_interpreter",
    note: "Responses built-in tool",
    states: ["advertised", "adapter_missing"],
  },
  {
    capability: "remote_mcp",
    note: "Responses built-in tool",
    states: ["advertised", "adapter_missing"],
  },
  {
    capability: "computer_use",
    note: "Responses built-in tool",
    states: ["advertised", "adapter_missing"],
  },
];

const MINIMAX_DECLARATIONS: ProviderCapabilityDeclaration[] = [
  {
    capability: "web_search_mcp",
    note: "official MCP surface only",
    states: ["advertised", "adapter_missing"],
  },
  {
    capability: "understand_image_mcp",
    note: "official MCP surface only",
    states: ["advertised", "adapter_missing"],
  },
];

const DEEPSEEK_DECLARATIONS: ProviderCapabilityDeclaration[] = [
  {
    capability: "function_calling",
    note: "tool execution remains user-provided",
    states: ["advertised", "adapter_missing"],
  },
];

const OPENCLAW_GENERIC_TOOLS: Array<{ tool: string; note: string }> = [
  { tool: "web_search", note: "generic OpenClaw web tool; not provider-native" },
  { tool: "web_fetch", note: "generic OpenClaw web fetch tool; not provider-native" },
  { tool: "memory_search", note: "generic OpenClaw memory recall tool; not provider-native" },
];

const PROVIDER_CAPABILITY_TO_GENERIC_TOOL: Record<string, string> = {
  "web-search": "web_search",
  web_search: "web_search",
  fetch: "web_fetch",
  memory: "memory_search",
};

const LOBSTER_PROTECTED_ANCHORS = [
  "memory/current-research-line.md",
  "memory/unified-risk-view.md",
  "MEMORY.md",
] as const;

function uniqueStates(states: CapabilityState[]): CapabilityState[] {
  return Array.from(new Set(states));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isDeepseekLikeProvider(params: { providerId: string; cfg: OpenClawConfig }): boolean {
  if (params.providerId === "deepseek" || params.providerId.includes("deepseek")) {
    return true;
  }
  const models = params.cfg.models?.providers?.[params.providerId]?.models ?? [];
  return models.some((entry) => entry.id.toLowerCase().includes("deepseek"));
}

function resolveProviderCapabilityDeclarations(params: {
  providerId: string;
  cfg: OpenClawConfig;
}): ProviderCapabilityDeclaration[] {
  if (params.providerId === "moonshot") {
    return MOONSHOT_DECLARATIONS;
  }
  if (params.providerId === "openai") {
    return OPENAI_DECLARATIONS;
  }
  if (params.providerId === "minimax" || params.providerId === "minimax-portal") {
    return MINIMAX_DECLARATIONS;
  }
  if (isDeepseekLikeProvider(params)) {
    return DEEPSEEK_DECLARATIONS;
  }
  return [];
}

function buildKnownCapabilityDescriptors(): KnownCapabilityDescriptor[] {
  const declarations = [
    ...MOONSHOT_DECLARATIONS,
    ...OPENAI_DECLARATIONS,
    ...MINIMAX_DECLARATIONS,
    ...DEEPSEEK_DECLARATIONS,
  ];
  const seen = new Set<string>();
  const descriptors: KnownCapabilityDescriptor[] = [];
  for (const declaration of declarations) {
    if (seen.has(declaration.capability)) {
      continue;
    }
    seen.add(declaration.capability);
    descriptors.push({
      label: declaration.capability,
      providerCapability: declaration.capability,
      aliases: uniqueStrings([
        declaration.capability,
        declaration.capability.replaceAll("_", " "),
        declaration.capability.replaceAll("-", " "),
      ]),
      genericTool: PROVIDER_CAPABILITY_TO_GENERIC_TOOL[declaration.capability] ?? null,
    });
  }
  return descriptors;
}

const KNOWN_CAPABILITY_DESCRIPTORS = buildKnownCapabilityDescriptors();

export function listKnownCapabilityDescriptors(): KnownCapabilityDescriptor[] {
  return KNOWN_CAPABILITY_DESCRIPTORS.map((entry) => ({
    ...entry,
    aliases: [...entry.aliases],
  }));
}

export function resolveKnownCapabilityDescriptor(text: string): KnownCapabilityDescriptor | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  for (const descriptor of KNOWN_CAPABILITY_DESCRIPTORS) {
    if (descriptor.aliases.some((alias) => normalized.includes(alias))) {
      return {
        ...descriptor,
        aliases: [...descriptor.aliases],
      };
    }
  }
  return null;
}

function buildProviderCapabilitySurfaces(cfg: OpenClawConfig): ProviderNativeCapabilitySurface[] {
  const providers = Object.keys(cfg.models?.providers ?? {})
    .map((value) => value.trim())
    .filter(Boolean)
    .toSorted((a, b) => a.localeCompare(b));
  const surfaces: ProviderNativeCapabilitySurface[] = [];
  for (const provider of providers) {
    for (const declaration of resolveProviderCapabilityDeclarations({
      providerId: provider,
      cfg,
    })) {
      surfaces.push({
        provider,
        capability: declaration.capability,
        states: uniqueStates(declaration.states),
        note: declaration.note,
      });
    }
  }
  return surfaces;
}

function buildOpenClawToolCapabilitySurfaces(): OpenClawToolCapabilitySurface[] {
  return OPENCLAW_GENERIC_TOOLS.filter((entry) => isKnownCoreToolId(entry.tool)).map((entry) => ({
    tool: entry.tool,
    states: ["adapter_implemented", "connected"],
    note: entry.note,
  }));
}

function collectConfiguredToolNames(cfg: OpenClawConfig): string[] {
  const collected = new Set<string>();
  const addNames = (values?: string[]) => {
    for (const value of values ?? []) {
      const normalized = value.trim();
      if (normalized) {
        collected.add(normalized);
      }
    }
  };
  addNames(cfg.tools?.allow);
  addNames(cfg.tools?.alsoAllow);
  for (const agent of cfg.agents?.list ?? []) {
    addNames(agent?.tools?.allow);
    addNames(agent?.tools?.alsoAllow);
  }
  return [...collected];
}

function resolveDefaultModelRef(cfg: OpenClawConfig): string | null {
  const primary = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model);
  if (primary) {
    return primary;
  }
  const entries = resolveConfiguredEntries(cfg).entries;
  const defaultEntry = entries.find((entry) => entry.tags.has("default"));
  return defaultEntry ? `${defaultEntry.ref.provider}/${defaultEntry.ref.model}` : null;
}

export function buildLobsterProtocolSurface(cfg: OpenClawConfig): LobsterProtocolSurface {
  const workspaceDir = resolveWorkspaceRoot(cfg.agents?.defaults?.workspace);
  const configuredTools = collectConfiguredToolNames(cfg).map((value) => value.toLowerCase());
  const lobsterPluginEnabled = configuredTools.includes("lobster");
  return {
    defaultMode: "control_room_main_lane",
    executionSubstrate: {
      kind: "openclaw_embedded_agent",
      defaultModel: resolveDefaultModelRef(cfg),
      states: ["configured", "connected"],
    },
    lobsterOperatingLayer: {
      kind: "bundled_operating_layer",
      states: ["adapter_implemented", "connected"],
      note: "protected summaries, learning carryover, and workface surfaces are part of the default repo workflow",
    },
    lobsterWorkflowRuntime: {
      kind: "optional_plugin",
      enabledByPolicy: lobsterPluginEnabled,
      states: lobsterPluginEnabled
        ? ["adapter_implemented", "configured"]
        : ["adapter_implemented", "disabled"],
      note: "lobster plugin tool remains optional and requires explicit allowlisting",
    },
    sessionBoundaries: {
      dmScopeDefault: "main",
      states: ["configured"],
      note: "DMs reuse the main session unless routing overrides dmScope",
    },
    protectedAnchors: LOBSTER_PROTECTED_ANCHORS.map((anchorPath) => {
      const present = fs.existsSync(`${workspaceDir}/${anchorPath}`);
      return {
        path: anchorPath,
        present,
        states: present ? ["configured"] : ["unavailable"],
      };
    }),
  };
}

export function formatLobsterProtocolSummary(
  protocol: LobsterProtocolSurface,
  labels?: LobsterProtocolSummaryLabels,
): string {
  const anchorsPresent = protocol.protectedAnchors.filter((anchor) => anchor.present).length;
  const anchorsTotal = protocol.protectedAnchors.length;
  const pluginState = protocol.lobsterWorkflowRuntime.enabledByPolicy
    ? (labels?.pluginEnabled ?? "plugin on")
    : (labels?.pluginDisabled ?? "plugin optional");
  return [
    protocol.defaultMode,
    protocol.executionSubstrate.kind,
    pluginState,
    `dm=${protocol.sessionBoundaries.dmScopeDefault}`,
    `anchors ${anchorsPresent}/${anchorsTotal}`,
  ].join(" · ");
}

export function formatLobsterProtocolDetailLines(protocol: LobsterProtocolSurface): string[] {
  return [
    `- defaultMode: ${protocol.defaultMode}`,
    `  executionSubstrate: ${protocol.executionSubstrate.kind} (${protocol.executionSubstrate.states.join(", ")})`,
    `  defaultModel: ${protocol.executionSubstrate.defaultModel ?? "unknown"}`,
    `  lobsterOperatingLayer: ${protocol.lobsterOperatingLayer.states.join(", ")} (${protocol.lobsterOperatingLayer.note})`,
    `  lobsterWorkflowRuntime: ${protocol.lobsterWorkflowRuntime.states.join(", ")} (${protocol.lobsterWorkflowRuntime.note})`,
    `  enabledByPolicy: ${protocol.lobsterWorkflowRuntime.enabledByPolicy ? "true" : "false"}`,
    `  dmScopeDefault: ${protocol.sessionBoundaries.dmScopeDefault} (${protocol.sessionBoundaries.note})`,
    "  protectedAnchors:",
    ...protocol.protectedAnchors.map(
      (anchor) =>
        `  - ${anchor.path}: ${anchor.present ? "present" : "missing"} (${anchor.states.join(", ")})`,
    ),
  ];
}

function buildConfiguredModelSurfaces(params: {
  cfg: OpenClawConfig;
  providerCapabilities: ProviderNativeCapabilitySurface[];
}): ConfiguredModelCapabilitySurface[] {
  const connectedCapabilitiesByProvider = new Map<string, string[]>();
  for (const capability of params.providerCapabilities) {
    if (!capability.states.includes("connected")) {
      continue;
    }
    const list = connectedCapabilitiesByProvider.get(capability.provider) ?? [];
    list.push(capability.capability);
    connectedCapabilitiesByProvider.set(capability.provider, list);
  }
  return resolveConfiguredEntries(params.cfg).entries.map((entry) => {
    const providerConfig = params.cfg.models?.providers?.[entry.ref.provider];
    const toolsConnected = connectedCapabilitiesByProvider.get(entry.ref.provider) ?? [];
    const configured = Boolean(providerConfig);
    return {
      provider: entry.ref.provider,
      model: entry.ref.model,
      providerApi: providerConfig?.api ?? null,
      defaultAgent: entry.tags.has("default"),
      mode: configured ? (toolsConnected.length > 0 ? "tool_backed" : "model_only") : "unavailable",
      tags: [...entry.tags].toSorted((a, b) => a.localeCompare(b)),
      aliases: [...entry.aliases].toSorted((a, b) => a.localeCompare(b)),
      states: uniqueStates(
        configured
          ? ["configured", toolsConnected.length > 0 ? "connected" : "model_only"]
          : ["unavailable"],
      ),
      toolsConnected,
    };
  });
}

export function buildCapabilitySurfaceReport(cfg: OpenClawConfig): CapabilitySurfaceReport {
  const providerCapabilities = buildProviderCapabilitySurfaces(cfg);
  const models = buildConfiguredModelSurfaces({ cfg, providerCapabilities });
  const openclawCapabilities = buildOpenClawToolCapabilitySurfaces();
  const lobsterProtocol = buildLobsterProtocolSurface(cfg);
  return {
    generatedAt: new Date().toISOString(),
    models,
    providerCapabilities,
    openclawCapabilities,
    lobsterProtocol,
    notes: [
      "configured model does not imply provider-native tools are connected",
      "provider-advertised capabilities remain adapter_missing until OpenClaw implements and wires them",
      "live_verified is never claimed here without explicit runtime evidence",
      "generic OpenClaw tools are listed separately from provider-native capabilities",
      "the Lobster operating layer is distinct from the optional lobster workflow plugin runtime",
    ],
  };
}

export type CapabilityRunFooterParams = {
  provider: string;
  model: string;
  toolsActuallyCalled?: string[];
  sourceCount?: number;
  liveVerified?: boolean;
};

export function formatCapabilityRunFooter(params: CapabilityRunFooterParams): string {
  const tools = (params.toolsActuallyCalled ?? []).filter(Boolean);
  const mode = tools.length > 0 ? "tool-backed" : "model-only";
  const toolLabel = tools.length > 0 ? tools.join("/") : "none";
  const suffixes: string[] = [];
  if (typeof params.sourceCount === "number" && Number.isFinite(params.sourceCount)) {
    suffixes.push(`sources=${params.sourceCount}`);
  }
  if (params.liveVerified) {
    suffixes.push("live");
  }
  const tail = suffixes.length > 0 ? ` · ${suffixes.join(" · ")}` : "";
  return `model=${params.provider}/${params.model} · mode=${mode} · tools=${toolLabel}${tail}`;
}

function formatCapabilitySurfaceText(report: CapabilitySurfaceReport): string {
  const lines: string[] = [];
  lines.push("OpenClaw live capability surface");
  lines.push("");
  lines.push("Models:");
  if (report.models.length === 0) {
    lines.push("- none");
  }
  for (const model of report.models) {
    lines.push(`- ${model.provider} / ${model.model}`);
    lines.push(`  state: ${model.mode}`);
    lines.push(`  providerApi: ${model.providerApi ?? "unknown"}`);
    lines.push(`  defaultAgent: ${model.defaultAgent ? "true" : "false"}`);
    lines.push(`  tags: ${model.tags.length > 0 ? model.tags.join(", ") : "none"}`);
    lines.push(`  aliases: ${model.aliases.length > 0 ? model.aliases.join(", ") : "none"}`);
    lines.push(
      `  toolsConnected: ${model.toolsConnected.length > 0 ? model.toolsConnected.join(", ") : "none"}`,
    );
    lines.push(`  states: ${model.states.join(", ")}`);
  }
  lines.push("");
  lines.push("Provider-native capabilities:");
  if (report.providerCapabilities.length === 0) {
    lines.push("- none");
  }
  for (const capability of report.providerCapabilities) {
    const note = capability.note ? ` (${capability.note})` : "";
    lines.push(
      `- ${capability.provider}/${capability.capability}: ${capability.states.join(", ")}${note}`,
    );
  }
  lines.push("");
  lines.push("OpenClaw generic tools:");
  if (report.openclawCapabilities.length === 0) {
    lines.push("- none");
  }
  for (const capability of report.openclawCapabilities) {
    const note = capability.note ? ` (${capability.note})` : "";
    lines.push(`- ${capability.tool}: ${capability.states.join(", ")}${note}`);
  }
  lines.push("");
  lines.push("Lobster operating protocol:");
  lines.push(...formatLobsterProtocolDetailLines(report.lobsterProtocol));
  lines.push("");
  lines.push("Notes:");
  for (const note of report.notes) {
    lines.push(`- ${note}`);
  }
  return lines.join("\n");
}

export async function capabilitiesCommand(
  opts: CapabilitiesCommandOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await loadModelsConfig({ commandName: "capabilities", runtime });
  const report = buildCapabilitySurfaceReport(cfg);
  runtime.log(opts.json ? JSON.stringify(report, null, 2) : formatCapabilitySurfaceText(report));
}

function displayScalar(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function formatGitHubCapabilityIntakeText(payload: Record<string, unknown>): string {
  const decision =
    typeof payload.adoptionDecision === "object" && payload.adoptionDecision !== null
      ? (payload.adoptionDecision as Record<string, unknown>)
      : {};
  const embryos = Array.isArray(payload.existingEmbryos)
    ? payload.existingEmbryos.filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      )
    : [];
  const safetyBlockers = Array.isArray(payload.safetyBlockers)
    ? payload.safetyBlockers.filter((item): item is string => typeof item === "string")
    : [];
  const lines: string[] = [];
  lines.push("GitHub project capability intake");
  lines.push("");
  lines.push(`Repo: ${displayScalar(payload.repoName, "unknown")}`);
  lines.push(`Feature: ${displayScalar(payload.selectedFeature, "unknown")}`);
  lines.push(`Capability family: ${displayScalar(payload.capabilityFamily, "unknown")}`);
  lines.push(`Decision: ${displayScalar(decision.status, "unknown")}`);
  lines.push(`Adoption target: ${displayScalar(decision.target, "unknown")}`);
  lines.push(`Safety blockers: ${safetyBlockers.length ? safetyBlockers.join(", ") : "none"}`);
  lines.push("");
  lines.push("Existing LCX Agent embryos:");
  if (embryos.length === 0) {
    lines.push("- none");
  }
  for (const embryo of embryos) {
    lines.push(
      `- ${displayScalar(embryo.surface, "unknown")}: ${displayScalar(embryo.path, "unknown")} (${displayScalar(embryo.fit, "unknown")})`,
    );
  }
  lines.push("");
  lines.push(`Next patch: ${displayScalar(payload.nextPatch, "none")}`);
  if (typeof payload.receiptPath === "string" && payload.receiptPath) {
    lines.push(`Receipt: ${payload.receiptPath}`);
  }
  lines.push("");
  lines.push("Boundaries:");
  lines.push("- noRemoteFetchOccurred: true");
  lines.push("- noCodeExecutionOccurred: true");
  lines.push("- liveTouched: false");
  lines.push("- protectedMemoryTouched: false");
  return lines.join("\n");
}

export async function githubCapabilityIntakeCommand(
  opts: GitHubCapabilityIntakeCommandOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await loadModelsConfig({ commandName: "capabilities github-intake", runtime });
  const workspaceDir = resolveWorkspaceRoot(cfg.agents?.defaults?.workspace);
  const tool = createGitHubProjectCapabilityIntakeTool({ workspaceDir });
  const result = await tool.execute("cli-github-capability-intake", {
    repoName: opts.repoName,
    repoUrl: opts.repoUrl,
    selectedFeature: opts.selectedFeature,
    projectSummary: opts.projectSummary,
    evidenceSnippets: opts.evidenceSnippets ?? [],
    tags: opts.tags ?? [],
    requestedAdoptionMode: opts.requestedAdoptionMode ?? "auto",
    writeReceipt: opts.writeReceipt === true,
  });
  const payload =
    typeof result.details === "object" && result.details !== null
      ? (result.details as Record<string, unknown>)
      : {};
  runtime.log(
    opts.json ? JSON.stringify(payload, null, 2) : formatGitHubCapabilityIntakeText(payload),
  );
}
