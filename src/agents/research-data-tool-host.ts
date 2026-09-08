import { Value } from "@sinclair/typebox/value";
import { resolveFinanceRealtimeSourceRegistryOptionsFromEnv } from "./finance-realtime-source-registry.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createFinanceChartAnalysisTool } from "./tools/finance-chart-analysis-tool.js";
import { createFinanceMarketCollectionRefreshTool } from "./tools/finance-market-collection-refresh-tool.js";
import { createFinanceRealtimeRefreshTool } from "./tools/finance-realtime-refresh-tool.js";
import { createResearchDataAutopilotTool } from "./tools/research-data-autopilot-tool.js";

/** Provider-neutral tool boundary. The host retains credentials and executes calls. */
export function createResearchDataToolHost(options: {
  workspaceDir: string;
  modelHasVision?: boolean;
  nativeVisionModelRef?: string;
  visionTool?: AnyAgentTool | null;
}) {
  function tools() {
    return [
      createResearchDataAutopilotTool(options),
      createFinanceMarketCollectionRefreshTool(options),
      createFinanceRealtimeRefreshTool({
        workspaceDir: options.workspaceDir,
        ...resolveFinanceRealtimeSourceRegistryOptionsFromEnv(),
      }),
      createFinanceChartAnalysisTool(options),
    ];
  }
  return {
    list: () =>
      tools().map(({ name, description, parameters }) => ({ name, description, parameters })),
    async execute(request: { tool: string; arguments: unknown; callId?: string }) {
      const tool = tools().find((entry) => entry.name === request.tool);
      if (!tool) {
        throw new Error("unsupported research data tool");
      }
      if (!Value.Check(tool.parameters, request.arguments)) {
        throw new Error("invalid research data tool arguments");
      }
      return tool.execute(request.callId ?? "research-data-host", request.arguments);
    },
  };
}
