import { describe, expect, it } from "vitest";
import { buildOntologyAudit } from "../scripts/operator/lcx-ontology.js";
import {
  LOCAL_BRAIN_MODULE_TAXONOMY,
  LOCAL_BRAIN_REQUIRED_FINANCE_MODULES,
  LOCAL_BRAIN_RISK_BOUNDARIES,
} from "../scripts/operator/local-brain-taxonomy.js";
import {
  FINANCE_DATA_DELAY_STATUSES,
  FINANCE_DATA_PROVIDER_ROLES,
  FINANCE_DATA_QUALITY_STATUSES,
  FINANCE_DATA_SOURCE_FAMILIES,
} from "../src/agents/finance-data-gateway.js";
import {
  MODULE_LEARNING_DECISIONS,
  MODULE_LEARNING_EVIDENCE_STATUSES,
  MODULE_LEARNING_TARGETS,
} from "../src/agents/tools/module-learning-pipeline-plan-tool.js";
import {
  FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS,
  FINANCE_ARTICLE_SOURCE_EVIDENCE_CLASSES,
  FINANCE_ARTICLE_SOURCE_RELIABILITY_GRADES,
  FINANCE_ARTICLE_SOURCE_TYPES,
  FINANCE_ARTICLE_SOURCE_WEAK_EVIDENCE_LEARNING_POLICIES,
  FINANCE_EVIDENCE_CATEGORIES,
  FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES,
  FINANCE_FRAMEWORK_CONFIDENCE_OR_CONVICTION_LEVELS,
  FINANCE_FRAMEWORK_CORE_DOMAINS,
  FINANCE_LEARNING_CAPABILITY_TAGS,
  FINANCE_LEARNING_CAPABILITY_TYPES,
  FINANCE_LEARNING_COLLECTION_METHODS,
  FINANCE_LEARNING_EVIDENCE_LEVELS,
  FINANCE_LEARNING_SOURCE_TYPES,
} from "../src/hooks/bundled/lobster-brain-registry.js";
import {
  LCX_ONTOLOGY_ADAPTER_IMPLEMENTATION_IDS,
  LCX_ONTOLOGY_CHANNEL_MILESTONE_ALIASES,
  LCX_ONTOLOGY_EVOLUTION_CONTRACT,
  LCX_ONTOLOGY_EVOLUTION_RULES,
  LCX_ONTOLOGY_FORBIDDEN_CANONICAL_TOKENS,
  LCX_ONTOLOGY_FINANCE_ALLOWED_ACTION_AUTHORITIES,
  LCX_ONTOLOGY_FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS,
  LCX_ONTOLOGY_FINANCE_ARTICLE_SOURCE_TYPES,
  LCX_ONTOLOGY_FINANCE_CONFIDENCE_OR_CONVICTION_LEVELS,
  LCX_ONTOLOGY_FINANCE_DATA_DELAY_STATUSES,
  LCX_ONTOLOGY_FINANCE_DATA_PROVIDER_ROLES,
  LCX_ONTOLOGY_FINANCE_DATA_QUALITY_STATUSES,
  LCX_ONTOLOGY_FINANCE_DATA_SOURCE_FAMILIES,
  LCX_ONTOLOGY_FINANCE_EVIDENCE_CATEGORIES,
  LCX_ONTOLOGY_FINANCE_FRAMEWORK_CORE_DOMAIN_IDS,
  LCX_ONTOLOGY_FINANCE_LEARNING_CAPABILITY_TAGS,
  LCX_ONTOLOGY_FINANCE_LEARNING_CAPABILITY_TYPES,
  LCX_ONTOLOGY_FINANCE_LEARNING_COLLECTION_METHODS,
  LCX_ONTOLOGY_FINANCE_LEARNING_EVIDENCE_LEVELS,
  LCX_ONTOLOGY_FINANCE_LEARNING_SOURCE_TYPES,
  LCX_ONTOLOGY_LEGACY_COMPATIBILITY_IDS,
  LCX_ONTOLOGY_LEARNING_EVIDENCE_STATUSES,
  LCX_ONTOLOGY_MIGRATION_MANIFEST_SCHEMA_VERSION,
  LCX_ONTOLOGY_NON_CANONICAL_TASK_FAMILY_CLASSES,
  LCX_ONTOLOGY_NON_CANONICAL_TASK_FAMILY_IDS,
  LCX_ONTOLOGY_RELATION_CONTRACTS,
  LCX_ONTOLOGY_REGISTRY,
  LCX_ONTOLOGY_REGISTRY_POLICY,
  LCX_ONTOLOGY_SOURCE_EVIDENCE_CLASSES,
  LCX_ONTOLOGY_SOURCE_RELIABILITY_GRADES,
  LCX_ONTOLOGY_STATE_CHAINS,
  LCX_ONTOLOGY_VOCABULARY_GROUPS,
  LCX_ONTOLOGY_VOCABULARIES,
  LCX_ONTOLOGY_WEAK_EVIDENCE_POLICIES,
  canonicalizeLcxOntologyValue,
  getLcxOntologyEvolutionRule,
  getLcxOntologyRelationContract,
  isLcxOntologyRelationAllowed,
  validateLcxOntologyMigrationManifest,
  validateLcxOntologyRegistry,
} from "../src/shared/lcx-ontology.js";

