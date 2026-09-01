import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LCX_ONTOLOGY_ADAPTER_IMPLEMENTATION_IDS,
  LCX_ONTOLOGY_EVOLUTION_CONTRACT,
  LCX_ONTOLOGY_FORBIDDEN_CANONICAL_TOKENS,
  LCX_ONTOLOGY_LEGACY_COMPATIBILITY_IDS,
  LCX_ONTOLOGY_REGISTRY_POLICY,
  isLcxOntologyNonCanonicalTaskFamily,
  LCX_ONTOLOGY_REGISTRY,
  LCX_ONTOLOGY_VOCABULARIES,
  canonicalizeLcxOntologyValue,
  validateLcxOntologyRegistry,
} from "../../src/shared/lcx-ontology.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

const TASK_FAMILY_SOURCE_PATHS = [
  "scripts/operator/local-brain-contracts.ts",
  "scripts/operator/local-brain-generalization-generator.ts",
  "scripts/operator/local-brain-plan.ts",
  "scripts/operator/local-brain-distill-dataset.ts",
  "scripts/operator/local-brain-distill-eval.ts",
  "scripts/operator/local-brain-distill-smoke.ts",
  "scripts/operator/local-brain-distill-train-slice.ts",
  "scripts/operator/local-brain-generalization-harness.ts",
  "scripts/operator/minimax-brain-teacher-batch.ts",
  "scripts/operator/lcx-self-repair-hands.ts",
] as const;

