import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createOpenClawCodingTools } from "../src/agents/pi-tools.ts";
import {
  CORE_TOOL_GROUPS,
  isKnownCoreToolId,
  listCoreToolSections,
} from "../src/agents/tool-catalog.ts";
import { getPluginToolMeta } from "../src/plugins/tools.ts";

// OpenAI and Anthropic both require function/tool names to match
// ^[a-zA-Z0-9_-]{1,64}$: a charset rule and a length rule, checked separately
// below so a violation names the rule it broke.
const PROVIDER_TOOL_NAME_CHARSET_RE = /^[a-zA-Z0-9_-]+$/;
const PROVIDER_TOOL_NAME_MAX_LENGTH = 64;

// Documented exceptions. These names exceed the 64-character provider limit but
// are still accepted by the currently configured OpenAI-compatible provider, so
// they are recorded here rather than treated as a failure: renaming one changes
// a public tool surface, which is the owner's call. The ratchet still holds for
// every new tool.
const KNOWN_OVER_LONG_TOOL_NAMES = new Set([
  "finance_doctrine_teacher_feedback_candidate_input_reconciliation_status",
]);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The display layer resolves tools by name (`TOOL_MAP` in tool-display.ts) and
// merges both maps below, so a key with nothing behind it is never looked up:
// it reads like a live tool while doing nothing.
const DISPLAY_MAPS = [
  "src/shared/tool-display.json",
  "src/agents/tool-display-overrides.json",
] as const;

// Keys that legitimately have no repo tool behind them, each with its reason.
const DISPLAY_KEYS_WITHOUT_A_REPO_TOOL = new Set([
  // ACP session updates are rendered through the same map. `AcpSessionUpdateTag`
  // (src/acp/runtime/types.ts) ends in `(string & {})`, so there is no closed
  // list to import; add a new tag here when the display map gains one.
  "tool_call",
  "tool_call_update",
  // Alias of `exec` (TOOL_NAME_ALIASES in tool-policy-shared.ts).
  "bash",
  // Display-layer special case for an attachment path (tool-display-common.ts).
  "attach",
  // Channel-provided tool: registered only once the WhatsApp plugin is loaded.
  "whatsapp_login",
  // Channel id, rendered through the same event stream as tools.
  "discord",
]);

let cachedTools: ReturnType<typeof createOpenClawCodingTools> | null = null;

function assembledTools(): ReturnType<typeof createOpenClawCodingTools> {
  cachedTools ??= createOpenClawCodingTools({});
  return cachedTools;
}

function registeredToolNames(): string[] {
  return assembledTools()
    .map((tool) => String(tool.name ?? ""))
    .filter(Boolean);
}

function registeredCoreToolNames(): string[] {
  return assembledTools()
    .filter((tool) => !getPluginToolMeta(tool))
    .map((tool) => String(tool.name ?? ""))
    .filter(Boolean);
}

// Every catalog entry is pushed into its own `group:<sectionId>` bucket, so the
// union of those buckets is the catalog id set. `group:openclaw` is a curated
// subset of the same ids and would double-count them.
function catalogToolIds(): string[] {
  return Object.entries(CORE_TOOL_GROUPS)
    .filter(([groupId]) => groupId !== "group:openclaw")
    .flatMap(([, ids]) => ids);
}

function displayMapKeys(relativePath: string): string[] {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8")) as {
    tools?: Record<string, unknown>;
  };
  return Object.keys(raw.tools ?? {});
}

describe("tool catalog covers the registered core tool surface", () => {
  it("registers no core tool that is missing from the catalog", () => {
    // A tool absent from the catalog belongs to no profile and no group, so any
    // profile allowlist (minimal/coding/messaging) drops it silently: the model
    // is told about a tool it cannot call.
    const missing = registeredCoreToolNames().filter((name) => !isKnownCoreToolId(name));
    expect(missing).toEqual([]);
  });

  it("keeps catalog ids unique and reachable from a rendered section", () => {
    const ids = catalogToolIds();
    expect(new Set(ids).size).toBe(ids.length);
    const sectioned = listCoreToolSections().flatMap((section) =>
      section.tools.map((tool) => tool.id),
    );
    // An id whose sectionId is not in CORE_TOOL_SECTION_ORDER would vanish from
    // every rendered section while still answering isKnownCoreToolId().
    expect(sectioned.toSorted()).toEqual(ids.toSorted());
  });

  it("keeps every tool name inside the provider charset and length limit", () => {
    const names = registeredCoreToolNames();
    expect(names.filter((name) => !PROVIDER_TOOL_NAME_CHARSET_RE.test(name))).toEqual([]);
    expect(
      names.filter(
        (name) =>
          name.length > PROVIDER_TOOL_NAME_MAX_LENGTH && !KNOWN_OVER_LONG_TOOL_NAMES.has(name),
      ),
    ).toEqual([]);
  });

  it("explains every tool-display key with a tool, a channel, or a documented event key", () => {
    const names = new Set(registeredToolNames());
    const unexplained = DISPLAY_MAPS.flatMap((relativePath) =>
      displayMapKeys(relativePath)
        .filter(
          (key) =>
            !isKnownCoreToolId(key) &&
            !names.has(key) &&
            !DISPLAY_KEYS_WITHOUT_A_REPO_TOOL.has(key),
        )
        .map((key) => `${relativePath}: ${key}`),
    );
    // This is the mirror image of the first test: a name can be declared without
    // being registered, not only registered without being declared.
    // `feishu_live_probe` survived the removal of its tool as `external_live_probe`
    // because the display entry was renamed while the tool itself was deleted.
    expect(unexplained).toEqual([]);
  });
});
