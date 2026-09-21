import type { FinanceBrainModuleId } from "./finance-brain-orchestration.js";

export const FINANCE_MODULE_COMPOSITION_SCHEMA_VERSION =
  "lcx_finance_module_composition_v1" as const;

export const FINANCE_MODULE_COMPOSITION_LIMITS = Object.freeze({
  maxNodes: 24,
  maxEdges: 48,
  maxDepth: 8,
  maxFanout: 24,
  maxReplans: 2,
});

export type FinanceModuleCompositionNode = Readonly<{
  id: string;
  moduleId: FinanceBrainModuleId;
  dependsOn: readonly string[];
}>;

export type FinanceModuleComposition = Readonly<{
  schemaVersion: typeof FINANCE_MODULE_COMPOSITION_SCHEMA_VERSION;
  nodes: readonly FinanceModuleCompositionNode[];
  topologicalOrder: readonly string[];
  roots: readonly string[];
  leaves: readonly string[];
  maxDepth: number;
  maxReplans: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compositionError(message: string): never {
  throw new Error(`moduleSelection.composition ${message}`);
}

function freezeNode(node: FinanceModuleCompositionNode): FinanceModuleCompositionNode {
  return Object.freeze({
    id: node.id,
    moduleId: node.moduleId,
    dependsOn: Object.freeze([...node.dependsOn]),
  });
}

function validateNodeId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value)) {
    compositionError("node IDs must be lowercase names up to 64 characters");
  }
  return value;
}

/**
 * Validate a model-proposed finite module DAG. This is a planner contract only:
 * it grants no tool, provider, memory, or execution authority.
 */
export function parseFinanceModuleComposition(
  value: unknown,
  allowedModuleIds: readonly FinanceBrainModuleId[],
): FinanceModuleComposition | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    compositionError("must be an object");
  }
  const unknownKeys = Object.keys(value).filter((key) => !["nodes", "maxReplans"].includes(key));
  if (unknownKeys.length > 0) {
    compositionError("cannot contain authority-changing fields");
  }
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
    compositionError("requires a nonempty nodes array");
  }
  if (value.nodes.length > FINANCE_MODULE_COMPOSITION_LIMITS.maxNodes) {
    compositionError(
      `cannot contain more than ${FINANCE_MODULE_COMPOSITION_LIMITS.maxNodes} nodes`,
    );
  }
  const maxReplans = value.maxReplans ?? 0;
  if (
    typeof maxReplans !== "number" ||
    !Number.isSafeInteger(maxReplans) ||
    maxReplans < 0 ||
    maxReplans > FINANCE_MODULE_COMPOSITION_LIMITS.maxReplans
  ) {
    compositionError(
      `maxReplans must be an integer from 0 to ${FINANCE_MODULE_COMPOSITION_LIMITS.maxReplans}`,
    );
  }
  const allowed = new Set(allowedModuleIds);
  const nodes: FinanceModuleCompositionNode[] = [];
  const nodeIds = new Set<string>();
  let edgeCount = 0;
  for (const rawNode of value.nodes) {
    if (!isRecord(rawNode)) {
      compositionError("nodes must contain objects");
    }
    const nodeKeys = Object.keys(rawNode).filter(
      (key) => !["id", "moduleId", "dependsOn"].includes(key),
    );
    if (nodeKeys.length > 0) {
      compositionError("nodes cannot contain extra fields");
    }
    const id = validateNodeId(rawNode.id);
    if (nodeIds.has(id)) {
      compositionError(`contains duplicate node ID ${id}`);
    }
    nodeIds.add(id);
    if (
      typeof rawNode.moduleId !== "string" ||
      !allowed.has(rawNode.moduleId as FinanceBrainModuleId)
    ) {
      compositionError("contains an unknown or unavailable module ID");
    }
    if (
      !Array.isArray(rawNode.dependsOn) ||
      rawNode.dependsOn.length > FINANCE_MODULE_COMPOSITION_LIMITS.maxFanout
    ) {
      compositionError(
        `each node dependsOn must be an array with at most ${FINANCE_MODULE_COMPOSITION_LIMITS.maxFanout} entries`,
      );
    }
    const dependsOn = rawNode.dependsOn.map(validateNodeId);
    if (new Set(dependsOn).size !== dependsOn.length) {
      compositionError(`node ${id} contains duplicate dependencies`);
    }
    if (dependsOn.includes(id)) {
      compositionError(`node ${id} cannot depend on itself`);
    }
    edgeCount += dependsOn.length;
    if (edgeCount > FINANCE_MODULE_COMPOSITION_LIMITS.maxEdges) {
      compositionError(
        `cannot contain more than ${FINANCE_MODULE_COMPOSITION_LIMITS.maxEdges} edges`,
      );
    }
    nodes.push({ id, moduleId: rawNode.moduleId as FinanceBrainModuleId, dependsOn });
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) {
        compositionError(`node ${node.id} depends on unknown node ${dependency}`);
      }
    }
  }

  const state = new Map<string, "visiting" | "visited">();
  const order: string[] = [];
  const depthById = new Map<string, number>();
  const visit = (id: string): number => {
    const current = state.get(id);
    if (current === "visiting") {
      compositionError("cannot contain dependency cycles");
    }
    if (current === "visited") {
      return depthById.get(id) ?? 1;
    }
    state.set(id, "visiting");
    const node = byId.get(id)!;
    const depth =
      node.dependsOn.length === 0
        ? 1
        : 1 + Math.max(...node.dependsOn.map((dependency) => visit(dependency)));
    if (depth > FINANCE_MODULE_COMPOSITION_LIMITS.maxDepth) {
      compositionError(
        `exceeds the maximum dependency depth of ${FINANCE_MODULE_COMPOSITION_LIMITS.maxDepth}`,
      );
    }
    depthById.set(id, depth);
    state.set(id, "visited");
    order.push(id);
    return depth;
  };
  for (const node of nodes) {
    visit(node.id);
  }
  const dependents = new Set(nodes.flatMap((node) => node.dependsOn));
  return Object.freeze({
    schemaVersion: FINANCE_MODULE_COMPOSITION_SCHEMA_VERSION,
    nodes: Object.freeze(nodes.map(freezeNode)),
    topologicalOrder: Object.freeze(order),
    roots: Object.freeze(
      nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.id),
    ),
    leaves: Object.freeze(nodes.filter((node) => !dependents.has(node.id)).map((node) => node.id)),
    maxDepth: Math.max(...depthById.values()),
    maxReplans,
  });
}