const INTEGRATION_SURFACES = [
  {
    path: "ops/local-brain/README.md",
    terms: [
      LCX_ONTOLOGY_REGISTRY_POLICY.canonicalSource,
      LCX_ONTOLOGY_REGISTRY_POLICY.auditEntrypoint,
      "single semantic registry",
      "must not introduce a parallel vocabulary",
      "subject/object entity-type contracts",
      "non-canonical task-family outcomes",
      "versioned explicit migration",
      "parallel registries are forbidden",
      "ontology evolution contract",
      "vocabulary groups",
      "additive canonical values",
      "migration manifest",
    ],
  },
  {
    path: "package.json",
    terms: [
      "lcx:ontology",
      "lcx:projection-reader-audit",
      LCX_ONTOLOGY_REGISTRY_POLICY.auditEntrypoint,
    ],
  },
  {
    path: "scripts/operator/local-brain-taxonomy.ts",
    terms: ["LCX_ONTOLOGY_MODULE_IDS", "LCX_ONTOLOGY_CORE_RISK_BOUNDARY_IDS"],
  },
  {
    path: "scripts/operator/local-brain-contracts.ts",
    terms: ["LCX_ONTOLOGY_CONTRACT_FIELD_IDS", "LCX_ONTOLOGY_CONTRACT_BOUNDARY_IDS"],
  },
  {
    path: "src/agents/tools/module-learning-pipeline-plan-tool.ts",
    terms: [
      "LCX_ONTOLOGY_LEARNING_TARGET_IDS",
      "LCX_ONTOLOGY_LEARNING_DECISIONS",
      "LCX_ONTOLOGY_LEARNING_EVIDENCE_STATUSES",
    ],
  },
  {
    path: "src/agents/finance-data-gateway.ts",
    terms: [
      "LCX_ONTOLOGY_FINANCE_DATA_PROVIDER_ROLES",
      "LCX_ONTOLOGY_FINANCE_DATA_SOURCE_FAMILIES",
      "LCX_ONTOLOGY_FINANCE_DATA_DELAY_STATUSES",
      "LCX_ONTOLOGY_FINANCE_DATA_QUALITY_STATUSES",
    ],
  },
  {
    path: "src/agents/tools/finance-data-gateway-tool.ts",
    terms: [
      "LCX_ONTOLOGY_FINANCE_DATA_PROVIDER_ROLES",
      "LCX_ONTOLOGY_FINANCE_DATA_SOURCE_FAMILIES",
      "LCX_ONTOLOGY_FINANCE_DATA_DELAY_STATUSES",
    ],
  },
  {
    path: "src/agents/finance-brain-orchestration.ts",
    terms: ["LcxOntologyModuleId"],
  },
  {
    path: "src/hooks/bundled/lobster-brain-registry.ts",
    terms: [
      "LCX_ONTOLOGY_FINANCE_FRAMEWORK_CORE_DOMAIN_IDS",
      "LCX_ONTOLOGY_FINANCE_ALLOWED_ACTION_AUTHORITIES",
      "LCX_ONTOLOGY_FINANCE_CONFIDENCE_OR_CONVICTION_LEVELS",
      "LCX_ONTOLOGY_FINANCE_LEARNING_CAPABILITY_TYPES",
      "LCX_ONTOLOGY_FINANCE_LEARNING_CAPABILITY_TAGS",
      "LCX_ONTOLOGY_FINANCE_LEARNING_SOURCE_TYPES",
      "LCX_ONTOLOGY_FINANCE_LEARNING_COLLECTION_METHODS",
      "LCX_ONTOLOGY_FINANCE_LEARNING_EVIDENCE_LEVELS",
      "LCX_ONTOLOGY_FINANCE_ARTICLE_SOURCE_TYPES",
      "LCX_ONTOLOGY_FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS",
      "LCX_ONTOLOGY_FINANCE_EVIDENCE_CATEGORIES",
      "LCX_ONTOLOGY_SOURCE_EVIDENCE_CLASSES",
      "LCX_ONTOLOGY_SOURCE_RELIABILITY_GRADES",
      "LCX_ONTOLOGY_WEAK_EVIDENCE_POLICIES",
    ],
  },
  {
    path: "scripts/operator/lcx-flow-graph.ts",
    terms: [
      "LCX_ONTOLOGY_WORKFLOW_NODE_IDS",
      "LCX_ONTOLOGY_WORKFLOW_FILTER_IDS",
      "LCX_ONTOLOGY_WORKFLOW_SCENARIO_IDS",
      "LCX_ONTOLOGY_WORKFLOW_FAMILY_IDS",
    ],
  },
  {
    path: "src/shared/global-evidence-projection.ts",
    terms: ["LCX_ONTOLOGY_SURFACE_IDS", "LCX_ONTOLOGY_CAPABILITY_ROLES", "isLcxOntologyValue"],
  },
  {
    path: "scripts/operator/lcx-mind-model.ts",
    terms: [
      "src/shared/lcx-ontology.ts",
      "LcxOntologySurfaceId",
      "LcxOntologyCapabilityRole",
      "canonical_ontology_registry",
      "ontology evolution contract",
      "LCX_ONTOLOGY_EVOLUTION_CONTRACT",
      "validateLcxOntologyMigrationManifest",
    ],
  },
  {
    path: "scripts/operator/lcx-commercial-answer-pipeline.ts",
    terms: ["LCX_ONTOLOGY_ANSWER_PIPELINE_FILTER_IDS"],
  },
  {
    path: "src/shared/global-evidence-projection-read.ts",
    terms: [
      "LCX_ONTOLOGY_PROJECTION_READ_STATUSES",
      "GLOBAL_EVIDENCE_PROJECTION_READER_CONTRACT_VERSION",
      "readGlobalEvidenceProjectionForAdapter",
    ],
  },
  {
    path: "scripts/operator/lcx-projection-reader-audit.ts",
    terms: [
      "readGlobalEvidenceProjectionForAdapter",
      "local_projection_reader_audit_only",
      "readerContractReadyForAllAdapters",
    ],
  },
  {
    path: "scripts/operator/lcx-governance-autopilot.ts",
    terms: ["readGlobalEvidenceProjectionForAdapter", "globalEvidenceProjectionReader"],
  },
  {
    path: "scripts/operator/lcx-farm-web-server.ts",
    terms: ["readGlobalEvidenceProjectionForAdapter", "globalEvidenceProjectionReader"],
  },
  {
    path: "src/auto-reply/reply/dispatch-from-config.ts",
    terms: [
      "readGlobalEvidenceProjectionForAdapter",
      "globalEvidenceProjectionInput",
      "neutral-answer-boundary",
    ],
  },
  {
    path: "scripts/operator/minimax-brain-teacher-batch.ts",
    terms: ["canonicalizeLcxOntologyValue"],
  },
] as const;

