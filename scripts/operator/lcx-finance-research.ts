import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runFinanceResearchRun } from "../../src/agents/finance-research-runner.ts";
import {
  createLocalQualityHarnessAdapter,
  createLocalRoleShadowAdapter,
  resolveLocalTextModelRuntimeConfig,
} from "../../src/agents/local-text-model-adapter.ts";

/** Explicit operator entrypoint; planning never starts network or model work. */
export async function runFinanceResearchCli(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      ask: { type: "string" },
      "as-of": { type: "string" },
      live: { type: "boolean", default: false },
      model: { type: "string" },
      adapter: { type: "string" },
      python: { type: "string" },
      "max-api-calls": { type: "string", default: "64" },
    },
  });
  if (!values.ask?.trim() || !values["as-of"]?.trim()) {
    throw new Error(
      "--ask and --as-of are required; use --live only for explicit collection and inference",
    );
  }
  const maxApiCalls = Number(values["max-api-calls"]);
  if (!Number.isSafeInteger(maxApiCalls) || maxApiCalls <= 0) {
    throw new Error("--max-api-calls must be a positive integer");
  }
  if (values.live && (!values.model?.trim() || !values.adapter?.trim())) {
    throw new Error("--live requires an explicit --model and --adapter before any collection");
  }
  const input = { ask: values.ask, asOf: values["as-of"] };
  if (!values.live) {
    return runFinanceResearchRun({ input });
  }
  const runtime = resolveLocalTextModelRuntimeConfig({
    modelId: values.model,
    adapterPath: values.adapter!,
    pythonPath: values.python,
    allowNetwork: false,
  });
  const role = createLocalRoleShadowAdapter(runtime);
  const quality = createLocalQualityHarnessAdapter(runtime);
  return runFinanceResearchRun({
    input,
    liveFetch: true,
    batchOptions: { maxApiCalls, retry: { attempts: 1 } },
    modelRouting: {
      revision: "finance-waterflow-v0-role",
      adapters: [role],
      defaultPolicy: {
        primary: role.id,
        requiredCapabilities: ["logical_agent_role_shadow"],
        maxInputBytes: 256_000,
        timeoutMs: runtime.timeoutMs,
      },
    },
    qualityModelRouting: {
      revision: "finance-waterflow-v0-quality",
      adapters: [quality],
      defaultPolicy: {
        primary: quality.id,
        requiredCapabilities: ["quality_harness"],
        maxInputBytes: 256_000,
        timeoutMs: runtime.timeoutMs,
      },
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFinanceResearchCli(process.argv.slice(2)).then(
    (receipt) => {
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      if (receipt.status === "blocked" || receipt.status === "needs_review") {
        process.exitCode = 2;
      }
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