function defaultDependencies(
  moduleId: FinanceBrainModuleId,
  moduleIds: readonly FinanceBrainModuleId[],
): FinanceBrainModuleId[] {
  if (moduleId === "finance_learning_memory") {
    return [];
  }
  if (moduleId === "causal_map") {
    return moduleIds.filter(
      (id) => !["causal_map", "portfolio_risk_gates", "finance_learning_memory"].includes(id),
    );
  }
  if (moduleId === "portfolio_risk_gates") {
    return ["causal_map", "quant_math"].filter((id) =>
      moduleIds.includes(id as FinanceBrainModuleId),
    ) as FinanceBrainModuleId[];
  }
  return moduleIds.includes("finance_learning_memory") ? ["finance_learning_memory"] : [];
}

/** Build the bounded default graph while preserving caller-proposed edges when supplied. */
export function buildFinanceModuleComposition(
  moduleIds: readonly FinanceBrainModuleId[],
  requiredModuleIds: readonly FinanceBrainModuleId[],
  proposal: FinanceModuleComposition | undefined,
): FinanceModuleComposition {
  const allIds = [...new Set([...moduleIds, ...requiredModuleIds])];
  if (allIds.length === 0) {
    return Object.freeze({
      schemaVersion: FINANCE_MODULE_COMPOSITION_SCHEMA_VERSION,
      nodes: Object.freeze([]),
      topologicalOrder: Object.freeze([]),
      roots: Object.freeze([]),
      leaves: Object.freeze([]),
      maxDepth: 0,
      maxReplans: 0,
    });
  }
  const proposedByModule = new Map(proposal?.nodes.map((node) => [node.moduleId, node]));
  const nodes = allIds.map((moduleId) => {
    const proposed = proposedByModule.get(moduleId);
    return {
      id: proposed?.id ?? moduleId,
      moduleId,
      dependsOn:
        proposed?.dependsOn ??
        defaultDependencies(moduleId, allIds).map(
          (dependency) => proposedByModule.get(dependency)?.id ?? dependency,
        ),
    };
  });
  const parsed = parseFinanceModuleComposition(
    { nodes, maxReplans: proposal?.maxReplans ?? 0 },
    allIds,
  );
  if (!parsed) {
    throw new Error("finance module composition could not be built");
  }
  return parsed;
}
