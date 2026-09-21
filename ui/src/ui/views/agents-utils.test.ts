import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../../../../src/agents/pi-tools.types.js";
import { pickSandboxToolPolicy } from "../../../../src/agents/sandbox-tool-policy.js";
import { listCoreToolSections } from "../../../../src/agents/tool-catalog.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "../../../../src/agents/tool-policy-pipeline.js";
import { resolveToolProfilePolicy } from "../../../../src/agents/tool-policy-shared.js";
import { mergeAlsoAllowPolicy } from "../../../../src/agents/tool-policy.js";
import {
  buildToolAccessSteps,
  isToolEnabledBySteps,
  resolveConfiguredCronModelSuggestions,
  resolveEffectiveModelFallbacks,
  sortLocaleStrings,
} from "./agents-utils.ts";

describe("resolveEffectiveModelFallbacks", () => {
  it("inherits defaults when no entry fallbacks are configured", () => {
    const entryModel = undefined;
    const defaultModel = {
      primary: "openai/gpt-5-nano",
      fallbacks: ["google/gemini-2.0-flash"],
    };

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toEqual([
      "google/gemini-2.0-flash",
    ]);
  });

  it("prefers entry fallbacks over defaults", () => {
    const entryModel = {
      primary: "openai/gpt-5-mini",
      fallbacks: ["openai/gpt-5-nano"],
    };
    const defaultModel = {
      primary: "openai/gpt-5",
      fallbacks: ["google/gemini-2.0-flash"],
    };

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toEqual(["openai/gpt-5-nano"]);
  });

  it("keeps explicit empty entry fallback lists", () => {
    const entryModel = {
      primary: "openai/gpt-5-mini",
      fallbacks: [],
    };
    const defaultModel = {
      primary: "openai/gpt-5",
      fallbacks: ["google/gemini-2.0-flash"],
    };

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toEqual([]);
  });
});

describe("resolveConfiguredCronModelSuggestions", () => {
  it("collects defaults primary/fallbacks, alias map keys, and per-agent model entries", () => {
    const result = resolveConfiguredCronModelSuggestions({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.2",
            fallbacks: ["google/gemini-2.5-pro", "openai/gpt-5.2-mini"],
          },
          models: {
            "anthropic/claude-sonnet-4-5": { alias: "smart" },
            "openai/gpt-5.2": { alias: "main" },
          },
        },
        list: {
          writer: {
            model: { primary: "xai/grok-4", fallbacks: ["openai/gpt-5.2-mini"] },
          },
          planner: {
            model: "google/gemini-2.5-flash",
          },
        },
      },
    });

    expect(result).toEqual([
      "anthropic/claude-sonnet-4-5",
      "google/gemini-2.5-flash",
      "google/gemini-2.5-pro",
      "openai/gpt-5.2",
      "openai/gpt-5.2-mini",
      "xai/grok-4",
    ]);
  });

  it("returns empty array for invalid or missing config shape", () => {
    expect(resolveConfiguredCronModelSuggestions(null)).toEqual([]);
    expect(resolveConfiguredCronModelSuggestions({})).toEqual([]);
    expect(resolveConfiguredCronModelSuggestions({ agents: { defaults: { model: "" } } })).toEqual(
      [],
    );
  });
});

describe("sortLocaleStrings", () => {
  it("sorts values using localeCompare without relying on Array.prototype.toSorted", () => {
    expect(sortLocaleStrings(["z", "b", "a"])).toEqual(["a", "b", "z"]);
  });

  it("accepts any iterable input, including sets", () => {
    expect(sortLocaleStrings(new Set(["beta", "alpha"]))).toEqual(["alpha", "beta"]);
  });
});

/**
 * The Tool Access panel only *displays* access; the server enforces it. When the
 * two disagree, an operator reads a restriction that is not in effect — or a
 * grant that does not exist. These tests pin the panel's composition to the
 * server's own pipeline, using that pipeline as the oracle.
 */