type IntegrationResult = {
  path: string;
  ok: boolean;
  missingTerms: string[];
};

type TaskFamilySourceResult = {
  path: string;
  ok: boolean;
  taskFamilies: string[];
  canonicalTaskFamilies: string[];
  aliases: Array<{ source: string; canonical: string }>;
  nonCanonicalTaskFamilies: string[];
  unknown: string[];
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function extractTaskFamilies(sourcePath: string, source: string): string[] {
  const fieldValues = [
    ...source.matchAll(
      /(?:^|\n)\s*(?:[\p{L}\p{N}_$]+\.)?(?:task_family|taskFamily)\s*(?::|=)\s*"([a-z0-9_]+)"/gu,
    ),
  ].map((match) => match[1]);
  const minimaxPromptIds =
    sourcePath === "scripts/operator/minimax-brain-teacher-batch.ts"
      ? [
          ...(source
            .match(/const TEACHER_PROMPTS[\s\S]*?\n\];/u)?.[0]
            .matchAll(/\bid:\s*"([a-z0-9_]+)"/gu) ?? []),
        ].map((match) => match[1])
      : [];
  return unique([...fieldValues, ...minimaxPromptIds]);
}

async function inspectIntegrationSurface(
  surface: (typeof INTEGRATION_SURFACES)[number],
): Promise<IntegrationResult> {
  const filePath = path.join(REPO_ROOT, surface.path);
  try {
    const source = await fs.readFile(filePath, "utf8");
    const missingTerms = surface.terms.filter((term) => !source.includes(term));
    return { path: surface.path, ok: missingTerms.length === 0, missingTerms };
  } catch {
    return { path: surface.path, ok: false, missingTerms: [...surface.terms] };
  }
}

async function inspectTaskFamilySource(sourcePath: string): Promise<TaskFamilySourceResult> {
  try {
    const source = await fs.readFile(path.join(REPO_ROOT, sourcePath), "utf8");
    const taskFamilies = extractTaskFamilies(sourcePath, source);
    const canonicalTaskFamilies = unique(
      taskFamilies.flatMap((taskFamily) => {
        const canonical = canonicalizeLcxOntologyValue("taskFamily", taskFamily);
        return canonical ? [canonical] : [];
      }),
    );
    const nonCanonicalTaskFamilies = unique(
      taskFamilies.filter((taskFamily) => isLcxOntologyNonCanonicalTaskFamily(taskFamily)),
    );
    const unknown = taskFamilies.filter(
      (taskFamily) =>
        !canonicalizeLcxOntologyValue("taskFamily", taskFamily) &&
        !isLcxOntologyNonCanonicalTaskFamily(taskFamily),
    );
    return {
      path: sourcePath,
      ok: unknown.length === 0,
      taskFamilies,
      canonicalTaskFamilies,
      aliases: taskFamilies.flatMap((taskFamily) => {
        const canonical = canonicalizeLcxOntologyValue("taskFamily", taskFamily);
        return canonical && canonical !== taskFamily ? [{ source: taskFamily, canonical }] : [];
      }),
      nonCanonicalTaskFamilies,
      unknown,
    };
  } catch {
    return {
      path: sourcePath,
      ok: false,
      taskFamilies: [],
      canonicalTaskFamilies: [],
      aliases: [],
      nonCanonicalTaskFamilies: [],
      unknown: [],
    };
  }
}