describe("LCX ontology registry", () => {
  it("is internally valid and exposes one canonical version", () => {
    expect(validateLcxOntologyRegistry()).toEqual([]);
    expect(LCX_ONTOLOGY_REGISTRY.version).toBe("lcx_ontology_v1");
    expect(LCX_ONTOLOGY_STATE_CHAINS.externalDelivery).toEqual([
      "core_ready",
      "external_channel_bound",
      "user_visible_observed",
    ]);
  });

  it("makes module and learning vocabularies resolve through the same registry", () => {
    expect(LCX_ONTOLOGY_RELATION_CONTRACTS).toHaveLength(15);
    expect(new Set(LCX_ONTOLOGY_RELATION_CONTRACTS.map((contract) => contract.relation)).size).toBe(
      15,
    );
    expect(LCX_ONTOLOGY_REGISTRY.relationContracts).toEqual(LCX_ONTOLOGY_RELATION_CONTRACTS);
    expect(LCX_ONTOLOGY_REGISTRY_POLICY).toMatchObject({
      canonicalSource: "src/shared/lcx-ontology.ts",
      auditEntrypoint: "scripts/operator/lcx-ontology.ts",
      changeMode: "extend_in_place",
      migrationMode: "versioned_explicit_migration",
      parallelRegistry: "forbidden",
    });
    expect(LCX_ONTOLOGY_NON_CANONICAL_TASK_FAMILY_IDS).toEqual(["unknown", "partial_json_object"]);
    expect(LCX_ONTOLOGY_NON_CANONICAL_TASK_FAMILY_CLASSES).toEqual({
      sentinel: ["unknown"],
      parserArtifact: ["partial_json_object"],
    });
    expect(LOCAL_BRAIN_MODULE_TAXONOMY).toEqual(LCX_ONTOLOGY_VOCABULARIES.module);
    expect(LOCAL_BRAIN_REQUIRED_FINANCE_MODULES).toEqual([
      "macro_rates_inflation",
      "credit_liquidity",
      "etf_regime",
      "company_fundamentals_value",
      "portfolio_risk_gates",
    ]);
    expect(LOCAL_BRAIN_RISK_BOUNDARIES).toContain("research_only");
    expect(MODULE_LEARNING_TARGETS).toEqual(LCX_ONTOLOGY_VOCABULARIES.learningTarget);
    expect(MODULE_LEARNING_DECISIONS).toEqual(LCX_ONTOLOGY_VOCABULARIES.learningDecision);
    expect(MODULE_LEARNING_EVIDENCE_STATUSES).toEqual(LCX_ONTOLOGY_LEARNING_EVIDENCE_STATUSES);
    expect(FINANCE_DATA_PROVIDER_ROLES).toEqual(LCX_ONTOLOGY_FINANCE_DATA_PROVIDER_ROLES);
    expect(FINANCE_DATA_SOURCE_FAMILIES).toEqual(LCX_ONTOLOGY_FINANCE_DATA_SOURCE_FAMILIES);
    expect(FINANCE_DATA_DELAY_STATUSES).toEqual(LCX_ONTOLOGY_FINANCE_DATA_DELAY_STATUSES);
    expect(FINANCE_DATA_QUALITY_STATUSES).toEqual(LCX_ONTOLOGY_FINANCE_DATA_QUALITY_STATUSES);
    expect(FINANCE_FRAMEWORK_CORE_DOMAINS).toEqual(LCX_ONTOLOGY_FINANCE_FRAMEWORK_CORE_DOMAIN_IDS);
    expect(FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES).toEqual(
      LCX_ONTOLOGY_FINANCE_ALLOWED_ACTION_AUTHORITIES,
    );
    expect(FINANCE_FRAMEWORK_CONFIDENCE_OR_CONVICTION_LEVELS).toEqual(
      LCX_ONTOLOGY_FINANCE_CONFIDENCE_OR_CONVICTION_LEVELS,
    );
    expect(FINANCE_LEARNING_CAPABILITY_TYPES).toEqual(
      LCX_ONTOLOGY_FINANCE_LEARNING_CAPABILITY_TYPES,
    );
    expect(FINANCE_LEARNING_CAPABILITY_TAGS).toEqual(LCX_ONTOLOGY_FINANCE_LEARNING_CAPABILITY_TAGS);
    expect(FINANCE_LEARNING_SOURCE_TYPES).toEqual(LCX_ONTOLOGY_FINANCE_LEARNING_SOURCE_TYPES);
    expect(FINANCE_LEARNING_COLLECTION_METHODS).toEqual(
      LCX_ONTOLOGY_FINANCE_LEARNING_COLLECTION_METHODS,
    );
    expect(FINANCE_LEARNING_EVIDENCE_LEVELS).toEqual(LCX_ONTOLOGY_FINANCE_LEARNING_EVIDENCE_LEVELS);
    expect(FINANCE_ARTICLE_SOURCE_TYPES).toEqual(LCX_ONTOLOGY_FINANCE_ARTICLE_SOURCE_TYPES);
    expect(FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS).toEqual(
      LCX_ONTOLOGY_FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS,
    );
    expect(FINANCE_ARTICLE_SOURCE_EVIDENCE_CLASSES).toEqual(LCX_ONTOLOGY_SOURCE_EVIDENCE_CLASSES);
    expect(FINANCE_ARTICLE_SOURCE_RELIABILITY_GRADES).toEqual(
      LCX_ONTOLOGY_SOURCE_RELIABILITY_GRADES,
    );
    expect(FINANCE_ARTICLE_SOURCE_WEAK_EVIDENCE_LEARNING_POLICIES).toEqual(
      LCX_ONTOLOGY_WEAK_EVIDENCE_POLICIES,
    );
    expect(FINANCE_EVIDENCE_CATEGORIES).toEqual(LCX_ONTOLOGY_FINANCE_EVIDENCE_CATEGORIES);
  });

  it("declares one evolution contract for every vocabulary and semantic change", () => {
    const groupedVocabularies = Object.values(LCX_ONTOLOGY_VOCABULARY_GROUPS).flat().toSorted();
    expect(groupedVocabularies).toEqual(Object.keys(LCX_ONTOLOGY_VOCABULARIES).toSorted());
    expect(LCX_ONTOLOGY_REGISTRY.vocabularyGroups).toEqual(LCX_ONTOLOGY_VOCABULARY_GROUPS);
    expect(LCX_ONTOLOGY_REGISTRY.evolution).toEqual(LCX_ONTOLOGY_EVOLUTION_CONTRACT);
    expect(LCX_ONTOLOGY_EVOLUTION_RULES).toHaveLength(10);
    expect(getLcxOntologyEvolutionRule("add_canonical_value")).toMatchObject({
      action: "extend_in_place",
      requiresVersionBump: false,
      requiresMigrationManifest: false,
    });
    expect(getLcxOntologyEvolutionRule("change_relation_contract")).toMatchObject({
      action: "versioned_explicit_migration",
      requiresVersionBump: true,
      requiresMigrationManifest: true,
      requiredProofs: expect.arrayContaining(["migration_manifest", "head_tail_consistency"]),
    });
    expect(LCX_ONTOLOGY_EVOLUTION_CONTRACT.migrationManifestSchemaVersion).toBe(
      LCX_ONTOLOGY_MIGRATION_MANIFEST_SCHEMA_VERSION,
    );
  });

  it("validates future migration manifests at the persisted boundary", () => {
    const validManifest = {
      schemaVersion: LCX_ONTOLOGY_MIGRATION_MANIFEST_SCHEMA_VERSION,
      fromOntologyVersion: "lcx_ontology_v1",
      toOntologyVersion: "lcx_ontology_v2",
      changes: [
        {
          changeKind: "change_relation_contract",
          scope: "relation",
          from: "requires:workflow->policy",
          to: "requires:workflow->policy|module",
        },
      ],
      affectedVocabularies: ["relation"],
      reason: "Extend relation endpoints while preserving existing consumers.",
      compatibility: "dual_read_then_cutover",
      rollback: "available",
      requiredProofs: [
        "ontology_audit",
        "change_impact_plan",
        "focused_regression",
        "head_tail_consistency",
        "flow_graph",
        "mind_model",
        "migration_manifest",
      ],
    };
    expect(validateLcxOntologyMigrationManifest(validManifest)).toEqual([]);
    expect(
      validateLcxOntologyMigrationManifest({
        ...validManifest,
        requiredProofs: ["ontology_audit"],
      }),
    ).toContain(
      "ontology migration manifest is missing proof head_tail_consistency for change_relation_contract",
    );
    expect(
      validateLcxOntologyMigrationManifest({
        ...validManifest,
        changes: [
          {
            changeKind: "add_canonical_value",
            scope: "module",
            from: "old",
            to: "new",
          },
        ],
      }),
    ).toContain(
      "ontology migration cannot contain non-breaking or forbidden change: add_canonical_value",
    );
    expect(
      validateLcxOntologyMigrationManifest({
        ...validManifest,
        affectedVocabularies: ["module"],
      }),
    ).toContain("ontology migration change 0 scope is not listed in affectedVocabularies");
  });

  it("does not promote transport or parser outcomes into task meaning", () => {
    expect(canonicalizeLcxOntologyValue("taskFamily", "unknown")).toBeUndefined();
    expect(canonicalizeLcxOntologyValue("taskFamily", "partial_json_object")).toBeUndefined();
  });

  it("enforces relation endpoint contracts for future ontology instances", () => {
    expect(getLcxOntologyRelationContract("requires")).toMatchObject({
      relation: "requires",
      subjectTypes: expect.arrayContaining(["workflow"]),
      objectTypes: expect.arrayContaining(["policy"]),
    });
    expect(isLcxOntologyRelationAllowed("requires", "workflow", "policy")).toBe(true);
    expect(isLcxOntologyRelationAllowed("requires", "workflow", "actor")).toBe(false);
    expect(isLcxOntologyRelationAllowed("delivered_via", "summary", "adapter")).toBe(true);
  });

  it("keeps legacy labels as aliases without changing canonical delivery states", () => {
    expect(canonicalizeLcxOntologyValue("module", "artifact-memory-recall")).toBe(
      "finance_learning_memory",
    );
    expect(canonicalizeLcxOntologyValue("channelMilestone", "user-visible-observed")).toBe(
      "user_visible_observed",
    );
    expect(LCX_ONTOLOGY_CHANNEL_MILESTONE_ALIASES["live-user-seen"]).toBe("user_visible_observed");
    expect(canonicalizeLcxOntologyValue("channelMilestone", "not-a-state")).toBeUndefined();
    expect(canonicalizeLcxOntologyValue("taskFamily", "external_source_learning_planning")).toBe(
      "external_knowledge_internalization_protocol",
    );
    expect(canonicalizeLcxOntologyValue("taskFamily", "portfolio_math_missing_inputs")).toBe(
      "portfolio_quant_math_missing_inputs",
    );
  });

  it("classifies adapter and legacy identifiers without making them core facts", () => {
    expect(LCX_ONTOLOGY_ADAPTER_IMPLEMENTATION_IDS.workflowNode).toEqual(
      expect.arrayContaining(["ingress_external_message", "real_external_inbound"]),
    );
    expect(LCX_ONTOLOGY_LEGACY_COMPATIBILITY_IDS.workflowNode).toContain("live_user_seen");
    expect(LCX_ONTOLOGY_FORBIDDEN_CANONICAL_TOKENS).toContain("dev");
    expect(LCX_ONTOLOGY_REGISTRY.identifierClasses.adapterImplementation).toEqual(
      LCX_ONTOLOGY_ADAPTER_IMPLEMENTATION_IDS,
    );
  });

  it("audits every production task-family producer against the registry", async () => {
    const audit = await buildOntologyAudit();
    expect(audit.ok).toBe(true);
    expect(audit.taskFamilySources.length).toBeGreaterThanOrEqual(10);
    expect(audit.taskFamilySources.every((source) => source.ok)).toBe(true);
    expect(audit.taskFamilySources.flatMap((source) => source.unknown)).toEqual([]);
    expect(audit.canonicalSource).toBe("src/shared/lcx-ontology.ts");
    expect(audit.evolutionContract).toEqual(
      expect.objectContaining({
        contractVersion: "lcx_ontology_evolution_v1",
        registryVersion: "lcx_ontology_v1",
        migrationManifestSchemaVersion: "lcx_ontology_migration_v1",
      }),
    );
    expect(audit.relationContracts.count).toBe(15);
    expect(audit.taskFamilySources.flatMap((source) => source.nonCanonicalTaskFamilies)).toEqual(
      expect.arrayContaining(["unknown", "partial_json_object"]),
    );
    expect(audit.taskFamilySources.flatMap((source) => source.aliases)).toEqual(
      expect.arrayContaining([
        {
          source: "external_source_learning_planning",
          canonical: "external_knowledge_internalization_protocol",
        },
        {
          source: "portfolio_multi_module_risk_planning",
          canonical: "full_stack_finance_stress_research_planning",
        },
      ]),
    );
  });
});
