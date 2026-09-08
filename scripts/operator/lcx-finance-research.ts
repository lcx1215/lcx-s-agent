import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  bindFinanceCaseFollowups,
  createFinanceNativeCronScheduler,
} from "../../src/agents/finance-caseflow-followups.ts";
import {
  buildFinanceCaseRun,
  listFinanceCases,
  saveFinanceCaseRun,
  readFinanceCaseRun,
  compareFinanceCaseRuns,
  caseflowFingerprint,
} from "../../src/agents/finance-caseflow.ts";
import { FinanceForecast } from "../../src/agents/finance-forecast-calibration.ts";
import {
  appendFinanceOutcome,
  readFinanceOutcomes,
} from "../../src/agents/finance-outcome-ledger.ts";
import type { FinanceResearchRunReceipt } from "../../src/agents/finance-research-runner.ts";
import { runFinanceResearchRun } from "../../src/agents/finance-research-runner.ts";
import {
  createLocalQualityHarnessAdapter,
  createLocalRoleShadowAdapter,
  resolveLocalTextModelRuntimeConfig,
} from "../../src/agents/local-text-model-adapter.ts";
import type { CronJob } from "../../src/cron/types.ts";

/** Explicit operator entrypoint; planning never starts network or model work. */
type FinanceResearchCliResult =
  | (FinanceResearchRunReceipt & { savedCaseRun?: Awaited<ReturnType<typeof saveFinanceCaseRun>> })
  | Awaited<ReturnType<typeof readFinanceCaseRun>>
  | ReturnType<typeof compareFinanceCaseRuns>
  | Awaited<ReturnType<typeof appendFinanceOutcome>>
  | Awaited<ReturnType<typeof readFinanceOutcomes>>
  | Awaited<ReturnType<typeof listFinanceCases>>
  | Awaited<ReturnType<typeof bindFinanceCaseFollowups>>;

