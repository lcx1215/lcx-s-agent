import { Type } from "@sinclair/typebox";
import { inspectEchoApiCliHealth, runEchoApiCliCase } from "../echoapi-cli-runner.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam, ToolInputError } from "./common.js";

const EchoApiCliHealthSchema = Type.Object({
  action: Type.Optional(
    Type.Union([Type.Literal("status"), Type.Literal("public_probe")], {
      description:
        "status reads the pinned local CLI and latest receipt without network; public_probe runs one bounded public read-only CLI smoke.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      minimum: 1_000,
      maximum: 30_000,
      description: "Public probe timeout in milliseconds.",
    }),
  ),
});

/** Report local EchoAPI CLI availability separately from cloud-case evidence. */
export function createEchoApiCliHealthTool(): AnyAgentTool {
  return {
    label: "EchoAPI CLI Health",
    name: "echoapi_cli_health",
    description:
      "Read the exact pinned EchoAPI CLI installation and its latest invocation receipt without network activity, or run one bounded public smoke when the CLI is already installed. The smoke makes one public Binance BTCUSDT GET, then invokes the EchoAPI CLI against a local snapshot and verifies its JSON report; it does not assess EchoAPI cloud CI uptime or CoinGecko health. Use finance_source_health_read and finance_realtime_source_refresh for CoinGecko status and calls.",
    parameters: EchoApiCliHealthSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action") ?? "status";
      if (action === "status") {
        return jsonResult(await inspectEchoApiCliHealth());
      }
      if (action !== "public_probe") {
        throw new ToolInputError("action must be status or public_probe");
      }
      const timeoutMs = readNumberParam(params, "timeoutMs") ?? 15_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
        throw new ToolInputError("timeoutMs must be an integer from 1000 to 30000");
      }
      const initialHealth = await inspectEchoApiCliHealth();
      if (initialHealth.installation.status !== "available") {
        return jsonResult({
          schemaVersion: "lcx_echoapi_cli_probe_v1",
          boundary: "bounded_public_read_only_cli_probe_not_echoapi_cloud_uptime",
          status: "unavailable",
          nextAction: "run pnpm lcx:echoapi:ensure, then retry public_probe",
          health: initialHealth,
        });
      }
      let probe: unknown;
      let passed = false;
      try {
        probe = await runEchoApiCliCase({ builtinPublicCase: true, timeoutMs });
        passed = (probe as { passed?: unknown }).passed === true;
      } catch (error) {
        probe = {
          status: "failed",
          errorCode: error instanceof Error ? error.name : "unknown_error",
        };
      }
      return jsonResult({
        schemaVersion: "lcx_echoapi_cli_probe_v1",
        boundary: "bounded_public_read_only_cli_probe_not_echoapi_cloud_uptime",
        status: passed ? "healthy" : "unhealthy",
        probe,
        health: await inspectEchoApiCliHealth(),
      });
    },
  };
}
