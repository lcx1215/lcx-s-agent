/** Original registered gateway -> bounded receipt -> exact recall -> changed evidence request.
 * All measurements are declared offline fixtures; no source trust or natural model adoption proof.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  compactReceipts,
  runCentralHarnessCycle,
} from "../../src/agents/central-harness/harness-loop.js";
import { buildCentralToolCatalog } from "../../src/agents/central-harness/model-brain.js";
import { createCentralToolRegistry } from "../../src/agents/central-harness/tool-registry.js";
import type {
  CentralPerception,
  CentralProposedAction,
  CentralRunReceipt,
} from "../../src/agents/central-harness/types.js";
import type { FinanceDataGatewayInput } from "../../src/agents/finance-data-gateway.js";

export async function probeOriginalGatewayFeedback(
  directory: string,
  fault: "conflict" | "missing_source" | "unchanged" = "conflict",
) {
  await fs.mkdir(directory, { recursive: true });
  const at = "2026-07-01T20:00:00.000Z";
  const input: FinanceDataGatewayInput = {
    instrument: "QQQ",
    assetClass: "etf",
    useCase: "offline_gateway_feedback",
    asOf: at,
    asOfMode: "historical",
    crossSourceSkewMaxMinutes: 60,
    observations: (
      ["primary_market_data", "cross_check_market_data", "official_or_issuer_reference"] as const
    )
      .filter((role) => fault !== "missing_source" || role !== "cross_check_market_data")
      .map((role) => ({
        providerName: `offline-${role}`,
        providerRole: role,
        sourceFamily: "market_data_api",
        observedAt: at,
        timezone: "UTC",
        delayStatus: "delayed",
        fields: [
          {
            name: "last_price",
            value: role === "cross_check_market_data" ? 110 : 100,
            currency: "USD",
            fieldDefinition: `Offline supplied quote; ${"fixture metadata ".repeat(100)}`,
            sourceTimestamp: at,
            sourceUrlOrArtifact: `fixture://${role}/original/QQQ`,
          },
        ],
      })),
  };
  const registry = createCentralToolRegistry({
    workspaceDir: directory,
    config: {
      agents: {
        defaults: {
          workspace: directory,
          memorySearch: { store: { path: path.join(directory, "artifacts.sqlite") } },
        },
      },
    },
  });
  const receipts: CentralRunReceipt[] = [];
  const perceptions: CentralPerception[] = [];
  const capabilities = new Set(["finance_data_gateway_snapshot", "artifact_memory_recall"]);
  async function cycle(
    decide: (seen: CentralPerception) => { actions: CentralProposedAction[]; note: string },
  ) {
    const perception: CentralPerception = {
      observedAt: at,
      ownerTotals: {},
      controlRoom: {},
      boundaries: [],
      backlog: compactReceipts(receipts, 10, capabilities),
    };
    const receipt = await runCentralHarnessCycle({
      registry,
      perception,
      capabilityOwnerIds: capabilities,
      brain: {
        propose: async (seen) => {
          perceptions.push(structuredClone(seen));
          return {
            kind: "proposed",
            provider: "offline-fixture",
            modelId: "scripted-consumer",
            plan: decide(seen),
          };
        },
      },
    });
    receipts.push(receipt);
    return receipt;
  }
  const first = await cycle(() => ({
    actions: [{ ownerId: "finance_data_gateway_snapshot", args: input }],
    note: "Check supplied observations with the original registered gateway",
  }));
  const firstStep = first.steps[0];
  const artifactId = firstStep.resultArtifact?.id;
  if (!artifactId) {
    throw new Error("original gateway did not archive its actual result");
  }
  const readField =
    fault === "missing_source" ? "/value/missingEvidence" : "/value/conflicts/0/providerValues";
  const recall = await cycle((seen) => {
    if (
      JSON.stringify(seen.backlog).indexOf(
        fault === "missing_source" ? "cross_check_market_data_provider" : "last_price",
      ) < 0
    ) {
      throw new Error("the original bounded feedback lost the specific source gap");
    }
    return {
      actions: [
        {
          ownerId: "artifact_memory_recall",
          args: { action: "read", id: artifactId, field: readField },
        },
      ],
      note: "Read the exact original evidence for the specific quality gap",
    };
  });
  const selected = recall.steps[0].outcome?.selectedValue;
  let correctedInput: FinanceDataGatewayInput | undefined;
  if (fault !== "missing_source") {
    await cycle((seen) => {
      if (!Array.isArray(selected) || !selected.some((row) => row?.value === 110)) {
        throw new Error("exact conflicting value unavailable");
      }
      if (JSON.stringify(seen.backlog).indexOf("110") < 0) {
        throw new Error("exact recall was not fed forward");
      }
      // This is a replacement offline source observation, not choosing the convenient price.
      // No production source is fetched, edited or trusted by this fixture.
      correctedInput = structuredClone(input);
      if (fault !== "unchanged") {
        const cross = correctedInput.observations.find(
          (item) => item.providerRole === "cross_check_market_data",
        )!;
        cross.fields[0].value = 100;
        cross.fields[0].sourceUrlOrArtifact = "fixture://cross_check_market_data/corrected/QQQ";
      }
      return {
        actions: [{ ownerId: "finance_data_gateway_snapshot", args: correctedInput }],
        note:
          fault === "unchanged"
            ? "Recheck unchanged fixture to prove the conflict remains"
            : "Revalidate a specifically corrected offline observation",
      };
    });
  }
  const final = await cycle((seen) => {
    const latest = receipts.at(-1)!;
    const outcome = latest.steps[0]?.outcome;
    const ready = outcome?.qualityStatus === "ready";
    if (
      JSON.stringify(seen.backlog).indexOf(
        fault === "missing_source" ? "cross_check_market_data_provider" : "last_price",
      ) < 0
    ) {
      throw new Error("quality evidence lost before judgment");
    }
    return {
      actions: [],
      note: ready
        ? "Changed supplied source now passes the existing gateway checks; upstream truth and broker authority remain unverified"
        : fault === "missing_source"
          ? "Unresolved: cross_check_market_data_provider is missing; no source or broker authority is invented"
          : "Unresolved: unchanged last_price source values 100 and 110 still conflict; no preference-based resolution",
    };
  });
  return {
    boundary: "offline_original_tool_feedback_not_whole_scene_or_natural_adoption",
    input,
    correctedInput,
    catalog: buildCentralToolCatalog([...registry.values()]),
    inputKeys: registry.get("finance_data_gateway_snapshot")!.inputKeys,
    receipts,
    perceptions,
    artifactId,
    readField,
    selected,
    finalNote: final.brainCall.note,
    callableNextTools: receipts.flatMap((receipt) =>
      receipt.steps.flatMap((step) =>
        typeof step.outcome?.nextTool === "string"
          ? [{ name: step.outcome.nextTool, registered: registry.has(step.outcome.nextTool) }]
          : [],
      ),
    ),
  };
}