async function buildOntologyAudit() {
  const [integrations, taskFamilySources] = await Promise.all([
    Promise.all(INTEGRATION_SURFACES.map(inspectIntegrationSurface)),
    Promise.all(TASK_FAMILY_SOURCE_PATHS.map(inspectTaskFamilySource)),
  ]);
  const registryErrors = validateLcxOntologyRegistry();
  const integrationErrors = integrations.flatMap((integration) =>
    integration.ok
      ? []
      : [
          integration.path +
            (integration.missingTerms.length > 0
              ? ": missing " + integration.missingTerms.join(", ")
              : ": unreadable"),
        ],
  );
  const taskFamilyErrors = taskFamilySources.flatMap((source) => {
    if (!source.ok && source.taskFamilies.length === 0) {
      return [source.path + ": unreadable"];
    }
    return source.unknown.map(
      (taskFamily) => source.path + " task family is not registered: " + taskFamily,
    );
  });
  const contractTaskFamilies =
    taskFamilySources.find((source) => source.path === "scripts/operator/local-brain-contracts.ts")
      ?.taskFamilies ?? [];
  const errors = [...registryErrors, ...integrationErrors, ...taskFamilyErrors];
  const vocabularyCounts = Object.fromEntries(
    Object.entries(LCX_ONTOLOGY_VOCABULARIES).map(([name, values]) => [name, values.length]),
  );

  return {
    ok: errors.length === 0,
    boundary: "local_ontology_registry_only",
    checkedAt: new Date().toISOString(),
    ontologyVersion: LCX_ONTOLOGY_REGISTRY.version,
    canonicalSource: LCX_ONTOLOGY_REGISTRY_POLICY.canonicalSource,
    registryPolicy: LCX_ONTOLOGY_REGISTRY_POLICY,
    evolutionContract: LCX_ONTOLOGY_EVOLUTION_CONTRACT,
    relationContracts: {
      count: LCX_ONTOLOGY_REGISTRY.relationContracts.length,
      relations: LCX_ONTOLOGY_REGISTRY.relationContracts.map((contract) => contract.relation),
    },
    vocabularyCounts,
    identifierClasses: {
      adapterImplementation: LCX_ONTOLOGY_ADAPTER_IMPLEMENTATION_IDS,
      legacyCompatibility: LCX_ONTOLOGY_LEGACY_COMPATIBILITY_IDS,
    },
    forbiddenCanonicalTokens: LCX_ONTOLOGY_FORBIDDEN_CANONICAL_TOKENS,
    stateChains: LCX_ONTOLOGY_REGISTRY.stateChains,
    integrationSurfaces: integrations,
    taskFamilySources,
    nonCanonicalTaskFamilies: unique(
      taskFamilySources.flatMap((source) => source.nonCanonicalTaskFamilies),
    ),
    contractTaskFamilies: {
      count: contractTaskFamilies.length,
      canonical: unique(
        taskFamilySources.find(
          (source) => source.path === "scripts/operator/local-brain-contracts.ts",
        )?.canonicalTaskFamilies ?? [],
      ),
      unknown:
        taskFamilySources.find(
          (source) => source.path === "scripts/operator/local-brain-contracts.ts",
        )?.unknown ?? [],
    },
    errors,
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

async function main(): Promise<void> {
  const result = await buildOntologyAudit();
  const json = process.argv.includes("--json");
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      [
        "LCX ontology audit",
        "status=" + (result.ok ? "ok" : "fail"),
        "version=" + result.ontologyVersion,
        "canonicalSource=" + result.canonicalSource,
        "contractTaskFamilies=" + result.contractTaskFamilies.count,
        "taskFamilySources=" + result.taskFamilySources.length,
        "errors=" + result.errors.length,
        "boundary=" + result.boundary,
      ].join("\n"),
    );
    if (result.errors.length > 0) {
      console.log(result.errors.map((error) => "- " + error).join("\n"));
    }
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export { buildOntologyAudit };
