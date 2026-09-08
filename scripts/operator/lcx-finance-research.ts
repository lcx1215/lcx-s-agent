import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  buildFinanceCaseRun,
  saveFinanceCaseRun,
  readFinanceCaseRun,
  compareFinanceCaseRuns,
  caseflowFingerprint,
} from "../../src/agents/finance-caseflow.ts";
import type { FinanceResearchRunReceipt } from "../../src/agents/finance-research-runner.ts";
import { runFinanceResearchRun } from "../../src/agents/finance-research-runner.ts";
import {
  createLocalQualityHarnessAdapter,
  createLocalRoleShadowAdapter,
  resolveLocalTextModelRuntimeConfig,
} from "../../src/agents/local-text-model-adapter.ts";

/** Explicit operator entrypoint; planning never starts network or model work. */
type FinanceResearchCliResult =
  | (FinanceResearchRunReceipt & { savedCaseRun?: Awaited<ReturnType<typeof saveFinanceCaseRun>> })
  | Awaited<ReturnType<typeof readFinanceCaseRun>>
  | ReturnType<typeof compareFinanceCaseRuns>;

export async function runFinanceResearchCli(args: string[]): Promise<FinanceResearchCliResult> {
  const { values } = parseArgs({
    args,
    options: {
      "checkpoint-run": { type: "string" },
      "case-dir": { type: "string" },
      "case-id": { type: "string" },
      "read-run": { type: "string" },
      "compare-run": { type: "string" },
      ask: { type: "string" },
      "as-of": { type: "string" },
      live: { type: "boolean", default: false },
      model: { type: "string" },
      adapter: { type: "string" },
      python: { type: "string" },
      "max-api-calls": { type: "string", default: "64" },
    },
  });
  if (
    values["checkpoint-run"] &&
    (!values.live || !values["case-id"] || !values["case-dir"] || values["read-run"])
  ) {
    throw new Error("--checkpoint-run requires live case research and cannot read a frozen run");
  }
  if (values["read-run"]) {
    if (!values["case-dir"] || values.live || values.ask || values["case-id"]) {
      throw new Error("--read-run requires --case-dir and cannot execute research");
    }
    const before = await readFinanceCaseRun(values["case-dir"], values["read-run"]);
    return values["compare-run"]
      ? compareFinanceCaseRuns(
          before,
          await readFinanceCaseRun(values["case-dir"], values["compare-run"]),
        )
      : before;
  }
  if (values["compare-run"]) {
    throw new Error("--compare-run requires --read-run");
  }
  if (Boolean(values["case-dir"]) !== Boolean(values["case-id"])) {
    throw new Error("--case-dir and --case-id must be supplied together");
  }
  if (values["case-id"] && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(values["case-id"])) {
    throw new Error("invalid --case-id");
  }
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
  const execution = {
    model: values.model ?? "none",
    adapterReference: values.adapter ?? "none",
    modelArtifactFingerprint: "not_captured",
    runtime: {} as Record<string, unknown>,
    live: values.live,
    maxApiCalls,
    codeFiles: values["case-dir"]
      ? Object.fromEntries(
          await Promise.all(
            [
              "../../src/agents/finance-caseflow.ts",
              "../../src/agents/finance-run-checkpoints.ts",
              "../../src/agents/finance-research-runner.ts",
              "../../src/agents/finance-research-batch-runner.ts",
              "../../src/agents/local-text-model-adapter.ts",
              "../../src/agents/logical-agent-model-router.ts",
              "../../src/agents/logical-agent-pool.ts",
              "../../src/agents/quality-harness.ts",
              "./lcx-finance-research.ts",
            ].map(async (file) => [
              file,
              caseflowFingerprint(await fs.readFile(new URL(file, import.meta.url), "utf8")),
            ]),
          ),
        )
      : {},
  };
  const finish = async (receipt: FinanceResearchRunReceipt) => {
    if (!values["case-dir"] || !values["case-id"]) {
      return receipt;
    }
    const run = buildFinanceCaseRun({
      caseId: values["case-id"],
      receipt,
      execution,
      budget: { maxApiCalls },
    });
    const savedCaseRun = await saveFinanceCaseRun(values["case-dir"], run);
    return { ...receipt, savedCaseRun };
  };
  const input = { ask: values.ask, asOf: values["as-of"] };
  if (!values.live) {
    return finish(await runFinanceResearchRun({ input }));
  }
  const runtime = resolveLocalTextModelRuntimeConfig({
    modelId: values.model,
    adapterPath: values.adapter!,
    pythonPath: values.python,
    allowNetwork: false,
  });
  execution.runtime = { ...runtime };
  const role = createLocalRoleShadowAdapter(runtime);
  const quality = createLocalQualityHarnessAdapter(runtime);
  return finish(
    await runFinanceResearchRun({
      input,
      liveFetch: true,
      batchOptions: {
        maxApiCalls,
        retry: { attempts: 1 },
        ...(values["checkpoint-run"]
          ? {
              checkpoint: {
                path: path.join(values["case-dir"]!, "source-checkpoints.sqlite"),
                runId: `${values["case-id"]}:${values["checkpoint-run"]}`,
                executionFingerprint: caseflowFingerprint(execution),
              },
            }
          : {}),
      },
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
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFinanceResearchCli(process.argv.slice(2)).then(
    (receipt) => {
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      if (
        "status" in receipt &&
        (receipt.status === "blocked" || receipt.status === "needs_review")
      ) {
        process.exitCode = 2;
      }
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
