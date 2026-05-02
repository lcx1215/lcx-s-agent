import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringArrayParam, readStringParam, ToolInputError } from "./common.js";

const GITHUB_CAPABILITY_INTAKE_DIR = path.join("memory", "github-capability-intake");

const GITHUB_CAPABILITY_FAMILIES = [
  "language_interface",
  "skills_runtime",
  "tool_runtime",
  "memory_learning",
  "retrieval_research",
  "eval_trace",
  "workflow_orchestration",
  "finance_research",
  "ui_control_room",
  "unknown",
] as const;

const ADOPTION_MODES = [
  "auto",
  "skill",
  "tool",
  "routing",
  "memory_rule",
  "eval",
  "research_source",
  "defer",
  "reject",
] as const;

type GitHubCapabilityFamily = (typeof GITHUB_CAPABILITY_FAMILIES)[number];
type AdoptionMode = (typeof ADOPTION_MODES)[number];

type ExistingEmbryo = {
  surface: string;
  path: string;
  fit: "strong" | "partial";
};

const GitHubProjectCapabilityIntakeSchema = Type.Object({
  repoName: Type.String(),
  repoUrl: Type.Optional(Type.String()),
  selectedFeature: Type.String(),
  projectSummary: Type.String(),
  evidenceSnippets: Type.Optional(Type.Array(Type.String())),
  requestedAdoptionMode: Type.Optional(stringEnum(ADOPTION_MODES)),
  tags: Type.Optional(Type.Array(Type.String())),
  writeReceipt: Type.Optional(Type.Boolean()),
});

function normalizeText(value: string): string {
  return value.trim().replace(/\r\n/gu, "\n");
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 72);
  return slug || "github-project";
}

function detectCapabilityFamily(text: string): GitHubCapabilityFamily {
  const lower = text.toLowerCase();
  const rules: Array<[GitHubCapabilityFamily, RegExp]> = [
    [
      "finance_research",
      /\b(finance|financial|quant|portfolio|etf|factor|market|markets)\b|trading research/u,
    ],
    [
      "language_interface",
      /(lark|feishu|utterance|intent|router|routing|corpus|dialog|conversation)/u,
    ],
    ["skills_runtime", /(skill|plugin|hook|extension|recipe|workflow pack|capability pack)/u],
    ["tool_runtime", /(tool call|tool-call|tool registry|function call|mcp|provider|api adapter)/u],
    ["memory_learning", /(memory|lesson|distill|knowledge|learning|reflection|artifact|state)/u],
    ["retrieval_research", /(rag|retrieval|search|chunk|embedding|vector|rerank|source registry)/u],
    ["eval_trace", /(eval|benchmark|trace|telemetry|observability|smoke|score|regression)/u],
    [
      "workflow_orchestration",
      /(agent|multi-agent|orchestration|queue|scheduler|supervisor|handoff)/u,
    ],
    ["ui_control_room", /(dashboard|control room|frontend|ui|chat surface|workbench|visual)/u],
  ];
  return rules.find(([, pattern]) => pattern.test(lower))?.[0] ?? "unknown";
}

function existingEmbryosForFamily(family: GitHubCapabilityFamily): ExistingEmbryo[] {
  const shared: ExistingEmbryo[] = [
    {
      surface: "tool catalog",
      path: "src/agents/tool-catalog.ts",
      fit: "partial",
    },
    {
      surface: "agent tools",
      path: "src/agents/openclaw-tools.ts",
      fit: "partial",
    },
  ];
  switch (family) {
    case "language_interface":
      return [
        {
          surface: "Lark language routing corpus",
          path: "extensions/feishu/src/lark-routing-corpus.ts",
          fit: "strong",
        },
        {
          surface: "Lark candidate review",
          path: "src/agents/tools/lark-language-corpus-review-tool.ts",
          fit: "strong",
        },
      ];
    case "skills_runtime":
      return [
        {
          surface: "system prompt skills contract",
          path: "docs/concepts/system-prompt.md",
          fit: "partial",
        },
        {
          surface: "hooks automation",
          path: "docs/automation/hooks.md",
          fit: "partial",
        },
        ...shared,
      ];
    case "tool_runtime":
      return shared;
    case "memory_learning":
      return [
        {
          surface: "local memory record",
          path: "src/agents/tools/local-memory-record-tool.ts",
          fit: "strong",
        },
        {
          surface: "artifact memory",
          path: "src/hooks/bundled/artifact-memory.ts",
          fit: "partial",
        },
      ];
    case "retrieval_research":
      return [
        {
          surface: "finance research source workbench",
          path: "src/agents/tools/finance-research-source-workbench-tool.ts",
          fit: "partial",
        },
        {
          surface: "finance source registry",
          path: "src/agents/tools/finance-article-source-registry-record-tool.ts",
          fit: "partial",
        },
      ];
    case "eval_trace":
      return [
        {
          surface: "dev full-system smoke",
          path: "scripts/dev/agent-system-loop-smoke.ts",
          fit: "partial",
        },
        {
          surface: "Feishu live probe",
          path: "src/agents/tools/feishu-live-probe-tool.ts",
          fit: "partial",
        },
      ];
    case "workflow_orchestration":
      return [
        {
          surface: "sessions spawn",
          path: "src/agents/tools/sessions-spawn-tool.ts",
          fit: "partial",
        },
        {
          surface: "learning council",
          path: "extensions/feishu/src/learning-council.ts",
          fit: "partial",
        },
      ];
    case "finance_research":
      return [
        {
          surface: "finance learning pipeline",
          path: "src/agents/tools/finance-learning-pipeline-orchestrator-tool.ts",
          fit: "strong",
        },
        {
          surface: "finance capability candidates",
          path: "memory/local-memory/finance-learning-capability-candidates.md",
          fit: "strong",
        },
      ];
    case "ui_control_room":
      return [
        {
          surface: "Feishu control-room surfaces",
          path: "extensions/feishu/src/surfaces.ts",
          fit: "partial",
        },
        {
          surface: "workface app",
          path: "src/agents/tools/lobster-workface-app-tool.ts",
          fit: "partial",
        },
      ];
    case "unknown":
      return shared;
  }
}