describe("tool access display matches the enforced pipeline", () => {
  const TOOL_IDS = Array.from(
    new Set([
      ...listCoreToolSections().flatMap((section) => section.tools.map((tool) => tool.id)),
      "exec",
      "bash",
      "apply_patch",
      "gateway",
      "cron",
      "sessions_send",
      "whatsapp_login",
    ]),
  );

  type PolicyConfig = {
    profile?: string;
    allow?: string[];
    alsoAllow?: string[];
    deny?: string[];
  };
  type Case = { agentTools?: PolicyConfig; globalTools?: PolicyConfig };

  /** The panel reads the profile from `agents.<id>.tools.profile` then `tools.profile`. */
  function caseProfile(testCase: Case): string | undefined {
    return testCase.agentTools?.profile ?? testCase.globalTools?.profile;
  }

  /** Oracle: the server's own pipeline, composed exactly as pi-tools.ts does. */
  function serverEnabled(toolName: string, testCase: Case): boolean {
    const profile = caseProfile(testCase);
    const profilePolicy = resolveToolProfilePolicy(profile);
    const profileAlsoAllow = Array.isArray(testCase.agentTools?.alsoAllow)
      ? testCase.agentTools.alsoAllow
      : Array.isArray(testCase.globalTools?.alsoAllow)
        ? testCase.globalTools.alsoAllow
        : undefined;
    const filtered = applyToolPolicyPipeline({
      // Only `name` is read by the pipeline; the oracle does not execute tools.
      tools: TOOL_IDS.map((name) => ({ name })) as unknown as AnyAgentTool[],
      toolMeta: () => undefined,
      warn: () => undefined,
      steps: buildDefaultToolPolicyPipelineSteps({
        profilePolicy: mergeAlsoAllowPolicy(profilePolicy, profileAlsoAllow),
        profile,
        globalPolicy: pickSandboxToolPolicy(testCase.globalTools),
        agentPolicy: pickSandboxToolPolicy(testCase.agentTools),
      }),
    });
    return filtered.some((tool) => tool.name === toolName);
  }

  /** Mirror: what renderAgentTools() shows for the same config. */
  function uiEnabled(toolName: string, testCase: Case): boolean {
    const steps = buildToolAccessSteps({
      profile: caseProfile(testCase) ?? "full",
      agentTools: testCase.agentTools ?? {},
      globalTools: testCase.globalTools ?? {},
    });
    return isToolEnabledBySteps(toolName, steps);
  }

  const CASES: Case[] = [
    {},
    { globalTools: { profile: "full" } },
    { globalTools: { profile: "coding" } },
    { globalTools: { profile: "messaging" } },
    { globalTools: { profile: "minimal" } },
    { globalTools: { profile: "bogus-profile" } },
    { agentTools: { profile: "coding" } },
    { globalTools: { profile: "minimal" }, agentTools: { profile: "coding" } },
    { globalTools: { profile: "coding" }, agentTools: { alsoAllow: ["gateway"] } },
    { globalTools: { profile: "messaging" }, agentTools: { alsoAllow: ["read"] } },
    { globalTools: { profile: "full" }, agentTools: { alsoAllow: ["*"] } },
    { globalTools: { profile: "minimal" }, agentTools: { alsoAllow: ["write"] } },
    { globalTools: { profile: "coding" }, agentTools: { deny: ["exec"] } },
    {
      globalTools: { profile: "coding" },
      agentTools: { alsoAllow: ["exec"], deny: ["exec"] },
    },
    { globalTools: { profile: "full" }, agentTools: { allow: ["read"] } },
    { globalTools: { profile: "coding" }, agentTools: { allow: ["read"] } },
    {
      globalTools: { profile: "messaging" },
      agentTools: { allow: ["exec"], alsoAllow: ["write"] },
    },
    { globalTools: { profile: "messaging" }, agentTools: { allow: ["exec"] } },
    { agentTools: { allow: ["read", "write"] } },
    { agentTools: { alsoAllow: ["read"] } },
    { globalTools: { profile: "coding", allow: ["read"] } },
    {
      globalTools: { profile: "coding", allow: ["read"] },
      agentTools: { alsoAllow: ["gateway"] },
    },
    { globalTools: { profile: "coding", alsoAllow: ["gateway"] } },
    { globalTools: { profile: "full", allow: ["read"] } },
    {
      globalTools: { profile: "full", allow: ["*"] },
      agentTools: { deny: ["exec"] },
    },
    { globalTools: { profile: "coding" }, agentTools: { allow: [] } },
    { globalTools: { profile: "coding" }, agentTools: { alsoAllow: [] } },
  ];

  it("agrees with the server pipeline across the config grid", () => {
    const disagreements: string[] = [];
    for (const testCase of CASES) {
      for (const tool of TOOL_IDS) {
        const server = serverEnabled(tool, testCase);
        const ui = uiEnabled(tool, testCase);
        if (server !== ui) {
          disagreements.push(`${JSON.stringify(testCase)} ${tool}: server=${server} ui=${ui}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("does not extend a deny list with the apply_patch -> exec grant", () => {
    // The server aliases apply_patch onto an exec *grant*, never onto a denial.
    const steps = buildToolAccessSteps({
      profile: "coding",
      agentTools: { deny: ["exec"] },
      globalTools: {},
    });
    expect(isToolEnabledBySteps("exec", steps)).toBe(false);
    expect(isToolEnabledBySteps("apply_patch", steps)).toBe(true);
  });

  it("reflects global tools.allow instead of showing every tool as enabled", () => {
    const steps = buildToolAccessSteps({
      profile: "full",
      agentTools: {},
      globalTools: { allow: ["read"] },
    });
    expect(isToolEnabledBySteps("read", steps)).toBe(true);
    expect(isToolEnabledBySteps("exec", steps)).toBe(false);
  });

  it("honours global tools.alsoAllow at the profile stage", () => {
    const steps = buildToolAccessSteps({
      profile: "coding",
      agentTools: {},
      globalTools: { alsoAllow: ["gateway"] },
    });
    expect(isToolEnabledBySteps("gateway", steps)).toBe(true);
  });

  it("keeps the profile step narrowing before an agent allowlist widens nothing", () => {
    // `allow` narrows after the profile; it cannot resurrect a tool the profile
    // already removed. Only `alsoAllow` widens, and it does so at the profile stage.
    const narrow = buildToolAccessSteps({
      profile: "messaging",
      agentTools: { allow: ["exec"] },
      globalTools: {},
    });
    expect(isToolEnabledBySteps("exec", narrow)).toBe(false);

    const widened = buildToolAccessSteps({
      profile: "messaging",
      agentTools: { alsoAllow: ["exec"] },
      globalTools: {},
    });
    expect(isToolEnabledBySteps("exec", widened)).toBe(true);
  });
});