export async function runFinanceResearchCli(args: string[]): Promise<FinanceResearchCliResult> {
  const { values } = parseArgs({
    args,
    options: {
      "all-sources": { type: "boolean", default: false },
      "sources-only": { type: "boolean", default: false },
      "followup-agent": { type: "string" },
      "gateway-cli": { type: "string" },
      "register-followups": { type: "boolean", default: false },
      "followup-status": { type: "boolean", default: false },
      "forecast-file": { type: "string" },
      "list-cases": { type: "boolean", default: false },
      "packet-ref": { type: "string" },
      "outcome-file": { type: "string" },
      "list-outcomes": { type: "boolean", default: false },
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
      "max-model-calls": { type: "string", default: "48" },
      "max-api-calls": { type: "string", default: "64" },
    },
  });
  if (
    (values["all-sources"] || values["sources-only"]) &&
    (values["read-run"] ||
      values["list-cases"] ||
      values["list-outcomes"] ||
      values["outcome-file"] ||
      values["followup-status"] ||
      values["register-followups"])
  ) {
    throw new Error("source selection flags require research mode");
  }
  if (values["sources-only"] && (!values.live || values.model || values.adapter || values.python)) {
    throw new Error("--sources-only requires --live without model overrides");
  }
  if (
    (values["gateway-cli"] || values["followup-agent"]) &&
    !values["register-followups"] &&
    !values["followup-status"]
  ) {
    throw new Error("gateway-cli and followup-agent require a followup operation");
  }
  if (values["gateway-cli"] && !values["followup-agent"]) {
    throw new Error("native scheduler requires an explicit --followup-agent owner");
  }
  if (values["register-followups"] || values["followup-status"]) {
    if (
      !values["case-dir"] ||
      !values["packet-ref"] ||
      values.live ||
      values.ask ||
      values["outcome-file"] ||
      values["list-outcomes"] ||
      values["list-cases"] ||
      values["read-run"] ||
      values["forecast-file"] ||
      values["compare-run"] ||
      (values["register-followups"] && values["followup-status"])
    ) {
      throw new Error(
        "followup mode requires case-dir and packet-ref, without research or outcome operations",
      );
    }
    const { callGateway } = await import("../../src/gateway/call.ts");
    return bindFinanceCaseFollowups({
      directory: values["case-dir"],
      packetRef: values["packet-ref"],
      register: values["register-followups"],
      agentId: values["followup-agent"],
      scheduler: values["gateway-cli"]
        ? createFinanceNativeCronScheduler(
            values["gateway-cli"],
            `caseflow:${values["packet-ref"]}:`,
          )
        : {
            list: async () => {
              const jobs: CronJob[] = [];
              let offset = 0;
              for (;;) {
                const page = await callGateway<{
                  jobs: CronJob[];
                  hasMore: boolean;
                  nextOffset: number | null;
                }>({
                  method: "cron.list",
                  params: {
                    includeDisabled: true,
                    query: `caseflow:${values["packet-ref"]}:`,
                    offset,
                    limit: 100,
                  },
                });
                jobs.push(...page.jobs);
                if (!page.hasMore) {
                  return jobs;
                }
                if (page.nextOffset === null || page.nextOffset <= offset) {
                  throw new Error("invalid scheduler pagination");
                }
                offset = page.nextOffset;
              }
            },
            add: (job) => callGateway<CronJob>({ method: "cron.add", params: job }),
          },
    });
  }
  if (values["list-cases"]) {
    if (
      !values["case-dir"] ||
      values.live ||
      values.ask ||
      values["read-run"] ||
      values["compare-run"] ||
      values["checkpoint-run"] ||
      values["outcome-file"] ||
      values["packet-ref"] ||
      values["list-outcomes"]
    ) {
      throw new Error(
        "--list-cases requires case-dir and cannot be combined with research or outcome operations",
      );
    }
    return listFinanceCases(values["case-dir"]);
  }
  if (values["outcome-file"] || values["list-outcomes"] || values["packet-ref"]) {
    if (
      !values["case-dir"] ||
      !values["packet-ref"] ||
      Boolean(values["outcome-file"]) === Boolean(values["list-outcomes"]) ||
      values.live ||
      values.ask ||
      values["as-of"] ||
      values["case-id"] ||
      values["checkpoint-run"] ||
      values["read-run"] ||
      values["compare-run"]
    ) {
      throw new Error(
        "outcome mode requires case-dir, packet-ref and either outcome-file or list-outcomes; research cannot run simultaneously",
      );
    }
    if (values["outcome-file"]) {
      if ((await fs.stat(values["outcome-file"])).size > 1_048_576) {
        throw new Error("outcome input exceeds 1 MiB");
      }
      const input: unknown = JSON.parse(await fs.readFile(values["outcome-file"], "utf8"));
      return appendFinanceOutcome(values["case-dir"], values["packet-ref"], input);
    }
    return readFinanceOutcomes(values["case-dir"], values["packet-ref"]);
  }
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
  if (values["forecast-file"] && (!values["case-dir"] || !values["case-id"])) {
    throw new Error("--forecast-file requires --case-dir and --case-id");
  }
  const forecasts = values["forecast-file"]
    ? FinanceForecast.array().parse(JSON.parse(await fs.readFile(values["forecast-file"], "utf8")))
    : undefined;
  const maxModelCalls = Number(values["max-model-calls"]);
  if (!Number.isSafeInteger(maxModelCalls) || maxModelCalls <= 0) {
    throw new Error("--max-model-calls must be a positive integer");
  }
  const maxApiCalls = Number(values["max-api-calls"]);
  if (!Number.isSafeInteger(maxApiCalls) || maxApiCalls <= 0) {
    throw new Error("--max-api-calls must be a positive integer");
  }
  if (
    values.live &&
    !values["sources-only"] &&
    (!values.model?.trim() || !values.adapter?.trim())
  ) {
    throw new Error("--live requires an explicit --model and --adapter before any collection");
  }
  const execution = {
    model: values.model ?? "none",
    adapterReference: values.adapter ?? "none",
    modelArtifactFingerprint: "not_captured",
    runtime: {} as Record<string, unknown>,
    live: values.live,
    sourcesOnly: values["sources-only"],
    sourcePolicy: values["all-sources"] ? "all_registered" : "prioritized",
    maxApiCalls,
    maxModelCalls,
    codeFiles: values["case-dir"]
      ? Object.fromEntries(
          await Promise.all(
            [
              "../../src/agents/finance-caseflow.ts",
              "../../src/agents/finance-forecast-calibration.ts",
              "../../src/agents/finance-history-coverage.ts",
              "../../src/agents/finance-research-assessment.ts",
              "../../src/agents/api-call-contract.ts",
              "../../src/agents/finance-free-market-collection-adapters.ts",
              "../../src/agents/finance-market-collection-registry.ts",
              "../../src/agents/quality-harness-contract.ts",
              "../../src/agents/finance-run-checkpoints.ts",
              "../../src/agents/finance-model-checkpoints.ts",
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
      forecasts,
    });
    const savedCaseRun = await saveFinanceCaseRun(values["case-dir"], run);
    return { ...receipt, savedCaseRun };
  };
  const input = {
    ask: values.ask,
    asOf: values["as-of"],
    sourcePolicy: values["all-sources"] ? ("all_registered" as const) : ("prioritized" as const),
  };
  if (!values.live) {
    return finish(await runFinanceResearchRun({ input }));
  }
  if (values["sources-only"]) {
    return finish(
      await runFinanceResearchRun({
        input,
        liveFetch: true,
        batchOptions: {
          maxApiCalls,
          retry: { attempts: 1 },
          sourceTimeoutMs: 15000,
          totalTimeoutMs: 120000,
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
      }),
    );
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
      ...(values["checkpoint-run"]
        ? {
            modelCheckpoint: {
              path: path.join(values["case-dir"]!, "source-checkpoints.sqlite"),
              runId: `${values["case-id"]}:${values["checkpoint-run"]}`,
              executionFingerprint: caseflowFingerprint(execution),
              maxModelCalls,
            },
          }
        : {}),
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