function detectSafetyBlockers(text: string): string[] {
  const checks: Array<[string, RegExp]> = [
    [
      "automatic_dependency_install_or_code_execution",
      /(auto.*install|install.*globally|clone.*run|run.*untrusted|execute.*repo)/iu,
    ],
    [
      "secret_or_private_data_risk",
      /(api key|secret|credential|token dump|private repo|private data)/iu,
    ],
    [
      "forbidden_collection_or_bypass",
      /(bypass|paywall|scrape private|crawl private|rate limit.*avoid)/iu,
    ],
    [
      "execution_authority_risk",
      /(place order|execute trade|trading execution|auto trade|autonomous trading)/iu,
    ],
  ];
  return checks.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function resolveAdoptionTarget(params: {
  family: GitHubCapabilityFamily;
  requestedMode: AdoptionMode;
  blockers: string[];
}) {
  if (params.requestedMode === "reject") {
    return {
      status: "rejected" as const,
      target: "none",
      reason: "Operator requested rejection.",
    };
  }
  if (params.blockers.length > 0) {
    return {
      status: "manual_review_required" as const,
      target: "blocked_until_safety_review",
      reason:
        "The request contains install, execution, private-data, bypass, or execution-authority risk signals.",
    };
  }
  if (params.requestedMode !== "auto" && params.requestedMode !== "defer") {
    return {
      status: "candidate_ready" as const,
      target: `${params.requestedMode}_candidate`,
      reason: "Operator selected a bounded adoption target.",
    };
  }
  if (params.requestedMode === "defer" || params.family === "unknown") {
    return {
      status: "deferred" as const,
      target: "capability_review_backlog",
      reason: "The capability family is not specific enough for a safe implementation patch.",
    };
  }
  const targets: Record<Exclude<GitHubCapabilityFamily, "unknown">, string> = {
    language_interface: "routing_corpus_candidate",
    skills_runtime: "skill_candidate",
    tool_runtime: "tool_candidate",
    memory_learning: "memory_rule_candidate",
    retrieval_research: "research_source_candidate",
    eval_trace: "eval_smoke_candidate",
    workflow_orchestration: "orchestration_contract_candidate",
    finance_research: "finance_learning_source_candidate",
    ui_control_room: "control_room_design_candidate",
  };
  return {
    status: "candidate_ready" as const,
    target: targets[params.family],
    reason: "Mapped to the closest existing LCX Agent capability surface.",
  };
}

function buildNextPatch(params: {
  family: GitHubCapabilityFamily;
  adoptionTarget: string;
  blockers: string[];
}): string {
  if (params.blockers.length > 0) {
    return "Do not install, clone-run, or execute the project. First reduce the idea to README/docs-level behavior and rerun intake.";
  }
  switch (params.adoptionTarget) {
    case "routing_corpus_candidate":
      return "Create pending Lark routing candidates, then run lark_language_corpus_review before touching the formal corpus.";
    case "skill_candidate":
      return "Draft one isolated skill note with uninstall/disable instructions before any runtime integration.";
    case "tool_candidate":
      return "Add one narrow tool contract with a deterministic fixture test; avoid provider or live sender changes.";
    case "memory_rule_candidate":
      return "Record one bounded local-memory rule or correction card; do not mutate protected summaries.";
    case "research_source_candidate":
      return "Keep it as a metadata-only source reference until safe manual content exists for extraction.";
    case "eval_smoke_candidate":
      return "Add a smoke/eval fixture that measures one explicit behavior without changing live runtime.";
    case "orchestration_contract_candidate":
      return "Document the handoff/state contract first, then add a minimal smoke before any role expansion.";
    case "finance_learning_source_candidate":
      return "Route only safe local/manual finance content through finance_learning_pipeline_orchestrator.";
    case "control_room_design_candidate":
      return "Prototype as a bounded local surface or artifact; do not change Feishu live sender until verified.";
    default:
      return params.family === "unknown"
        ? "Capture a clearer feature summary before implementation."
        : "Keep as a review candidate; no implementation patch yet.";
  }
}

function renderReceipt(params: {
  repoName: string;
  repoUrl?: string;
  selectedFeature: string;
  projectSummary: string;
  evidenceSnippets: string[];
  tags: string[];
  family: GitHubCapabilityFamily;
  embryos: ExistingEmbryo[];
  safetyBlockers: string[];
  decision: ReturnType<typeof resolveAdoptionTarget>;
  nextPatch: string;
}): string {
  const evidence = params.evidenceSnippets.length
    ? params.evidenceSnippets.map((item) => `- ${item}`).join("\n")
    : "- No snippets provided; this is an operator-supplied summary intake.";
  const tags = params.tags.length ? params.tags.join(", ") : "none";
  const embryos = params.embryos
    .map((item) => `| ${item.surface} | ${item.path} | ${item.fit} |`)
    .join("\n");
  const blockers = params.safetyBlockers.length ? params.safetyBlockers.join(", ") : "none";
  return `# GitHub Project Capability Intake

## Source
- Repo Name: ${params.repoName}
- Repo Url: ${params.repoUrl ?? "not provided"}
- Selected Feature: ${params.selectedFeature}
- Tags: ${tags}

## Summary
${params.projectSummary}

## Evidence Snippets
${evidence}

## Capability Mapping
- Capability Family: ${params.family}
- Decision Status: ${params.decision.status}
- Adoption Target: ${params.decision.target}
- Reason: ${params.decision.reason}
- Safety Blockers: ${blockers}

## Existing LCX Agent Embryos
| Surface | Path | Fit |
| --- | --- | --- |
${embryos}

## Next Patch
${params.nextPatch}

## Boundaries
- noRemoteFetchOccurred: true
- noCodeExecutionOccurred: true
- notInstalled: true
- liveTouched: false
- protectedMemoryTouched: false
`;
}

export function createGitHubProjectCapabilityIntakeTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "GitHub Project Capability Intake",
    name: "github_project_capability_intake",
    description:
      "Map one GitHub project feature into an LCX Agent capability family, existing internal embryos, and a bounded adoption decision without fetching remote content, executing code, or touching live surfaces.",
    parameters: GitHubProjectCapabilityIntakeSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const repoName = normalizeText(readStringParam(params, "repoName", { required: true }));
      const repoUrl = readStringParam(params, "repoUrl");
      const selectedFeature = normalizeText(
        readStringParam(params, "selectedFeature", { required: true }),
      );
      const projectSummary = normalizeText(
        readStringParam(params, "projectSummary", { required: true }),
      );
      const evidenceSnippets = (readStringArrayParam(params, "evidenceSnippets") ?? []).map(
        normalizeText,
      );
      const tags = (readStringArrayParam(params, "tags") ?? []).map(normalizeText);
      const requestedMode = (readStringParam(params, "requestedAdoptionMode") ??
        "auto") as AdoptionMode;
      if (!ADOPTION_MODES.includes(requestedMode)) {
        throw new ToolInputError("requestedAdoptionMode is not supported");
      }
      const combinedText = [repoName, repoUrl, selectedFeature, projectSummary, ...evidenceSnippets]
        .filter((item): item is string => typeof item === "string")
        .join("\n");
      const family = detectCapabilityFamily(combinedText);
      const safetyBlockers = detectSafetyBlockers(combinedText);
      const embryos = existingEmbryosForFamily(family);
      const decision = resolveAdoptionTarget({
        family,
        requestedMode,
        blockers: safetyBlockers,
      });
      const nextPatch = buildNextPatch({
        family,
        adoptionTarget: decision.target,
        blockers: safetyBlockers,
      });

      let receiptPath: string | undefined;
      if (params.writeReceipt === true) {
        const dateKey = new Date().toISOString().slice(0, 10);
        receiptPath = path.join(
          GITHUB_CAPABILITY_INTAKE_DIR,
          dateKey,
          `${slugify(repoName)}-${slugify(selectedFeature)}.md`,
        );
        await fs.mkdir(path.join(workspaceDir, path.dirname(receiptPath)), { recursive: true });
        await fs.writeFile(
          path.join(workspaceDir, receiptPath),
          renderReceipt({
            repoName,
            repoUrl,
            selectedFeature,
            projectSummary,
            evidenceSnippets,
            tags,
            family,
            embryos,
            safetyBlockers,
            decision,
            nextPatch,
          }),
          "utf8",
        );
      }

      return jsonResult({
        ok: true,
        boundary: "github_capability_intake_only",
        repoName,
        repoUrl: repoUrl ?? null,
        selectedFeature,
        capabilityFamily: family,
        requestedAdoptionMode: requestedMode,
        existingEmbryos: embryos,
        safetyBlockers,
        adoptionDecision: decision,
        nextPatch,
        receiptPath,
        noRemoteFetchOccurred: true,
        noCodeExecutionOccurred: true,
        notInstalled: true,
        liveTouched: false,
        protectedMemoryTouched: false,
      });
    },
  };
}
